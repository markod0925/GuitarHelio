import type { PitchFrame } from '../types/models';

export type TunerReading = {
  detectedMidi: number;
  cents: number;
};

type TunerPitchStabilizerOptions = {
  minConfidence: number;
  midiSmoothingAlpha: number;
  centsSmoothingAlpha: number;
  switchHysteresisSemitones: number;
  switchConfirmFrames: number;
  maxMissedFrames: number;
  maxOutlierDeltaSemitones: number;
  centerDeadbandCents: number;
  centsQuantizeStep: number;
};

const DEFAULT_OPTIONS: TunerPitchStabilizerOptions = {
  minConfidence: 0.62,
  midiSmoothingAlpha: 0.2,
  centsSmoothingAlpha: 0.28,
  switchHysteresisSemitones: 0.62,
  switchConfirmFrames: 3,
  maxMissedFrames: 4,
  maxOutlierDeltaSemitones: 2.4,
  centerDeadbandCents: 1.2,
  centsQuantizeStep: 0.5
};

export class TunerPitchStabilizer {
  private readonly options: TunerPitchStabilizerOptions;
  private smoothedMidi: number | null = null;
  private smoothedCents: number | null = null;
  private lockedDetectedMidi: number | null = null;
  private pendingDetectedMidi: number | null = null;
  private pendingDetectedMidiFrames = 0;
  private missedFrames = 0;

  constructor(options: Partial<TunerPitchStabilizerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(): void {
    this.smoothedMidi = null;
    this.smoothedCents = null;
    this.lockedDetectedMidi = null;
    this.pendingDetectedMidi = null;
    this.pendingDetectedMidiFrames = 0;
    this.missedFrames = 0;
  }

  update(frame: PitchFrame, targetMidi: number): TunerReading | null {
    const rawMidi = frame.midi_estimate;
    const hasValidPitch =
      rawMidi !== null &&
      Number.isFinite(rawMidi) &&
      Number.isFinite(frame.confidence) &&
      frame.confidence >= this.options.minConfidence;

    if (!hasValidPitch) {
      return this.handleMissingFrame();
    }

    this.missedFrames = 0;
    if (this.smoothedMidi === null) {
      this.smoothedMidi = rawMidi;
    } else {
      const delta = rawMidi - this.smoothedMidi;
      if (Math.abs(delta) > this.options.maxOutlierDeltaSemitones) {
        return this.handleMissingFrame();
      }
      this.smoothedMidi += this.options.midiSmoothingAlpha * delta;
    }

    const roundedMidi = Math.round(this.smoothedMidi);
    if (this.lockedDetectedMidi === null) {
      this.lockedDetectedMidi = roundedMidi;
      this.pendingDetectedMidi = null;
      this.pendingDetectedMidiFrames = 0;
    } else {
      this.updateNoteLock(roundedMidi);
    }

    const cents = (this.smoothedMidi - targetMidi) * 100;
    if (this.smoothedCents === null) {
      this.smoothedCents = cents;
    } else {
      this.smoothedCents += this.options.centsSmoothingAlpha * (cents - this.smoothedCents);
    }

    const finalCents = this.quantizeCents(this.smoothedCents);
    return {
      detectedMidi: this.lockedDetectedMidi ?? roundedMidi,
      cents: finalCents
    };
  }

  private handleMissingFrame(): TunerReading | null {
    this.missedFrames += 1;
    if (
      this.missedFrames <= this.options.maxMissedFrames &&
      this.lockedDetectedMidi !== null &&
      this.smoothedCents !== null
    ) {
      return {
        detectedMidi: this.lockedDetectedMidi,
        cents: this.quantizeCents(this.smoothedCents)
      };
    }
    this.reset();
    return null;
  }

  private updateNoteLock(candidateMidi: number): void {
    if (this.lockedDetectedMidi === null || this.smoothedMidi === null) {
      this.lockedDetectedMidi = candidateMidi;
      this.pendingDetectedMidi = null;
      this.pendingDetectedMidiFrames = 0;
      return;
    }

    if (candidateMidi === this.lockedDetectedMidi) {
      this.pendingDetectedMidi = null;
      this.pendingDetectedMidiFrames = 0;
      return;
    }

    if (Math.abs(this.smoothedMidi - this.lockedDetectedMidi) < this.options.switchHysteresisSemitones) {
      this.pendingDetectedMidi = null;
      this.pendingDetectedMidiFrames = 0;
      return;
    }

    if (this.pendingDetectedMidi !== candidateMidi) {
      this.pendingDetectedMidi = candidateMidi;
      this.pendingDetectedMidiFrames = 1;
      return;
    }

    this.pendingDetectedMidiFrames += 1;
    if (this.pendingDetectedMidiFrames >= this.options.switchConfirmFrames) {
      this.lockedDetectedMidi = candidateMidi;
      this.pendingDetectedMidi = null;
      this.pendingDetectedMidiFrames = 0;
    }
  }

  private quantizeCents(rawCents: number): number {
    if (!Number.isFinite(rawCents)) return 0;
    const withDeadband = Math.abs(rawCents) <= this.options.centerDeadbandCents ? 0 : rawCents;
    const step = this.options.centsQuantizeStep;
    if (step <= 0) return withDeadband;
    return Math.round(withDeadband / step) * step;
  }
}
