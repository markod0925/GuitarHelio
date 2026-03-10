import type { DifficultyLevel, DifficultyPreset } from "./types";

export const DIFFICULTY_PRESETS: Record<DifficultyLevel, DifficultyPreset> = {
  easy: {
    level: "easy",
    weights: {
      b: 0.55,
      height: 2.8,
      length: 3.2,
      n_changed_strings: 2.4,
    },
    fretboard: {
      maxFretSpan: 3,
      maxReachFret: 9,
    },
    soft: {
      allowNoteDrop: true,
      velocityThreshold: 45,
      minDurationTicks: 90,
      onsetMergeWindowTicks: 36,
      maxNotesPerEvent: 2,
      maxSubsetCandidates: 18,
      alpha: 0.45,
      beta: 0.7,
      dropPenalty: 0.05,
      fallbackStrategy: "greedy_drop",
      includeEventDiagnostics: true,
    },
  },
  medium: {
    level: "medium",
    weights: {
      b: 0.75,
      height: 1.9,
      length: 2.1,
      n_changed_strings: 1.6,
    },
    fretboard: {
      maxFretSpan: 4,
      maxReachFret: 12,
    },
    soft: {
      allowNoteDrop: true,
      velocityThreshold: 28,
      minDurationTicks: 55,
      onsetMergeWindowTicks: 24,
      maxNotesPerEvent: 3,
      maxSubsetCandidates: 14,
      alpha: 0.5,
      beta: 0.78,
      dropPenalty: 0.1,
      fallbackStrategy: "greedy_drop",
      includeEventDiagnostics: true,
    },
  },
  hard: {
    level: "hard",
    weights: {
      b: 1.6,
      height: 0.65,
      length: 0.7,
      n_changed_strings: 0.75,
    },
    fretboard: {
      maxFretSpan: 6,
      maxReachFret: 20,
    },
    soft: {
      allowNoteDrop: false,
      velocityThreshold: 0,
      minDurationTicks: 0,
      onsetMergeWindowTicks: 0,
      maxNotesPerEvent: 6,
      maxSubsetCandidates: 10,
      alpha: 0.25,
      beta: 0.55,
      dropPenalty: 0.9,
      fallbackStrategy: "none",
      includeEventDiagnostics: false,
    },
  },
};

export const DIFFICULTY_LEVELS: DifficultyLevel[] = ["easy", "medium", "hard"];

export function getDifficultyPreset(level: DifficultyLevel = "medium"): DifficultyPreset {
  const preset = DIFFICULTY_PRESETS[level];
  return {
    level: preset.level,
    weights: { ...preset.weights },
    fretboard: { ...preset.fretboard },
    soft: { ...preset.soft },
  };
}
