import type { PitchFrame } from '../types/models';
import pitchWorkletUrl from './pitchWorklet.js?url';

export type PitchListener = (frame: PitchFrame) => void;

type PitchDetectorOptions = {
  roundMidi?: boolean;
};

export class PitchDetectorService {
  private listeners = new Set<PitchListener>();
  private workletNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array | null = null;
  private analyserRafId: number | null = null;
  private sink: GainNode | null = null;
  private workletReady = false;
  private initialized = false;
  private readonly roundMidi: boolean;

  constructor(private readonly ctx: AudioContext, options: PitchDetectorOptions = {}) {
    this.roundMidi = options.roundMidi ?? true;
  }

  async init(): Promise<void> {
    this.workletReady = false;
    if (typeof AudioWorkletNode !== 'undefined' && this.ctx.audioWorklet) {
      await this.ctx.audioWorklet.addModule(pitchWorkletUrl);
      this.workletReady = true;
    }
    this.initialized = true;
  }

  start(source: AudioNode): void {
    if (!this.initialized) throw new Error('PitchDetectorService not initialized');
    this.stop();

    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sink.connect(this.ctx.destination);
    this.sink = sink;

    if (this.workletReady) {
      const workletNode = new AudioWorkletNode(this.ctx, 'gh-pitch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        outputChannelCount: [1]
      });
      workletNode.port.onmessage = (event: MessageEvent<PitchFrame>) => {
        const payload = event.data;
        if (!payload) return;
        const midi = payload.midi_estimate;
        const frame: PitchFrame = {
          t_seconds: Number.isFinite(payload.t_seconds) ? payload.t_seconds : this.ctx.currentTime,
          midi_estimate: midi === null ? null : this.roundMidi ? Math.round(midi) : midi,
          confidence: midi === null ? 0 : clamp01(payload.confidence)
        };
        for (const listener of this.listeners) listener(frame);
      };
      source.connect(workletNode);
      workletNode.connect(sink);
      this.workletNode = workletNode;
      return;
    }

    // Fallback path for environments without AudioWorklet support.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    this.analyserBuffer = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(sink);
    this.analyser = analyser;
    this.scheduleAnalyserFrame();
  }

  stop(): void {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.analyserBuffer = null;
    if (this.analyserRafId !== null) {
      cancelAnimationFrame(this.analyserRafId);
      this.analyserRafId = null;
    }
    this.sink?.disconnect();
    this.sink = null;
  }

  onPitch(listener: PitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleAnalyserFrame(): void {
    this.analyserRafId = requestAnimationFrame(() => {
      this.analyserRafId = null;
      if (!this.analyser || !this.analyserBuffer) return;
      this.analyser.getFloatTimeDomainData(this.analyserBuffer as any);
      const estimation = estimatePitch(this.analyserBuffer, this.ctx.sampleRate);
      const frame: PitchFrame = {
        t_seconds: this.ctx.currentTime,
        midi_estimate:
          estimation.midiEstimate === null
            ? null
            : this.roundMidi
              ? Math.round(estimation.midiEstimate)
              : estimation.midiEstimate,
        confidence: estimation.confidence
      };
      for (const listener of this.listeners) listener(frame);
      this.scheduleAnalyserFrame();
    });
  }
}

export function isValidHeldHit(
  frames: PitchFrame[],
  expectedMidi: number,
  tolerance: number,
  holdMs = 80,
  minConfidence = 0.7
): boolean {
  if (frames.length < 2) return false;

  let streakStartSeconds: number | null = null;

  for (const frame of frames) {
    const isValid =
      frame.midi_estimate !== null &&
      frame.confidence >= minConfidence &&
      Math.abs(frame.midi_estimate - expectedMidi) <= tolerance;

    if (!isValid) {
      streakStartSeconds = null;
      continue;
    }

    if (streakStartSeconds === null) {
      streakStartSeconds = frame.t_seconds;
      continue;
    }

    if ((frame.t_seconds - streakStartSeconds) * 1000 >= holdMs) {
      return true;
    }
  }

  return false;
}

function estimatePitch(
  samples: ArrayLike<number>,
  sampleRate: number
): { midiEstimate: number | null; confidence: number } {
  const minFrequency = 65;
  const maxFrequency = 1200;
  const minLag = Math.max(1, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(samples.length - 2, Math.floor(sampleRate / minFrequency));

  let mean = 0;
  for (let i = 0; i < samples.length; i += 1) {
    mean += samples[i];
  }
  mean /= samples.length;

  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = samples[i] - mean;
    energy += centered * centered;
  }
  const rms = Math.sqrt(energy / samples.length);
  if (!Number.isFinite(rms) || rms < 0.0035) {
    return { midiEstimate: null, confidence: 0 };
  }

  let bestLag = -1;
  let bestCorrelation = -1;
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
    const correlation = cross / denom;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestCorrelation < 0.58) {
    return { midiEstimate: null, confidence: clamp01(bestCorrelation) };
  }

  const frequencyHz = sampleRate / bestLag;
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return { midiEstimate: null, confidence: 0 };
  }
  return {
    midiEstimate: 69 + 12 * Math.log2(frequencyHz / 440),
    confidence: clamp01((bestCorrelation - 0.45) / 0.5)
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
