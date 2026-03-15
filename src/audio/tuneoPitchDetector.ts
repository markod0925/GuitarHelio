import type { PitchFrame } from '../types/models';
import type { PitchCalibrationProfile } from './pitchCalibration';
import { applyPitchCalibration } from './pitchCalibration';

export type TuneoPitchListener = (frame: PitchFrame) => void;

type TuneoPitchDetectorOptions = {
  windowSize?: number;
  buffersPerSecond?: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  thresholdDefault?: number;
  thresholdNoisy?: number;
  maxPitchDev?: number;
  rmsGap?: number;
  enableAdaptiveRange?: boolean;
  minRms?: number;
  calibrationProfile?: PitchCalibrationProfile | null;
};

type TuneoYinResult = {
  frequencyHz: number;
  cmnd: number;
};

const DEFAULT_WINDOW_SIZE = 9000;
const DEFAULT_BUFFERS_PER_SECOND = 15;
const DEFAULT_MIN_FREQUENCY_HZ = 30;
const DEFAULT_MAX_FREQUENCY_HZ = 500;
const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_THRESHOLD_NOISY = 0.6;
const DEFAULT_MAX_PITCH_DEV = 0.2;
const DEFAULT_RMS_GAP = 1.1;
const DEFAULT_MIN_RMS = 0.0008;
const HISTORY_SIZE = 3;

export class TuneoPitchDetectorService {
  private listeners = new Set<TuneoPitchListener>();
  private analyser: AnalyserNode | null = null;
  private analyserSnapshot: Float32Array | null = null;
  private rollingBuffer: Float32Array;
  private scratchYin: Float32Array;
  private chunkBuffer: Float32Array;
  private analyserRafId: number | null = null;
  private sink: GainNode | null = null;
  private initialized = false;
  private lastAnalysisTimeSeconds = 0;
  private accumulatedSamples = 0;
  private updateId = 0;
  private idHistory = new Array<number>(HISTORY_SIZE).fill(0);
  private rmsHistory = new Array<number>(HISTORY_SIZE).fill(0);
  private pitchHistory = new Array<number>(HISTORY_SIZE).fill(-1);
  private lastMidiEstimate: number | null = null;

  private readonly windowSize: number;
  private readonly buffersPerSecond: number;
  private readonly minFrequencyHz: number;
  private readonly maxFrequencyHz: number;
  private readonly thresholdDefault: number;
  private readonly thresholdNoisy: number;
  private readonly maxPitchDev: number;
  private readonly rmsGap: number;
  private readonly enableAdaptiveRange: boolean;
  private readonly minRms: number;
  private readonly calibrationProfile: PitchCalibrationProfile | null;

  constructor(
    private readonly ctx: AudioContext,
    options: TuneoPitchDetectorOptions = {}
  ) {
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.buffersPerSecond = options.buffersPerSecond ?? DEFAULT_BUFFERS_PER_SECOND;
    this.minFrequencyHz = options.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ;
    this.maxFrequencyHz = options.maxFrequencyHz ?? DEFAULT_MAX_FREQUENCY_HZ;
    this.thresholdDefault = options.thresholdDefault ?? DEFAULT_THRESHOLD;
    this.thresholdNoisy = options.thresholdNoisy ?? DEFAULT_THRESHOLD_NOISY;
    this.maxPitchDev = options.maxPitchDev ?? DEFAULT_MAX_PITCH_DEV;
    this.rmsGap = options.rmsGap ?? DEFAULT_RMS_GAP;
    this.enableAdaptiveRange = options.enableAdaptiveRange ?? true;
    this.minRms = options.minRms ?? DEFAULT_MIN_RMS;
    this.calibrationProfile = options.calibrationProfile ?? null;
    this.rollingBuffer = new Float32Array(this.windowSize);
    this.scratchYin = new Float32Array(this.windowSize);
    this.chunkBuffer = new Float32Array(Math.max(1, Math.floor(this.ctx.sampleRate / this.buffersPerSecond)));
  }

  async init(): Promise<void> {
    this.initialized = true;
  }

  start(source: AudioNode): void {
    if (!this.initialized) {
      throw new Error('TuneoPitchDetectorService not initialized');
    }

    this.stop();

    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sink.connect(this.ctx.destination);
    this.sink = sink;

    const chunkSize = this.resolveChunkSize();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = resolveAnalyserFftSize(Math.max(chunkSize, 1024));
    analyser.smoothingTimeConstant = 0;
    this.analyserSnapshot = new Float32Array(analyser.fftSize);
    this.chunkBuffer = new Float32Array(chunkSize);
    this.analyser = analyser;

    source.connect(analyser);
    analyser.connect(sink);

    this.rollingBuffer.fill(0);
    this.scratchYin.fill(0);
    this.lastAnalysisTimeSeconds = this.ctx.currentTime;
    this.accumulatedSamples = 0;
    this.updateId = 0;
    this.idHistory.fill(0);
    this.rmsHistory.fill(0);
    this.pitchHistory.fill(-1);
    this.lastMidiEstimate = null;
    this.scheduleAnalysisFrame();
  }

  stop(): void {
    this.analyser?.disconnect();
    this.analyser = null;
    this.analyserSnapshot = null;
    if (this.analyserRafId !== null) {
      cancelAnimationFrame(this.analyserRafId);
      this.analyserRafId = null;
    }

    this.sink?.disconnect();
    this.sink = null;
    this.lastAnalysisTimeSeconds = 0;
    this.accumulatedSamples = 0;
    this.lastMidiEstimate = null;
  }

  onPitch(listener: TuneoPitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleAnalysisFrame(): void {
    this.analyserRafId = requestAnimationFrame(() => {
      this.analyserRafId = null;
      const analyser = this.analyser;
      const analyserSnapshot = this.analyserSnapshot;
      if (!analyser || !analyserSnapshot) return;

      const now = this.ctx.currentTime;
      const elapsedSeconds = Math.max(0, now - this.lastAnalysisTimeSeconds);
      this.lastAnalysisTimeSeconds = now;
      this.accumulatedSamples += elapsedSeconds * this.ctx.sampleRate;

      const chunkSize = this.chunkBuffer.length;
      while (this.accumulatedSamples >= chunkSize) {
        this.accumulatedSamples -= chunkSize;
        analyser.getFloatTimeDomainData(analyserSnapshot as unknown as Float32Array<ArrayBuffer>);
        this.extractLatestChunk(analyserSnapshot, this.chunkBuffer);
        this.pushChunkIntoRollingBuffer(this.chunkBuffer);
        this.processCurrentBuffer();
      }

      this.scheduleAnalysisFrame();
    });
  }

  private processCurrentBuffer(): void {
    this.updateId += 1;
    if (this.idHistory[HISTORY_SIZE - 1] === this.updateId) {
      return;
    }
    pushHistory(this.idHistory, this.updateId);

    const rms = computeRms(this.chunkBuffer);
    pushHistory(this.rmsHistory, rms);

    let minFreq = this.minFrequencyHz;
    let maxFreq = this.maxFrequencyHz;
    let threshold = this.thresholdDefault;

    const previousPitch = this.pitchHistory[HISTORY_SIZE - 1];
    const secondPreviousPitch = this.pitchHistory[HISTORY_SIZE - 2];
    const previousRms = this.rmsHistory[HISTORY_SIZE - 1];
    const secondPreviousRms = this.rmsHistory[HISTORY_SIZE - 2];

    let restrictRange = this.enableAdaptiveRange;
    restrictRange = restrictRange && previousPitch > 0;
    restrictRange = restrictRange && previousRms < secondPreviousRms * this.rmsGap;
    restrictRange = restrictRange && getRelativeDiff(previousPitch, secondPreviousPitch) <= this.maxPitchDev;
    if (restrictRange) {
      minFreq = previousPitch * (1 - this.maxPitchDev);
      maxFreq = previousPitch * (1 + this.maxPitchDev);
      threshold = this.thresholdNoisy;
    }

    const yinResult = detectPitchWithTuneoYin(
      this.rollingBuffer,
      this.ctx.sampleRate,
      minFreq,
      maxFreq,
      threshold,
      this.scratchYin
    );

    if (!Number.isFinite(rms) || rms < this.minRms || yinResult.frequencyHz <= 0) {
      pushHistory(this.pitchHistory, -1);
      this.lastMidiEstimate = null;
      this.emitFrame({
        t_seconds: this.ctx.currentTime,
        midi_estimate: null,
        confidence: 0
      });
      return;
    }

    pushHistory(this.pitchHistory, yinResult.frequencyHz);
    const midiEstimateRaw = 69 + 12 * Math.log2(yinResult.frequencyHz / 440);
    const correctedMidi = applyPitchCalibration(midiEstimateRaw, this.calibrationProfile);
    const confidence = estimateTuneoConfidence({
      cmnd: yinResult.cmnd,
      threshold,
      rms,
      minRms: this.minRms,
      currentMidi: correctedMidi,
      previousMidi: this.lastMidiEstimate
    });
    this.lastMidiEstimate = correctedMidi;
    this.emitFrame({
      t_seconds: this.ctx.currentTime,
      midi_estimate: correctedMidi,
      confidence
    });
  }

  private emitFrame(frame: PitchFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private resolveChunkSize(): number {
    const chunkSize = Math.floor(this.ctx.sampleRate / Math.max(1, this.buffersPerSecond));
    return Math.max(64, chunkSize);
  }

  private extractLatestChunk(snapshot: Float32Array, outChunk: Float32Array): void {
    const chunkSize = outChunk.length;
    if (snapshot.length >= chunkSize) {
      outChunk.set(snapshot.subarray(snapshot.length - chunkSize));
      return;
    }

    const padding = chunkSize - snapshot.length;
    outChunk.fill(0, 0, padding);
    outChunk.set(snapshot, padding);
  }

  private pushChunkIntoRollingBuffer(chunk: Float32Array): void {
    const chunkSize = chunk.length;
    if (chunkSize >= this.rollingBuffer.length) {
      this.rollingBuffer.set(chunk.subarray(chunkSize - this.rollingBuffer.length));
      return;
    }

    this.rollingBuffer.copyWithin(0, chunkSize);
    this.rollingBuffer.set(chunk, this.rollingBuffer.length - chunkSize);
  }
}

function detectPitchWithTuneoYin(
  audioBuffer: Float32Array,
  sampleRate: number,
  minFreq: number,
  maxFreq: number,
  threshold: number,
  scratchBuffer: Float32Array
): TuneoYinResult {
  const tauMin = Math.max(2, Math.floor(sampleRate / Math.max(1, maxFreq)));
  const tauMax = Math.floor(sampleRate / Math.max(1, minFreq));
  const safeTauMax = Math.min(tauMax, audioBuffer.length - 1);
  if (safeTauMax <= tauMin + 2) {
    return { frequencyHz: -1, cmnd: 1 };
  }

  scratchBuffer.fill(0, tauMin, safeTauMax + 1);

  for (let tau = tauMin; tau < safeTauMax; tau += 1) {
    let sum = 0;
    for (let j = 0; j < audioBuffer.length - tau; j += 1) {
      const diff = audioBuffer[j] - audioBuffer[j + tau];
      sum += diff * diff;
    }
    scratchBuffer[tau] = sum;
  }

  let acc = 0;
  for (let tau = tauMin; tau < safeTauMax; tau += 1) {
    acc += scratchBuffer[tau];
    if (acc <= 1e-12) {
      scratchBuffer[tau] = 1;
      continue;
    }
    scratchBuffer[tau] = (scratchBuffer[tau] * (tau + 1 - tauMin)) / acc;
  }

  let minTau = -1;
  let minCmnd = 1;
  for (let tau = tauMin + 1; tau < safeTauMax - 1; tau += 1) {
    if (scratchBuffer[tau] < threshold && scratchBuffer[tau] < scratchBuffer[tau + 1]) {
      minTau = parabolaInterp(tau, scratchBuffer[tau - 1], scratchBuffer[tau], scratchBuffer[tau + 1]);
      minCmnd = scratchBuffer[tau];
      break;
    }
  }

  if (!Number.isFinite(minTau) || minTau <= 0) {
    return { frequencyHz: -1, cmnd: 1 };
  }

  return {
    frequencyHz: sampleRate / minTau,
    cmnd: clamp01(minCmnd)
  };
}

function parabolaInterp(n: number, yLeft: number, yCenter: number, yRight: number): number {
  const nom = -4 * n * yCenter + (2 * n - 1) * yRight + (2 * n + 1) * yLeft;
  const denom = 2 * (yLeft - 2 * yCenter + yRight);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) {
    return n;
  }
  const estimate = nom / denom;
  if (!Number.isFinite(estimate) || estimate < n - 1 || estimate > n + 1) {
    return n;
  }
  return estimate;
}

function estimateTuneoConfidence(args: {
  cmnd: number;
  threshold: number;
  rms: number;
  minRms: number;
  currentMidi: number;
  previousMidi: number | null;
}): number {
  const yinScore = clamp01(1 - args.cmnd / Math.max(1e-4, args.threshold));
  const energyScore = clamp01((args.rms - args.minRms) / Math.max(1e-5, args.minRms * 10));
  const stabilityScore =
    args.previousMidi === null ? 0.7 : clamp01(1 - Math.abs(args.currentMidi - args.previousMidi) / 2.5);
  return clamp01(0.45 + 0.35 * yinScore + 0.15 * energyScore + 0.05 * stabilityScore);
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function getRelativeDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(b), 1e-6);
  return Math.abs(a - b) / denom;
}

function resolveAnalyserFftSize(requiredSamples: number): number {
  const minFft = 32;
  const maxFft = 32768;
  let fftSize = minFft;
  while (fftSize < requiredSamples && fftSize < maxFft) {
    fftSize <<= 1;
  }
  return Math.min(maxFft, fftSize);
}

function pushHistory(history: number[], value: number): void {
  history.shift();
  history.push(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
