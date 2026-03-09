import aubioFactory from 'aubiojs/build/aubio.esm.js';
import aubioWasmUrl from 'aubiojs/build/aubio.esm.wasm?url';
import type { PitchFrame } from '../types/models';
import type { PitchCalibrationProfile } from './pitchCalibration';
import { applyPitchCalibration } from './pitchCalibration';

export type AubioPitchListener = (frame: PitchFrame) => void;

type AubioPitchMethod =
  | 'default'
  | 'yin'
  | 'mcomb'
  | 'schmitt'
  | 'fcomb'
  | 'yinfft'
  | 'yinfast'
  | 'specacf';

type AubioPitchDetectorOptions = {
  method?: AubioPitchMethod;
  bufferSize?: number;
  hopSize?: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  minRms?: number;
  calibrationProfile?: PitchCalibrationProfile | null;
};

type AubioPitch = {
  do(buffer: Float32Array | number[]): number;
};

type AubioModule = {
  Pitch: {
    new (
      method: AubioPitchMethod,
      bufferSize: number,
      hopSize: number,
      sampleRate: number
    ): AubioPitch;
  };
};

type AubioFactory = (
  options?: {
    locateFile?: (path: string) => string;
  }
) => Promise<AubioModule>;

const DEFAULT_BUFFER_SIZE = 2048;
const DEFAULT_HOP_SIZE = 1024;
const DEFAULT_MIN_FREQUENCY_HZ = 65;
const DEFAULT_MAX_FREQUENCY_HZ = 1200;
const DEFAULT_MIN_RMS = 0.0015;
const GUITAR_MIN_MIDI = 35;
const GUITAR_MAX_MIDI = 88;
const GUITAR_MIDI_CENTER = 58;

export class AubioPitchDetectorService {
  private listeners = new Set<AubioPitchListener>();
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private initialized = false;
  private pitch: AubioPitch | null = null;
  private pitchOutputIsMidi = false;
  private ringBuffer: Float32Array | null = null;
  private frameBuffer: Float32Array | null = null;
  private ringWriteIndex = 0;
  private totalSamples = 0;
  private samplesSinceLastAnalysis = 0;

  private readonly method: AubioPitchMethod;
  private readonly bufferSize: number;
  private readonly hopSize: number;
  private readonly minFrequencyHz: number;
  private readonly maxFrequencyHz: number;
  private readonly minRms: number;
  private readonly calibrationProfile: PitchCalibrationProfile | null;

  constructor(
    private readonly ctx: AudioContext,
    options: AubioPitchDetectorOptions = {}
  ) {
    this.method = options.method ?? 'yinfft';
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.hopSize = options.hopSize ?? DEFAULT_HOP_SIZE;
    this.minFrequencyHz = options.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ;
    this.maxFrequencyHz = options.maxFrequencyHz ?? DEFAULT_MAX_FREQUENCY_HZ;
    this.minRms = options.minRms ?? DEFAULT_MIN_RMS;
    this.calibrationProfile = options.calibrationProfile ?? null;
  }

  async init(): Promise<void> {
    const runtimeFactory = aubioFactory as unknown as AubioFactory;
    const aubio = await runtimeFactory({
      locateFile: (path) => (path.endsWith('.wasm') ? aubioWasmUrl : path)
    });
    this.pitch = new aubio.Pitch(this.method, this.bufferSize, this.hopSize, this.ctx.sampleRate);
    const pitchWithUnit = this.pitch as unknown as {
      setUnit?: (unit: string) => void;
    };
    if (typeof pitchWithUnit.setUnit === 'function') {
      try {
        pitchWithUnit.setUnit('midi');
        this.pitchOutputIsMidi = true;
      } catch {
        this.pitchOutputIsMidi = false;
      }
    } else {
      this.pitchOutputIsMidi = false;
    }
    this.initialized = true;
  }

  start(source: AudioNode): void {
    if (!this.initialized || !this.pitch) {
      throw new Error('AubioPitchDetectorService not initialized');
    }

    this.stop();

    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sink.connect(this.ctx.destination);
    this.sink = sink;

    const scriptProcessor = this.ctx.createScriptProcessor(this.hopSize, 1, 1);
    this.ringBuffer = new Float32Array(this.bufferSize);
    this.frameBuffer = new Float32Array(this.bufferSize);
    this.ringWriteIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastAnalysis = 0;

    scriptProcessor.onaudioprocess = (event) => {
      const ringBuffer = this.ringBuffer;
      const frameBuffer = this.frameBuffer;
      if (!ringBuffer || !frameBuffer) return;

      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i += 1) {
        ringBuffer[this.ringWriteIndex] = input[i];
        this.ringWriteIndex = (this.ringWriteIndex + 1) % this.bufferSize;
        this.totalSamples += 1;
        this.samplesSinceLastAnalysis += 1;
      }

      if (this.totalSamples < this.bufferSize || this.samplesSinceLastAnalysis < this.hopSize) {
        return;
      }
      this.samplesSinceLastAnalysis = 0;
      copyRingToFrame(ringBuffer, frameBuffer, this.ringWriteIndex);

      const rms = computeRms(frameBuffer);
      if (!Number.isFinite(rms) || rms < this.minRms) {
        this.emitFrame({
          t_seconds: this.ctx.currentTime,
          midi_estimate: null,
          confidence: 0
        });
        return;
      }

      const frequencyHz = Number(this.pitch?.do(frameBuffer) ?? 0);
      const midiEstimateRaw = this.resolveMidiFromAubioValue(frequencyHz);
      if (midiEstimateRaw === null) {
        this.emitFrame({
          t_seconds: this.ctx.currentTime,
          midi_estimate: null,
          confidence: 0
        });
        return;
      }

      const correctedMidi = applyPitchCalibration(midiEstimateRaw, this.calibrationProfile);
      this.emitFrame({
        t_seconds: this.ctx.currentTime,
        midi_estimate: correctedMidi,
        confidence: 1
      });
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(sink);
    this.scriptProcessor = scriptProcessor;
  }

  stop(): void {
    this.scriptProcessor?.disconnect();
    if (this.scriptProcessor) {
      this.scriptProcessor.onaudioprocess = null;
    }
    this.scriptProcessor = null;
    this.ringBuffer = null;
    this.frameBuffer = null;
    this.ringWriteIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastAnalysis = 0;

    this.sink?.disconnect();
    this.sink = null;
  }

  onPitch(listener: AubioPitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitFrame(frame: PitchFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private resolveMidiFromAubioValue(value: number): number | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (this.pitchOutputIsMidi) return value;

    const asMidi = value;
    const asHzMidi = 69 + 12 * Math.log2(value / 440);
    const asMidiInGuitarRange = asMidi >= GUITAR_MIN_MIDI && asMidi <= GUITAR_MAX_MIDI;
    const asHzInGuitarRange = asHzMidi >= GUITAR_MIN_MIDI && asHzMidi <= GUITAR_MAX_MIDI;

    if (asHzInGuitarRange && !asMidiInGuitarRange) return asHzMidi;
    if (!asHzInGuitarRange && asMidiInGuitarRange) return asMidi;
    if (asHzInGuitarRange && asMidiInGuitarRange) {
      return Math.abs(asHzMidi - GUITAR_MIDI_CENTER) <= Math.abs(asMidi - GUITAR_MIDI_CENTER) ? asHzMidi : asMidi;
    }

    if (value >= this.minFrequencyHz && value <= this.maxFrequencyHz) {
      return asHzMidi;
    }
    if (value <= 127) {
      return asMidi;
    }
    return asHzMidi;
  }
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    energy += value * value;
  }
  return Math.sqrt(energy / samples.length);
}

function copyRingToFrame(ring: Float32Array, frame: Float32Array, writeIndex: number): void {
  for (let i = 0; i < ring.length; i += 1) {
    const idx = (writeIndex + i) % ring.length;
    frame[i] = ring[idx];
  }
}
