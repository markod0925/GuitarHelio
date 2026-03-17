import initDspCore, { DspMode, GhDspCore, PitchDetectorPreset } from './dsp-core/gh_dsp_core.js';

const DETECTOR_PRESETS = {
  baseline: {
    windowSeconds: 2048 / 48000,
    chunkSeconds: 1024 / 48000,
    minFrequencyHz: 65,
    maxFrequencyHz: 1200,
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  },
  ac14: {
    windowSeconds: 0.08534542062883915,
    chunkSeconds: 0.03524227822491771,
    minFrequencyHz: 55,
    maxFrequencyHz: 1200,
    energyThreshold: 0.003074202393734413,
    correlationThreshold: 0.6559736283225794,
    decayGraceFrames: 4,
    decayEnergyFactor: 0.4157769062463687,
    decayCorrelationThreshold: 0.6288579679610562
  },
  spectral_game_runtime_unified_v3: {
    windowSeconds: 0.0464399093,
    chunkSeconds: 0.0116099773,
    minFrequencyHz: 75,
    maxFrequencyHz: 3600,
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  }
};

const DEFAULT_DETECTOR_PRESET = 'baseline';
const MAX_DELAY_SAMPLES = 720;
const NLMS_TAPS = 64;
const NLMS_MU = 0.08;
const NLMS_EPS = 1e-6;

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.detectorPreset = normalizeDetectorPreset(options?.processorOptions?.detectorPreset);
    this.detectorConfig = getDetectorPresetConfig(this.detectorPreset);
    this.configureAnalysisWindow(this.detectorConfig);
    this.resetAnalysisState();
    this.audioInputMode = 'speaker';
    this.spectralModel = sanitizeSpectralModel(options?.processorOptions?.spectralModel);
    this.dspWasmBytes = options?.processorOptions?.dspWasmBytes ?? null;
    this.dspCore = null;
    this.legacyFallback = false;
    this.backendStatus = null;
    this.port.onmessage = (event) => this.handleControlMessage(event.data);
    void this.initializeDspCore();
  }

  async initializeDspCore() {
    try {
      const moduleOrPath = this.dspWasmBytes ?? './dsp-core/gh_dsp_core_bg.wasm';
      await initDspCore({ module_or_path: moduleOrPath });
      const core = new GhDspCore();
      core.prepare(sampleRate, this.bufferSize, this.resolveDspMode(this.audioInputMode));
      core.set_pitch_detector_preset(this.resolvePitchPreset(this.detectorPreset));
      this.applySpectralModel(core, this.spectralModel);
      this.dspCore = core;
      this.legacyFallback = false;
      this.publishBackendStatus(false);
    } catch (error) {
      this.dspCore = null;
      this.legacyFallback = true;
      this.publishBackendStatus(true, toErrorMessage(error));
    }
  }

  handleControlMessage(payload) {
    if (!payload || payload.type !== 'config') return;
    if (payload.audioInputMode !== 'speaker' && payload.audioInputMode !== 'headphones') return;
    this.audioInputMode = payload.audioInputMode;
    this.spectralModel = sanitizeSpectralModel(payload.spectralModel);
    const nextPreset = normalizeDetectorPreset(payload.detectorPreset);
    if (nextPreset !== this.detectorPreset) {
      this.detectorPreset = nextPreset;
      this.detectorConfig = getDetectorPresetConfig(this.detectorPreset);
      this.configureAnalysisWindow(this.detectorConfig);
      this.resetAnalysisState();
    }
    if (!this.dspCore) return;
    this.dspCore.prepare(sampleRate, this.bufferSize, this.resolveDspMode(this.audioInputMode));
    this.dspCore.set_pitch_detector_preset(this.resolvePitchPreset(this.detectorPreset));
    this.applySpectralModel(this.dspCore, this.spectralModel);
    this.dspCore.reset();
  }

  resolveDspMode(audioInputMode) {
    return audioInputMode === 'headphones' ? DspMode.Headphones : DspMode.Speaker;
  }

  resolvePitchPreset(detectorPreset) {
    if (detectorPreset === 'ac14') {
      return PitchDetectorPreset.Ac14;
    }
    if (detectorPreset === 'spectral_game_runtime_unified_v3') {
      return PitchDetectorPreset.SpectralGameRuntimeUnifiedV3;
    }
    return PitchDetectorPreset.Baseline;
  }

  applySpectralModel(core, model) {
    if (!core || !model || this.detectorPreset !== 'spectral_game_runtime_unified_v3') return;
    try {
      core.set_spectral_model(JSON.stringify(model));
    } catch (error) {
      this.publishBackendStatus(true, toErrorMessage(error));
      throw error;
    }
  }

  configureAnalysisWindow(detectorConfig) {
    const windowSamples = Math.floor(detectorConfig.windowSeconds * sampleRate);
    const hopSamples = Math.floor(detectorConfig.chunkSeconds * sampleRate);
    this.bufferSize = clampInteger(windowSamples, 512, 8192);
    this.hopSize = clampInteger(hopSamples, 128, this.bufferSize);
    this.minLag = Math.max(1, Math.floor(sampleRate / detectorConfig.maxFrequencyHz));
    this.maxLag = Math.max(this.minLag + 1, Math.floor(sampleRate / detectorConfig.minFrequencyHz));
  }

  resetAnalysisState() {
    this.micRing = new Float32Array(this.bufferSize);
    this.referenceRing = new Float32Array(this.bufferSize);
    this.micFrame = new Float32Array(this.bufferSize);
    this.referenceFrame = new Float32Array(this.bufferSize);
    this.alignedReferenceFrame = new Float32Array(this.bufferSize);
    this.residualFrame = new Float32Array(this.bufferSize);
    this.nlmsWeights = new Float32Array(NLMS_TAPS);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastAnalysis = 0;
    this.prevMicRms = 0;
    this.decayGraceFramesRemaining = 0;
  }

  publishBackendStatus(legacyFallback, reason) {
    if (this.backendStatus === legacyFallback) return;
    this.backendStatus = legacyFallback;
    this.port.postMessage({
      type: 'status',
      legacy_fallback: legacyFallback,
      reason
    });
  }

  process(inputs) {
    const micChannel = inputs[0]?.[0];
    if (!micChannel) return true;
    const referenceChannel = inputs[0]?.[1];

    for (let i = 0; i < micChannel.length; i += 1) {
      this.micRing[this.writeIndex] = micChannel[i];
      this.referenceRing[this.writeIndex] = referenceChannel ? referenceChannel[i] : 0;
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      this.totalSamples += 1;
      this.samplesSinceLastAnalysis += 1;
    }

    if (this.totalSamples < this.bufferSize || this.samplesSinceLastAnalysis < this.hopSize) {
      return true;
    }
    this.samplesSinceLastAnalysis = 0;

    this.copyRingToFrame(this.micRing, this.micFrame);
    this.copyRingToFrame(this.referenceRing, this.referenceFrame);

    let suppression;
    try {
      suppression =
        this.dspCore && !this.legacyFallback
          ? processEchoSuppressionWithCore(
              this.dspCore,
              this.micFrame,
              this.referenceFrame,
              this.alignedReferenceFrame,
              this.residualFrame,
              this.prevMicRms,
              this.detectorPreset
            )
          : processEchoSuppression(
              this.micFrame,
              this.referenceFrame,
              this.alignedReferenceFrame,
              this.residualFrame,
              this.nlmsWeights,
              this.prevMicRms
            );
    } catch (error) {
      this.dspCore = null;
      this.legacyFallback = true;
      this.publishBackendStatus(true, toErrorMessage(error));
      suppression = processEchoSuppression(
        this.micFrame,
        this.referenceFrame,
        this.alignedReferenceFrame,
        this.residualFrame,
        this.nlmsWeights,
        this.prevMicRms
      );
    }
    this.prevMicRms = suppression.micRms;

    if (this.detectorPreset === 'ac14' && suppression.referencePolicyApplied) {
      this.decayGraceFramesRemaining = 0;
      const midiEstimate = sanitizeMidiEstimate(suppression.midiEstimate);
      const referenceMidi = sanitizeMidiEstimate(suppression.referenceMidi);
      this.port.postMessage({
        type: 'frame',
        t_seconds: currentTime,
        midi_estimate: midiEstimate,
        confidence: midiEstimate === null ? 0 : clamp01(suppression.confidence),
        mic_rms: suppression.micRms,
        reference_midi: referenceMidi,
        reference_correlation: suppression.referenceCorrelation,
        energy_ratio_db: suppression.energyRatioDb,
        onset_strength: suppression.onsetStrength,
        contamination_score: suppression.contaminationScore,
        rejected_as_reference_bleed: Boolean(suppression.rejectedAsReferenceBleed),
        reference_policy_applied: true,
        delay_samples: suppression.delaySamples
      });
      return true;
    }

    if (this.detectorPreset === 'spectral_game_runtime_unified_v3') {
      this.decayGraceFramesRemaining = 0;
      const midiEstimate = sanitizeMidiEstimate(suppression.midiEstimate);
      const referenceMidi = sanitizeMidiEstimate(suppression.referenceMidi);
      this.port.postMessage({
        type: 'frame',
        t_seconds: currentTime,
        midi_estimate: midiEstimate,
        confidence: midiEstimate === null ? 0 : clamp01(suppression.confidence),
        mic_rms: suppression.micRms,
        reference_midi: referenceMidi,
        reference_correlation: suppression.referenceCorrelation,
        energy_ratio_db: suppression.energyRatioDb,
        onset_strength: suppression.onsetStrength,
        contamination_score: suppression.contaminationScore,
        rejected_as_reference_bleed: Boolean(suppression.rejectedAsReferenceBleed),
        reference_policy_applied: Boolean(suppression.referencePolicyApplied),
        selected_notes: suppression.selectedNotes,
        chord_scores: suppression.chordScores,
        detected_string: suppression.detectedString,
        detected_fret: suppression.detectedFret,
        best_note_id: suppression.bestNoteId,
        delay_samples: suppression.delaySamples
      });
      return true;
    }

    const hasRustPitch = Number.isFinite(suppression.pitchHz) && suppression.pitchHz > 0;
    let residualPitchHz = hasRustPitch ? suppression.pitchHz : 0;
    let residualPitchConfidence = hasRustPitch ? suppression.pitchConfidence : 0;
    if (!hasRustPitch) {
      const decayActive = this.decayGraceFramesRemaining > 0;
      const fallbackPitch = detectPitch(this.residualFrame, sampleRate, this.minLag, this.maxLag, {
        energyThreshold: decayActive
          ? this.detectorConfig.energyThreshold * this.detectorConfig.decayEnergyFactor
          : this.detectorConfig.energyThreshold,
        correlationThreshold: decayActive
          ? this.detectorConfig.decayCorrelationThreshold
          : this.detectorConfig.correlationThreshold
      });
      residualPitchHz = fallbackPitch.frequencyHz;
      residualPitchConfidence = fallbackPitch.confidence;
      if (fallbackPitch.frequencyHz > 0) {
        this.decayGraceFramesRemaining = this.detectorConfig.decayGraceFrames;
      } else if (this.decayGraceFramesRemaining > 0) {
        this.decayGraceFramesRemaining -= 1;
      }
    } else {
      this.decayGraceFramesRemaining = 0;
    }

    const referencePitch = detectPitch(this.alignedReferenceFrame, sampleRate, this.minLag, this.maxLag, {
      energyThreshold: this.detectorConfig.energyThreshold,
      correlationThreshold: this.detectorConfig.correlationThreshold
    });
    const residualMidiEstimate = residualPitchHz > 0 ? 69 + 12 * Math.log2(residualPitchHz / 440) : null;
    const referenceMidiEstimate = referencePitch.frequencyHz > 0 ? 69 + 12 * Math.log2(referencePitch.frequencyHz / 440) : null;

    this.port.postMessage({
      type: 'frame',
      t_seconds: currentTime,
      midi_estimate: residualMidiEstimate,
      confidence: residualMidiEstimate === null ? 0 : clamp01(residualPitchConfidence),
      mic_rms: suppression.micRms,
      reference_midi: referenceMidiEstimate,
      reference_correlation: suppression.referenceCorrelation,
      energy_ratio_db: suppression.energyRatioDb,
      onset_strength: suppression.onsetStrength,
      contamination_score: suppression.contaminationScore,
      delay_samples: suppression.delaySamples
    });
    return true;
  }

  copyRingToFrame(ring, frame) {
    for (let i = 0; i < this.bufferSize; i += 1) {
      const idx = (this.writeIndex + i) % this.bufferSize;
      frame[i] = ring[idx];
    }
  }
}

registerProcessor('gh-pitch-processor', PitchProcessor);

function processEchoSuppressionWithCore(
  dspCore,
  mic,
  reference,
  alignedReference,
  residual,
  previousMicRms,
  detectorPreset
) {
  dspCore.set_reference_block(reference);
  const output = dspCore.process_block(mic) ?? {};

  const delaySamples = sanitizeDelay(output.delay_samples);
  const referenceCorrelation = clampSigned(output.reference_correlation);
  const energyRatioDb = sanitizeNumber(output.energy_ratio_db);
  const onsetStrength = sanitizeNumber(output.onset_strength);
  const contaminationScore = sanitizeNumber(output.contamination_score);
  const midiEstimate = sanitizeNumber(output.midi_estimate);
  const confidence = clamp01(output.confidence);
  const referenceMidi = sanitizeNumber(output.reference_midi);
  const pitchHz = sanitizeNumber(output.pitch_hz);
  const pitchConfidence = clamp01(output.pitch_confidence);
  const rejectedAsReferenceBleed = Boolean(output.rejected_as_reference_bleed);
  const referencePolicyApplied = Boolean(output.reference_policy_applied);
  const selectedNotes = sanitizeSelectedNotes(output.selected_notes);
  const chordScores = sanitizeChordScores(output.chord_scores);
  const detectedString = sanitizeOptionalInteger(output.detected_string);
  const detectedFret = sanitizeOptionalInteger(output.detected_fret);
  const bestNoteId = sanitizeOptionalString(output.best_note_id);
  const residualBlock = output.residual_block;

  if (detectorPreset === 'ac14' && referencePolicyApplied) {
    return {
      delaySamples,
      referenceCorrelation,
      energyRatioDb: Number.isFinite(energyRatioDb) ? energyRatioDb : 0,
      onsetStrength: Number.isFinite(onsetStrength) ? clamp01(onsetStrength) : 0,
      contaminationScore: Number.isFinite(contaminationScore) ? clamp01(contaminationScore) : 0,
      micRms: previousMicRms,
      midiEstimate,
      confidence,
      referenceMidi,
      pitchHz,
      pitchConfidence,
      rejectedAsReferenceBleed,
      referencePolicyApplied,
      selectedNotes,
      chordScores,
      detectedString,
      detectedFret,
      bestNoteId
    };
  }

  alignReference(reference, alignedReference, delaySamples);
  copyResidualBlock(residualBlock, residual);

  const micRms = computeRms(mic);
  const safeEnergyRatioDb = Number.isFinite(energyRatioDb)
    ? energyRatioDb
    : 20 * Math.log10((micRms + 1e-6) / (computeRms(alignedReference) + 1e-6));
  const safeOnsetStrength = Number.isFinite(onsetStrength)
    ? clamp01(onsetStrength)
    : clamp01((micRms - previousMicRms) / Math.max(previousMicRms, 1e-4));
  const safeContaminationScore = Number.isFinite(contaminationScore)
    ? clamp01(contaminationScore)
    : computeContaminationScore(referenceCorrelation, safeEnergyRatioDb, safeOnsetStrength);

  return {
    delaySamples,
    referenceCorrelation,
    energyRatioDb: safeEnergyRatioDb,
    onsetStrength: safeOnsetStrength,
    contaminationScore: safeContaminationScore,
    micRms,
    midiEstimate,
    confidence,
    referenceMidi,
    pitchHz,
    pitchConfidence,
    rejectedAsReferenceBleed,
    referencePolicyApplied,
    selectedNotes,
    chordScores,
    detectedString,
    detectedFret,
    bestNoteId
  };
}

function processEchoSuppression(
  mic,
  reference,
  alignedReference,
  residual,
  nlmsWeights,
  previousMicRms
) {
  const delayEstimate = estimateDelayAndCorrelation(mic, reference, MAX_DELAY_SAMPLES);
  alignReference(reference, alignedReference, delayEstimate.delaySamples);
  runNlms(mic, alignedReference, residual, nlmsWeights);

  const micRms = computeRms(mic);
  const referenceRms = computeRms(alignedReference);
  const energyRatioDb = 20 * Math.log10((micRms + 1e-6) / (referenceRms + 1e-6));
  const onsetStrength = clamp01((micRms - previousMicRms) / Math.max(previousMicRms, 1e-4));
  const contaminationScore = computeContaminationScore(
    delayEstimate.referenceCorrelation,
    energyRatioDb,
    onsetStrength
  );

  return {
    delaySamples: delayEstimate.delaySamples,
    referenceCorrelation: delayEstimate.referenceCorrelation,
    energyRatioDb,
    onsetStrength,
    contaminationScore,
    micRms
  };
}

function estimateDelayAndCorrelation(mic, reference, maxDelaySamples) {
  const maxDelay = Math.min(maxDelaySamples, mic.length - 2, reference.length - 2);
  let bestDelay = 0;
  let bestCorrelation = -1;

  for (let delay = -maxDelay; delay <= maxDelay; delay += 1) {
    let cross = 0;
    let normMic = 0;
    let normRef = 0;
    for (let i = 0; i < mic.length; i += 1) {
      const j = i - delay;
      if (j < 0 || j >= reference.length) continue;
      const m = mic[i];
      const r = reference[j];
      cross += m * r;
      normMic += m * m;
      normRef += r * r;
    }
    const denom = Math.sqrt(normMic * normRef);
    if (denom <= 1e-8) continue;
    const correlation = cross / denom;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestDelay = delay;
    }
  }

  return {
    delaySamples: bestDelay,
    referenceCorrelation: clampSigned(bestCorrelation)
  };
}

function copyResidualBlock(source, target) {
  if (source instanceof Float32Array && source.length === target.length) {
    target.set(source);
    return;
  }
  target.fill(0);
  if (!source || typeof source.length !== 'number') {
    return;
  }
  const copyLength = Math.min(target.length, source.length);
  for (let i = 0; i < copyLength; i += 1) {
    target[i] = source[i];
  }
}

function alignReference(reference, out, delaySamples) {
  for (let i = 0; i < reference.length; i += 1) {
    const sourceIndex = i - delaySamples;
    out[i] = sourceIndex >= 0 && sourceIndex < reference.length ? reference[sourceIndex] : 0;
  }
}

function runNlms(mic, alignedReference, residual, nlmsWeights) {
  const taps = nlmsWeights.length;
  for (let n = 0; n < mic.length; n += 1) {
    let yHat = 0;
    let norm = NLMS_EPS;
    for (let k = 0; k < taps; k += 1) {
      const xIndex = n - k;
      const x = xIndex >= 0 ? alignedReference[xIndex] : 0;
      yHat += nlmsWeights[k] * x;
      norm += x * x;
    }
    const error = mic[n] - yHat;
    residual[n] = error;
    const gain = (NLMS_MU * error) / norm;
    for (let k = 0; k < taps; k += 1) {
      const xIndex = n - k;
      const x = xIndex >= 0 ? alignedReference[xIndex] : 0;
      nlmsWeights[k] += gain * x;
    }
  }
}

function computeContaminationScore(referenceCorrelation, energyRatioDb, onsetStrength) {
  const corrScore = clamp01((referenceCorrelation - 0.55) / 0.45);
  const bleedScore = clamp01((-energyRatioDb - 3) / 18);
  const onsetRelief = clamp01(onsetStrength);
  return clamp01(corrScore * 0.65 + bleedScore * 0.35 - onsetRelief * 0.25);
}

function detectPitch(samples, sampleRateHz, minLag, maxLag, options = {}) {
  const energyThreshold = Number.isFinite(options.energyThreshold)
    ? Math.max(0, options.energyThreshold)
    : DETECTOR_PRESETS.baseline.energyThreshold;
  const correlationThreshold = Number.isFinite(options.correlationThreshold)
    ? clamp01(options.correlationThreshold)
    : DETECTOR_PRESETS.baseline.correlationThreshold;
  const count = samples.length;
  let mean = 0;
  for (let i = 0; i < count; i += 1) {
    mean += samples[i];
  }
  mean /= count;

  let energy = 0;
  for (let i = 0; i < count; i += 1) {
    const centered = samples[i] - mean;
    energy += centered * centered;
  }
  const rms = Math.sqrt(energy / count);
  if (!Number.isFinite(rms) || rms < energyThreshold) {
    return { frequencyHz: 0, confidence: 0 };
  }

  const safeMaxLag = Math.min(maxLag, count - 2);
  let bestLag = -1;
  let bestCorrelation = -1;
  for (let lag = minLag; lag <= safeMaxLag; lag += 1) {
    let cross = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < count - lag; i += 1) {
      const a = samples[i] - mean;
      const b = samples[i + lag] - mean;
      cross += a * b;
      normA += a * a;
      normB += b * b;
    }

    const denom = Math.sqrt(normA * normB);
    if (denom <= 1e-8) continue;
    const correlation = cross / denom;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestCorrelation < correlationThreshold) {
    return { frequencyHz: 0, confidence: clamp01(bestCorrelation) };
  }

  const frequencyHz = sampleRateHz / bestLag;
  const confidence = clamp01((bestCorrelation - 0.45) / 0.5);
  return { frequencyHz, confidence };
}

function computeRms(samples) {
  if (!samples.length) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    energy += value * value;
  }
  return Math.sqrt(energy / samples.length);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function sanitizeDelay(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function sanitizeNumber(value) {
  if (!Number.isFinite(value)) return Number.NaN;
  return value;
}

function sanitizeMidiEstimate(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeOptionalInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function sanitizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeSelectedNotes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const midi = Number(item.midi);
    if (!Number.isFinite(midi)) continue;
    out.push({
      note_id: sanitizeOptionalString(item.note_id),
      midi,
      string: sanitizeOptionalInteger(item.string),
      fret: sanitizeOptionalInteger(item.fret),
      score: Number.isFinite(item.score) ? Number(item.score) : 0
    });
  }
  return out;
}

function sanitizeChordScores(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const chordId = sanitizeOptionalString(item.chord_id);
    if (!chordId) continue;
    out.push({
      chord_id: chordId,
      score: Number.isFinite(item.score) ? Number(item.score) : 0
    });
  }
  return out;
}

function sanitizeSpectralModel(value) {
  if (!value || typeof value !== 'object') return null;
  const notesRaw = Array.isArray(value.notes) ? value.notes : [];
  const chordsRaw = Array.isArray(value.chords) ? value.chords : [];
  const notes = [];
  const noteIds = new Set();
  for (const note of notesRaw) {
    if (!note || typeof note !== 'object') continue;
    const id = sanitizeOptionalString(note.id);
    const string = sanitizeOptionalInteger(note.string);
    const fret = sanitizeOptionalInteger(note.fret);
    const midi = Number(note.midi);
    const frequencyHz = Number(note.frequency_hz);
    if (!id || noteIds.has(id)) continue;
    if (!Number.isFinite(midi) || string === null || fret === null) continue;
    notes.push({
      id,
      string,
      fret,
      midi,
      frequency_hz: Number.isFinite(frequencyHz)
        ? frequencyHz
        : 440 * Math.pow(2, (midi - 69) / 12)
    });
    noteIds.add(id);
  }
  const chords = [];
  for (const chord of chordsRaw) {
    if (!chord || typeof chord !== 'object') continue;
    const id = sanitizeOptionalString(chord.id);
    if (!id) continue;
    const membersRaw = Array.isArray(chord.member_note_ids) ? chord.member_note_ids : [];
    const member_note_ids = membersRaw
      .map((entry) => sanitizeOptionalString(entry))
      .filter((entry) => entry && noteIds.has(entry));
    if (member_note_ids.length === 0) continue;
    chords.push({
      id,
      member_note_ids: Array.from(new Set(member_note_ids))
    });
  }
  if (notes.length === 0) return null;
  return { notes, chords };
}

function normalizeDetectorPreset(value) {
  if (value === 'ac14') return 'ac14';
  if (value === 'spectral_game_runtime_unified_v3') return 'spectral_game_runtime_unified_v3';
  return DEFAULT_DETECTOR_PRESET;
}

function getDetectorPresetConfig(detectorPreset) {
  if (detectorPreset === 'ac14') return DETECTOR_PRESETS.ac14;
  if (detectorPreset === 'spectral_game_runtime_unified_v3') {
    return DETECTOR_PRESETS.spectral_game_runtime_unified_v3;
  }
  return DETECTOR_PRESETS.baseline;
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'DSP core unavailable';
}
