import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const MIDI_EXTENSIONS = new Set(['.mid', '.midi']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg']);
const BASIC_PITCH_MODEL_SAMPLE_RATE = 22050;
const BASIC_PITCH_MODEL_FFT_HOP = 256;
const BASIC_PITCH_ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_MODEL_SAMPLE_RATE / BASIC_PITCH_MODEL_FFT_HOP);
const AUDIO_CONVERSION_PRESETS = {
  accurate: {
    noteSegmentationThreshold: 0.55,
    modelConfidenceThreshold: 0.34,
    minNoteLengthMs: 28,
    minPitchHz: 55,
    maxPitchHz: 3000,
    midiTempo: 120,
    energyTolerance: 9,
    melodiaTrick: true,
    normalizeInput: false,
    useModelAmplitudeVelocity: true,
    targetPeak: 0.88,
    targetRms: 0.08,
    velocityBase: 0.48,
    velocityRange: 0.52,
    amplitudeExponent: 0.52,
    volumeBoost: 1.5,
    velocityFloor: 0.52
  },
  balanced: {
    // Tuned to closely match the project reference transcription.
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
  },
  dense: {
    noteSegmentationThreshold: 0.42,
    modelConfidenceThreshold: 0.2,
    minNoteLengthMs: 8,
    minPitchHz: 0,
    maxPitchHz: 3000,
    midiTempo: 120,
    energyTolerance: 13,
    melodiaTrick: true,
    normalizeInput: true,
    useModelAmplitudeVelocity: false,
    targetPeak: 0.95,
    targetRms: 0.1,
    velocityBase: 0.52,
    velocityRange: 0.48,
    amplitudeExponent: 0.36,
    volumeBoost: 1.55,
    velocityFloor: 0.62
  }
};

function normalizeText(value) {
  return String(value || '').trim();
}

function getExtension(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('.')) return raw;
  const fromPath = path.extname(raw);
  if (fromPath) return fromPath;
  if (raw.includes('audio/mpeg') || raw.includes('audio/mp3')) return '.mp3';
  if (raw.includes('audio/wav') || raw.includes('audio/wave') || raw.includes('audio/x-wav')) return '.wav';
  if (raw.includes('audio/ogg') || raw.includes('audio/x-ogg')) return '.ogg';
  if (raw.includes('audio/midi') || raw.includes('audio/x-midi')) return '.mid';
  return '';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeConversionPreset(value) {
  const preset = String(value || '').trim().toLowerCase();
  if (preset === 'dense' || preset === 'accurate') return preset;
  return 'balanced';
}

function noteLengthMsToFrames(minNoteLengthMs) {
  const safeMs = Math.max(0, toFiniteNumber(minNoteLengthMs, 11));
  const frames = Math.round((safeMs / 1000) * BASIC_PITCH_ANNOTATIONS_FPS);
  return Math.max(1, frames);
}

function toFiniteNumber(value, fallback = 0) {
  const safe = Number(value);
  return Number.isFinite(safe) ? safe : fallback;
}

function safeProgressHandler(options) {
  return typeof options?.onProgress === 'function' ? options.onProgress : null;
}

function reportProgress(options, stage, progress) {
  const handler = safeProgressHandler(options);
  if (!handler) return;
  handler({
    stage: String(stage || '').trim() || 'Working...',
    progress: clamp(toFiniteNumber(progress, 0), 0, 1)
  });
}

function downmixToMono(audioBuffer) {
  const channels = Math.max(0, Number(audioBuffer?.numberOfChannels) || 0);
  const length = Math.max(0, Number(audioBuffer?.length) || 0);
  if (channels <= 0 || length <= 0) throw new Error('Uploaded audio is empty.');

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

function resampleMonoSignal(samples, sourceSampleRate, targetSampleRate = BASIC_PITCH_MODEL_SAMPLE_RATE) {
  const inputLength = Math.max(0, Number(samples?.length) || 0);
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
    const frac = sourcePosition - left;
    const leftSample = toFiniteNumber(samples[left], 0);
    const rightSample = toFiniteNumber(samples[right], 0);
    out[i] = leftSample + (rightSample - leftSample) * frac;
  }

  return out;
}

function analyzeSignalLevels(samples) {
  const length = Math.max(0, Number(samples?.length) || 0);
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

function normalizeMonoSignal(samples, settings, stats = analyzeSignalLevels(samples)) {
  const length = Math.max(0, Number(samples?.length) || 0);
  if (length <= 0) return samples;
  if (stats.peak <= 1e-6) return samples;

  const targetPeak = clamp(toFiniteNumber(settings?.targetPeak, 0.92), 0.2, 0.99);
  const targetRms = clamp(toFiniteNumber(settings?.targetRms, 0.09), 0.01, 0.3);
  const maxGain = 8;
  let gain = targetPeak / stats.peak;
  if (stats.rms > 1e-6) {
    gain = Math.max(gain, targetRms / stats.rms);
  }
  gain = clamp(gain, 1, maxGain);
  if (Math.abs(gain - 1) < 1e-4) return samples;

  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = clamp(toFiniteNumber(samples[i], 0) * gain, -1, 1);
  }
  return out;
}

function normalizeModuleExports(moduleValue) {
  if (!moduleValue || typeof moduleValue !== 'object') return moduleValue;
  if (moduleValue.default && typeof moduleValue.default === 'object') return moduleValue.default;
  return moduleValue;
}

function ensureTfjsNodeUtilCompatibility(require) {
  const util = require('util');
  if (typeof util.isNullOrUndefined !== 'function') {
    util.isNullOrUndefined = (value) => value === null || value === undefined;
  }
}

function createModelPathResolver(modelDirectory, modelDirectoryLabel) {
  const modelDir = path.resolve(modelDirectory);
  const modelJsonPath = path.join(modelDir, 'model.json');

  function resolveWeightPath(weightPath) {
    const safeWeightPath = String(weightPath || '').trim().replace(/\\/g, '/');
    if (!safeWeightPath || safeWeightPath.includes('..')) {
      throw new Error('Basic Pitch model has an invalid weight path.');
    }
    const resolved = path.resolve(modelDir, safeWeightPath);
    const modelPrefix = `${modelDir}${path.sep}`;
    if (resolved !== modelDir && !resolved.startsWith(modelPrefix)) {
      throw new Error('Basic Pitch model has an invalid weight path.');
    }
    return resolved;
  }

  async function readValidatedMetadata() {
    let modelJsonRaw;
    try {
      modelJsonRaw = await fs.readFile(modelJsonPath, 'utf8');
    } catch {
      throw new Error(
        `Basic Pitch model is missing in ${modelDirectoryLabel}. Expected ${path.join(modelDirectoryLabel, 'model.json')}.`
      );
    }

    let modelJson;
    try {
      modelJson = JSON.parse(modelJsonRaw);
    } catch {
      throw new Error('Basic Pitch model metadata is invalid JSON.');
    }

    const manifest = Array.isArray(modelJson?.weightsManifest) ? modelJson.weightsManifest : [];
    const weightSpecs = manifest.flatMap((entry) => (Array.isArray(entry?.weights) ? entry.weights : []));
    const weightPaths = manifest.flatMap((entry) => (Array.isArray(entry?.paths) ? entry.paths : []));

    if (weightSpecs.length === 0 || weightPaths.length === 0) {
      throw new Error('Basic Pitch model weights are missing from model metadata.');
    }

    await Promise.all(
      weightPaths.map(async (weightPath) => {
        const resolved = resolveWeightPath(weightPath);
        try {
          await fs.access(resolved);
        } catch {
          throw new Error(`Basic Pitch weight file is missing: ${path.relative(process.cwd(), resolved)}`);
        }
      })
    );

    return { modelDir, modelDirectoryLabel, modelJson, weightSpecs, weightPaths, resolveWeightPath };
  }

  return {
    modelDir,
    modelDirectoryLabel,
    readValidatedMetadata
  };
}

export function createAudioToMidiConverter(config = {}) {
  const {
    modelDir,
    modelDirLabel = String(config.modelDir || ''),
    fallbackMidiBaseName = 'upload'
  } = config;

  if (!modelDir) {
    throw new Error('createAudioToMidiConverter requires a modelDir.');
  }

  const require = createRequire(import.meta.url);
  const modelPaths = createModelPathResolver(modelDir, modelDirLabel || path.resolve(modelDir));

  let modelPromise = null;
  let metadataPromise = null;
  let tensorflowRuntimePromise = null;

  function sanitizeMidiBaseName(baseName, fallback = fallbackMidiBaseName) {
    const safe = normalizeText(baseName)
      .replace(/\.[^/.]+$/g, '')
      .replace(/[^\w.-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^\.+/, '')
      .replace(/^_+/, '')
      .replace(/[._-]+$/, '');
    return safe || fallback;
  }

  async function loadModelMetadata() {
    if (metadataPromise) return metadataPromise;
    metadataPromise = modelPaths.readValidatedMetadata().catch((err) => {
      metadataPromise = null;
      throw err;
    });
    return metadataPromise;
  }

  async function loadTensorflowRuntime(options = {}) {
    if (tensorflowRuntimePromise) return tensorflowRuntimePromise;

    tensorflowRuntimePromise = (async () => {
      reportProgress(options, 'Initializing TensorFlow runtime...', 0.06);
      try {
        ensureTfjsNodeUtilCompatibility(require);
        const tfNodeModule = normalizeModuleExports(await import('@tensorflow/tfjs-node'));
        const tfNode = tfNodeModule;
        if (typeof tfNode?.loadGraphModel !== 'function' || typeof tfNode?.io?.fromMemory !== 'function') {
          throw new Error('Invalid TensorFlow Node runtime.');
        }
        await tfNode.ready?.();
        reportProgress(options, 'TensorFlow Node backend ready.', 0.08);
        return tfNode;
      } catch {
        const tfModule = normalizeModuleExports(await import('@tensorflow/tfjs'));
        const tf = tfModule;
        if (typeof tf?.loadGraphModel !== 'function' || typeof tf?.io?.fromMemory !== 'function') {
          throw new Error('TensorFlow runtime is not available.');
        }
        await tf.ready?.();
        reportProgress(options, 'TensorFlow JS backend ready (slower).', 0.08);
        return tf;
      }
    })().catch((err) => {
      tensorflowRuntimePromise = null;
      throw err;
    });

    return tensorflowRuntimePromise;
  }

  async function loadBasicPitchGraphModel(tf, options = {}) {
    if (modelPromise) return modelPromise;

    modelPromise = (async () => {
      reportProgress(options, 'Reading model metadata...', 0.1);
      const { modelJson, weightSpecs, weightPaths, resolveWeightPath } = await loadModelMetadata();

      const weightBuffers = [];
      const totalWeightFiles = Math.max(1, weightPaths.length);
      reportProgress(options, 'Loading model weights...', 0.14);
      for (let idx = 0; idx < weightPaths.length; idx += 1) {
        const weightPath = weightPaths[idx];
        weightBuffers.push(await fs.readFile(resolveWeightPath(weightPath)));
        const ratio = (idx + 1) / totalWeightFiles;
        reportProgress(options, `Loading model weights (${idx + 1}/${totalWeightFiles})...`, 0.14 + ratio * 0.22);
      }
      const merged = Buffer.concat(weightBuffers);
      const weightData = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
      const ioHandler = tf.io.fromMemory({
        modelTopology: modelJson.modelTopology,
        format: modelJson.format,
        generatedBy: modelJson.generatedBy,
        convertedBy: modelJson.convertedBy,
        weightSpecs,
        weightData
      });
      reportProgress(options, 'Building TensorFlow graph...', 0.38);
      const graph = await tf.loadGraphModel(ioHandler);
      reportProgress(options, 'Model loaded. Decoding audio...', 0.46);
      return graph;
    })().catch((err) => {
      modelPromise = null;
      throw err;
    });

    return modelPromise;
  }

  function detectUploadSourceType(fileNameOrExt) {
    const ext = getExtension(fileNameOrExt);
    if (MIDI_EXTENSIONS.has(ext)) return 'midi';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    return null;
  }

  function buildUniqueMidiFileName(baseName, existingNamesSet = new Set()) {
    const existing = new Set(
      Array.from(existingNamesSet || [])
        .map((entry) => normalizeText(entry).toLowerCase())
        .filter(Boolean)
    );

    const safeBase = sanitizeMidiBaseName(baseName);
    let candidate = `${safeBase}.mid`;
    if (!existing.has(candidate.toLowerCase())) return candidate;

    let index = 1;
    while (true) {
      candidate = `${safeBase}_${index}.mid`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
      index += 1;
    }
  }

  async function assertModelReady() {
    const metadata = await loadModelMetadata();
    return {
      modelDir: metadata.modelDir,
      relativeModelDir: metadata.modelDirectoryLabel
    };
  }

  async function convertAudioBufferToMidiBuffer(inputBuffer, mimeOrExt = '', options = {}) {
    if (!inputBuffer || Number(inputBuffer.length || inputBuffer.byteLength || 0) <= 0) {
      throw new Error('Uploaded audio is empty.');
    }

    const sourceType = detectUploadSourceType(mimeOrExt);
    if (sourceType && sourceType !== 'audio') {
      throw new Error('Only WAV, MP3, and OGG can be converted to MIDI.');
    }

    const conversionPreset = normalizeConversionPreset(options?.conversionPreset);
    const presetSettings = AUDIO_CONVERSION_PRESETS[conversionPreset];
    const minNoteLengthFrames = noteLengthMsToFrames(presetSettings.minNoteLengthMs);
    const maxFreq = Number.isFinite(Number(presetSettings.maxPitchHz))
      ? Math.max(0, Number(presetSettings.maxPitchHz))
      : null;
    const minPitchHz = Number(presetSettings.minPitchHz);
    const minFreq = Number.isFinite(minPitchHz) && minPitchHz > 0 ? minPitchHz : null;

    reportProgress(options, 'Loading conversion model...', 0.04);
    const [{ default: decodeAudio }, basicPitchModule, toneMidiModule] = await Promise.all([
      import('audio-decode'),
      import('@spotify/basic-pitch'),
      import('@tonejs/midi')
    ]);

    const tf = await loadTensorflowRuntime(options);
    const { BasicPitch, outputToNotesPoly, noteFramesToTime, addPitchBendsToNoteEvents } = basicPitchModule;
    const toneMidiExports =
      toneMidiModule?.default && typeof toneMidiModule.default === 'object' ? toneMidiModule.default : toneMidiModule;
    const Midi = toneMidiExports?.Midi;

    if (typeof BasicPitch !== 'function' || typeof Midi !== 'function') {
      throw new Error('MIDI conversion dependencies are not available.');
    }

    reportProgress(options, 'Initializing conversion runtime...', 0.08);
    const graphModel = await loadBasicPitchGraphModel(tf, options);
    const basicPitch = new BasicPitch(Promise.resolve(graphModel));
    const audioBuffer = await decodeAudio(Buffer.from(inputBuffer));
    const sourceSampleRate = Math.max(1, Number(audioBuffer?.sampleRate) || BASIC_PITCH_MODEL_SAMPLE_RATE);
    const monoAudio = downmixToMono(audioBuffer);
    const resampledMonoAudio = resampleMonoSignal(monoAudio, sourceSampleRate, BASIC_PITCH_MODEL_SAMPLE_RATE);
    const normalizedMonoAudio = presetSettings.normalizeInput
      ? normalizeMonoSignal(resampledMonoAudio, presetSettings)
      : resampledMonoAudio;
    reportProgress(options, 'Audio decoded. Analyzing notes...', 0.58);

    const frames = [];
    const onsets = [];
    const contours = [];

    await basicPitch.evaluateModel(
      normalizedMonoAudio,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (percent) => {
        const safe = clamp(toFiniteNumber(percent, 0), 0, 1);
        reportProgress(options, 'Analyzing notes...', 0.58 + safe * 0.32);
      }
    );

    reportProgress(options, 'Building MIDI events...', 0.92);
    const rawNotes = outputToNotesPoly(
      frames,
      onsets,
      presetSettings.modelConfidenceThreshold,
      presetSettings.noteSegmentationThreshold,
      minNoteLengthFrames,
      true,
      maxFreq,
      minFreq,
      presetSettings.melodiaTrick !== false,
      Math.max(1, Math.floor(toFiniteNumber(presetSettings.energyTolerance, 11)))
    );
    const noteEvents = noteFramesToTime(addPitchBendsToNoteEvents(contours, rawNotes));

    if (!Array.isArray(noteEvents) || noteEvents.length === 0) {
      throw new Error('No notes detected in uploaded audio.');
    }

    const midi = new Midi();
    midi.header.setTempo(clamp(toFiniteNumber(presetSettings.midiTempo, 120), 20, 300));
    const track = midi.addTrack();

    for (const note of noteEvents) {
      const pitch = clamp(Math.round(Number(note.pitchMidi) || 0), 0, 127);
      const time = Math.max(0, Number(note.startTimeSeconds) || 0);
      const duration = Math.max(0.02, Number(note.durationSeconds) || 0.02);
      const amplitude = clamp(toFiniteNumber(note.amplitude, 0.4), 0, 1);
      if (presetSettings.useModelAmplitudeVelocity) {
        const velocity = clamp(amplitude, 0.01, 1);
        track.addNote({ midi: pitch, time, duration, velocity });
        continue;
      }
      const liftedAmplitude = Math.pow(amplitude, presetSettings.amplitudeExponent);
      const baseVelocity = presetSettings.velocityBase + liftedAmplitude * presetSettings.velocityRange;
      const boostedVelocity = baseVelocity * presetSettings.volumeBoost;
      const velocity = clamp(boostedVelocity, presetSettings.velocityFloor, 1);
      track.addNote({ midi: pitch, time, duration, velocity });
    }

    reportProgress(options, 'Finalizing MIDI file...', 0.98);
    const midiBytes = midi.toArray();
    reportProgress(options, 'Conversion complete.', 1);
    return Buffer.from(midiBytes.buffer, midiBytes.byteOffset, midiBytes.byteLength);
  }

  async function convertUploadToMidi(upload, existingNamesSet = new Set(), options = {}) {
    const fileName = normalizeText(upload?.fileName);
    const mimeType = normalizeText(upload?.mimeType).toLowerCase();
    const buffer = upload?.buffer;

    if (!fileName) {
      const err = new Error('Uploaded file name is missing');
      err.statusCode = 400;
      throw err;
    }

    if (!buffer || Number(buffer.length || buffer.byteLength || 0) <= 0) {
      const err = new Error('Uploaded file is empty');
      err.statusCode = 400;
      throw err;
    }

    const sourceType = detectUploadSourceType(fileName) || detectUploadSourceType(mimeType);
    if (!sourceType) {
      const err = new Error('Unsupported file type. Use MID, MIDI, WAV, MP3, or OGG.');
      err.statusCode = 400;
      throw err;
    }

    const midiFileName = buildUniqueMidiFileName(fileName, existingNamesSet);
    let midiBuffer;
    let converted = false;

    if (sourceType === 'audio') {
      reportProgress(options, 'Preparing audio conversion...', 0.02);
      midiBuffer = await convertAudioBufferToMidiBuffer(buffer, fileName || mimeType, options);
      converted = true;
    } else {
      reportProgress(options, 'Preparing MIDI file...', 0.55);
      midiBuffer = Buffer.from(buffer);
      reportProgress(options, 'MIDI file ready.', 1);
    }

    return {
      midiFileName,
      sourceType,
      converted,
      midiBuffer
    };
  }

  return {
    assertModelReady,
    detectUploadSourceType,
    buildUniqueMidiFileName,
    convertAudioBufferToMidiBuffer,
    convertUploadToMidi
  };
}
