import { describe, expect, test } from 'vitest';
import {
  ALGORITHMS,
  aggregateValidatorRows,
  buildNoteEvidenceFromCaseTelemetry,
  evaluateCaseTelemetry,
  evaluateNoteEvidence,
  passesTar100Constraint,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig,
  type ValidatorRow
} from '../tools/benchmark_suites/gameplay_validator_core';

function frame(input: Partial<ValidatorCaseTelemetry['frames'][number]> = {}): ValidatorCaseTelemetry['frames'][number] {
  return {
    frameIndex: input.frameIndex ?? 0,
    timestampMs: input.timestampMs ?? 0,
    runtimeMs: input.runtimeMs ?? 1,
    detectorAccepted: input.detectorAccepted ?? true,
    detectorConfidence: input.detectorConfidence ?? 0.8,
    detectedMidi: input.detectedMidi ?? 60,
    detectedString: input.detectedString ?? 3,
    detectedFret: input.detectedFret ?? 5,
    expectedCentsError: input.expectedCentsError ?? 0,
    expectedScore: input.expectedScore ?? 100,
    bestCompetitorScore: input.bestCompetitorScore ?? 20,
    bestCompetitorMidi: input.bestCompetitorMidi ?? 61,
    bestOctaveScore: input.bestOctaveScore ?? 15,
    neighborScore: input.neighborScore ?? 12,
    samePitchAltScore: input.samePitchAltScore ?? null,
    expectedRank: input.expectedRank ?? 1,
    expectedTop1: input.expectedTop1 ?? true,
    expectedTop3: input.expectedTop3 ?? true,
    expectedPairwiseWinRate: input.expectedPairwiseWinRate ?? null,
    octaveCompetitorOutranked: input.octaveCompetitorOutranked ?? false,
    expectedVsSourceWon: input.expectedVsSourceWon ?? null,
    positionAmbiguous: input.positionAmbiguous ?? false,
    candidateScoreCount: input.candidateScoreCount ?? null,
    sharedEvidenceAvailability: input.sharedEvidenceAvailability ?? [],
    sharedEvidenceLimitations: input.sharedEvidenceLimitations ?? [],
    samePitchAltDetected: input.samePitchAltDetected ?? false,
    expectedPositionMatch: input.expectedPositionMatch ?? true,
    evidenceSource: input.evidenceSource ?? 'masp_proxy',
    spectralProbe: input.spectralProbe ?? null
  };
}

function caseTelemetry(input: Partial<ValidatorCaseTelemetry> = {}): ValidatorCaseTelemetry {
  return {
    algorithm: input.algorithm ?? 'MASP',
    caseId: input.caseId ?? 'case-1',
    sourceFileId: input.sourceFileId ?? 'src-1',
    sourceRelativeFilePath: input.sourceRelativeFilePath ?? 'assets/demo.wav',
    sourceStringId: input.sourceStringId ?? 3,
    sourceFret: input.sourceFret ?? 5,
    sourceTake: input.sourceTake ?? 1,
    sourceStringBand: input.sourceStringBand ?? 'mid',
    targetKind: 'single_note',
    mismatchType: input.mismatchType ?? 'correct_target',
    expectedAccept: input.expectedAccept ?? true,
    expectedString: input.expectedString ?? 3,
    expectedFret: input.expectedFret ?? 5,
    expectedMidi: input.expectedMidi ?? 60,
    samePitchAltCandidateExists: input.samePitchAltCandidateExists ?? false,
    frames: input.frames ?? [frame(), frame({ frameIndex: 1 })]
  };
}

function config(mode: ValidatorDecisionConfig['mode']): ValidatorDecisionConfig {
  return {
    id: `cfg-${mode}`,
    label: 'test',
    mode,
    note: {
      minExpectedScore: 40,
      minExpectedSupportSeconds: 0.02,
      minConsecutiveExpectedFrames: 2,
      maxExpectedCentsError: 35,
      minExpectedConfidence: 0.2,
      minExpectedVsBestMargin: 10,
      minExpectedVsBestRatio: 1.4,
      minExpectedVsOctaveMargin: 10,
      ignoreAttackMs: 0,
      minExpectedTop1FrameRatio: 0,
      minExpectedTop3FrameRatio: 0,
      minExpectedPairwiseWinRate: 0,
      maxOctaveConfusionFrameRatio: 1,
      minExpectedVsSourceFrameRatio: 0
    },
    position: {
      minPositionFrameRatio: 0.5,
      minConsecutivePositionFrames: 2,
      rejectSamePitchAltFrames: true
    },
    legacy: {
      frameToleranceCents: 50,
      acceptFrameRatio: 0.12
    }
  };
}

describe('evaluateCaseTelemetry decision semantics', () => {
  test('accepts note_only when expected evidence passes', () => {
    const telemetry = caseTelemetry({
      frames: [
        frame({ frameIndex: 0 }),
        frame({ frameIndex: 1 }),
        frame({ frameIndex: 2, detectorAccepted: false, expectedCentsError: null, expectedScore: 10, bestCompetitorScore: 40 }),
        frame({ frameIndex: 3 })
      ]
    });

    const row = evaluateCaseTelemetry(telemetry, config('note_only'));
    expect(row.decisionAccept).toBe(true);
    expect(row.decisionReason).toBe('note_stage_passed');
    expect(row.hitFrameCountExpected).toBe(3);
    expect(row.noteDecisionConfigId).toBe('cfg-note_only');
    expect(row.acceptedNote).toBe(true);
    expect(row.topKPresence.top1FrameRatio).toBeGreaterThan(0);
  });

  test('builds shared note evidence and reuses the shared note decision core', () => {
    const telemetry = caseTelemetry({
      frames: [
        frame({ frameIndex: 0 }),
        frame({ frameIndex: 1, expectedScore: 80, bestCompetitorScore: 20, detectorConfidence: 0.95 })
      ]
    });

    const evidence = buildNoteEvidenceFromCaseTelemetry(telemetry, config('note_only'));
    const decision = evaluateNoteEvidence(evidence, config('note_only'));

    expect(evidence.noteDecisionConfigId).toBe('cfg-note_only');
    expect(evidence.supportFrames).toBeGreaterThan(0);
    expect(evidence.topKPresence.top1FrameRatio).toBeGreaterThanOrEqual(0);
    expect(evidence.acceptedNote).toBeNull();
    expect(decision.decisionAccept).toBe(true);
    expect(decision.acceptedNote).toBe(true);
  });

  test('rejects when expected evidence is weaker than competitors', () => {
    const telemetry = caseTelemetry({
      expectedAccept: false,
      mismatchType: 'neighbor_fret',
      frames: [
        frame({ expectedScore: 10, bestCompetitorScore: 50, bestOctaveScore: 30, expectedCentsError: 0 }),
        frame({ frameIndex: 1, expectedScore: 12, bestCompetitorScore: 45, bestOctaveScore: 25, expectedCentsError: 0 }),
        frame({ frameIndex: 2, expectedScore: 8, bestCompetitorScore: 60, bestOctaveScore: 35, expectedCentsError: 0 }),
        frame({ frameIndex: 3, expectedScore: 11, bestCompetitorScore: 55, bestOctaveScore: 31, expectedCentsError: 0 })
      ]
    });

    const row = evaluateCaseTelemetry(telemetry, config('note_only'));
    expect(row.decisionAccept).toBe(false);
    expect(row.decisionReason).toBe('stage_a_expected_support_seconds_failed');
  });

  test('distinguishes note_only vs exact_position for same-pitch alt string', () => {
    const telemetry = caseTelemetry({
      expectedAccept: false,
      mismatchType: 'same_pitch_alt_string',
      samePitchAltCandidateExists: true,
      frames: [
        frame({ samePitchAltDetected: true, expectedPositionMatch: false, detectedString: 2, detectedFret: 10 }),
        frame({ frameIndex: 1, samePitchAltDetected: true, expectedPositionMatch: false, detectedString: 2, detectedFret: 10 }),
        frame({ frameIndex: 2, samePitchAltDetected: true, expectedPositionMatch: false, detectedString: 2, detectedFret: 10 }),
        frame({ frameIndex: 3, samePitchAltDetected: true, expectedPositionMatch: false, detectedString: 2, detectedFret: 10 })
      ]
    });

    const noteOnlyRow = evaluateCaseTelemetry(telemetry, config('note_only'));
    const exactPositionRow = evaluateCaseTelemetry(telemetry, config('exact_position'));

    expect(noteOnlyRow.decisionAccept).toBe(true);
    expect(exactPositionRow.decisionAccept).toBe(false);
    expect(exactPositionRow.decisionReason).toBe('stage_b_position_frame_ratio_failed');
  });
});

describe('aggregateValidatorRows metrics', () => {
  test('computes mismatch FAR and band metrics', () => {
    const rows: ValidatorRow[] = [
      {
        ...evaluateCaseTelemetry(caseTelemetry({ caseId: 'p', expectedAccept: true, mismatchType: 'correct_target' }), config('note_only')),
        decisionAccept: true
      },
      {
        ...evaluateCaseTelemetry(caseTelemetry({ caseId: 'n1', expectedAccept: false, mismatchType: 'neighbor_fret' }), config('note_only')),
        decisionAccept: true
      },
      {
        ...evaluateCaseTelemetry(caseTelemetry({ caseId: 'n2', expectedAccept: false, mismatchType: 'octave_distractor', sourceStringBand: 'low' }), config('note_only')),
        decisionAccept: false
      },
      {
        ...evaluateCaseTelemetry(caseTelemetry({ caseId: 'n3', expectedAccept: false, mismatchType: 'nearby_note_distractor', sourceStringBand: 'high' }), config('note_only')),
        decisionAccept: true
      },
      {
        ...evaluateCaseTelemetry(caseTelemetry({ caseId: 'n4', expectedAccept: false, mismatchType: 'same_pitch_alt_string', sourceStringBand: 'high' }), config('note_only')),
        decisionAccept: false
      }
    ];

    const agg = aggregateValidatorRows(rows);
    expect(agg.tar).toBe(1);
    expect(agg.far).toBeCloseTo(0.5, 6);
    expect(agg.mismatchFarByType.neighbor_fret).toBe(1);
    expect(agg.mismatchFarByType.octave_distractor).toBe(0);
    expect(agg.mismatchFarByType.nearby_note_distractor).toBe(1);
    expect(agg.mismatchFarByType.same_pitch_alt_string).toBe(0);
    expect(agg.tarFarByStringBand.low.far).toBe(0);
    expect(agg.tarFarByStringBand.high.far).toBeCloseTo(0.5, 6);
  });
});

describe('TAR gate', () => {
  test('passes only when all algorithms have TAR 100%', () => {
    const aggregatesOk = {
      MASP: { tar: 1 },
      spectral_game_runtime_unified_v3: { tar: 1 }
    } as unknown as Record<(typeof ALGORITHMS)[number], { tar: number }>;

    const aggregatesFail = {
      MASP: { tar: 1 },
      spectral_game_runtime_unified_v3: { tar: 0.99 }
    } as unknown as Record<(typeof ALGORITHMS)[number], { tar: number }>;

    expect(passesTar100Constraint(aggregatesOk as any)).toBe(true);
    expect(passesTar100Constraint(aggregatesFail as any)).toBe(false);
  });
});
