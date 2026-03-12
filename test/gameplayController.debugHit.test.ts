import { describe, expect, test } from 'vitest';
import { DIFFICULTY_PRESETS } from '../src/app/config';
import { GameplayController } from '../src/ui/play/controllers/GameplayController';
import { PlayState, type RuntimeState, type ScoreEvent, type TargetNote } from '../src/types/models';

function makeTarget(id: string): TargetNote {
  return {
    id,
    tick: 1000,
    duration_ticks: 180,
    string: 4,
    fret: 2,
    finger: 1,
    expected_midi: 52
  };
}

function createWaitingDebugScene(waitingElapsedMs: number) {
  const target = makeTarget('dbg-1');
  const runtime: RuntimeState = {
    state: PlayState.WaitingForHit,
    current_tick: target.tick,
    active_target_index: 0,
    waiting_target_id: target.id,
    waiting_started_at_s: 10
  };

  const scene: any = {
    sceneData: { difficulty: 'Easy' as const },
    playbackPausedByButton: false,
    playbackStarted: true,
    audioCtx: { currentTime: 12 },
    tempoMap: { tickToSeconds: () => 11 },
    profile: DIFFICULTY_PRESETS.Easy,
    fallbackTimeoutSeconds: undefined,
    runtime,
    runtimeUpdateScratch: {
      state: runtime,
      transition: 'none'
    },
    targets: [target],
    scoreEvents: [] as ScoreEvent[],
    totalScore: 0,
    currentComboStreak: 0,
    correctlyHitTargetIds: new Set<string>(),
    chordHitTargetIds: new Set<string>(),
    activeChordTrackingId: 'chord-debug',
    waitingStartMs: performance.now() - waitingElapsedMs,
    latestFrames: { clear: () => undefined },
    gameplayPitchStabilizer: { reset: () => undefined },
    feedbackText: '',
    feedbackUntilMs: 0,
    lastRuntimeTransition: 'none',
    lastRuntimeTransitionAtMs: 0,
    isWaitingPausedByButton: () => false,
    getSongSecondsNow: () => 12,
    redrawTargetsAndBall: () => undefined,
    updateSongMinimapProgress: () => undefined,
    updateHud: () => undefined,
    queueFinishSong: () => undefined,
    clearFinishSongQueue: () => undefined,
    resumeBackingPlayback: () => undefined
  };

  const controller = new GameplayController(scene as never);
  scene.handleTransition = (...args: Parameters<GameplayController['handleTransition']>) =>
    controller.handleTransition(...args);
  scene.recordScoreEvent = (event: ScoreEvent) => controller.recordScoreEvent(event);
  scene.measureHitDeltaMs = (...args: Parameters<GameplayController['measureHitDeltaMs']>) =>
    controller.measureHitDeltaMs(...args);
  scene.measureHitSignedDeltaMs = (...args: Parameters<GameplayController['measureHitSignedDeltaMs']>) =>
    controller.measureHitSignedDeltaMs(...args);

  return { controller, scene, target };
}

describe('GameplayController debug hit', () => {
  test('Debug hit in WaitingForHit validates in Easy and does not produce Miss', () => {
    const { controller, scene, target } = createWaitingDebugScene(1200);

    controller.consumeDebugHit();

    expect(scene.lastRuntimeTransition).toBe('validated_hit');
    expect(scene.scoreEvents).toHaveLength(1);
    expect(scene.scoreEvents[0]).toMatchObject({ targetId: target.id, rating: 'OK', points: 40 });
    expect(scene.correctlyHitTargetIds.has(target.id)).toBe(true);
    expect(scene.currentComboStreak).toBe(1);
    expect(scene.feedbackText).toBe('OK');
  });
});
