export interface MidiNoteEvent {
  pitch: number;
  velocity: number;
  startTicks: number;
  endTicks: number;
  startTime: number;
  endTime: number;
}

export interface MidiTrack {
  name?: string;
  channel?: number;
  program?: number;
  isDrum: boolean;
  notes: MidiNoteEvent[];
}

export interface TempoEvent {
  ticks: number;
  time: number;
  bpm: number;
  microsecondsPerQuarter: number;
}

export interface TimeSignatureEvent {
  numerator: number;
  denominator: number;
  ticks: number;
  time: number;
}

export interface MidiSong {
  ppq: number;
  tracks: MidiTrack[];
  tempos: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  endTicks: number;
  ticksToSeconds: (ticks: number) => number;
}

export interface TabNote {
  degree: string;
  octave: string;
  string: number;
  fret: number;
}

export interface TabEvent {
  time: number;
  time_ticks: number;
  measure_timing: number;
  time_signature_change?: [number, number];
  notes?: TabNote[];
  processing?: TabEventProcessingDiagnostics;
}

export interface TabMeasure {
  events: TabEvent[];
}

export interface TabJson {
  tuning: number[];
  measures: TabMeasure[];
}

export interface TabWeights {
  b: number;
  height: number;
  length: number;
  n_changed_strings: number;
}

export type DifficultyLevel = "easy" | "medium" | "hard";

export interface FretboardConstraints {
  maxFretSpan: number;
  maxReachFret: number;
  // 1-based string numbers (e.g. [5, 6] for low A/E on standard guitar).
  allowedStrings?: number[];
  // Absolute fret numbers (e.g. [0, 5, 6, 7]).
  allowedFrets?: number[];
}

export interface DifficultyPreset {
  level: DifficultyLevel;
  weights: TabWeights;
  fretboard: FretboardConstraints;
  soft: SoftModeOptions;
}

export type FallbackStrategy = "none" | "greedy_drop";

export interface SoftModeOptions {
  allowNoteDrop: boolean;
  velocityThreshold: number;
  minDurationTicks: number;
  onsetMergeWindowTicks: number;
  maxNotesPerEvent: number;
  maxSubsetCandidates: number;
  alpha: number;
  beta: number;
  dropPenalty: number;
  fallbackStrategy: FallbackStrategy;
  includeEventDiagnostics: boolean;
}

export interface TabEventProcessingDiagnostics {
  originalNotes: number[];
  mergedNotes: number[];
  keptNotes: number[];
  droppedNotes: number[];
  droppedNotesCount: number;
  droppedWeight: number;
  dropCost: number;
  selectedSubsetId: string;
  candidateCount: number;
}

export interface TimelineEventData {
  notes?: MidiNoteEvent[];
  time_signature?: TimeSignatureEvent;
}
