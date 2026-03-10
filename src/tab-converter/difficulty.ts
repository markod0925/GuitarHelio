import type { Tuning } from "./theory";
import type { TabWeights } from "./types";
import { Note } from "./theory";

export const MAX_FRET_DISTANCE = 10;
export const SPAN_NORMALIZATION = 5;

function positionOf(positions: Map<Note, [number, number]>, note: Note): [number, number] {
  const pos = positions.get(note);
  if (!pos) {
    throw new Error("Missing note position");
  }
  return pos;
}

export function computePathDifficulty(
  positions: Map<Note, [number, number]>,
  path: Note[],
  previousPath: Note[],
  weights: TabWeights,
  tuning: Tuning,
): number {
  const rawHeight = getRawHeight(positions, path, previousPath);
  const previousRawHeight = previousPath.length > 0 ? getRawHeight(positions, previousPath) : 0;

  const height = getHeightScore(rawHeight, tuning);
  const dheight = getDheightScore(rawHeight, previousRawHeight, tuning);
  const span = getPathSpan(positions, path);
  const nChangedStrings = getNChangedStrings(positions, path, previousPath, tuning);

  const easiness =
    laplaceDistro(dheight, weights.b) *
    1 / (1 + height * weights.height) *
    1 / (1 + span * weights.length) *
    1 / (1 + nChangedStrings * weights.n_changed_strings);

  return 1 / easiness;
}

export function computeIsolatedPathDifficulty(
  positions: Map<Note, [number, number]>,
  path: Note[],
  tuning: Tuning,
): number {
  const rawHeight = getRawHeight(positions, path);
  const height = getHeightScore(rawHeight, tuning);
  const span = getPathSpan(positions, path);
  const easiness = 1 / (1 + height) * 1 / (1 + span);
  return 1 / easiness;
}

export function laplaceDistro(x: number, b: number, mu = 0): number {
  return (1 / (2 * b)) * Math.exp(-Math.abs(x - mu) / b);
}

export function getNFingers(positions: Map<Note, [number, number]>, path: Note[]): number {
  return path.filter((note) => positionOf(positions, note)[1] !== 0).length;
}

export function getNChangedStrings(
  positions: Map<Note, [number, number]>,
  path: Note[],
  previousPath: Note[],
  tuning: Tuning,
): number {
  const usedStrings = new Set(path.map((note) => positionOf(positions, note)[0]));
  const previousUsedStrings = new Set(
    previousPath
      .filter((note) => positionOf(positions, note)[1] !== 0)
      .map((note) => positionOf(positions, note)[0]),
  );
  const intersection = [...usedStrings].filter((value) => previousUsedStrings.has(value)).length;
  const score = (path.length - intersection) / tuning.nstrings;
  return Math.max(0, Math.min(1, score));
}

export function getHeightScore(rawHeight: number, tuning: Tuning): number {
  const height = rawHeight / tuning.nfrets;
  return Math.max(0, Math.min(1, height));
}

export function getRawHeight(
  positions: Map<Note, [number, number]>,
  path: Note[],
  previousPath?: Note[],
): number {
  const y = path.map((note) => positionOf(positions, note)[1]).filter((fret) => fret !== 0);
  if (y.length > 0) {
    return (Math.max(...y) + Math.min(...y)) / 2;
  }
  if (!previousPath) {
    return 0;
  }
  return getRawHeight(positions, previousPath);
}

export function getDheightScore(height: number, previousHeight: number, tuning: Tuning): number {
  const dheight = Math.abs(height - previousHeight) / tuning.nfrets;
  return Math.max(0, Math.min(1, dheight));
}

export function precomputeFingeringStats(
  positions: Map<Note, [number, number]>,
  fingerings: Note[][],
  tuning: Tuning,
): Array<{
  raw_height: number;
  height_score: number;
  span_score: number;
  all_strings: Set<number>;
  non_open_strings: Set<number>;
  n_notes: number;
}> {
  return fingerings.map((fingering) => {
    const rawHeight = getRawHeight(positions, fingering);
    const allStrings = new Set(fingering.map((note) => positionOf(positions, note)[0]));
    const nonOpenStrings = new Set(
      fingering
        .filter((note) => positionOf(positions, note)[1] !== 0)
        .map((note) => positionOf(positions, note)[0]),
    );

    return {
      raw_height: rawHeight,
      height_score: getHeightScore(rawHeight, tuning),
      span_score: getPathSpan(positions, fingering),
      all_strings: allStrings,
      non_open_strings: nonOpenStrings,
      n_notes: fingering.length,
    };
  });
}

export function getPathSpan(positions: Map<Note, [number, number]>, path: Note[]): number {
  const y = path.map((note) => positionOf(positions, note)[1]).filter((fret) => fret !== 0);
  if (y.length === 0) {
    return 0;
  }
  const span = (Math.max(...y) - Math.min(...y)) / SPAN_NORMALIZATION;
  return Math.max(0, Math.min(1, span));
}
