import { describe, expect, test } from 'vitest';
import { PlayState, type TargetNote } from '../src/types/models';
import { RealtimeGameplayValidator, type ValidatorFrameCandidateEvidence, type ValidatorFrameEvidence } from '../src/gameplay/validation';
import { createIdleValidationWindowState, markGameplayValidationWindowAccepted, syncGameplayValidationWindow } from '../src/ui/play/controllers/validationWindow';

function makeTarget(id: string, tick: number, expectedMidi: number, chordId?: string): TargetNote {
  return {
    id,
    tick,
    duration_ticks: 120,
    string: 4,
    fret: 2,
    finger: 1,
    expected_midi: expectedMidi,
    chord_id: chordId
  };
}

function makeNoteEvidence(midi: number, timestampMs: number, overrides: Partial<ValidatorFrameCandidateEvidence> = {}): ValidatorFrameCandidateEvidence {
  return {
    timestampMs,
    midi,
    detectorAccepted: overrides.detectorAccepted ?? true,
    detectorConfidence: overrides.detectorConfidence ?? 0.96,
    detectedMidi: overrides.detectedMidi ?? midi,
    detectedString: overrides.detectedString ?? 4,
    detectedFret: overrides.detectedFret ?? 2,
    expectedCentsError: overrides.expectedCentsError ?? 0,
    expectedScore: overrides.expectedScore ?? 100,
    bestCompetitorScore: overrides.bestCompetitorScore ?? 10,
    bestCompetitorMidi: overrides.bestCompetitorMidi ?? midi + 1,
    bestOctaveScore: overrides.bestOctaveScore ?? 4,
    neighborScore: overrides.neighborScore ?? 8,
    samePitchAltScore: overrides.samePitchAltScore ?? null,
    expectedRank: overrides.expectedRank ?? 1,
    expectedTop1: overrides.expectedTop1 ?? true,
    expectedTop3: overrides.expectedTop3 ?? true,
    expectedPairwiseWinRate: overrides.expectedPairwiseWinRate ?? 1,
    octaveCompetitorOutranked: overrides.octaveCompetitorOutranked ?? false,
    expectedVsSourceWon: overrides.expectedVsSourceWon ?? true,
    positionAmbiguous: overrides.positionAmbiguous ?? false,
    candidateScoreCount: overrides.candidateScoreCount ?? 4,
    sharedEvidenceAvailability: overrides.sharedEvidenceAvailability ?? [],
    sharedEvidenceLimitations: overrides.sharedEvidenceLimitations ?? [],
    evidenceSource: overrides.evidenceSource ?? 'spectral_probe',
    spectralProbe: overrides.spectralProbe ?? null,
    samePitchAltDetected: overrides.samePitchAltDetected ?? false,
    expectedPositionMatch: overrides.expectedPositionMatch ?? true
  };
}

function makeFrameEvidence(timestampMs: number, notes: Array<ValidatorFrameCandidateEvidence>): ValidatorFrameEvidence {
  const realizedNotes = notes.map((note) => ({
    ...note,
    timestampMs
  }));
  return {
    timestampMs,
    notes: realizedNotes,
    rawDetectedMidis: realizedNotes.map((note) => note.midi).filter((value): value is number => value !== null),
    rawDetectionMaxConfidence: realizedNotes.length > 0 ? Math.max(...realizedNotes.map((note) => note.detectorConfidence)) : null,
    rawDetectionFrameRatio: realizedNotes.length > 0 ? 1 : 0,
    metadata: {}
  };
}

function makeHarnessValidator(): RealtimeGameplayValidator & {
  resetCount: number;
  setTargetCount: number;
  updateCount: number;
} {
  const validator = new RealtimeGameplayValidator();
  const harness = validator as RealtimeGameplayValidator & {
    resetCount: number;
    setTargetCount: number;
    updateCount: number;
    reset: () => void;
    setTarget: (target: Parameters<RealtimeGameplayValidator['setTarget']>[0]) => void;
    update: (input: Parameters<RealtimeGameplayValidator['update']>[0]) => ReturnType<RealtimeGameplayValidator['update']>;
  };
  harness.resetCount = 0;
  harness.setTargetCount = 0;
  harness.updateCount = 0;
  const realReset = validator.reset.bind(validator);
  const realSetTarget = validator.setTarget.bind(validator);
  const realUpdate = validator.update.bind(validator);
  harness.reset = () => {
    harness.resetCount += 1;
    realReset();
  };
  harness.setTarget = (target) => {
    harness.setTargetCount += 1;
    realSetTarget(target);
  };
  harness.update = (input) => {
    harness.updateCount += 1;
    return realUpdate(input);
  };
  return harness;
}

function makeScene(targets: TargetNote[]) {
  const realtimeGameplayValidator = makeHarnessValidator();
  return {
    sceneData: { difficulty: 'Easy' as const },
    playbackStarted: true,
    runtime: {
      state: PlayState.Playing,
      current_tick: targets[0]?.tick ?? 0,
      active_target_index: 0
    },
    tempoMap: {
      tickToSeconds: (tick: number) => (tick === targets[0]?.tick ? 10 : 0)
    },
    targets,
    realtimeGameplayValidator,
    realtimeValidationOutput: undefined,
    realtimeValidationState: realtimeGameplayValidator.getState(),
    validationWindowState: createIdleValidationWindowState()
  } as any;
}

function runValidatorFrames(
  scene: ReturnType<typeof makeScene>,
  targetGroup: TargetNote[],
  timestamps: number[]
): ReturnType<RealtimeGameplayValidator['update']> {
  let output = scene.realtimeGameplayValidator.update({
    timestampMs: timestamps[0],
    frameEvidence: makeFrameEvidence(timestamps[0], targetGroup.map((target) => makeNoteEvidence(target.expected_midi, timestamps[0])))
  });
  for (let index = 1; index < timestamps.length; index += 1) {
    const timestampMs = timestamps[index];
    output = scene.realtimeGameplayValidator.update({
      timestampMs,
      frameEvidence: makeFrameEvidence(
        timestampMs,
        targetGroup.map((target) => makeNoteEvidence(target.expected_midi, timestampMs))
      )
    });
  }
  return output;
}

describe('play validation window lifecycle', () => {
  test('stays idle before the tolerance window and ignores positive input', () => {
    const target = makeTarget('t-1', 1000, 60);
    const scene = makeScene([target]);

    const windowState = syncGameplayValidationWindow(scene as never, 0, 9.3);
    expect(windowState.phase).toBe('idle');
    expect(windowState.deadTime).toBe(true);
    expect(windowState.targetKey).toBe(target.id);
    expect(scene.realtimeGameplayValidator.getState().target).toBeNull();

    const output = scene.realtimeGameplayValidator.update({
      timestampMs: 8,
      frameEvidence: makeFrameEvidence(8, [makeNoteEvidence(60, 8)])
    });

    expect(output.accepted).toBe(false);
    expect(output.rejectStage).toBe('no_target');
  });

  test.each([
    {
      label: 'mono',
      targets: [makeTarget('m-1', 1000, 60)]
    },
    {
      label: 'poly',
      targets: [makeTarget('p-1', 1000, 60, 'chord-1'), makeTarget('p-2', 1000, 64, 'chord-1')]
    }
  ])('arms once and accepts a $label window exactly once', ({ targets }) => {
    const scene = makeScene(targets);

    const armed = syncGameplayValidationWindow(scene as never, 0, 9.6);
    expect(armed.phase).toBe('armed');
    expect(armed.deadTime).toBe(false);
    expect(armed.targetMode).toBe(targets.length > 1 ? 'poly' : 'mono');
    expect(armed.setTargetCount).toBe(2);
    expect(armed.resetCount).toBe(1);
    expect(armed.armCount).toBe(1);
    expect(armed.lastSetTargetAtMs).toBe(0);
    expect(armed.lastResetAtMs).toBe(0);
    expect(armed.lastTargetChangeAtMs).toBe(0);
    expect(scene.realtimeGameplayValidator.getState().target).not.toBeNull();

    const countsAfterArm = {
      reset: scene.realtimeGameplayValidator.resetCount,
      setTarget: scene.realtimeGameplayValidator.setTargetCount
    };

    const repeated = syncGameplayValidationWindow(scene as never, 16, 9.62);
    expect(repeated.phase).toBe('armed');
    expect(scene.realtimeGameplayValidator.resetCount).toBe(countsAfterArm.reset);
    expect(scene.realtimeGameplayValidator.setTargetCount).toBe(countsAfterArm.setTarget);

    const output = runValidatorFrames(scene, targets, [0, 16, 32]);
    expect(output.accepted).toBe(true);
    expect(output.targetMode).toBe(targets.length > 1 ? 'poly' : 'mono');

    markGameplayValidationWindowAccepted(scene as never, 48, 9.62);
    const acceptedState = syncGameplayValidationWindow(scene as never, 64, 9.63);
    expect(acceptedState.phase).toBe('accepted');
    expect(acceptedState.deadTime).toBe(true);

    const rejectedAfterAccept = scene.realtimeGameplayValidator.update({
      timestampMs: 80,
      frameEvidence: makeFrameEvidence(80, targets.map((target) => makeNoteEvidence(target.expected_midi, 80)))
    });
    expect(rejectedAfterAccept.accepted).toBe(false);
    expect(rejectedAfterAccept.rejectStage).toBe('no_target');
  });

  test('expires after the late tolerance window and stays disarmed', () => {
    const target = makeTarget('t-2', 1000, 60);
    const scene = makeScene([target]);

    const expired = syncGameplayValidationWindow(scene as never, 0, 10.7);
    expect(expired.phase).toBe('expired');
    expect(expired.deadTime).toBe(true);
    expect(expired.expiredAtSongSeconds).toBe(10.7);
    expect(scene.realtimeGameplayValidator.getState().target).toBeNull();

    const countsAfterExpire = {
      reset: scene.realtimeGameplayValidator.resetCount,
      setTarget: scene.realtimeGameplayValidator.setTargetCount
    };

    const repeated = syncGameplayValidationWindow(scene as never, 16, 9.65);
    expect(repeated.phase).toBe('expired');
    expect(scene.realtimeGameplayValidator.resetCount).toBe(countsAfterExpire.reset);
    expect(scene.realtimeGameplayValidator.setTargetCount).toBe(countsAfterExpire.setTarget);

    const output = scene.realtimeGameplayValidator.update({
      timestampMs: 32,
      frameEvidence: makeFrameEvidence(32, [makeNoteEvidence(60, 32)])
    });
    expect(output.accepted).toBe(false);
    expect(output.rejectStage).toBe('no_target');
  });

  test('keeps validation armed while the runtime is waiting for hit', () => {
    const target = makeTarget('t-3', 1000, 60);
    const scene = makeScene([target]);

    const armed = syncGameplayValidationWindow(scene as never, 0, 9.6);
    expect(armed.phase).toBe('armed');
    expect(armed.deadTime).toBe(false);
    expect(scene.realtimeGameplayValidator.getState().target).not.toBeNull();

    const countsAfterArm = {
      reset: scene.realtimeGameplayValidator.resetCount,
      setTarget: scene.realtimeGameplayValidator.setTargetCount
    };

    scene.runtime = {
      ...scene.runtime,
      state: PlayState.WaitingForHit,
      waiting_target_id: target.id,
      waiting_started_at_s: 10.7
    };

    const waiting = syncGameplayValidationWindow(scene as never, 16, 10.7);
    expect(waiting.phase).toBe('armed');
    expect(waiting.deadTime).toBe(false);
    expect(waiting.lastReason).toBe('waiting');
    expect(waiting.expiredAtSongSeconds).toBeNull();
    expect(scene.realtimeGameplayValidator.getState().target).not.toBeNull();
    expect(scene.realtimeGameplayValidator.resetCount).toBe(countsAfterArm.reset);
    expect(scene.realtimeGameplayValidator.setTargetCount).toBe(countsAfterArm.setTarget);
  });
});
