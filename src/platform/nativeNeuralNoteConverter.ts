import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { decodeAudioBuffer, type DecodedAudioBuffer } from '../audio/decodeAudioBuffer';
import { Midi } from '@tonejs/midi';
import { IMPORT_DEBUG_LOG_ENABLED } from './importDebugConfig';

export type NativeAudioToMidiProgress = {
  stage: string;
  progress: number;
};

type CoreNoteEvent = {
  startTimeSeconds?: number;
  durationSeconds?: number;
  pitchMidi?: number;
  amplitude?: number;
};

type CoreTempoPoint = {
  timeSeconds?: number;
  time?: number;
  seconds?: number;
  bpm?: number;
};

type StartTranscriptionResult = {
  jobId: string;
  debugLogPath?: string;
};

type ShareImportDebugLogResult = {
  shared?: boolean;
  logPath?: string;
};

type NativeTranscriptionResult = {
  events?: CoreNoteEvent[];
  tempoBpm?: number;
};

type TranscriptionStatus = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage?: string;
  progress?: number;
  error?: string;
  result?: NativeTranscriptionResult;
};

type NeuralNoteConverterPlugin = {
  startTranscription: (options: {
    pcmPath: string;
    tempoPcmPath: string;
    preset?: 'balanced';
    tempoTimeoutMs?: number;
    neuralTimeoutMs?: number;
  }) => Promise<StartTranscriptionResult>;
  getTranscriptionStatus: (options: { jobId: string }) => Promise<TranscriptionStatus>;
  shareImportDebugLog: () => Promise<ShareImportDebugLogResult>;
};

const NeuralNoteConverter = registerPlugin<NeuralNoteConverterPlugin>('NeuralNoteConverter');

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg']);
const NEURALNOTE_SAMPLE_RATE = 22050;
const TEMPO_CNN_SAMPLE_RATE = 11025;
const TEMPO_BPM_MIN = 20;
const TEMPO_BPM_MAX = 300;
const IMPORT_STATUS_POLL_MS = 450;
const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
const NATIVE_STAGE_TIMEOUT_MIN_MS = 60 * 1000;
const NATIVE_STAGE_TIMEOUT_MAX_MS = 20 * 60 * 1000;
const IMPORT_DEBUG_DIR_PATH = 'import-debug';
const IMPORT_DEBUG_LOG_PATH = `${IMPORT_DEBUG_DIR_PATH}/song-import-debug.log`;
const PCM_WRITE_CHUNK_BYTES = 2 * 1024 * 1024;
const PCM_WRITE_LOG_EVERY_N_CHUNKS = 4;

const BALANCED_PRESET = {
  midiTempo: 120,
  normalizeInput: false,
  useModelAmplitudeVelocity: true,
  targetPeak: 0.92,
  targetRms: 0.09,
  velocityBase: 0.5,
  velocityRange: 0.5,
  amplitudeExponent: 0.42,
  volumeBoost: 1.5,
  velocityFloor: 0.6
};

export function isNativeNeuralNoteConverterAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export async function shareNativeImportDebugLog(): Promise<{ logPath: string | null }> {
  if (!isNativeNeuralNoteConverterAvailable()) {
    throw new Error('Import debug log sharing is available only on native runtime.');
  }

  const result = await NeuralNoteConverter.shareImportDebugLog();
  return {
    logPath: firstNonEmpty(result?.logPath) ?? null
  };
}

export async function convertAudioBufferToMidiNativeCxx(
  sourceBuffer: ArrayBuffer,
  mimeOrExtension: string,
  onProgress?: (update: NativeAudioToMidiProgress) => void
): Promise<Uint8Array> {
  const jsRunId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  debugImportLog(
    `JS converter start | run=${jsRunId} | sourceBytes=${sourceBuffer.byteLength} | mimeOrExtension=${mimeOrExtension}`
  );

  if (sourceBuffer.byteLength <= 0) {
    debugImportLog(`JS converter rejected empty buffer | run=${jsRunId}`);
    throw new Error('Uploaded audio is empty.');
  }

  const sourceType = detectUploadSourceType(mimeOrExtension);
  if (sourceType && sourceType !== 'audio') {
    debugImportLog(`JS converter rejected non-audio source | run=${jsRunId} | sourceType=${sourceType}`);
    throw new Error('Only WAV, MP3, and OGG can be converted to MIDI.');
  }

  if (!isNativeNeuralNoteConverterAvailable()) {
    debugImportLog(`JS converter rejected non-native runtime | run=${jsRunId}`);
    throw new Error('NeuralNote native converter is available only on native runtime.');
  }

  reportProgress(onProgress, 'Decoding audio...', 0.16);
  const decodeStartedAt = Date.now();
  debugImportLog(`Decoding audio started | run=${jsRunId}`);
  const decoded = await decodeAudioBuffer(sourceBuffer);
  debugImportLog(
    `Decoding audio completed | run=${jsRunId} | elapsedMs=${Date.now() - decodeStartedAt} | channels=${decoded.numberOfChannels} | sampleRate=${decoded.sampleRate} | frames=${decoded.length}`
  );
  const sourceSampleRate = Math.max(1, Number(decoded.sampleRate) || NEURALNOTE_SAMPLE_RATE);
  const downmixStartedAt = Date.now();
  debugImportLog(`Downmix to mono started | run=${jsRunId} | sourceSampleRate=${sourceSampleRate}`);
  const mono = downmixToMono(decoded);
  const audioDurationSeconds = Math.max(0, mono.length / sourceSampleRate);
  debugImportLog(
    `Downmix to mono completed | run=${jsRunId} | elapsedMs=${Date.now() - downmixStartedAt} | monoSamples=${mono.length} | durationSec=${audioDurationSeconds.toFixed(3)}`
  );

  const neuralResampleStartedAt = Date.now();
  debugImportLog(`NeuralNote resampling started | run=${jsRunId}`);
  const neuralNoteResampled = resampleMonoSignal(mono, sourceSampleRate, NEURALNOTE_SAMPLE_RATE);
  const neuralNoteNormalized = BALANCED_PRESET.normalizeInput
    ? normalizeMonoSignal(neuralNoteResampled, BALANCED_PRESET)
    : neuralNoteResampled;
  debugImportLog(
    `NeuralNote resampling completed | run=${jsRunId} | elapsedMs=${Date.now() - neuralResampleStartedAt} | samples=${neuralNoteNormalized.length} | bytes=${neuralNoteNormalized.byteLength}`
  );

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const neuralTmpPath = `converter-tmp/neuralnote-import-${suffix}.f32`;
  const tempoTmpPath = `converter-tmp/tempocnn-import-${suffix}.f32`;
  let debugLogPath: string | null = null;

  try {
    reportProgress(onProgress, 'Preparing NeuralNote native job...', 0.24);
    debugImportLog(
      `Preparing temp PCM files | run=${jsRunId} | neuralTmpPath=${neuralTmpPath} | tempoTmpPath=${tempoTmpPath}`
    );

    await writeFloat32PcmFileChunked(neuralTmpPath, neuralNoteNormalized, {
      runId: jsRunId,
      label: 'NeuralNote'
    });
    debugImportLog(`NeuralNote temp PCM written | run=${jsRunId} | path=${neuralTmpPath}`);

    const tempoResampleStartedAt = Date.now();
    debugImportLog(`Tempo resampling started | run=${jsRunId}`);
    const tempoResampled = resampleMonoSignal(mono, sourceSampleRate, TEMPO_CNN_SAMPLE_RATE);
    debugImportLog(
      `Tempo resampling completed | run=${jsRunId} | elapsedMs=${Date.now() - tempoResampleStartedAt} | samples=${tempoResampled.length} | bytes=${tempoResampled.byteLength}`
    );

    await writeFloat32PcmFileChunked(tempoTmpPath, tempoResampled, {
      runId: jsRunId,
      label: 'Tempo'
    });
    debugImportLog(`Tempo temp PCM written | run=${jsRunId} | path=${tempoTmpPath}`);

    const [neuralUri, tempoUri] = await Promise.all([
      Filesystem.getUri({ path: neuralTmpPath, directory: Directory.Data }),
      Filesystem.getUri({ path: tempoTmpPath, directory: Directory.Data })
    ]);
    debugImportLog(
      `Temp PCM URIs resolved | run=${jsRunId} | neuralUri=${neuralUri.uri} | tempoUri=${tempoUri.uri}`
    );

    debugImportLog(`Native startTranscription requested | run=${jsRunId}`);
    const start = await NeuralNoteConverter.startTranscription({
      pcmPath: neuralUri.uri,
      tempoPcmPath: tempoUri.uri,
      preset: 'balanced',
      tempoTimeoutMs: estimateTempoStageTimeoutMs(audioDurationSeconds),
      neuralTimeoutMs: estimateNeuralStageTimeoutMs(audioDurationSeconds)
    });
    debugLogPath = firstNonEmpty(start?.debugLogPath);
    debugImportLog(
      `Native startTranscription resolved | run=${jsRunId} | jobId=${firstNonEmpty(start?.jobId) ?? '<missing>'} | nativeLogPath=${debugLogPath ?? '<none>'}`
    );
    if (debugLogPath) {
      console.info('[native-import-debug] log file:', debugLogPath);
    }

    const jobId = String(start?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Native converter did not return a valid job id.');
    }

    const transcription = await pollNativeTranscription(jobId, onProgress);
    const events = Array.isArray(transcription.events) ? transcription.events : [];
    debugImportLog(`Native transcription completed | run=${jsRunId} | jobId=${jobId} | events=${events.length}`);
    if (events.length === 0) {
      throw new Error('No notes detected in uploaded audio.');
    }

    reportProgress(onProgress, 'Building MIDI events...', 0.92);

    const midi = new Midi();
    applyTempoMetadataToMidi(midi, {
      tempoBpm: Number(transcription.tempoBpm),
      audioDurationSeconds,
      fallbackTempoBpm: BALANCED_PRESET.midiTempo
    });
    const track = midi.addTrack();

    for (const event of events) {
      const pitch = clamp(Math.round(toFiniteNumber(event.pitchMidi, 0)), 0, 127);
      const time = Math.max(0, toFiniteNumber(event.startTimeSeconds, 0));
      if (time >= audioDurationSeconds) continue;
      const maxDuration = Math.max(0, audioDurationSeconds - time);
      if (maxDuration <= 0) continue;
      const duration = Math.min(Math.max(0.001, toFiniteNumber(event.durationSeconds, 0.02)), maxDuration);
      const amplitude = clamp(toFiniteNumber(event.amplitude, 0.4), 0, 1);

      if (BALANCED_PRESET.useModelAmplitudeVelocity) {
        track.addNote({ midi: pitch, time, duration, velocity: clamp(amplitude, 0.01, 1) });
        continue;
      }

      const liftedAmplitude = Math.pow(amplitude, BALANCED_PRESET.amplitudeExponent);
      const baseVelocity = BALANCED_PRESET.velocityBase + liftedAmplitude * BALANCED_PRESET.velocityRange;
      const boostedVelocity = baseVelocity * BALANCED_PRESET.volumeBoost;
      const velocity = clamp(boostedVelocity, BALANCED_PRESET.velocityFloor, 1);
      track.addNote({ midi: pitch, time, duration, velocity });
    }

    reportProgress(onProgress, 'Finalizing MIDI file...', 0.98);
    const bytes = midi.toArray();
    debugImportLog(`MIDI finalized | run=${jsRunId} | outputBytes=${bytes.byteLength}`);
    reportProgress(onProgress, 'Conversion complete.', 1);
    debugImportLog(`JS converter completed successfully | run=${jsRunId}`);
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (error) {
    debugImportLog(`JS converter failed | run=${jsRunId} | error=${toErrorLine(error)}`);
    if (debugLogPath) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} (import debug log: ${debugLogPath})`);
    }
    throw error;
  } finally {
    debugImportLog(`Cleaning temp files | run=${jsRunId}`);
    await Filesystem.deleteFile({
      path: neuralTmpPath,
      directory: Directory.Data
    }).catch(() => undefined);
    await Filesystem.deleteFile({
      path: tempoTmpPath,
      directory: Directory.Data
    }).catch(() => undefined);
    debugImportLog(`Temp cleanup completed | run=${jsRunId}`);
  }
}

async function pollNativeTranscription(
  jobId: string,
  onProgress?: (update: NativeAudioToMidiProgress) => void
): Promise<NativeTranscriptionResult> {
  const startedAt = Date.now();

  while (true) {
    const status = await NeuralNoteConverter.getTranscriptionStatus({ jobId });

    reportProgress(
      onProgress,
      firstNonEmpty(status.stage, 'Converting audio to MIDI...') ?? 'Converting audio to MIDI...',
      clamp01(Number(status.progress ?? 0))
    );

    if (status.status === 'completed') {
      return status.result ?? {};
    }

    if (status.status === 'failed') {
      throw new Error(firstNonEmpty(status.error, 'Audio import failed.') ?? 'Audio import failed.');
    }

    if (Date.now() - startedAt > IMPORT_TIMEOUT_MS) {
      throw new Error('Import timed out. Try again with a shorter track.');
    }

    await waitMs(IMPORT_STATUS_POLL_MS);
  }
}

function applyTempoMetadataToMidi(
  midi: Midi,
  options: {
    tempoBpm?: number;
    audioDurationSeconds?: number;
    fallbackTempoBpm?: number;
  }
): void {
  const fallbackTempoBpm = clamp(toFiniteNumber(options.fallbackTempoBpm, 120), TEMPO_BPM_MIN, TEMPO_BPM_MAX);
  const resolvedTempoBpm =
    Number.isFinite(options.tempoBpm) && Number(options.tempoBpm) > 0
      ? clamp(Number(options.tempoBpm), TEMPO_BPM_MIN, TEMPO_BPM_MAX)
      : fallbackTempoBpm;

  const normalizedTempoMap = normalizeTempoMap(undefined, resolvedTempoBpm);
  const tempoMapWithEndPoint = appendTempoEndPoint(normalizedTempoMap, Number(options.audioDurationSeconds));
  const tempoEvents = toTempoTickEvents(tempoMapWithEndPoint, Number(midi.header.ppq));

  const header = midi.header as typeof midi.header & {
    tempos?: Array<{ ticks?: number; bpm?: number }>;
    update?: () => void;
  };

  header.tempos = tempoEvents;
  header.update?.();
}

function normalizeTempoMap(rawTempoMap: CoreTempoPoint[] | undefined, fallbackTempoBpm: number): Array<{ timeSeconds: number; bpm: number }> {
  const parsed = Array.isArray(rawTempoMap)
    ? rawTempoMap
        .map((entry) => {
          const rawTime = Number(entry?.timeSeconds ?? entry?.time ?? entry?.seconds);
          const rawBpm = Number(entry?.bpm);
          if (!Number.isFinite(rawTime) || rawTime < 0) return null;
          if (!Number.isFinite(rawBpm) || rawBpm <= 0) return null;
          return {
            timeSeconds: rawTime,
            bpm: clamp(rawBpm, TEMPO_BPM_MIN, TEMPO_BPM_MAX)
          };
        })
        .filter((entry): entry is { timeSeconds: number; bpm: number } => entry !== null)
    : [];

  if (parsed.length === 0) {
    return [{ timeSeconds: 0, bpm: fallbackTempoBpm }];
  }

  parsed.sort((left, right) => left.timeSeconds - right.timeSeconds);

  const deduped: Array<{ timeSeconds: number; bpm: number }> = [];
  for (const point of parsed) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(point.timeSeconds - last.timeSeconds) < 1e-6) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    if (!last || Math.abs(point.bpm - last.bpm) >= 0.05 || point.timeSeconds - last.timeSeconds >= 0.2) {
      deduped.push(point);
    }
  }

  if (deduped.length === 0 || deduped[0].timeSeconds > 1e-6) {
    const firstBpm = deduped.length > 0 ? deduped[0].bpm : fallbackTempoBpm;
    deduped.unshift({ timeSeconds: 0, bpm: firstBpm });
  } else {
    deduped[0].timeSeconds = 0;
  }

  return deduped;
}

function appendTempoEndPoint(
  tempoMap: Array<{ timeSeconds: number; bpm: number }>,
  audioDurationSeconds: number
): Array<{ timeSeconds: number; bpm: number }> {
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds < 0 || tempoMap.length === 0) {
    return tempoMap;
  }

  const out = [...tempoMap];
  const last = out[out.length - 1];
  const safeDuration = Math.max(0, audioDurationSeconds);

  if (safeDuration > last.timeSeconds + 1e-6) {
    out.push({ timeSeconds: safeDuration, bpm: last.bpm });
  } else if (Math.abs(safeDuration - last.timeSeconds) <= 1e-6) {
    out[out.length - 1] = { timeSeconds: safeDuration, bpm: last.bpm };
  }

  return out;
}

function toTempoTickEvents(
  tempoMap: Array<{ timeSeconds: number; bpm: number }>,
  ppq: number
): Array<{ ticks: number; bpm: number }> {
  const safePpq = Math.max(1, Math.round(toFiniteNumber(ppq, 480)));
  if (tempoMap.length === 0) return [{ ticks: 0, bpm: 120 }];

  const events: Array<{ ticks: number; bpm: number }> = [{ ticks: 0, bpm: tempoMap[0].bpm }];
  let elapsedTicks = 0;
  let lastTime = tempoMap[0].timeSeconds;
  let lastBpm = tempoMap[0].bpm;

  for (let index = 1; index < tempoMap.length; index += 1) {
    const point = tempoMap[index];
    const deltaSeconds = Math.max(0, point.timeSeconds - lastTime);
    elapsedTicks += deltaSeconds * ((safePpq * lastBpm) / 60);
    const roundedTick = Math.max(events[events.length - 1].ticks, Math.round(elapsedTicks));

    if (roundedTick === events[events.length - 1].ticks) {
      events[events.length - 1] = { ticks: roundedTick, bpm: point.bpm };
    } else {
      events.push({ ticks: roundedTick, bpm: point.bpm });
    }

    lastTime = point.timeSeconds;
    lastBpm = point.bpm;
  }

  return events;
}

function reportProgress(
  onProgress: ((update: NativeAudioToMidiProgress) => void) | undefined,
  stage: string,
  progress: number
): void {
  if (!onProgress) return;
  onProgress({ stage, progress: clamp01(progress) });
}

function detectUploadSourceType(fileNameOrExt: string): 'audio' | 'midi' | null {
  const ext = getExtension(fileNameOrExt);
  if (ext === '.mid' || ext === '.midi') return 'midi';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

function getExtension(value: string): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  if (raw.startsWith('.')) return raw;
  const fromPath = raw.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  if (fromPath) return `.${fromPath[1]}`;

  if (raw.includes('audio/mpeg') || raw.includes('audio/mp3')) return '.mp3';
  if (raw.includes('audio/wav') || raw.includes('audio/wave') || raw.includes('audio/x-wav')) return '.wav';
  if (raw.includes('audio/ogg') || raw.includes('audio/x-ogg') || raw.includes('audio/opus')) return '.ogg';
  if (raw.includes('audio/midi') || raw.includes('audio/x-midi')) return '.mid';

  return '';
}

function downmixToMono(audioBuffer: DecodedAudioBuffer): Float32Array {
  const channels = Math.max(0, Number(audioBuffer.numberOfChannels) || 0);
  const length = Math.max(0, Number(audioBuffer.length) || 0);
  if (channels <= 0 || length <= 0) {
    throw new Error('Uploaded audio is empty.');
  }

  if (channels === 1) {
    return new Float32Array(audioBuffer.getChannelData(0));
  }

  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }

  return mono;
}

function resampleMonoSignal(samples: Float32Array, sourceSampleRate: number, targetSampleRate = NEURALNOTE_SAMPLE_RATE): Float32Array {
  const inputLength = Math.max(0, Number(samples.length) || 0);
  if (inputLength <= 0) return new Float32Array(0);

  const srcRate = Math.max(1, Math.round(toFiniteNumber(sourceSampleRate, targetSampleRate)));
  const dstRate = Math.max(1, Math.round(toFiniteNumber(targetSampleRate, NEURALNOTE_SAMPLE_RATE)));
  if (srcRate === dstRate) return samples;

  const outputLength = Math.max(1, Math.round((inputLength * dstRate) / srcRate));
  const out = new Float32Array(outputLength);
  const lastSourceIndex = inputLength - 1;

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = (i * srcRate) / dstRate;
    const left = Math.floor(sourcePosition);
    const right = Math.min(lastSourceIndex, left + 1);
    const fraction = sourcePosition - left;
    const leftSample = toFiniteNumber(samples[left], 0);
    const rightSample = toFiniteNumber(samples[right], 0);
    out[i] = leftSample + (rightSample - leftSample) * fraction;
  }

  return out;
}

function analyzeSignalLevels(samples: Float32Array): { peak: number; rms: number } {
  const length = Math.max(0, Number(samples.length) || 0);
  if (length <= 0) return { peak: 0, rms: 0 };

  let peak = 0;
  let sumSquares = 0;

  for (let i = 0; i < length; i += 1) {
    const sample = toFiniteNumber(samples[i], 0);
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumSquares += sample * sample;
  }

  return {
    peak,
    rms: Math.sqrt(sumSquares / length)
  };
}

function normalizeMonoSignal(samples: Float32Array, settings: { targetPeak: number; targetRms: number }): Float32Array {
  const stats = analyzeSignalLevels(samples);
  if (samples.length <= 0 || stats.peak <= 1e-6) return samples;

  const targetPeak = clamp(toFiniteNumber(settings.targetPeak, 0.92), 0.2, 0.99);
  const targetRms = clamp(toFiniteNumber(settings.targetRms, 0.09), 0.01, 0.3);

  let gain = targetPeak / stats.peak;
  if (stats.rms > 1e-6) {
    gain = Math.max(gain, targetRms / stats.rms);
  }

  gain = clamp(gain, 1, 8);
  if (Math.abs(gain - 1) < 1e-4) return samples;

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = clamp(toFiniteNumber(samples[i], 0) * gain, -1, 1);
  }

  return out;
}

function float32ToBytes(value: Float32Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function estimateTempoStageTimeoutMs(audioDurationSeconds: number): number {
  return estimateNativeStageTimeoutMs(audioDurationSeconds, {
    baseMs: 90 * 1000,
    perAudioSecondMs: 350
  });
}

function estimateNeuralStageTimeoutMs(audioDurationSeconds: number): number {
  return estimateNativeStageTimeoutMs(audioDurationSeconds, {
    baseMs: 180 * 1000,
    perAudioSecondMs: 1800
  });
}

function estimateNativeStageTimeoutMs(
  audioDurationSeconds: number,
  options: { baseMs: number; perAudioSecondMs: number }
): number {
  const durationSeconds = Math.max(0, toFiniteNumber(audioDurationSeconds, 0));
  const estimatedMs = options.baseMs + durationSeconds * options.perAudioSecondMs;
  return Math.round(clamp(estimatedMs, NATIVE_STAGE_TIMEOUT_MIN_MS, NATIVE_STAGE_TIMEOUT_MAX_MS));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const safe = Number(value);
  return Number.isFinite(safe) ? safe : fallback;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function debugImportLog(message: string): void {
  if (!IMPORT_DEBUG_LOG_ENABLED) return;
  void appendRealtimeImportDebugLog(message);
}

async function appendRealtimeImportDebugLog(message: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const timestamp = new Date().toISOString();
  const line = `${timestamp} [js] ${message}\n`;
  const directories: Directory[] = [Directory.External, Directory.Data];

  for (const directory of directories) {
    try {
      await Filesystem.mkdir({
        path: IMPORT_DEBUG_DIR_PATH,
        directory,
        recursive: true
      }).catch(() => undefined);

      await Filesystem.appendFile({
        path: IMPORT_DEBUG_LOG_PATH,
        directory,
        data: line,
        encoding: Encoding.UTF8
      });
      return;
    } catch {
      // Try next target directory.
    }
  }
}

async function writeFloat32PcmFileChunked(
  path: string,
  samples: Float32Array,
  options: { runId: string; label: string }
): Promise<void> {
  const bytes = float32ToBytes(samples);
  const totalBytes = bytes.byteLength;
  debugImportLog(
    `${options.label} PCM chunked write started | run=${options.runId} | totalBytes=${totalBytes} | chunkBytes=${PCM_WRITE_CHUNK_BYTES}`
  );

  if (totalBytes <= 0) {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      recursive: true,
      data: ''
    });
    debugImportLog(`${options.label} PCM empty file written | run=${options.runId}`);
    return;
  }

  let offset = 0;
  let chunkIndex = 0;

  const firstEnd = Math.min(totalBytes, PCM_WRITE_CHUNK_BYTES);
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    recursive: true,
    data: bytesToBase64(bytes.subarray(0, firstEnd))
  });
  offset = firstEnd;
  chunkIndex = 1;
  debugImportLog(
    `${options.label} PCM chunk written | run=${options.runId} | chunk=${chunkIndex} | writtenBytes=${offset}/${totalBytes}`
  );

  while (offset < totalBytes) {
    const end = Math.min(totalBytes, offset + PCM_WRITE_CHUNK_BYTES);
    await Filesystem.appendFile({
      path,
      directory: Directory.Data,
      data: bytesToBase64(bytes.subarray(offset, end))
    });
    offset = end;
    chunkIndex += 1;

    if (offset >= totalBytes || chunkIndex % PCM_WRITE_LOG_EVERY_N_CHUNKS === 0) {
      debugImportLog(
        `${options.label} PCM chunk written | run=${options.runId} | chunk=${chunkIndex} | writtenBytes=${offset}/${totalBytes}`
      );
    }
  }

  debugImportLog(
    `${options.label} PCM chunked write completed | run=${options.runId} | chunks=${chunkIndex} | totalBytes=${totalBytes}`
  );
}

function toErrorLine(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? ` | stack=${sanitizeErrorStack(error.stack)}` : '';
    return `${error.message}${stack}`;
  }
  return String(error);
}

function sanitizeErrorStack(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1200);
}
