const BUFFER_SIZE = 2048;
const HOP_SIZE = 1024;
const MIN_FREQUENCY = 65;
const MAX_FREQUENCY = 1200;
const ENERGY_THRESHOLD = 0.0035;

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(BUFFER_SIZE);
    this.frame = new Float32Array(BUFFER_SIZE);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastAnalysis = 0;
    this.minLag = Math.max(1, Math.floor(sampleRate / MAX_FREQUENCY));
    this.maxLag = Math.max(this.minLag + 1, Math.floor(sampleRate / MIN_FREQUENCY));
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (!channelData) return true;

    for (let i = 0; i < channelData.length; i += 1) {
      this.ring[this.writeIndex] = channelData[i];
      this.writeIndex = (this.writeIndex + 1) % BUFFER_SIZE;
      this.totalSamples += 1;
      this.samplesSinceLastAnalysis += 1;
    }

    if (this.totalSamples < BUFFER_SIZE || this.samplesSinceLastAnalysis < HOP_SIZE) {
      return true;
    }
    this.samplesSinceLastAnalysis = 0;

    this.copyRingToFrame();
    const pitch = detectPitch(this.frame, sampleRate, this.minLag, this.maxLag);
    const midiEstimate = pitch.frequencyHz > 0 ? 69 + 12 * Math.log2(pitch.frequencyHz / 440) : null;

    this.port.postMessage({
      t_seconds: currentTime,
      midi_estimate: midiEstimate,
      confidence: midiEstimate === null ? 0 : pitch.confidence
    });
    return true;
  }

  copyRingToFrame() {
    for (let i = 0; i < BUFFER_SIZE; i += 1) {
      const idx = (this.writeIndex + i) % BUFFER_SIZE;
      this.frame[i] = this.ring[idx];
    }
  }
}

registerProcessor('gh-pitch-processor', PitchProcessor);

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
    return { frequencyHz: 0, confidence: Math.max(0, Math.min(1, bestCorrelation)) };
  }

  const frequencyHz = sampleRateHz / bestLag;
  const confidence = Math.max(0, Math.min(1, (bestCorrelation - 0.45) / 0.5));
  return { frequencyHz, confidence };
}
