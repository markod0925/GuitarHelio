import type { Rating, ScoreEvent, ScoreSummary } from '../types/models';

const thresholds: Array<{ rating: Rating; maxMs: number; points: number }> = [
  { rating: 'Perfect', maxMs: 50, points: 100 },
  { rating: 'Great', maxMs: 120, points: 70 },
  { rating: 'OK', maxMs: 250, points: 40 }
];

export function rateHit(deltaMs: number): { rating: Rating; points: number } {
  const match = thresholds.find((t) => deltaMs <= t.maxMs);
  if (!match) return { rating: 'Miss', points: 0 };
  return { rating: match.rating, points: match.points };
}

export function summarizeScores(events: ScoreEvent[]): ScoreSummary {
  const distribution: ScoreSummary['hitDistribution'] = {
    Perfect: 0,
    Great: 0,
    OK: 0,
    Miss: 0
  };

  let totalScore = 0;
  let streak = 0;
  let longestStreak = 0;

  for (const event of events) {
    distribution[event.rating] += 1;
    totalScore += event.points;
    if (event.rating === 'Miss') {
      streak = 0;
    } else {
      streak += 1;
      longestStreak = Math.max(longestStreak, streak);
    }
  }

  const nonMiss = events.filter((event) => event.rating !== 'Miss');
  const averageReactionMs = nonMiss.length === 0
    ? 0
    : nonMiss.reduce((acc, event) => acc + event.deltaMs, 0) / nonMiss.length;

  return {
    totalScore,
    hitDistribution: distribution,
    averageReactionMs,
    longestStreak
  };
}
