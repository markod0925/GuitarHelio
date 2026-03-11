import { describe, expect, test } from 'vitest';
import { computeEndScreenStars } from '../src/ui/UIOverlays';

function makeSummary(playedNotes: number, misses: number) {
  return {
    totalScore: 0,
    hitDistribution: {
      Perfect: playedNotes,
      Great: 0,
      OK: 0,
      Miss: misses
    },
    averageReactionMs: 0,
    longestStreak: 0
  };
}

describe('computeEndScreenStars', () => {
  test('uses Easy thresholds', () => {
    expect(computeEndScreenStars(10, makeSummary(6, 4), 'Easy')).toBe(3);
    expect(computeEndScreenStars(10, makeSummary(4, 6), 'Easy')).toBe(2);
    expect(computeEndScreenStars(10, makeSummary(1, 9), 'Easy')).toBe(1);
    expect(computeEndScreenStars(10, makeSummary(0, 10), 'Easy')).toBe(0);
  });

  test('keeps Medium/Hard thresholds unchanged', () => {
    expect(computeEndScreenStars(10, makeSummary(9, 1), 'Medium')).toBe(3);
    expect(computeEndScreenStars(10, makeSummary(6, 4), 'Medium')).toBe(2);
    expect(computeEndScreenStars(10, makeSummary(3, 7), 'Medium')).toBe(1);
    expect(computeEndScreenStars(10, makeSummary(2, 8), 'Medium')).toBe(0);

    expect(computeEndScreenStars(10, makeSummary(9, 1), 'Hard')).toBe(3);
    expect(computeEndScreenStars(10, makeSummary(6, 4), 'Hard')).toBe(2);
    expect(computeEndScreenStars(10, makeSummary(3, 7), 'Hard')).toBe(1);
    expect(computeEndScreenStars(10, makeSummary(2, 8), 'Hard')).toBe(0);
  });
});
