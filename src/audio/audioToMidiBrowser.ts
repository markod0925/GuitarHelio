import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import decodeAudio from 'audio-decode';
import { Midi } from '@tonejs/midi';

export type AudioToMidiBrowserProgress = {
  stage: string;
  progress: number;
};

type ConversionPreset = {
  noteSegmentationThreshold: number;
  modelConfidenceThreshold: number;
  minNoteLengthMs: number;
  minPitchHz: number;
  maxPitchHz: number;
  midiTempo: number;
  energyTolerance: number;
  melodiaTrick: boolean;
  normalizeInput: boolean;
  useModelAmplitudeVelocity: boolean;
  targetPeak: number;
  targetRms: number;
  velocityBase: number;
  velocityRange: number;
  amplitudeExponent: number;
  volumeBoost: number;
  velocityFloor: number;
};

type DecodedAudioBuffer = {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
};

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg']);
const BASIC_PITCH_MODEL_SAMPLE_RATE = 22050;
const BASIC_PITCH_MODEL_FFT_HOP = 256;
const BASIC_PITCH_ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_MODEL_SAMPLE_RATE / BASIC_PITCH_MODEL_FFT_HOP);
const BASIC_PITCH_MODEL_URL = '/models/basic-pitch/model.json';

const BALANCED_PRESET: ConversionPreset = {
  noteSegmentationThreshold: 0.31,
  modelConfidenceThreshold: 0.355,
  minNoteLengthMs: 24,
  minPitchHz: 1,
  maxPitchHz: 3000,
  midiTempo: 120,
  energyTolerance: 11,
  melodiaTrick: false,
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

let basicPitchPromise: Promise<BasicPitch> | null = null;

export async function convertAudioBufferToMidiBrowser(
  sourceBuffer: ArrayBuffer,
  mimeOrExtension: string,
  onProgress?: (update: AudioToMidiBrowserProgress) => void
): Promise<Uint8Array> {
  if (sourceBuffer.byteLength <= 0) {
    throw new Error('Uploaded audio is empty.');
  }

  const sourceType = detectUploadSourceType(mimeOrExtension);
  if (sourceType && sourceType !== 'audio') {
    throw new Error('Only WAV, MP3, and OGG can be converted to MIDI.');
  }

  reportProgress(onProgress, 'Loading conversion model...', 0.04);
  const basicPitch = await getBasicPitchModel();

  reportProgress(onProgress, 'Decoding audio...', 0.16);
  const decoded = (await decodeAudio(sourceBuffer)) as DecodedAudioBuffer;
  const sourceSampleRate = Math.max(1, Number(decoded.sampleRate) || BASIC_PITCH_MODEL_SAMPLE_RATE);
  const mono = downmixToMono(decoded);
  const resampled = resampleMonoSignal(mono, sourceSampleRate, BASIC_PITCH_MODEL_SAMPLE_RATE);
  const normalized = BALANCED_PRESET.normalizeInput ? normalizeMonoSignal(resampled, BALANCED_PRESET) : resampled;

  reportProgress(onProgress, 'Analyzing notes...', 0.58);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await basicPitch.evaluateModel(
    normalized,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (percent) => {
      const safePercent = clamp01(toFiniteNumber(percent, 0));
      reportProgress(onProgress, 'Analyzing notes...', 0.58 + safePercent * 0.32);
    }
  );

  reportProgress(onProgress, 'Building MIDI events...', 0.92);
  const minNoteLengthFrames = noteLengthMsToFrames(BALANCED_PRESET.minNoteLengthMs);
  const maxFreq = Number.isFinite(BALANCED_PRESET.maxPitchHz) ? Math.max(0, BALANCED_PRESET.maxPitchHz) : null;
  const minFreq = Number.isFinite(BALANCED_PRESET.minPitchHz) && BALANCED_PRESET.minPitchHz > 0 ? BALANCED_PRESET.minPitchHz : null;

  const rawNotes = outputToNotesPoly(
    frames,
    onsets,
    BALANCED_PRESET.modelConfidenceThreshold,
    BALANCED_PRESET.noteSegmentationThreshold,
    minNoteLengthFrames,
    true,
    maxFreq,
    minFreq,
    BALANCED_PRESET.melodiaTrick,
    Math.max(1, Math.floor(toFiniteNumber(BALANCED_PRESET.energyTolerance, 11)))
  );

  const noteEvents = noteFramesToTime(addPitchBendsToNoteEvents(contours, rawNotes));
  if (!Array.isArray(noteEvents) || noteEvents.length === 0) {
    throw new Error('No notes detected in uploaded audio.');
  }

  const midi = new Midi();
  midi.header.setTempo(clamp(toFiniteNumber(BALANCED_PRESET.midiTempo, 120), 20, 300));
  const track = midi.addTrack();

  for (const event of noteEvents) {
    const eventData = event as {
      pitchMidi?: number;
      pitch_midi?: number;
      startTimeSeconds?: number;
      durationSeconds?: number;
      amplitude?: number;
    };

    const pitch = clamp(Math.round(toFiniteNumber(eventData.pitchMidi ?? eventData.pitch_midi, 0)), 0, 127);
    const time = Math.max(0, toFiniteNumber(eventData.startTimeSeconds, 0));
    const duration = Math.max(0.02, toFiniteNumber(eventData.durationSeconds, 0.02));
    const amplitude = clamp(toFiniteNumber(eventData.amplitude, 0.4), 0, 1);

    if (BALANCED_PRESET.useModelAmplitudeVelocity) {
      const velocity = clamp(amplitude, 0.01, 1);
      track.addNote({ midi: pitch, time, duration, velocity });
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
  reportProgress(onProgress, 'Conversion complete.', 1);
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function detectUploadSourceType(fileNameOrExt: string): 'audio' | 'midi' | null {
  const ext = getExtension(fileNameOrExt);
  if (ext === '.mid' || ext === '.midi') return 'midi';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

async function getBasicPitchModel(): Promise<BasicPitch> {
  if (!basicPitchPromise) {
    basicPitchPromise = Promise.resolve(new BasicPitch(BASIC_PITCH_MODEL_URL));
  }
  return basicPitchPromise;
}

function reportProgress(
  onProgress: ((update: AudioToMidiBrowserProgress) => void) | undefined,
  stage: string,
  progress: number
): void {
  if (!onProgress) return;
  onProgress({ stage, progress: clamp01(progress) });
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

function resampleMonoSignal(samples: Float32Array, sourceSampleRate: number, targetSampleRate = BASIC_PITCH_MODEL_SAMPLE_RATE): Float32Array {
  const inputLength = Math.max(0, Number(samples.length) || 0);
  if (inputLength <= 0) return new Float32Array(0);

  const srcRate = Math.max(1, Math.round(toFiniteNumber(sourceSampleRate, targetSampleRate)));
  const dstRate = Math.max(1, Math.round(toFiniteNumber(targetSampleRate, BASIC_PITCH_MODEL_SAMPLE_RATE)));
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

function normalizeMonoSignal(samples: Float32Array, settings: ConversionPreset): Float32Array {
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

function noteLengthMsToFrames(minNoteLengthMs: number): number {
  const safeMs = Math.max(0, toFiniteNumber(minNoteLengthMs, 11));
  const frames = Math.round((safeMs / 1000) * BASIC_PITCH_ANNOTATIONS_FPS);
  return Math.max(1, frames);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const safe = Number(value);
  return Number.isFinite(safe) ? safe : fallback;
}
