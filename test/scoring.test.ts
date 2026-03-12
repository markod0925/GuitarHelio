import { describe, expect, test } from 'vitest';
import { rateHit, summarizeScores } from '../src/game/scoring';

describe('scoring', () => {
  test('maps timing windows', () => {
    expect(rateHit(50).rating).toBe('Perfect');
    expect(rateHit(120).rating).toBe('Great');
    expect(rateHit(250).rating).toBe('OK');
    expect(rateHit(251).rating).toBe('Miss');
  });

  test('supports no-miss mode', () => {
    expect(rateHit(251, { noMiss: true }).rating).toBe('OK');
    expect(rateHit(10_000, { noMiss: true })).toEqual({ rating: 'OK', points: 40 });
  });

  test('summarizes events', () => {
    const summary = summarizeScores([
      { targetId: 'a', rating: 'Perfect', deltaMs: 40, points: 100 },
      { targetId: 'b', rating: 'Great', deltaMs: 90, points: 70 },
      { targetId: 'c', rating: 'Miss', deltaMs: 400, points: 0 }
    ]);
    expect(summary.totalScore).toBe(170);
    expect(summary.longestStreak).toBe(2);
    expect(summary.hitDistribution.Miss).toBe(1);
  });
});
