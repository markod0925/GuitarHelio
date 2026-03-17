import type { PitchFrame } from '../types/models';

export type PitchStabilityFilterOptions = {
  minConfidence: number;
  smoothingAlpha: number;
  maxOutlierDeltaSemitones: number;
  switchHysteresisSemitones: number;
  switchConfirmFrames: number;
  maxMissedFrames: number;
  emitLockedMidiOnMissedFrames: boolean;
};

const DEFAULT_OPTIONS: PitchStabilityFilterOptions = {
  minConfidence: 0.62,
  smoothingAlpha: 0.24,
  maxOutlierDeltaSemitones: 2.6,
  switchHysteresisSemitones: 0.72,
  switchConfirmFrames: 4,
  maxMissedFrames: 4,
  emitLockedMidiOnMissedFrames: true
};

export class PitchStabilityFilter {
  private readonly options: PitchStabilityFilterOptions;
  private smoothedMidi: number | null = null;
  private lockedMidi: number | null = null;
  private lockedString: number | null = null;
  private lockedFret: number | null = null;
  private lockedBestNoteId: string | null = null;
  private pendingMidi: number | null = null;
  private pendingMidiFrames = 0;
  private missedFrames = 0;

  constructor(options: Partial<PitchStabilityFilterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(): void {
    this.smoothedMidi = null;
    this.lockedMidi = null;
    this.lockedString = null;
    this.lockedFret = null;
    this.lockedBestNoteId = null;
    this.pendingMidi = null;
    this.pendingMidiFrames = 0;
    this.missedFrames = 0;
  }

  update(frame: PitchFrame): PitchFrame {
    const rawMidi = frame.midi_estimate;
    const confidence = sanitizeConfidence(frame.confidence);
    const valid =
      rawMidi !== null &&
      Number.isFinite(rawMidi) &&
      confidence >= this.options.minConfidence;

    if (!valid) {
      return this.handleMissedFrame(frame, confidence);
    }

    this.missedFrames = 0;
    if (this.smoothedMidi === null) {
      this.smoothedMidi = rawMidi;
    } else {
      const delta = rawMidi - this.smoothedMidi;
      if (Math.abs(delta) > this.options.maxOutlierDeltaSemitones) {
        return this.handleMissedFrame(frame, confidence);
      }
      this.smoothedMidi += this.options.smoothingAlpha * delta;
    }

    const roundedMidi = Math.round(this.smoothedMidi);
    if (this.lockedMidi === null) {
      this.lockedMidi = roundedMidi;
      this.pendingMidi = null;
      this.pendingMidiFrames = 0;
    } else if (roundedMidi === this.lockedMidi) {
      this.pendingMidi = null;
      this.pendingMidiFrames = 0;
    } else if (Math.abs(this.smoothedMidi - this.lockedMidi) < this.options.switchHysteresisSemitones) {
      this.pendingMidi = null;
      this.pendingMidiFrames = 0;
    } else if (this.pendingMidi !== roundedMidi) {
      this.pendingMidi = roundedMidi;
      this.pendingMidiFrames = 1;
    } else {
      this.pendingMidiFrames += 1;
      if (this.pendingMidiFrames >= this.options.switchConfirmFrames) {
        this.lockedMidi = roundedMidi;
        this.pendingMidi = null;
        this.pendingMidiFrames = 0;
      }
    }

    this.lockedString = sanitizeOptionalInteger(frame.detected_string);
    this.lockedFret = sanitizeOptionalInteger(frame.detected_fret);
    this.lockedBestNoteId = sanitizeOptionalString(frame.best_note_id);

    return {
      ...frame,
      t_seconds: frame.t_seconds,
      midi_estimate: this.lockedMidi ?? roundedMidi,
      confidence,
      detected_string: this.lockedString,
      detected_fret: this.lockedFret,
      best_note_id: this.lockedBestNoteId
    };
  }

  getLockedMidi(): number | null {
    return this.lockedMidi;
  }

  private handleMissedFrame(frame: PitchFrame, confidence: number): PitchFrame {
    this.missedFrames += 1;
    if (this.missedFrames > this.options.maxMissedFrames) {
      this.reset();
      return {
        ...frame,
        t_seconds: frame.t_seconds,
        midi_estimate: null,
        confidence,
        detected_string: null,
        detected_fret: null,
        best_note_id: null
      };
    }

    const holdMidi =
      this.options.emitLockedMidiOnMissedFrames &&
      this.lockedMidi !== null
        ? this.lockedMidi
        : null;

    return {
      ...frame,
      t_seconds: frame.t_seconds,
      midi_estimate: holdMidi,
      confidence,
      detected_string: holdMidi === null ? null : this.lockedString,
      detected_fret: holdMidi === null ? null : this.lockedFret,
      best_note_id: holdMidi === null ? null : this.lockedBestNoteId
    };
  }
}

function sanitizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sanitizeOptionalInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function sanitizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
