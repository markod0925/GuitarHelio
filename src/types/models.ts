export type SourceNote = {
  tick_on: number;
  tick_off: number;
  midi_note: number;
  velocity: number;
  channel: number;
  track: number;
};

export type TargetNote = {
  id: string;
  tick: number;
  duration_ticks: number;
  string: number;
  fret: number;
  finger: number;
  expected_midi: number;
  source_midi?: number;
};

export type DifficultyProfile = {
  allowed_strings: number[];
  allowed_frets: { min: number; max: number };
  allowed_fingers: number[];
  avg_seconds_per_note?: number;
  target_notes_per_minute?: number;
  pitch_tolerance_semitones: number;
  prefer_open_strings?: boolean;
  max_simultaneous_notes: 1 | 2;
  gating_timeout_seconds?: number;
};

export type PitchFrame = {
  t_seconds: number;
  midi_estimate: number | null;
  confidence: number;
};

export enum PlayState {
  Playing = 'Playing',
  WaitingForHit = 'WaitingForHit',
  Finished = 'Finished'
}

export type RuntimeState = {
  state: PlayState;
  current_tick: number;
  active_target_index: number;
  waiting_target_id?: string;
  waiting_started_at_s?: number;
};

export type Rating = 'Perfect' | 'Great' | 'OK' | 'Miss';

export type ScoreEvent = {
  targetId: string;
  rating: Rating;
  deltaMs: number;
  points: number;
};

export type ScoreSummary = {
  totalScore: number;
  hitDistribution: Record<Rating, number>;
  averageReactionMs: number;
  longestStreak: number;
};
