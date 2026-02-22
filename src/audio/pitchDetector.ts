import type { PitchFrame } from '../types/models';
import aubioWasmUrl from 'aubiojs/build/aubio.wasm?url';

export type PitchListener = (frame: PitchFrame) => void;

type PitchDetectorOptions = {
  roundMidi?: boolean;
};

export class PitchDetectorService {
  private listeners = new Set<PitchListener>();
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private aubioPitch: ((samples: Float32Array) => number | null) | null = null;
  private aubioConfidence: (() => number) | null = null;
  private readonly roundMidi: boolean;

  constructor(private readonly ctx: AudioContext, options: PitchDetectorOptions = {}) {
    this.roundMidi = options.roundMidi ?? true;
  }

  async init(): Promise<void> {
    const aubioModule = await import('aubiojs');
    const aubioFactory = (aubioModule as unknown as {
      default?: (options?: { locateFile?: (path: string) => string }) => Promise<unknown>;
    }).default;
    if (!aubioFactory) {
      throw new Error('aubiojs failed to load');
    }
    const aubio = (await aubioFactory({
      locateFile: (path: string) => (path.endsWith('.wasm') ? aubioWasmUrl : path)
    })) as {
      Pitch?: new (method: string, bufferSize: number, hopSize: number, sampleRate: number) => { do: (buffer: Float32Array) => number };
    };

    if (!aubio.Pitch) {
      throw new Error('aubiojs Pitch API unavailable');
    }

    const detector = new aubio.Pitch('yinfft', 2048, 1024, this.ctx.sampleRate) as {
      do: (buffer: Float32Array) => number;
      getConfidence?: () => number;
    };
    this.aubioPitch = (samples: Float32Array) => {
      const hz = detector.do(samples);
      if (!hz || hz <= 0) return null;
      const midi = 69 + 12 * Math.log2(hz / 440);
      return this.roundMidi ? Math.round(midi) : midi;
    };
    this.aubioConfidence = typeof detector.getConfidence === 'function' ? () => detector.getConfidence?.() ?? 0 : null;
  }

  start(source: AudioNode): void {
    if (!this.aubioPitch) throw new Error('PitchDetectorService not initialized');
    const processor = this.ctx.createScriptProcessor(2048, 1, 1);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(this.ctx.destination);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const midi = this.aubioPitch?.(input) ?? null;
      const detectorConfidence = this.aubioConfidence?.() ?? 0.8;
      const frame: PitchFrame = {
        t_seconds: this.ctx.currentTime,
        midi_estimate: midi,
        confidence: midi === null ? 0 : Math.max(0, Math.min(1, detectorConfidence))
      };
      for (const listener of this.listeners) listener(frame);
    };

    this.processor = processor;
    this.sink = sink;
  }

  stop(): void {
    if (!this.processor) return;
    this.processor.disconnect();
    this.sink?.disconnect();
    this.processor = null;
    this.sink = null;
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
