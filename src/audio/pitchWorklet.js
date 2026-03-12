import initDspCore, { DspMode, GhDspCore } from './dsp-core/gh_dsp_core.js';

const BUFFER_SIZE = 2048;
const HOP_SIZE = 1024;
const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1200;
const ENERGY_THRESHOLD = 0.0035;
const MAX_DELAY_SAMPLES = 720;
const NLMS_TAPS = 64;
const NLMS_MU = 0.08;
const NLMS_EPS = 1e-6;

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.micRing = new Float32Array(BUFFER_SIZE);
    this.referenceRing = new Float32Array(BUFFER_SIZE);
    this.micFrame = new Float32Array(BUFFER_SIZE);
    this.referenceFrame = new Float32Array(BUFFER_SIZE);
    this.alignedReferenceFrame = new Float32Array(BUFFER_SIZE);
    this.residualFrame = new Float32Array(BUFFER_SIZE);
    this.nlmsWeights = new Float32Array(NLMS_TAPS);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastAnalysis = 0;
    this.minLag = Math.max(1, Math.floor(sampleRate / MAX_FREQUENCY));
    this.maxLag = Math.max(this.minLag + 1, Math.floor(sampleRate / MIN_FREQUENCY));
    this.prevMicRms = 0;
    this.audioInputMode = 'speaker';
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
      core.prepare(sampleRate, BUFFER_SIZE, this.resolveDspMode(this.audioInputMode));
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
    if (!this.dspCore) return;
    this.dspCore.prepare(sampleRate, BUFFER_SIZE, this.resolveDspMode(this.audioInputMode));
    this.dspCore.reset();
  }

  resolveDspMode(audioInputMode) {
    return audioInputMode === 'headphones' ? DspMode.Headphones : DspMode.Speaker;
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
      this.writeIndex = (this.writeIndex + 1) % BUFFER_SIZE;
      this.totalSamples += 1;
      this.samplesSinceLastAnalysis += 1;
    }

    if (this.totalSamples < BUFFER_SIZE || this.samplesSinceLastAnalysis < HOP_SIZE) {
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
              this.prevMicRms
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

    const residualPitch = detectPitch(this.residualFrame, sampleRate, this.minLag, this.maxLag);
    const referencePitch = detectPitch(this.alignedReferenceFrame, sampleRate, this.minLag, this.maxLag);
    const residualMidiEstimate = residualPitch.frequencyHz > 0 ? 69 + 12 * Math.log2(residualPitch.frequencyHz / 440) : null;
    const referenceMidiEstimate = referencePitch.frequencyHz > 0 ? 69 + 12 * Math.log2(referencePitch.frequencyHz / 440) : null;

    this.port.postMessage({
      type: 'frame',
      t_seconds: currentTime,
      midi_estimate: residualMidiEstimate,
      confidence: residualMidiEstimate === null ? 0 : residualPitch.confidence,
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
    for (let i = 0; i < BUFFER_SIZE; i += 1) {
      const idx = (this.writeIndex + i) % BUFFER_SIZE;
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
  previousMicRms
) {
  dspCore.set_reference_block(reference);
  const output = dspCore.process_block(mic) ?? {};

  const delaySamples = sanitizeDelay(output.delay_samples);
  const referenceCorrelation = clampSigned(output.reference_correlation);
  const energyRatioDb = sanitizeNumber(output.energy_ratio_db);
  const onsetStrength = sanitizeNumber(output.onset_strength);
  const contaminationScore = sanitizeNumber(output.contamination_score);
  const residualBlock = output.residual_block;

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
    micRms
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

function detectPitch(samples, sampleRateHz, minLag, maxLag) {
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
  if (!Number.isFinite(rms) || rms < ENERGY_THRESHOLD) {
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

  if (bestLag <= 0 || bestCorrelation < 0.58) {
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

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'DSP core unavailable';
}
