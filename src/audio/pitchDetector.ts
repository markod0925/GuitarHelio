import type { PitchFrame } from '../types/models';

export type PitchListener = (frame: PitchFrame) => void;

export class PitchDetectorService {
  private listeners = new Set<PitchListener>();
  private processor: ScriptProcessorNode | null = null;
  private aubioPitch: ((samples: Float32Array) => number | null) | null = null;

  constructor(private readonly ctx: AudioContext) {}

  async init(): Promise<void> {
    const aubioModule = await import('aubiojs');
    const aubioFactory = (aubioModule as unknown as { default?: () => Promise<unknown> }).default;
    if (!aubioFactory) {
      throw new Error('aubiojs failed to load');
    }
    const aubio = await aubioFactory() as {
      Pitch?: new (method: string, bufferSize: number, hopSize: number, sampleRate: number) => { do: (buffer: Float32Array) => number };
    };

    if (!aubio.Pitch) {
      throw new Error('aubiojs Pitch API unavailable');
    }

    const detector = new aubio.Pitch('yinfft', 2048, 1024, this.ctx.sampleRate);
    this.aubioPitch = (samples: Float32Array) => {
      const hz = detector.do(samples);
      if (!hz || hz <= 0) return null;
      return Math.round(69 + 12 * Math.log2(hz / 440));
    };
  }

  start(source: AudioNode): void {
    if (!this.aubioPitch) throw new Error('PitchDetectorService not initialized');
    const processor = this.ctx.createScriptProcessor(2048, 1, 1);
    source.connect(processor);
    processor.connect(this.ctx.destination);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const midi = this.aubioPitch?.(input) ?? null;
      const frame: PitchFrame = {
        t_seconds: this.ctx.currentTime,
        midi_estimate: midi,
        confidence: midi === null ? 0 : 0.8
      };
      for (const listener of this.listeners) listener(frame);
    };

    this.processor = processor;
  }

  stop(): void {
    if (!this.processor) return;
    this.processor.disconnect();
    this.processor = null;
  }

  onPitch(listener: PitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  const valid = frames.filter((f) =>
    f.midi_estimate !== null &&
    f.confidence >= minConfidence &&
    Math.abs(f.midi_estimate - expectedMidi) <= tolerance
  );

  if (valid.length === 0) return false;
  const start = valid[0].t_seconds;
  const end = valid[valid.length - 1].t_seconds;
  return (end - start) * 1000 >= holdMs;
}
