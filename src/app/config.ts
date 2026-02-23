import type { DifficultyProfile } from '../types/models';

export const APPROACH_THRESHOLD_TICKS = 120;
export const DEFAULT_HOLD_MS = 80;
export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const TARGET_HIT_GRACE_SECONDS = 0.5;
export const SCHEDULER_LOOKAHEAD_SECONDS = 0.15;
export const SCHEDULER_UPDATE_MS = 25;

// Increase/decrease this to tune how tall the ball jump looks on beat.
export const BALL_BOUNCE_AMPLITUDE_FACTOR = 0.8;
export const BALL_BOUNCE_AMPLITUDE_MIN_PX = 32;
export const BALL_BOUNCE_AMPLITUDE_MAX_PX = 150;

// Ghost trail tuning for the yellow ball.
export const BALL_GHOST_TRAIL_COUNT = 10;
export const BALL_GHOST_TRAIL_SAMPLE_STEP = 2;
export const BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS = 6;

export const DIFFICULTY_PRESETS: Record<'Easy' | 'Medium' | 'Hard', DifficultyProfile> = {
  Easy: {
    allowed_strings: [6, 5, 4],
    allowed_frets: { min: 0, max: 3 },
    allowed_fingers: [1],
    avg_seconds_per_note: 2.0,
    pitch_tolerance_semitones: 2,
    max_simultaneous_notes: 1
  },
  Medium: {
    allowed_strings: [6, 5, 4, 3],
    allowed_frets: { min: 0, max: 5 },
    allowed_fingers: [1, 2, 3],
    avg_seconds_per_note: 1.2,
    pitch_tolerance_semitones: 1,
    max_simultaneous_notes: 1
  },
  Hard: {
    allowed_strings: [1, 2, 3, 4, 5, 6],
    allowed_frets: { min: 0, max: 12 },
    allowed_fingers: [1, 2, 3, 4],
    avg_seconds_per_note: 0.6,
    pitch_tolerance_semitones: 0,
    max_simultaneous_notes: 1
  }
};

export const FINGER_COLORS: Record<number, number> = {
  0: 0x9ca3af,
  1: 0xfacc15,
  2: 0xa855f7,
  3: 0x2563eb,
  4: 0xef4444
};
