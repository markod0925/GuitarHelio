import { describe, expect, test } from 'vitest';
import { DEFAULT_VALIDATOR_DECISION_CONFIG, RealtimeGameplayValidator, buildValidationTargetFromTargetGroup, type ValidatorFrameCandidateEvidence, type ValidatorFrameEvidence } from '../src/gameplay/validation';
import { createIdleValidationWindowState } from '../src/ui/play/controllers/validationWindow';
import {
  createGameplayValidationLiveTraceSession,
  recordGameplayValidationLiveTrace,
  replayGameplayValidationLiveTrace,
  serializeGameplayValidationLiveTrace
} from '../src/ui/play/controllers/gameplayValidationLiveTrace';
import type { PitchFrame, TargetNote } from '../src/types/models';

function makeTargetGroup(): TargetNote[] {
  return [
    {
      id: 'target-1',
      tick: 1000,
      duration_ticks: 120,
      string: 4,
      fret: 2,
      finger: 1,
      expected_midi: 60
    }
  ];
}

function makeFrame(): PitchFrame {
  return {
    t_seconds: 10.05,
    midi_estimate: 60,
    confidence: 0.95,
    selected_notes: [
      { midi: 60, score: 0.95, note_id: 'candidate-60' }
    ],
    best_note_id: 'candidate-60'
  };
}

function makeFrameEvidence(timestampMs: number): ValidatorFrameEvidence {
  const note: ValidatorFrameCandidateEvidence = {
    timestampMs,
    midi: 60,
    targetSemitoneTolerance: 3,
    matchedMidi: 60,
    matchedSemitoneDistance: 0,
    detectorAccepted: true,
    detectorConfidence: 0.95,
    detectedMidi: 60,
    detectedString: 4,
    detectedFret: 2,
    expectedCentsError: 0,
    expectedScore: 100,
    bestCompetitorScore: 10,
    bestCompetitorMidi: 62,
    bestOctaveScore: 5,
    neighborScore: 8,
    samePitchAltScore: null,
    expectedRank: 1,
    expectedTop1: true,
    expectedTop3: true,
    expectedPairwiseWinRate: 1,
    octaveCompetitorOutranked: false,
    expectedVsSourceWon: true,
    positionAmbiguous: false,
    candidateScoreCount: 1,
    sharedEvidenceAvailability: [],
    sharedEvidenceLimitations: [],
    evidenceSource: 'spectral_probe',
    spectralProbe: null,
    samePitchAltDetected: false,
    expectedPositionMatch: true
  };

  return {
    timestampMs,
    notes: [note],
    rawDetectedMidis: [60],
    rawDetectionMaxConfidence: 0.95,
    rawDetectionFrameRatio: 1,
    metadata: {}
  };
}

describe('gameplay validation live trace', () => {
  test('records a confirmed target window and replays it as accepted', () => {
    const targetGroup = makeTargetGroup();
    const difficulty = 'Easy' as const;
    const frame = makeFrame();
    const target = buildValidationTargetFromTargetGroup(targetGroup, difficulty);
    if (!target) {
      throw new Error('Expected a validation target for the live trace test.');
    }

    const permissiveDecisionConfig = {
      ...DEFAULT_VALIDATOR_DECISION_CONFIG,
      note: {
        ...DEFAULT_VALIDATOR_DECISION_CONFIG.note,
        minExpectedSupportSeconds: 0,
        minExpectedConfidence: 0,
        minExpectedTop1FrameRatio: 0,
        minExpectedTop3FrameRatio: 0,
        minExpectedPairwiseWinRate: 0,
        maxOctaveConfusionFrameRatio: 1,
        minExpectedVsSourceFrameRatio: 0,
        minExpectedTargetConfirmationFrameRatio: 0
      }
    } as const;

    const validator = new RealtimeGameplayValidator({ noteDecisionConfig: permissiveDecisionConfig });
    validator.setTarget(target);
    validator.update({
      timestampMs: 0,
      frameEvidence: makeFrameEvidence(0)
    });
    validator.update({
      timestampMs: 16,
      frameEvidence: makeFrameEvidence(16)
    });
    const runtimeOutput = validator.update({
      timestampMs: 32,
      frameEvidence: makeFrameEvidence(32)
    });

    expect(runtimeOutput.accepted).toBe(true);

    const trace = createGameplayValidationLiveTraceSession(0);
    const validationWindow = createIdleValidationWindowState();
    validationWindow.phase = 'accepted';
    validationWindow.deadTime = true;
    validationWindow.targetKey = targetGroup.map((note) => note.id).join('|');
    validationWindow.targetIds = targetGroup.map((note) => note.id);
    validationWindow.targetMode = 'mono';
    validationWindow.difficulty = difficulty;
    validationWindow.semitoneTolerance = target.semitoneTolerance;
    validationWindow.windowStartSeconds = 9.55;
    validationWindow.windowEndSeconds = 10.55;
    validationWindow.armedAtMs = 0;
    validationWindow.acceptedAtSongSeconds = 10.05;
    validationWindow.lastReason = 'accepted';

    recordGameplayValidationLiveTrace(trace, {
      timestampMs: 32,
      songSecondsNow: 10.05,
      frame,
      validationWindow,
      runtimeOutput,
      targetGroup,
      difficulty
    });

    expect(trace.windows).toHaveLength(1);
    expect(trace.windows[0]?.outcome).toBe('accepted');
    expect(trace.windows[0]?.samples).toHaveLength(1);
    expect(trace.metrics.acceptedWindows).toBe(1);
    expect(trace.metrics.medianConfirmationLatencyMs).toBe(32);
    expect(trace.metrics.windowsWithTopCandidateConfirmation).toBe(1);

    const replay = replayGameplayValidationLiveTrace(trace, {
      reset() {},
      setTarget() {},
      update() {
        return { accepted: true } as any;
      }
    } as unknown as RealtimeGameplayValidator);
    expect(replay.acceptedWindows).toBe(1);
    expect(replay.mismatchedWindows).toBe(0);
    expect(replay.replayedWindows).toBe(1);

    const serialized = serializeGameplayValidationLiveTrace(trace);
    expect(serialized).toContain('target-1');
    expect(serialized).toContain('accepted');
  });
});
