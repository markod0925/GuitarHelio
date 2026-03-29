import type {
  FrameSignalMetrics,
  PitchDebugInputMode,
  ReferenceNoteSelection,
  SpectralPeak,
  WindowType
} from '../pitch/types';
import { midiToHz } from '../ui/song-select/utils/songSelectUtils';

export const DEFAULT_FFT_SIZE = 4096;
export const MIN_SUPPORTED_FRAME_SIZE = 512;
export const MAX_SUPPORTED_FRAME_SIZE = 16384;
export const DEFAULT_FRAME_SIZE = 4096;
export const DEFAULT_HOP_SIZE = 512;
export const DEFAULT_CALLBACK_CHUNK_SIZE = 512;
export const DEFAULT_REFERENCE_TEST_NOTE_DURATION_MS = 1800;
export const E2_FREQUENCY_HZ = 82.4068892282175;
export const OPEN_STRING_REFERENCE_NOTES = Object.freeze([
  { label: 'E2', midi: 40, frequencyHz: midiToHz(40), stringId: 6, fret: 0 },
  { label: 'A2', midi: 45, frequencyHz: midiToHz(45), stringId: 5, fret: 0 },
  { label: 'D3', midi: 50, frequencyHz: midiToHz(50), stringId: 4, fret: 0 },
  { label: 'G3', midi: 55, frequencyHz: midiToHz(55), stringId: 3, fret: 0 },
  { label: 'B3', midi: 59, frequencyHz: midiToHz(59), stringId: 2, fret: 0 },
  { label: 'E4', midi: 64, frequencyHz: midiToHz(64), stringId: 1, fret: 0 }
]);

export type FftPlan = {
  nfft: number;
  bitrev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
};

export type DiagnosticPreprocessConfig = {
  windowType: WindowType;
  normalize: boolean;
  dcRemoval: boolean;
  highPass: boolean;
  lowPass: boolean;
  bandPass: boolean;
  noiseGate: boolean;
  silenceGateThreshold: number;
  highPassHz: number;
  lowPassHz: number;
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function toDbfs(value: number): number {
  if (!(value > 0)) return -120;
  return 20 * Math.log10(Math.max(1e-8, value));
}

export function computeRms(samples: ArrayLike<number>): number {
  if (samples.length <= 0) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    energy += value * value;
  }
  return Math.sqrt(energy / samples.length);
}

export function computePeak(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  return peak;
}

export function midiToPitchHz(midi: number | null | undefined): number | undefined {
  if (midi === null || midi === undefined || !Number.isFinite(midi)) return undefined;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function pitchHzToMidi(pitchHz: number | null | undefined): number | null {
  if (!(pitchHz && Number.isFinite(pitchHz) && pitchHz > 0)) return null;
  return 69 + 12 * Math.log2(pitchHz / 440);
}

export function centsBetweenMidi(observedMidi: number | null | undefined, targetMidi: number | null | undefined): number | null {
  if (observedMidi === null || observedMidi === undefined || targetMidi === null || targetMidi === undefined) {
    return null;
  }
  if (!Number.isFinite(observedMidi) || !Number.isFinite(targetMidi)) return null;
  return (observedMidi - targetMidi) * 100;
}

export function describeAndroidRuntime(): string | null {
  if (typeof navigator === 'undefined') return null;
  const userAgent = navigator.userAgent ?? '';
  if (!/android/i.test(userAgent)) {
    return null;
  }
  const release = userAgent.match(/Android\s+([\d.]+)/i)?.[1] ?? 'unknown';
  const model = userAgent.match(/;\s([^;)]*Build\/)/)?.[1]?.replace(/Build\/$/, '').trim() ?? null;
  return model ? `${model} • Android ${release}` : `Android ${release}`;
}

export function resolveCapturePresetLabel(mode: PitchDebugInputMode): string {
  if (mode === 'live_mic') return 'Live mic';
  if (mode === 'file') return 'File';
  if (mode === 'reference_test') return 'Reference test';
  return 'Replay';
}

export function fillWindowKernel(target: Float32Array, windowType: WindowType): Float32Array {
  const length = target.length;
  if (length <= 0) return target;
  const denom = Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    const phase = (2 * Math.PI * i) / denom;
    if (windowType === 'hann') {
      target[i] = 0.5 - 0.5 * Math.cos(phase);
    } else if (windowType === 'hamming') {
      target[i] = 0.54 - 0.46 * Math.cos(phase);
    } else if (windowType === 'blackman') {
      target[i] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
    } else {
      target[i] = 1;
    }
  }
  return target;
}

export function buildFftPlan(nfft: number): FftPlan {
  const bits = Math.round(Math.log2(nfft));
  if (1 << bits !== nfft) {
    throw new Error(`FFT size must be a power of two, got ${nfft}`);
  }
  const bitrev = new Uint32Array(nfft);
  for (let i = 0; i < nfft; i += 1) {
    let x = i;
    let y = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    bitrev[i] = y;
  }
  const cos = new Float64Array(nfft / 2);
  const sin = new Float64Array(nfft / 2);
  for (let i = 0; i < nfft / 2; i += 1) {
    const angle = (-2 * Math.PI * i) / nfft;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  return { nfft, bitrev, cos, sin };
}

export function fftInPlace(re: Float64Array, im: Float64Array, plan: FftPlan): void {
  const n = plan.nfft;
  for (let i = 0; i < n; i += 1) {
    const j = plan.bitrev[i];
    if (j <= i) continue;
    const tmpRe = re[i];
    re[i] = re[j];
    re[j] = tmpRe;
    const tmpIm = im[i];
    im[i] = im[j];
    im[j] = tmpIm;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k += 1) {
        const tableIndex = k * step;
        const wr = plan.cos[tableIndex];
        const wi = plan.sin[tableIndex];
        const even = start + k;
        const odd = even + half;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        const ur = re[even];
        const ui = im[even];
        re[even] = ur + tr;
        im[even] = ui + ti;
        re[odd] = ur - tr;
        im[odd] = ui - ti;
      }
    }
  }
}

export function removeDc(samples: Float32Array): number {
  if (samples.length <= 0) return 0;
  let mean = 0;
  for (let i = 0; i < samples.length; i += 1) {
    mean += samples[i];
  }
  mean /= samples.length;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] -= mean;
  }
  return mean;
}

export function normalizeFrame(samples: Float32Array, targetPeak = 0.92): number {
  const peak = computePeak(samples);
  if (!(peak > 0) || !(targetPeak > 0)) return 1;
  const gain = targetPeak / peak;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= gain;
  }
  return gain;
}

function onePoleFilterCoefficient(sampleRate: number, cutoffHz: number): number {
  if (!(sampleRate > 0) || !(cutoffHz > 0)) return 0;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  return dt / (rc + dt);
}

export function applyHighPass(samples: Float32Array, sampleRate: number, cutoffHz: number): void {
  if (samples.length <= 1) return;
  const alpha = sampleRate > 0 && cutoffHz > 0
    ? 1 / (1 + 1 / (2 * Math.PI * cutoffHz / sampleRate))
    : 0;
  let prevX = samples[0];
  let prevY = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i];
    const value = alpha * (prevY + current - prevX);
    samples[i] = value;
    prevX = current;
    prevY = value;
  }
  samples[0] = 0;
}

export function applyLowPass(samples: Float32Array, sampleRate: number, cutoffHz: number): void {
  if (samples.length <= 1) return;
  const alpha = onePoleFilterCoefficient(sampleRate, cutoffHz);
  if (!(alpha > 0)) return;
  let previous = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    previous = previous + alpha * (samples[i] - previous);
    samples[i] = previous;
  }
}

export function applyNoiseGate(samples: Float32Array, gateThreshold: number): boolean {
  const rms = computeRms(samples);
  if (rms >= gateThreshold) {
    return false;
  }
  samples.fill(0);
  return true;
}

export function applyWindow(source: Float32Array, kernel: Float32Array, target: Float32Array): void {
  const length = Math.min(source.length, kernel.length, target.length);
  for (let i = 0; i < length; i += 1) {
    target[i] = source[i] * kernel[i];
  }
}

export function computeMagnitudeSpectrum(
  samples: Float32Array,
  fftSize: number,
  plan: FftPlan,
  re: Float64Array,
  im: Float64Array,
  magnitude: Float32Array
): void {
  re.fill(0);
  im.fill(0);
  const copyLength = Math.min(samples.length, fftSize);
  for (let i = 0; i < copyLength; i += 1) {
    re[i] = samples[i];
  }
  fftInPlace(re, im, plan);
  const half = fftSize / 2;
  for (let i = 0; i <= half; i += 1) {
    magnitude[i] = Math.hypot(re[i], im[i]);
  }
}

export function computeAutocorrelationSummary(
  samples: ArrayLike<number>,
  sampleRate: number,
  minFrequencyHz = 65,
  maxFrequencyHz = 1200
): { bestLag: number; bestPeak: number } {
  if (samples.length < 4 || !(sampleRate > 0)) {
    return { bestLag: 0, bestPeak: 0 };
  }
  const minLag = Math.max(1, Math.floor(sampleRate / maxFrequencyHz));
  const maxLag = Math.min(samples.length - 2, Math.floor(sampleRate / minFrequencyHz));
  let mean = 0;
  for (let i = 0; i < samples.length; i += 1) {
    mean += samples[i];
  }
  mean /= samples.length;
  let bestLag = 0;
  let bestPeak = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let cross = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < samples.length - lag; i += 1) {
      const a = samples[i] - mean;
      const b = samples[i + lag] - mean;
      cross += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    if (denom <= 1e-8) continue;
    const value = cross / denom;
    if (value > bestPeak) {
      bestPeak = value;
      bestLag = lag;
    }
  }
  return {
    bestLag,
    bestPeak: Number.isFinite(bestPeak) ? clampFinite(bestPeak, 0) : 0
  };
}

export function computeTopSpectralPeaks(
  magnitudeSpectrum: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  maxPeaks = 5
): SpectralPeak[] {
  if (magnitudeSpectrum.length < 3 || !(sampleRate > 0) || !(fftSize > 0)) {
    return [];
  }
  const peaks: SpectralPeak[] = [];
  for (let i = 1; i < magnitudeSpectrum.length - 1; i += 1) {
    const value = magnitudeSpectrum[i];
    if (!(value > magnitudeSpectrum[i - 1] && value >= magnitudeSpectrum[i + 1])) continue;
    peaks.push({
      bin: i,
      frequencyHz: (i * sampleRate) / fftSize,
      magnitude: value,
      magnitudeDb: toDbfs(value)
    });
  }
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  return peaks.slice(0, maxPeaks);
}

function bandEnergy(magnitudeSpectrum: ArrayLike<number>, sampleRate: number, fftSize: number, minHz: number, maxHz: number): number {
  if (!(sampleRate > 0) || !(fftSize > 0)) return 0;
  const minBin = Math.max(0, Math.floor((minHz * fftSize) / sampleRate));
  const maxBin = Math.min(magnitudeSpectrum.length - 1, Math.ceil((maxHz * fftSize) / sampleRate));
  let energy = 0;
  for (let i = minBin; i <= maxBin; i += 1) {
    energy += magnitudeSpectrum[i] * magnitudeSpectrum[i];
  }
  return energy;
}

function energyNearFrequency(magnitudeSpectrum: ArrayLike<number>, sampleRate: number, fftSize: number, frequencyHz: number, bandwidthHz = 8): number {
  return bandEnergy(magnitudeSpectrum, sampleRate, fftSize, Math.max(0, frequencyHz - bandwidthHz), frequencyHz + bandwidthHz);
}

export function computeSignalMetrics(
  frame: Float32Array,
  magnitudeSpectrum: Float32Array,
  sampleRate: number,
  fftSize: number,
  previousRms: number
): FrameSignalMetrics {
  const rms = computeRms(frame);
  const peak = computePeak(frame);
  let dcOffset = 0;
  let clippingCount = 0;
  let zeroCrossings = 0;
  for (let i = 0; i < frame.length; i += 1) {
    dcOffset += frame[i];
    if (Math.abs(frame[i]) >= 0.999) clippingCount += 1;
    if (i > 0 && (frame[i - 1] <= 0 ? frame[i] > 0 : frame[i] <= 0)) {
      zeroCrossings += 1;
    }
  }
  dcOffset /= Math.max(1, frame.length);

  const magnitudeValues = Array.from(magnitudeSpectrum);
  const epsilon = 1e-12;
  let weightedFrequency = 0;
  let weightedSum = 0;
  let totalEnergy = 0;
  for (let i = 0; i < magnitudeValues.length; i += 1) {
    const magnitude = Math.max(epsilon, magnitudeValues[i]);
    const frequency = (i * sampleRate) / fftSize;
    weightedFrequency += magnitude * frequency;
    weightedSum += magnitude;
    totalEnergy += magnitude;
  }

  let rolloffEnergy = 0;
  const rolloffTarget = totalEnergy * 0.85;
  let spectralRolloffHz = 0;
  let geometricSum = 0;
  for (let i = 0; i < magnitudeValues.length; i += 1) {
    const value = Math.max(epsilon, magnitudeValues[i]);
    rolloffEnergy += value;
    geometricSum += Math.log(value);
    if (spectralRolloffHz === 0 && rolloffEnergy >= rolloffTarget) {
      spectralRolloffHz = (i * sampleRate) / fftSize;
    }
  }

  const sortedMagnitudes = magnitudeValues.slice().sort((a, b) => a - b);
  const noiseFloorMagnitude = sortedMagnitudes[Math.floor(sortedMagnitudes.length * 0.2)] ?? epsilon;
  const noiseFloorDb = toDbfs(noiseFloorMagnitude);
  const snrDb = toDbfs(Math.max(epsilon, Math.max(...magnitudeValues))) - noiseFloorDb;
  const autocorr = computeAutocorrelationSummary(frame, sampleRate, 55, 1200);
  const lowBandEnergy = bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 60, 200);
  const totalBandEnergy = bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 60, 3200);
  const onsetStrength = clamp01((rms - previousRms) / Math.max(previousRms, 1e-4));

  return {
    rms,
    rmsDbfs: toDbfs(rms),
    peak,
    peakDbfs: toDbfs(peak),
    crestFactor: rms > 0 ? peak / rms : 0,
    dcOffset,
    clippingRatio: clippingCount / Math.max(1, frame.length),
    zcr: zeroCrossings / Math.max(1, frame.length - 1),
    spectralCentroidHz: weightedSum > 0 ? weightedFrequency / weightedSum : 0,
    spectralRolloffHz,
    spectralFlatness: Math.exp(geometricSum / Math.max(1, magnitudeValues.length)) / Math.max(epsilon, weightedSum / Math.max(1, magnitudeValues.length)),
    bandEnergy_60_100: bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 60, 100),
    bandEnergy_100_200: bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 100, 200),
    bandEnergy_200_400: bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 200, 400),
    bandEnergy_400_800: bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 400, 800),
    bandEnergy_800_1600: bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 800, 1600),
    bandEnergy_1600_3200: bandEnergy(magnitudeSpectrum, sampleRate, fftSize, 1600, 3200),
    lowBandEnergyRatio: totalBandEnergy > 0 ? lowBandEnergy / totalBandEnergy : 0,
    estimatedNoiseFloorDb: noiseFloorDb,
    estimatedSnrDb: snrDb,
    autocorrelationBestLag: autocorr.bestLag,
    autocorrelationBestPeak: autocorr.bestPeak,
    onsetStrength,
    harmonicityScore: autocorr.bestPeak,
    energyNearE2: energyNearFrequency(magnitudeSpectrum, sampleRate, fftSize, E2_FREQUENCY_HZ, 6),
    energyNearE2Harmonic2: energyNearFrequency(magnitudeSpectrum, sampleRate, fftSize, E2_FREQUENCY_HZ * 2, 8),
    energyNearE2Harmonic3: energyNearFrequency(magnitudeSpectrum, sampleRate, fftSize, E2_FREQUENCY_HZ * 3, 10),
    energyNearE2Harmonic4: energyNearFrequency(magnitudeSpectrum, sampleRate, fftSize, E2_FREQUENCY_HZ * 4, 12)
  };
}

export function buildSyntheticReferenceWav(selection: ReferenceNoteSelection, sampleRate = 48000, durationMs = 2200): Uint8Array {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const samples = new Float32Array(sampleCount);
  const harmonics = [
    { multiple: 1, amplitude: 0.3 },
    { multiple: 2, amplitude: 0.55 },
    { multiple: 3, amplitude: 0.42 },
    { multiple: 4, amplitude: 0.26 },
    { multiple: 5, amplitude: 0.18 }
  ];
  for (let i = 0; i < sampleCount; i += 1) {
    const time = i / sampleRate;
    const attack = Math.min(1, time / 0.04);
    const release = Math.min(1, Math.max(0, (durationMs / 1000 - time) / 0.25));
    const envelope = Math.sin(Math.min(1, attack) * Math.PI * 0.5) * Math.min(1, release);
    let value = 0;
    for (const harmonic of harmonics) {
      value += harmonic.amplitude * Math.sin(2 * Math.PI * selection.frequencyHz * harmonic.multiple * time);
    }
    samples[i] = Math.max(-0.98, Math.min(0.98, value * envelope * 0.55));
  }
  return encodeMonoWav(samples, sampleRate);
}

export function encodeMonoWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function buildDownloadFileName(prefix: string, extension: string): string {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, '0'),
    `${date.getDate()}`.padStart(2, '0')
  ].join('');
  const time = [
    `${date.getHours()}`.padStart(2, '0'),
    `${date.getMinutes()}`.padStart(2, '0'),
    `${date.getSeconds()}`.padStart(2, '0')
  ].join('');
  return `${prefix}-${stamp}-${time}.${extension}`;
}
