import type { ScoreSummary } from '../types/models';

export function formatSummary(summary: ScoreSummary): string {
  return [
    `Score: ${summary.totalScore}`,
    `Perfect: ${summary.hitDistribution.Perfect}`,
    `Great: ${summary.hitDistribution.Great}`,
    `OK: ${summary.hitDistribution.OK}`,
    `Miss: ${summary.hitDistribution.Miss}`,
    `Avg reaction: ${summary.averageReactionMs.toFixed(1)} ms`,
    `Longest streak: ${summary.longestStreak}`
  ].join('\n');
}
