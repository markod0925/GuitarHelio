import { describe, expect, test } from 'vitest';
import {
  compareGameplayRecallEpsilonAlgorithmMetrics,
  compareGameplayRecallEpsilonCombinedMetrics,
  normalizeRecallEpsilon,
  type AlgorithmRankingMetrics,
  type CombinedRankingMetrics
} from '../tools/benchmark_suites/gameplay_validator_poly_sweep_ranking';

function algorithmMetrics(overrides: Partial<AlgorithmRankingMetrics> = {}): AlgorithmRankingMetrics {
  return {
    postRecall: 0.8,
    stableRecall: 0.8,
    emptyFar: 0.2,
    transitionAccept: 0.2,
    extraRate: 0.1,
    exactRate: 0.7,
    stableSupersetAccept: 0.4,
    runtimeMs: 1.0,
    ...overrides
  };
}

function combinedMetrics(overrides: Partial<CombinedRankingMetrics> = {}): CombinedRankingMetrics {
  return {
    avgPostRecall: 0.8,
    avgStableRecall: 0.8,
    avgEmptyFar: 0.2,
    avgTransitionAccept: 0.2,
    avgExtraNoteRate: 0.1,
    avgExactRate: 0.7,
    avgStableSupersetAccept: 0.4,
    avgRuntimeMs: 1.0,
    ...overrides
  };
}

describe('gameplay recall-epsilon ranking', () => {
  test('treats recalls within epsilon as equivalent and prefers lower empty/transition/extra rates', () => {
    const epsilon = 0.01;
    const nearTopRecallButNoisy = algorithmMetrics({
      stableRecall: 0.905,
      emptyFar: 0.25,
      transitionAccept: 0.23,
      extraRate: 0.14
    });
    const slightlyLowerRecallButCleaner = algorithmMetrics({
      stableRecall: 0.899,
      emptyFar: 0.06,
      transitionAccept: 0.08,
      extraRate: 0.05
    });

    expect(
      compareGameplayRecallEpsilonAlgorithmMetrics(
        slightlyLowerRecallButCleaner,
        nearTopRecallButNoisy,
        epsilon
      )
    ).toBeLessThan(0);
  });

  test('still prioritizes stable recall when difference exceeds epsilon', () => {
    const epsilon = 0.01;
    const cleanerButLowerRecall = algorithmMetrics({
      stableRecall: 0.87,
      emptyFar: 0.01,
      transitionAccept: 0.02,
      extraRate: 0.01
    });
    const higherRecall = algorithmMetrics({
      stableRecall: 0.89,
      emptyFar: 0.3,
      transitionAccept: 0.3,
      extraRate: 0.2
    });

    expect(
      compareGameplayRecallEpsilonAlgorithmMetrics(
        cleanerButLowerRecall,
        higherRecall,
        epsilon
      )
    ).toBeGreaterThan(0);
  });

  test('uses exact-set rate as mismatch proxy after extra-note tie', () => {
    const epsilon = 0.01;
    const worseMismatch = combinedMetrics({
      avgStableRecall: 0.9,
      avgEmptyFar: 0.08,
      avgTransitionAccept: 0.09,
      avgExtraNoteRate: 0.05,
      avgExactRate: 0.72
    });
    const betterMismatch = combinedMetrics({
      avgStableRecall: 0.903,
      avgEmptyFar: 0.08,
      avgTransitionAccept: 0.09,
      avgExtraNoteRate: 0.05,
      avgExactRate: 0.83
    });

    expect(
      compareGameplayRecallEpsilonCombinedMetrics(
        betterMismatch,
        worseMismatch,
        epsilon
      )
    ).toBeLessThan(0);
  });

  test('supports deterministic fallback when comparator tie remains', () => {
    const epsilon = 0.01;
    const tiedA = combinedMetrics();
    const tiedB = combinedMetrics();

    const ids = ['b_entry', 'a_entry'];
    const sorted = ids
      .slice()
      .sort((leftId, rightId) => {
        const cmp = compareGameplayRecallEpsilonCombinedMetrics(tiedA, tiedB, epsilon);
        return cmp !== 0 ? cmp : leftId.localeCompare(rightId);
      });
    expect(sorted).toEqual(['a_entry', 'b_entry']);
  });
});

describe('recall epsilon parsing helper', () => {
  test('normalizes invalid and negative values safely', () => {
    expect(normalizeRecallEpsilon(undefined)).toBe(0.01);
    expect(normalizeRecallEpsilon(Number.NaN)).toBe(0.01);
    expect(normalizeRecallEpsilon(-0.2)).toBe(0);
    expect(normalizeRecallEpsilon(0.005)).toBe(0.005);
  });
});
