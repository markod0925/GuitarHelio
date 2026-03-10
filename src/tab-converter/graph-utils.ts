import {
  getDheightScore,
  laplaceDistro,
  precomputeFingeringStats,
} from "./difficulty";
import { Note, Tuning } from "./theory";
import type { TabWeights } from "./types";

export const MAX_EDGE_DISTANCE = 6;

export interface PathGraph {
  nodes: Set<Note>;
  edges: Map<Note, Array<{ to: Note; distance: number }>>;
}

function positionOf(positions: Map<Note, [number, number]>, note: Note): [number, number] {
  const pos = positions.get(note);
  if (!pos) {
    throw new Error("Missing note position");
  }
  return pos;
}

export function distanceBetween(
  p1: [number, number],
  p2: [number, number],
  nstrings: number,
): number {
  if (p2[1] === 0) {
    return 0;
  }
  return Math.hypot(p1[0] / nstrings - p2[0] / nstrings, p1[1] - p2[1]);
}

export function buildPathGraph(
  positions: Map<Note, [number, number]>,
  noteArrays: Note[][],
  nstrings: number,
): PathGraph {
  const nodes = new Set<Note>();
  const edges = new Map<Note, Array<{ to: Note; distance: number }>>();

  for (const noteArray of noteArrays) {
    for (const note of noteArray) {
      nodes.add(note);
    }
  }

  for (let i = 0; i < noteArrays.length - 1; i++) {
    for (const note of noteArrays[i]) {
      for (const target of noteArrays[i + 1]) {
        const dist = distanceBetween(positionOf(positions, note), positionOf(positions, target), nstrings);
        if (isEdgePossible(note, target, positions, dist)) {
          const current = edges.get(note) ?? [];
          current.push({ to: target, distance: dist });
          edges.set(note, current);
        }
      }
    }
  }

  return { nodes, edges };
}

export function isEdgePossible(
  note: Note,
  target: Note,
  positions: Map<Note, [number, number]>,
  distance: number,
): boolean {
  return distance < MAX_EDGE_DISTANCE && positionOf(positions, note)[0] !== positionOf(positions, target)[0];
}

export function findValidPaths(
  positions: Map<Note, [number, number]>,
  noteArrays: Note[][],
  nstrings: number,
): Note[][] {
  if (noteArrays.length === 0) {
    return [];
  }

  const adjacency: Array<Map<Note, Note[]>> = [];

  for (let i = 0; i < noteArrays.length - 1; i++) {
    const layer = new Map<Note, Note[]>();
    for (const note of noteArrays[i]) {
      const neighbors: Note[] = [];
      for (const target of noteArrays[i + 1]) {
        const dist = distanceBetween(positionOf(positions, note), positionOf(positions, target), nstrings);
        if (isEdgePossible(note, target, positions, dist)) {
          neighbors.push(target);
        }
      }
      layer.set(note, neighbors);
    }
    adjacency.push(layer);
  }

  const paths: Note[][] = [];

  const dfs = (layer: number, currentPath: Note[]): void => {
    if (layer === noteArrays.length - 1) {
      paths.push([...currentPath]);
      return;
    }

    const neighbors = adjacency[layer].get(currentPath[currentPath.length - 1]) ?? [];
    for (const neighbor of neighbors) {
      currentPath.push(neighbor);
      dfs(layer + 1, currentPath);
      currentPath.pop();
    }
  };

  for (const start of noteArrays[0]) {
    dfs(0, [start]);
  }

  return paths;
}

export function isPathAlreadyChecked(paths: Note[][], currentPath: Note[]): boolean {
  const currentSet = new Set(currentPath.map((note) => note.id));
  return paths.some((path) => {
    const pathSet = new Set(path.map((note) => note.id));
    if (pathSet.size !== currentSet.size) {
      return false;
    }
    for (const id of currentSet) {
      if (!pathSet.has(id)) {
        return false;
      }
    }
    return true;
  });
}

export function viterbi(
  observations: number[],
  transitionMatrix: number[][],
  emissionMatrix: number[][],
  initialDistribution?: number[],
): number[] {
  if (observations.length === 0 || transitionMatrix.length === 0 || emissionMatrix.length === 0) {
    return [];
  }

  const T = observations.length;
  const M = transitionMatrix.length;
  const emCols = emissionMatrix[0].length;

  const initial =
    initialDistribution && initialDistribution.length === M
      ? initialDistribution
      : Array(M).fill(1 / M);

  const omega: number[][] = Array.from({ length: T }, () => Array(M).fill(Number.NEGATIVE_INFINITY));
  const prev: number[][] = Array.from({ length: Math.max(T - 1, 0) }, () => Array(M).fill(0));

  const firstObs = observations[0] >= 0 ? observations[0] : emCols - 1;
  for (let state = 0; state < M; state++) {
    omega[0][state] = Math.log(initial[state]) + Math.log(emissionMatrix[state][firstObs]);
  }

  for (let t = 1; t < T; t++) {
    const obs = observations[t] >= 0 ? observations[t] : emCols - 1;
    for (let nextState = 0; nextState < M; nextState++) {
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestPrev = 0;
      const emissionLog = Math.log(emissionMatrix[nextState][obs]);

      for (let prevState = 0; prevState < M; prevState++) {
        const score = omega[t - 1][prevState] + Math.log(transitionMatrix[prevState][nextState]) + emissionLog;
        if (score > bestScore) {
          bestScore = score;
          bestPrev = prevState;
        }
      }

      omega[t][nextState] = bestScore;
      prev[t - 1][nextState] = bestPrev;
    }
  }

  let lastState = 0;
  let lastScore = Number.NEGATIVE_INFINITY;
  for (let state = 0; state < M; state++) {
    if (omega[T - 1][state] > lastScore) {
      lastScore = omega[T - 1][state];
      lastState = state;
    }
  }

  const sequence = Array(T).fill(0);
  sequence[T - 1] = lastState;

  for (let t = T - 2; t >= 0; t--) {
    sequence[t] = prev[t][sequence[t + 1]];
  }

  return sequence;
}

function countIntersection(a: Set<number>, b: Set<number>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) {
      count += 1;
    }
  }
  return count;
}

function computePairEasiness(
  currStats: ReturnType<typeof precomputeFingeringStats>[number],
  prevStats: ReturnType<typeof precomputeFingeringStats>[number],
  weights: TabWeights,
  tuning: Tuning,
): number {
  const currRawHeight = currStats.raw_height !== 0 ? currStats.raw_height : prevStats.raw_height;
  const dheight = getDheightScore(currRawHeight, prevStats.raw_height, tuning);
  const nChanged =
    (currStats.n_notes - countIntersection(currStats.all_strings, prevStats.non_open_strings)) /
    tuning.nstrings;

  return (
    laplaceDistro(dheight, weights.b) *
    1 / (1 + currStats.height_score * weights.height) *
    1 / (1 + currStats.span_score * weights.length) *
    1 / (1 + nChanged * weights.n_changed_strings)
  );
}

export function buildTransitionMatrix(
  positions: Map<Note, [number, number]>,
  fingerings: Note[][],
  weights: TabWeights,
  tuning: Tuning,
): number[][] {
  const n = fingerings.length;
  const stats = precomputeFingeringStats(positions, fingerings, tuning);
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let prev = 0; prev < n; prev++) {
    const easiness = Array.from({ length: n }, (_, curr) =>
      computePairEasiness(stats[curr], stats[prev], weights, tuning),
    );
    matrix[prev] = difficultiesToProbabilities(easiness);
  }

  return matrix;
}

export function difficultiesToProbabilities(difficulties: number[]): number[] {
  const total = difficulties.reduce((acc, value) => acc + value, 0);
  if (total <= 0 || !Number.isFinite(total)) {
    return Array.from({ length: difficulties.length }, () => 1 / difficulties.length);
  }
  return difficulties.map((value) => value / total);
}

export function expandEmissionMatrix(
  emissionMatrix: number[][],
  allPaths: Note[][],
): number[][] {
  if (emissionMatrix.length > 0) {
    const cols = emissionMatrix[0].length;
    const expanded = emissionMatrix.map((row) => [...row]);

    for (let i = 0; i < allPaths.length; i++) {
      expanded.push(Array(cols).fill(0));
    }

    for (let row = 0; row < expanded.length; row++) {
      expanded[row].push(row >= expanded.length - allPaths.length ? 1 : 0);
    }

    return expanded;
  }

  return allPaths.map(() => [1]);
}
