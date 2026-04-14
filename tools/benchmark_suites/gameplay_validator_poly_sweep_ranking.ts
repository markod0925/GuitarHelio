import { roundNumber } from './shared';

export type AlgorithmRankingMetrics = {
  postRecall: number;
  stableRecall: number;
  emptyFar: number;
  transitionAccept: number;
  extraRate: number;
  exactRate: number;
  stableSupersetAccept: number;
  runtimeMs: number;
};

export type CombinedRankingMetrics = {
  avgPostRecall: number;
  avgStableRecall: number;
  avgEmptyFar: number;
  avgTransitionAccept: number;
  avgExtraNoteRate: number;
  avgExactRate: number;
  avgStableSupersetAccept: number;
  avgRuntimeMs: number;
};

const DEFAULT_RECALL_EPSILON = 0.01;

export function normalizeRecallEpsilon(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECALL_EPSILON;
  }
  return Math.max(0, value);
}

export function recallEquivalent(leftRecall: number, rightRecall: number, epsilon: number): boolean {
  return Math.abs(leftRecall - rightRecall) <= Math.max(0, epsilon);
}

export function compareStrictSymbolicAlgorithmMetrics(
  left: AlgorithmRankingMetrics,
  right: AlgorithmRankingMetrics
): number {
  if (left.postRecall !== right.postRecall) return right.postRecall - left.postRecall;
  if (left.emptyFar !== right.emptyFar) return left.emptyFar - right.emptyFar;
  if (left.transitionAccept !== right.transitionAccept) return left.transitionAccept - right.transitionAccept;
  if (left.extraRate !== right.extraRate) return left.extraRate - right.extraRate;
  if (left.exactRate !== right.exactRate) return right.exactRate - left.exactRate;
  if (left.runtimeMs !== right.runtimeMs) return left.runtimeMs - right.runtimeMs;
  return 0;
}

export function compareGameplayLexicographicAlgorithmMetrics(
  left: AlgorithmRankingMetrics,
  right: AlgorithmRankingMetrics
): number {
  if (left.stableRecall !== right.stableRecall) return right.stableRecall - left.stableRecall;
  if (left.emptyFar !== right.emptyFar) return left.emptyFar - right.emptyFar;
  if (left.transitionAccept !== right.transitionAccept) return left.transitionAccept - right.transitionAccept;
  if (left.extraRate !== right.extraRate) return left.extraRate - right.extraRate;
  if (left.stableSupersetAccept !== right.stableSupersetAccept) {
    return right.stableSupersetAccept - left.stableSupersetAccept;
  }
  if (left.runtimeMs !== right.runtimeMs) return left.runtimeMs - right.runtimeMs;
  return 0;
}

export function compareGameplayRecallEpsilonAlgorithmMetrics(
  left: AlgorithmRankingMetrics,
  right: AlgorithmRankingMetrics,
  recallEpsilon: number
): number {
  if (!recallEquivalent(left.stableRecall, right.stableRecall, recallEpsilon)) {
    return right.stableRecall - left.stableRecall;
  }
  if (left.emptyFar !== right.emptyFar) return left.emptyFar - right.emptyFar;
  if (left.transitionAccept !== right.transitionAccept) return left.transitionAccept - right.transitionAccept;
  if (left.extraRate !== right.extraRate) return left.extraRate - right.extraRate;
  if (left.exactRate !== right.exactRate) return right.exactRate - left.exactRate;
  if (left.runtimeMs !== right.runtimeMs) return left.runtimeMs - right.runtimeMs;
  return 0;
}

export function compareStrictSymbolicCombinedMetrics(
  left: CombinedRankingMetrics,
  right: CombinedRankingMetrics
): number {
  if (left.avgPostRecall !== right.avgPostRecall) return right.avgPostRecall - left.avgPostRecall;
  if (left.avgEmptyFar !== right.avgEmptyFar) return left.avgEmptyFar - right.avgEmptyFar;
  if (left.avgTransitionAccept !== right.avgTransitionAccept) return left.avgTransitionAccept - right.avgTransitionAccept;
  if (left.avgExtraNoteRate !== right.avgExtraNoteRate) return left.avgExtraNoteRate - right.avgExtraNoteRate;
  if (left.avgExactRate !== right.avgExactRate) return right.avgExactRate - left.avgExactRate;
  if (left.avgRuntimeMs !== right.avgRuntimeMs) return left.avgRuntimeMs - right.avgRuntimeMs;
  return 0;
}

export function compareGameplayLexicographicCombinedMetrics(
  left: CombinedRankingMetrics,
  right: CombinedRankingMetrics
): number {
  if (left.avgStableRecall !== right.avgStableRecall) return right.avgStableRecall - left.avgStableRecall;
  if (left.avgEmptyFar !== right.avgEmptyFar) return left.avgEmptyFar - right.avgEmptyFar;
  if (left.avgTransitionAccept !== right.avgTransitionAccept) return left.avgTransitionAccept - right.avgTransitionAccept;
  if (left.avgExtraNoteRate !== right.avgExtraNoteRate) return left.avgExtraNoteRate - right.avgExtraNoteRate;
  if (left.avgStableSupersetAccept !== right.avgStableSupersetAccept) {
    return right.avgStableSupersetAccept - left.avgStableSupersetAccept;
  }
  if (left.avgRuntimeMs !== right.avgRuntimeMs) return left.avgRuntimeMs - right.avgRuntimeMs;
  return 0;
}

export function compareGameplayRecallEpsilonCombinedMetrics(
  left: CombinedRankingMetrics,
  right: CombinedRankingMetrics,
  recallEpsilon: number
): number {
  if (!recallEquivalent(left.avgStableRecall, right.avgStableRecall, recallEpsilon)) {
    return right.avgStableRecall - left.avgStableRecall;
  }
  if (left.avgEmptyFar !== right.avgEmptyFar) return left.avgEmptyFar - right.avgEmptyFar;
  if (left.avgTransitionAccept !== right.avgTransitionAccept) return left.avgTransitionAccept - right.avgTransitionAccept;
  if (left.avgExtraNoteRate !== right.avgExtraNoteRate) return left.avgExtraNoteRate - right.avgExtraNoteRate;
  if (left.avgExactRate !== right.avgExactRate) return right.avgExactRate - left.avgExactRate;
  if (left.avgRuntimeMs !== right.avgRuntimeMs) return left.avgRuntimeMs - right.avgRuntimeMs;
  return 0;
}

export function formatRecallEpsilon(epsilon: number): string {
  return roundNumber(epsilon, 4).toFixed(4);
}
