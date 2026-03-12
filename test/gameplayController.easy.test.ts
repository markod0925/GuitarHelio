import { describe, expect, test } from 'vitest';
import { PlayState, type ScoreEvent, type TargetNote } from '../src/types/models';
import { GameplayController } from '../src/ui/play/controllers/GameplayController';

type TestScene = {
  sceneData: { difficulty: 'Easy' | 'Medium' | 'Hard' };
  playbackPausedByButton: boolean;
  correctlyHitTargetIds: Set<string>;
  chordHitTargetIds: Set<string>;
  activeChordTrackingId?: string;
  waitingStartMs: number | null;
  latestFrames: { clear: () => void };
  gameplayPitchStabilizer?: { reset: () => void };
  feedbackText: string;
  feedbackUntilMs: number;
  resumeBackingPlayback: () => void;
  measureHitSignedDeltaMs: () => number | undefined;
  measureHitDeltaMs: () => number;
  recordScoreEvent: (event: ScoreEvent) => void;
};

function makeTarget(id: string): TargetNote {
  return {
    id,
    tick: 100,
    duration_ticks: 120,
    string: 6,
    fret: 3,
    finger: 1,
    expected_midi: 40
  };
}

function makeScene(
  difficulty: 'Easy' | 'Medium' | 'Hard',
  deltaMs: number,
  events: ScoreEvent[]
): TestScene {
  return {
    sceneData: { difficulty },
    playbackPausedByButton: false,
    correctlyHitTargetIds: new Set<string>(),
    chordHitTargetIds: new Set<string>(),
    activeChordTrackingId: 'chord-1',
    waitingStartMs: 0,
    latestFrames: { clear: () => undefined },
    gameplayPitchStabilizer: { reset: () => undefined },
    feedbackText: '',
    feedbackUntilMs: 0,
    resumeBackingPlayback: () => undefined,
    measureHitSignedDeltaMs: () => undefined,
    measureHitDeltaMs: () => deltaMs,
    recordScoreEvent: (event: ScoreEvent) => {
      events.push(event);
    }
  };
}

describe('GameplayController Easy scoring override', () => {
  test('in Easy a validated waiting hit cannot be Miss even when very late', () => {
    const events: ScoreEvent[] = [];
    const scene = makeScene('Easy', 1200, events);
    const controller = new GameplayController(scene as never);
    const target = makeTarget('t-1');

    controller.handleTransition('validated_hit', target, [target], PlayState.WaitingForHit);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rating: 'OK', points: 40, deltaMs: 1200 });
    expect(scene.correctlyHitTargetIds.has(target.id)).toBe(true);
  });

  test('Medium keeps default miss behavior for very late validated waiting hits', () => {
    const events: ScoreEvent[] = [];
    const scene = makeScene('Medium', 1200, events);
    const controller = new GameplayController(scene as never);
    const target = makeTarget('t-2');

    controller.handleTransition('validated_hit', target, [target], PlayState.WaitingForHit);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rating: 'Miss', points: 0, deltaMs: 1200 });
    expect(scene.correctlyHitTargetIds.has(target.id)).toBe(false);
  });
});
