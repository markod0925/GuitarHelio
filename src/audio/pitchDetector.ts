import type { PitchFrame } from '../types/models';
import { DEFAULT_AUDIO_INPUT_MODE, type AudioInputMode } from '../types/audioInputMode';
import type { PitchCalibrationProfile } from './pitchCalibration';
import { applyPitchCalibration } from './pitchCalibration';
import dspCoreWasmUrl from './dsp-core/gh_dsp_core_bg.wasm?url';
import pitchWorkletUrl from './pitchWorklet.js?url';

export type PitchListener = (frame: PitchFrame) => void;
export type PitchDetectorPreset = 'baseline' | 'ac14' | 'spectral_game_runtime_unified_v3';

export type SpectralRuntimeNote = {
  id: string;
  string: number;
  fret: number;
  midi: number;
  frequency_hz: number;
};

export type SpectralRuntimeChord = {
  id: string;
  member_note_ids: string[];
};

export type SpectralRuntimeModel = {
  notes: SpectralRuntimeNote[];
  chords: SpectralRuntimeChord[];
};

type PitchDetectorOptions = {
  roundMidi?: boolean;
  smoothingAlpha?: number;
  calibrationProfile?: PitchCalibrationProfile | null;
  audioInputMode?: AudioInputMode;
  enableDspCore?: boolean;
  detectorPreset?: PitchDetectorPreset;
  spectralModel?: SpectralRuntimeModel | null;
};

type WorkletPitchPayload = PitchFrame & {
  type?: 'frame';
  delay_samples?: number;
  reference_policy_applied?: boolean;
  selected_notes?: PitchFrame['selected_notes'];
  chord_scores?: PitchFrame['chord_scores'];
  detected_string?: number | null;
  detected_fret?: number | null;
  best_note_id?: string | null;
};

type WorkletStatusPayload = {
  type: 'status';
  legacy_fallback?: boolean;
  reason?: string;
};

type WorkletMessagePayload = WorkletPitchPayload | WorkletStatusPayload;
let dspWasmBytesPromise: Promise<ArrayBuffer | null> | null = null;
const FALLBACK_PRESET_CONFIG: Record<
  PitchDetectorPreset,
  {
    energyThreshold: number;
    correlationThreshold: number;
    decayGraceFrames: number;
    decayEnergyFactor: number;
    decayCorrelationThreshold: number;
  }
> = {
  baseline: {
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  },
  ac14: {
    energyThreshold: 0.003074202393734413,
    correlationThreshold: 0.6559736283225794,
    decayGraceFrames: 4,
    decayEnergyFactor: 0.4157769062463687,
    decayCorrelationThreshold: 0.6288579679610562
  },
  spectral_game_runtime_unified_v3: {
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  }
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
  private readonly smoothingAlpha: number;
  private readonly calibrationProfile: PitchCalibrationProfile | null;
  private readonly audioInputMode: AudioInputMode;
  private readonly enableDspCore: boolean;
  private readonly detectorPreset: PitchDetectorPreset;
  private readonly spectralModel: SpectralRuntimeModel | null;
  private smoothedMidiEstimate: number | null = null;
  private legacyFallback = false;
  private legacyFallbackReason: string | null = null;
  private micTapNode: GainNode | null = null;
  private referenceTapNode: GainNode | null = null;
  private channelMergerNode: ChannelMergerNode | null = null;
  private silentReferenceSource: ConstantSourceNode | null = null;
  private backendStatusResolver: (() => void) | null = null;
  private backendStatusTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private analyserDecayGraceFrames = 0;

  constructor(private readonly ctx: AudioContext, options: PitchDetectorOptions = {}) {
    this.roundMidi = options.roundMidi ?? true;
    this.smoothingAlpha = clamp01(options.smoothingAlpha ?? 0);
    this.calibrationProfile = options.calibrationProfile ?? null;
    this.audioInputMode = options.audioInputMode ?? DEFAULT_AUDIO_INPUT_MODE;
    this.enableDspCore = options.enableDspCore ?? true;
    this.detectorPreset = options.detectorPreset ?? 'baseline';
    this.spectralModel = options.spectralModel ?? null;
  }

  async init(): Promise<void> {
    this.workletReady = false;
    this.legacyFallback = false;
    this.legacyFallbackReason = null;
    if (typeof AudioWorkletNode !== 'undefined' && this.ctx.audioWorklet) {
      try {
        await this.ctx.audioWorklet.addModule(pitchWorkletUrl);
        this.workletReady = true;
      } catch (error) {
        // Some Android WebView builds fail to load worklet modules.
        // Continue with the analyser fallback instead of failing mic setup.
        console.warn('Pitch worklet unavailable, using analyser fallback.', error);
        if (this.enableDspCore) {
          this.legacyFallback = true;
          this.legacyFallbackReason = toErrorMessage(error);
        }
      }
    } else if (this.enableDspCore) {
      this.legacyFallback = true;
      this.legacyFallbackReason = 'AudioWorklet unavailable';
    }
    this.initialized = true;
  }

  isLegacyFallback(): boolean {
    return this.legacyFallback;
  }

  getLegacyFallbackReason(): string | null {
    return this.legacyFallbackReason;
  }

  async start(source: AudioNode, referenceSource?: AudioNode): Promise<void> {
    if (!this.initialized) throw new Error('PitchDetectorService not initialized');
    this.stop();
    this.smoothedMidiEstimate = null;
    this.analyserDecayGraceFrames = 0;

    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sink.connect(this.ctx.destination);
    this.sink = sink;

    if (this.workletReady && this.enableDspCore) {
      const backendReady = this.awaitBackendStatus(800);
      const dspWasmBytes = await loadDspWasmBytes();
      try {
        const workletNode = this.createWorkletNode(dspWasmBytes);
        this.workletNode = workletNode;

        const micTap = this.ctx.createGain();
        micTap.gain.value = 1;
        source.connect(micTap);
        this.micTapNode = micTap;

        const merger = this.ctx.createChannelMerger(2);
        this.channelMergerNode = merger;
        micTap.connect(merger, 0, 0);

        if (referenceSource) {
          const referenceTap = this.ctx.createGain();
          referenceTap.gain.value = 1;
          referenceSource.connect(referenceTap);
          referenceTap.connect(merger, 0, 1);
          this.referenceTapNode = referenceTap;
        } else {
          const silentReference = this.ctx.createConstantSource();
          silentReference.offset.value = 0;
          silentReference.connect(merger, 0, 1);
          silentReference.start();
          this.silentReferenceSource = silentReference;
        }

        merger.connect(workletNode);
        workletNode.connect(sink);
        workletNode.port.postMessage({
          type: 'config',
          audioInputMode: this.audioInputMode,
          detectorPreset: this.detectorPreset,
          spectralModel: this.spectralModel ?? undefined
        });
        workletNode.port.onmessage = (event: MessageEvent<WorkletMessagePayload>) => {
          const payload = event.data;
          if (!payload) return;
          if (payload.type === 'status') {
            this.legacyFallback = Boolean(payload.legacy_fallback);
            this.legacyFallbackReason = this.legacyFallback ? sanitizeReason(payload.reason) : null;
            this.resolveBackendStatus();
            if (this.legacyFallback && payload.reason) {
              console.warn('Pitch worklet running in legacy fallback mode.', payload.reason);
            }
            return;
          }

          const rustManagedFrame = this.detectorPreset === 'ac14' && payload.reference_policy_applied === true;
          const incomingMidi = sanitizeMidi(payload.midi_estimate);
          const normalizedMidi = rustManagedFrame
            ? incomingMidi
            : this.normalizeMidiEstimate(incomingMidi);
          const correctedMidi = rustManagedFrame
            ? normalizedMidi
            : normalizedMidi === null || !Number.isFinite(normalizedMidi)
              ? null
              : applyPitchCalibration(normalizedMidi, this.calibrationProfile);

          const baseFrame: PitchFrame = {
            t_seconds: Number.isFinite(payload.t_seconds) ? payload.t_seconds : this.ctx.currentTime,
            midi_estimate: correctedMidi,
            confidence: correctedMidi === null ? 0 : clamp01(payload.confidence),
            reference_midi: sanitizeMidi(payload.reference_midi),
            reference_correlation: sanitizeSigned(payload.reference_correlation),
            energy_ratio_db: sanitizeNumber(payload.energy_ratio_db),
            onset_strength: clamp01(payload.onset_strength ?? 0),
            contamination_score: clamp01(payload.contamination_score ?? 0),
            rejected_as_reference_bleed: Boolean(payload.rejected_as_reference_bleed),
            detected_string: sanitizeOptionalInteger(payload.detected_string),
            detected_fret: sanitizeOptionalInteger(payload.detected_fret),
            best_note_id: sanitizeOptionalString(payload.best_note_id),
            selected_notes: sanitizeSelectedNotes(payload.selected_notes),
            chord_scores: sanitizeChordScores(payload.chord_scores)
          };
          const gated = rustManagedFrame
            ? baseFrame
            : applyReferenceContaminationPolicy(baseFrame, this.audioInputMode);
          const frame: PitchFrame = {
            ...gated,
            midi_estimate:
              gated.midi_estimate === null
                ? null
                : this.roundMidi
                  ? Math.round(gated.midi_estimate)
                  : gated.midi_estimate
          };
          for (const listener of this.listeners) listener(frame);
        };

        this.legacyFallback = false;
        this.legacyFallbackReason = null;
        await backendReady;
        return;
      } catch (error) {
        console.warn('Pitch worklet node failed, using analyser fallback.', error);
        this.workletReady = false;
        this.legacyFallback = true;
        this.legacyFallbackReason = toErrorMessage(error);
        this.resolveBackendStatus();
      }
    }

    // Fallback path for environments without AudioWorklet support.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = this.detectorPreset === 'ac14' ? 4096 : 2048;
    analyser.smoothingTimeConstant = 0;
    this.analyserBuffer = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(sink);
    this.analyser = analyser;
    this.legacyFallback = this.enableDspCore;
    this.legacyFallbackReason = this.enableDspCore ? this.legacyFallbackReason ?? 'Worklet backend unavailable' : null;
    this.resolveBackendStatus();
    this.scheduleAnalyserFrame();
  }

  stop(): void {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.channelMergerNode?.disconnect();
    this.channelMergerNode = null;
    this.micTapNode?.disconnect();
    this.micTapNode = null;
    this.referenceTapNode?.disconnect();
    this.referenceTapNode = null;
    if (this.silentReferenceSource) {
      try {
        this.silentReferenceSource.stop();
      } catch {
        // no-op: already stopped
      }
      this.silentReferenceSource.disconnect();
    }
    this.silentReferenceSource = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.analyserBuffer = null;
    if (this.analyserRafId !== null) {
      cancelAnimationFrame(this.analyserRafId);
      this.analyserRafId = null;
    }
    if (this.backendStatusTimeoutId !== null) {
      clearTimeout(this.backendStatusTimeoutId);
      this.backendStatusTimeoutId = null;
    }
    if (this.backendStatusResolver) {
      this.backendStatusResolver();
      this.backendStatusResolver = null;
    }
    this.sink?.disconnect();
    this.sink = null;
    this.smoothedMidiEstimate = null;
    this.analyserDecayGraceFrames = 0;
  }

  onPitch(listener: PitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private awaitBackendStatus(timeoutMs: number): Promise<void> {
    if (this.backendStatusTimeoutId !== null) {
      clearTimeout(this.backendStatusTimeoutId);
      this.backendStatusTimeoutId = null;
    }
    if (this.backendStatusResolver) {
      this.backendStatusResolver();
      this.backendStatusResolver = null;
    }
    return new Promise((resolve) => {
      this.backendStatusResolver = () => {
        if (this.backendStatusTimeoutId !== null) {
          clearTimeout(this.backendStatusTimeoutId);
          this.backendStatusTimeoutId = null;
        }
        this.backendStatusResolver = null;
        resolve();
      };
      this.backendStatusTimeoutId = setTimeout(() => {
        this.resolveBackendStatus();
      }, Math.max(100, timeoutMs));
    });
  }

  private resolveBackendStatus(): void {
    this.backendStatusResolver?.();
  }

  private createWorkletNode(dspWasmBytes: ArrayBuffer | null): AudioWorkletNode {
    const processorOptions: {
      detectorPreset: PitchDetectorPreset;
      spectralModel?: SpectralRuntimeModel;
      dspWasmBytes?: ArrayBuffer;
    } = {
      detectorPreset: this.detectorPreset
    };
    if (this.spectralModel && this.detectorPreset === 'spectral_game_runtime_unified_v3') {
      processorOptions.spectralModel = this.spectralModel;
    }
    if (dspWasmBytes) {
      processorOptions.dspWasmBytes = dspWasmBytes;
    }
    const primaryOptions: AudioWorkletNodeOptions = {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
      processorOptions
    };

    try {
      return new AudioWorkletNode(this.ctx, 'gh-pitch-processor', primaryOptions);
    } catch (primaryError) {
      console.warn('Pitch worklet node creation failed with explicit channel config, retrying with minimal config.', primaryError);
    }

    try {
      return new AudioWorkletNode(this.ctx, 'gh-pitch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions
      });
    } catch (secondaryError) {
      console.warn('Pitch worklet node creation failed with minimal config, retrying with defaults.', secondaryError);
    }

    return new AudioWorkletNode(this.ctx, 'gh-pitch-processor', {
      processorOptions
    });
  }

  private scheduleAnalyserFrame(): void {
    this.analyserRafId = requestAnimationFrame(() => {
      this.analyserRafId = null;
      if (!this.analyser || !this.analyserBuffer) return;
      this.analyser.getFloatTimeDomainData(this.analyserBuffer as any);
      const presetConfig = FALLBACK_PRESET_CONFIG[this.detectorPreset];
      const decayActive = this.analyserDecayGraceFrames > 0;
      const estimation = estimatePitch(this.analyserBuffer, this.ctx.sampleRate, {
        energyThreshold: decayActive
          ? presetConfig.energyThreshold * presetConfig.decayEnergyFactor
          : presetConfig.energyThreshold,
        correlationThreshold: decayActive
          ? presetConfig.decayCorrelationThreshold
          : presetConfig.correlationThreshold
      });
      if (estimation.midiEstimate !== null) {
        this.analyserDecayGraceFrames = presetConfig.decayGraceFrames;
      } else if (this.analyserDecayGraceFrames > 0) {
        this.analyserDecayGraceFrames -= 1;
      }
      const midi = this.normalizeMidiEstimate(estimation.midiEstimate);
      const correctedMidi =
        midi === null || !Number.isFinite(midi) ? null : applyPitchCalibration(midi, this.calibrationProfile);
      const frame: PitchFrame = {
        t_seconds: this.ctx.currentTime,
        midi_estimate: correctedMidi === null ? null : this.roundMidi ? Math.round(correctedMidi) : correctedMidi,
        confidence: correctedMidi === null ? 0 : estimation.confidence
      };
      for (const listener of this.listeners) listener(frame);
      this.scheduleAnalyserFrame();
    });
  }

  private normalizeMidiEstimate(midiEstimate: number | null): number | null {
    if (midiEstimate === null || !Number.isFinite(midiEstimate)) {
      this.smoothedMidiEstimate = null;
      return null;
    }
    if (this.smoothingAlpha <= 0) {
      this.smoothedMidiEstimate = midiEstimate;
      return midiEstimate;
    }
    if (this.smoothedMidiEstimate === null) {
      this.smoothedMidiEstimate = midiEstimate;
      return midiEstimate;
    }
    this.smoothedMidiEstimate += this.smoothingAlpha * (midiEstimate - this.smoothedMidiEstimate);
    return this.smoothedMidiEstimate;
  }
}

export function applyReferenceContaminationPolicy(frame: PitchFrame, mode: AudioInputMode): PitchFrame {
  const midi = sanitizeMidi(frame.midi_estimate);
  if (midi === null) {
    return {
      ...frame,
      midi_estimate: null,
      confidence: 0
    };
  }

  const referenceMidi = sanitizeMidi(frame.reference_midi);
  if (referenceMidi === null) {
    return {
      ...frame,
      midi_estimate: midi,
      confidence: clamp01(frame.confidence),
      rejected_as_reference_bleed: false
    };
  }

  const referenceCorrelation = sanitizeSigned(frame.reference_correlation);
  const energyRatioDb = sanitizeNumber(frame.energy_ratio_db);
  const onsetStrength = clamp01(frame.onset_strength ?? 0);
  const contaminationScore = clamp01(
    frame.contamination_score ?? estimateContaminationScore(referenceCorrelation, energyRatioDb, onsetStrength)
  );
  const pitchMatch = Math.abs(midi - referenceMidi) <= 0.25;
  if (!pitchMatch) {
    return {
      ...frame,
      midi_estimate: midi,
      confidence: clamp01(frame.confidence),
      contamination_score: contaminationScore,
      rejected_as_reference_bleed: false
    };
  }

  if (mode === 'headphones') {
    if (referenceCorrelation >= 0.94 && energyRatioDb <= -14) {
      return {
        ...frame,
        midi_estimate: null,
        confidence: 0,
        contamination_score: contaminationScore,
        rejected_as_reference_bleed: true
      };
    }

    return {
      ...frame,
      midi_estimate: midi,
      confidence: clamp01(frame.confidence * (1 - 0.3 * contaminationScore)),
      contamination_score: contaminationScore,
      rejected_as_reference_bleed: false
    };
  }

  const highCorrelation = referenceCorrelation >= 0.86;
  const lowMicDominance = energyRatioDb <= -10;
  const strongOnset = onsetStrength >= 0.22;
  const micDominant = energyRatioDb >= 4;
  if (highCorrelation && lowMicDominance && !strongOnset && !micDominant) {
    return {
      ...frame,
      midi_estimate: null,
      confidence: 0,
      contamination_score: contaminationScore,
      rejected_as_reference_bleed: true
    };
  }

  return {
    ...frame,
    midi_estimate: midi,
    confidence: clamp01(frame.confidence * (1 - 0.45 * contaminationScore)),
    contamination_score: contaminationScore,
    rejected_as_reference_bleed: false
  };
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
  sampleRate: number,
  options: {
    energyThreshold?: number;
    correlationThreshold?: number;
  } = {}
): { midiEstimate: number | null; confidence: number } {
  const rawEnergyThreshold = options.energyThreshold;
  const rawCorrelationThreshold = options.correlationThreshold;
  const energyThreshold = typeof rawEnergyThreshold === 'number' && Number.isFinite(rawEnergyThreshold)
    ? Math.max(0, rawEnergyThreshold)
    : FALLBACK_PRESET_CONFIG.baseline.energyThreshold;
  const correlationThreshold = typeof rawCorrelationThreshold === 'number' && Number.isFinite(rawCorrelationThreshold)
    ? clamp01(rawCorrelationThreshold)
    : FALLBACK_PRESET_CONFIG.baseline.correlationThreshold;
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
  if (!Number.isFinite(rms) || rms < energyThreshold) {
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

  if (bestLag <= 0 || bestCorrelation < correlationThreshold) {
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

function estimateContaminationScore(referenceCorrelation: number, energyRatioDb: number, onsetStrength: number): number {
  const corrScore = clamp01((referenceCorrelation - 0.55) / 0.45);
  const bleedScore = clamp01((-energyRatioDb - 3) / 18);
  return clamp01(corrScore * 0.65 + bleedScore * 0.35 - onsetStrength * 0.25);
}

function sanitizeMidi(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

function sanitizeNumber(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return value;
}

function sanitizeSigned(value: number | null | undefined): number {
  return Math.max(-1, Math.min(1, sanitizeNumber(value)));
}

function sanitizeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeOptionalInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded;
}

function sanitizeSelectedNotes(value: unknown): PitchFrame['selected_notes'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<PitchFrame['selected_notes']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const data = item as Record<string, unknown>;
    const rawMidi = data.midi;
    if (typeof rawMidi !== 'number' || !Number.isFinite(rawMidi)) continue;
    out.push({
      note_id: sanitizeOptionalString(data.note_id),
      midi: rawMidi,
      string: sanitizeOptionalInteger(data.string),
      fret: sanitizeOptionalInteger(data.fret),
      score: sanitizeNumber(data.score as number | null | undefined)
    });
  }
  return out;
}

function sanitizeChordScores(value: unknown): PitchFrame['chord_scores'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<PitchFrame['chord_scores']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const data = item as Record<string, unknown>;
    const chordId = sanitizeOptionalString(data.chord_id);
    if (!chordId) continue;
    out.push({
      chord_id: chordId,
      score: sanitizeNumber(data.score as number | null | undefined)
    });
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return 'Unknown error';
}

async function loadDspWasmBytes(): Promise<ArrayBuffer | null> {
  if (!dspWasmBytesPromise) {
    dspWasmBytesPromise = fetch(dspCoreWasmUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load DSP WASM (${response.status})`);
        }
        return await response.arrayBuffer();
      })
      .catch((error) => {
        console.warn('Unable to preload DSP WASM bytes for worklet processor options.', error);
        return null;
      });
  }
  return await dspWasmBytesPromise;
}
