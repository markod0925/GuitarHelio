import type { summarizeScores } from '../game/scoring';
import { PlayState } from '../types/models';
import { normalizeTopFeedback } from './playSceneDebug';

export function computeEndScreenStars(
  totalTargets: number,
  summary: ReturnType<typeof summarizeScores>
): number {
  if (totalTargets <= 0) return 0;
  const playedNotes = summary.hitDistribution.Perfect + summary.hitDistribution.Great + summary.hitDistribution.OK;
  const playedRatio = playedNotes / totalTargets;
  if (playedRatio >= 0.9) return 3;
  if (playedRatio >= 0.6) return 2;
  if (playedRatio >= 0.3) return 1;
  return 0;
}

type TopFeedbackArgs = {
  runtimeState: PlayState;
  timeoutSeconds: number | undefined;
  audioCurrentTime: number | undefined;
  waitingStartedAtSeconds: number | undefined;
  playbackStarted: boolean;
  prePlaybackStartAtMs: number | undefined;
  nowMs: number;
  feedbackUntilMs: number;
  feedbackText: string;
};

export function resolveTopFeedbackMessage(args: TopFeedbackArgs): string {
  if (args.runtimeState === PlayState.WaitingForHit) {
    if (
      args.timeoutSeconds !== undefined &&
      args.audioCurrentTime !== undefined &&
      args.waitingStartedAtSeconds !== undefined
    ) {
      const remaining = Math.max(0, args.timeoutSeconds - (args.audioCurrentTime - args.waitingStartedAtSeconds));
      return `Waiting ${remaining.toFixed(1)}s`;
    }
    return 'Waiting';
  }

  if (!args.playbackStarted && args.runtimeState !== PlayState.Finished) {
    const remainingMs =
      args.prePlaybackStartAtMs !== undefined ? Math.max(0, args.prePlaybackStartAtMs - args.nowMs) : 0;
    return `Get Ready ${(remainingMs / 1000).toFixed(1)}s`;
  }

  if (args.nowMs >= args.feedbackUntilMs) return '';
  return normalizeTopFeedback(args.feedbackText);
}
