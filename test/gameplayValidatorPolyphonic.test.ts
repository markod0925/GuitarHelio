import { describe, expect, test } from 'vitest';
import {
  evaluateCaseTelemetry,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig,
  type ValidatorRow
} from '../tools/benchmark_suites/gameplay_validator_core';
import {
  DEFAULT_ACTIVATION_GATE_POLICY,
  DEFAULT_NOTE_SET_POLICY,
  MONO_ACTIVATION_GATE_POLICY,
  MONO_NOTE_SET_POLICY,
  buildExpectedNoteWindows,
  evaluateNoteSetWindow,
  evaluatePolyphonicTelemetryForConfig,
  parseJamsNoteEvents,
  type ActivationGatePolicy,
  type NoteSetAggregationPolicy,
  type PolyphonicWindowTelemetry
} from '../tools/benchmark_suites/gameplay_validator_polyphonic';

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

function caseTelemetry(expectedMidi: number, frames: ValidatorCaseTelemetry['frames']): ValidatorCaseTelemetry {
  return {
    algorithm: 'MASP',
    caseId: `c_${expectedMidi}`,
    sourceFileId: 'src-1',
    sourceRelativeFilePath: 'tools/pitch-offline-bench/input/wav/mock.wav',
    sourceStringId: 3,
    sourceFret: 5,
    sourceTake: 0,
    sourceStringBand: 'mid',
    targetKind: 'single_note',
    mismatchType: 'correct_target',
    expectedAccept: true,
    expectedString: 3,
    expectedFret: 5,
    expectedMidi,
    samePitchAltCandidateExists: false,
    frames
  };
}

type DeepPartialValidatorDecisionConfig = Partial<Omit<ValidatorDecisionConfig, 'note' | 'position' | 'legacy'>> & {
  note?: Partial<ValidatorDecisionConfig['note']>;
  position?: Partial<ValidatorDecisionConfig['position']>;
  legacy?: Partial<ValidatorDecisionConfig['legacy']>;
};

function config(overrides: DeepPartialValidatorDecisionConfig = {}): ValidatorDecisionConfig {
  const base: ValidatorDecisionConfig = {
    id: 'cfg',
    label: 'cfg',
    mode: 'note_only',
    note: {
      minExpectedScore: 40,
      minExpectedSupportSeconds: 0.02,
      minConsecutiveExpectedFrames: 1,
      maxExpectedCentsError: 50,
      minExpectedConfidence: 0.2,
      minExpectedVsBestMargin: 0,
      minExpectedVsBestRatio: 1,
      minExpectedVsOctaveMargin: 0,
      ignoreAttackMs: 0,
      minMicRms: 0.008,
      minExpectedTop1FrameRatio: 0,
      minExpectedTop3FrameRatio: 0,
      minExpectedPairwiseWinRate: 0,
      maxOctaveConfusionFrameRatio: 1,
      minExpectedVsSourceFrameRatio: 0
    },
    position: {
      minPositionFrameRatio: 0,
      minConsecutivePositionFrames: 1,
      rejectSamePitchAltFrames: false
    },
    legacy: {
      frameToleranceCents: 50,
      acceptFrameRatio: 0.1
    }
  };
  return {
    ...base,
    ...overrides,
    note: {
      ...base.note,
      ...(overrides.note ?? {})
    },
    position: {
      ...base.position,
      ...(overrides.position ?? {})
    },
    legacy: {
      ...base.legacy,
      ...(overrides.legacy ?? {})
    }
  };
}

function toRow(expectedMidi: number, pass: boolean, decisionConfig: ValidatorDecisionConfig): ValidatorRow {
  const frames = pass
    ? [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })]
    : [
      frame({ frameIndex: 0, expectedScore: 10, bestCompetitorScore: 100, bestOctaveScore: 80 }),
      frame({ frameIndex: 1, expectedScore: 9, bestCompetitorScore: 90, bestOctaveScore: 70 })
    ];
  return evaluateCaseTelemetry(caseTelemetry(expectedMidi, frames), decisionConfig);
}

function gatePolicy(overrides: Partial<ActivationGatePolicy> = {}): ActivationGatePolicy {
  return {
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    ...overrides
  };
}

describe('JAMS parser', () => {
  test('extracts note_midi events and drops invalid observations', () => {
    const raw = JSON.stringify({
      annotations: [
        {
          namespace: 'note_midi',
          annotation_metadata: { data_source: '2' },
          data: [
            { time: 0.1, duration: 0.3, value: 60.2 },
            { time: 0.7, duration: 0.0, value: 62.0 }
          ]
        },
        {
          namespace: 'tempo',
          data: [{ time: 0, duration: 0, value: 120 }]
        }
      ],
      file_metadata: { duration: 1.2 }
    });

    const parsed = parseJamsNoteEvents(raw, 'mock.jams');
    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0].midi).toBe(60);
    expect(parsed.events[0].sourceTrack).toBe('2');
    expect(parsed.audit.noteEventCount).toBe(1);
    expect(parsed.audit.droppedObservationCount).toBe(1);
    expect(parsed.audit.namespaceCounts.note_midi).toBe(1);
  });
});

describe('Expected note windows', () => {
  test('builds time-aligned expected note sets for comp-like overlap', () => {
    const windows = buildExpectedNoteWindows({
      fileId: 'mock_comp',
      wavRelativePath: 'tools/pitch-offline-bench/input/wav/mock_comp_mic.wav',
      subset: 'comp',
      durationSec: 1.0,
      windowDurationSec: 0.5,
      windowHopSec: 0.5,
      minEventOverlapSec: 0.05,
      includeSilentWindows: true,
      maxWindowsPerFile: null,
      stableWindowMinRatio: 0.55,
      transitionOverlapThreshold: 0.45,
      events: [
        { startSec: 0.0, endSec: 0.6, midi: 60, sourceTrack: '0', annotationIndex: 0, observationIndex: 0 },
        { startSec: 0.2, endSec: 0.9, midi: 64, sourceTrack: '1', annotationIndex: 1, observationIndex: 0 }
      ]
    });

    expect(windows.length).toBe(2);
    expect(windows[0].expectedMidis).toEqual([60, 64]);
    expect(windows[1].expectedMidis).toEqual([60, 64]);
    expect(windows[0].windowCategory).toBe('poly_window');
    expect(windows[0].isStableWindow).toBe(true);
  });

  test('labels empty and transition windows explicitly', () => {
    const emptyWindows = buildExpectedNoteWindows({
      fileId: 'mock_empty',
      wavRelativePath: 'tools/pitch-offline-bench/input/wav/mock_empty_mic.wav',
      subset: 'solo',
      durationSec: 0.5,
      windowDurationSec: 0.5,
      windowHopSec: 0.5,
      minEventOverlapSec: 0.05,
      includeSilentWindows: true,
      maxWindowsPerFile: null,
      events: []
    });

    expect(emptyWindows.length).toBe(1);
    expect(emptyWindows[0].windowCategory).toBe('empty_window');
    expect(emptyWindows[0].isStableWindow).toBe(false);

    const transitionWindows = buildExpectedNoteWindows({
      fileId: 'mock_transition',
      wavRelativePath: 'tools/pitch-offline-bench/input/wav/mock_transition_mic.wav',
      subset: 'comp',
      durationSec: 0.5,
      windowDurationSec: 0.5,
      windowHopSec: 0.5,
      minEventOverlapSec: 0.01,
      includeSilentWindows: true,
      maxWindowsPerFile: null,
      stableWindowMinRatio: 0.85,
      transitionOverlapThreshold: 0.15,
      events: [
        { startSec: 0.0, endSec: 0.25, midi: 60, sourceTrack: '0', annotationIndex: 0, observationIndex: 0 },
        { startSec: 0.25, endSec: 0.5, midi: 64, sourceTrack: '1', annotationIndex: 1, observationIndex: 0 }
      ]
    });

    expect(transitionWindows.length).toBe(1);
    expect(transitionWindows[0].windowCategory).toBe('transition_window');
    expect(transitionWindows[0].isStableWindow).toBe(false);
    expect(transitionWindows[0].transitionOverlapRatio).toBeGreaterThan(0.15);
  });
});

describe('Note-set aggregation', () => {
  test('accepts partial chord when min_ratio policy is satisfied', () => {
    const decision = config();
    const rows = [toRow(60, true, decision), toRow(64, true, decision), toRow(67, false, decision)];

    const policy: NoteSetAggregationPolicy = {
      ...DEFAULT_NOTE_SET_POLICY,
      mode: 'min_ratio_required',
      minNoteRatio: 2 / 3,
      minNoteCount: 1
    };

    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w1',
      fileId: 'f1',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [60, 64, 67],
      rawDetectedMidis: [60, 64, 70],
      perNoteRows: rows,
      policy
    });

    expect(result.accept).toBe(true);
    expect(result.aggregationMode).toBe('poly_aggregation_mode');
    expect(result.noteSetCardinality).toBe(3);
    expect(result.noteDecisionConfigId).toBe('cfg');
    expect(result.validatedNoteCount).toBe(2);
    expect(result.noteValidationRatio).toBeCloseTo(2 / 3, 6);
    expect(result.missingExpectedNotes).toEqual([67]);
    expect(result.extraDetectedNotes).toEqual([70]);
    expect(result.supersetMatch).toBe(false);
    expect(result.setRelation).toBe('partial_overlap');
  });

  test('treats a single expected note as mono aggregation mode', () => {
    const decision = config();
    const row = toRow(60, true, decision);

    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_mono',
      fileId: 'f_mono',
      wavRelativePath: 'mono.wav',
      subset: 'solo',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [60],
      rawDetectedMidis: [60],
      perNoteRows: [row],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required'
      }
    });

    expect(result.aggregationMode).toBe('mono_aggregation_mode');
    expect(result.noteSetCardinality).toBe(1);
    expect(result.noteDecisionConfigId).toBe('cfg');
  });

  test('rejects when octave-confusion threshold is strict and evidence is confused', () => {
    const strictConfig = config({
      note: {
        maxOctaveConfusionFrameRatio: 0
      }
    });

    const confusedTelemetry = caseTelemetry(60, [
      frame({ frameIndex: 0, octaveCompetitorOutranked: true }),
      frame({ frameIndex: 1, octaveCompetitorOutranked: true })
    ]);

    const row = evaluateCaseTelemetry(confusedTelemetry, strictConfig);
    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: strictConfig.id,
      windowId: 'w_oct',
      fileId: 'f_oct',
      wavRelativePath: 'mock.wav',
      subset: 'solo',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [60],
      rawDetectedMidis: [72],
      perNoteRows: [row],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required'
      }
    });

    expect(row.decisionAccept).toBe(false);
    expect(result.accept).toBe(false);
    expect(result.missingExpectedNotes).toEqual([60]);
    expect(result.disjointSetMatch).toBe(true);
  });

  test('classifies stable exact, superset, subset, and silent false activation cases', () => {
    const decision = config();
    const hit60 = toRow(60, true, decision);
    const hit64 = toRow(64, true, decision);
    const miss64 = toRow(64, false, decision);

    const exact = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_exact',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60, 64],
      perNoteRows: [hit60, hit64],
      policy: { ...DEFAULT_NOTE_SET_POLICY, mode: 'all_notes_required', allowSupersetIfExpectedCovered: false, maxExtraDetectedNotes: 0 }
    });
    expect(exact.exactSetMatch).toBe(true);
    expect(exact.setRelation).toBe('exact');
    expect(exact.policyAccept).toBe(true);

    const superset = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_superset',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60, 64, 67],
      perNoteRows: [hit60, hit64],
      policy: { ...DEFAULT_NOTE_SET_POLICY, mode: 'all_notes_required', allowSupersetIfExpectedCovered: true, maxExtraDetectedNotes: null }
    });
    expect(superset.supersetMatch).toBe(true);
    expect(superset.setRelation).toBe('superset');
    expect(superset.policyAccept).toBe(true);
    expect(superset.strictAccept).toBe(false);

    const subset = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_subset',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60],
      perNoteRows: [hit60, miss64],
      policy: { ...DEFAULT_NOTE_SET_POLICY, mode: 'all_notes_required' }
    });
    expect(subset.subsetMatch).toBe(true);
    expect(subset.setRelation).toBe('subset');
    expect(subset.policyAccept).toBe(false);

    const silentFalseActivation = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_silent',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'solo',
      startSec: 0.5,
      endSec: 1.0,
      expectedMidis: [],
      rawDetectedMidis: [67],
      perNoteRows: [],
      policy: { ...DEFAULT_NOTE_SET_POLICY, emptyWindowMustBeQuiet: true }
    });
    expect(silentFalseActivation.setRelation).toBe('empty_false_activation');
    expect(silentFalseActivation.policyFalseAccept).toBe(true);
    expect(silentFalseActivation.negativeType).toBe('empty_negative');
  });
});

describe('Polyphonic telemetry evaluation', () => {
  test('aggregates solo and comp subsets with shared per-note core semantics', () => {
    const decision = config();
    const soloNote = caseTelemetry(55, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })]);
    const compNoteA = caseTelemetry(60, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })]);
    const compNoteB = caseTelemetry(64, [
      frame({ frameIndex: 0, expectedScore: 10, bestCompetitorScore: 80 }),
      frame({ frameIndex: 1, expectedScore: 12, bestCompetitorScore: 75 })
    ]);

    const telemetry: PolyphonicWindowTelemetry[] = [
      {
        algorithm: 'MASP',
        windowId: 'solo_w1',
        fileId: 'solo_f',
        wavRelativePath: 'solo.wav',
        subset: 'solo',
        startSec: 0,
        endSec: 0.5,
        expectedMidis: [55],
        rawDetectedMidis: [55],
        perNoteTelemetry: [soloNote]
      },
      {
        algorithm: 'MASP',
        windowId: 'comp_w1',
        fileId: 'comp_f',
        wavRelativePath: 'comp.wav',
        subset: 'comp',
        startSec: 0,
        endSec: 0.5,
        expectedMidis: [60, 64],
        rawDetectedMidis: [60, 67],
        perNoteTelemetry: [compNoteA, compNoteB]
      }
    ];

    const evaluation = evaluatePolyphonicTelemetryForConfig({
      windowTelemetry: telemetry,
      decisionConfig: decision,
      noteSetPolicy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'min_ratio_required',
        minNoteRatio: 0.5
      },
      algorithms: ['MASP', 'spectral_game_runtime_unified_v3']
    });

    const soloMetrics = evaluation.aggregates.MASP.solo;
    const compMetrics = evaluation.aggregates.MASP.comp;
    const combinedMetrics = evaluation.aggregates.MASP.combined;

    expect(soloMetrics.windows).toBe(1);
    expect(compMetrics.windows).toBe(1);
    expect(compMetrics.noteValidationRatio).toBeCloseTo(0.5, 6);
    expect(combinedMetrics.expectedNoteCountTotal).toBe(3);
    expect(combinedMetrics.validatedNoteCountTotal).toBe(2);
    expect(combinedMetrics.noteLevelRecall).toBeCloseTo(2 / 3, 6);
    expect(combinedMetrics.emptyWindowFalseAcceptRate).toBeNull();
  });

  test('computes negative FAR breakdown by type', () => {
    const decision = config();
    const ok60 = caseTelemetry(60, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })]);
    const ok64 = caseTelemetry(64, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })]);
    const miss64 = caseTelemetry(64, [
      frame({ frameIndex: 0, expectedScore: 5, bestCompetitorScore: 90 }),
      frame({ frameIndex: 1, expectedScore: 8, bestCompetitorScore: 85 })
    ]);

    const telemetry: PolyphonicWindowTelemetry[] = [
      {
        algorithm: 'MASP',
        windowId: 'w_empty',
        fileId: 'f',
        wavRelativePath: 'f.wav',
        subset: 'comp',
        startSec: 0,
        endSec: 0.5,
        expectedMidis: [],
        windowCategory: 'empty_window',
        baseWindowCategory: 'empty_window',
        isStableWindow: false,
        rawDetectedMidis: [67],
        perNoteTelemetry: []
      },
      {
        algorithm: 'MASP',
        windowId: 'w_stable_superset',
        fileId: 'f',
        wavRelativePath: 'f.wav',
        subset: 'comp',
        startSec: 0.5,
        endSec: 1.0,
        expectedMidis: [60, 64],
        windowCategory: 'poly_window',
        baseWindowCategory: 'poly_window',
        isStableWindow: true,
        rawDetectedMidis: [60, 64, 67],
        perNoteTelemetry: [ok60, ok64]
      },
      {
        algorithm: 'MASP',
        windowId: 'w_transition',
        fileId: 'f',
        wavRelativePath: 'f.wav',
        subset: 'comp',
        startSec: 1.0,
        endSec: 1.5,
        expectedMidis: [60, 64],
        windowCategory: 'transition_window',
        baseWindowCategory: 'poly_window',
        isStableWindow: false,
        rawDetectedMidis: [60, 64],
        perNoteTelemetry: [ok60, miss64]
      }
    ];

    const evaluation = evaluatePolyphonicTelemetryForConfig({
      windowTelemetry: telemetry,
      decisionConfig: decision,
      noteSetPolicy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required',
        allowSupersetIfExpectedCovered: true,
        emptyWindowMustBeQuiet: true
      },
      algorithms: ['MASP', 'spectral_game_runtime_unified_v3']
    });

    const metrics = evaluation.aggregates.MASP.comp;
    expect(metrics.negativeTypeMetrics.empty_negative.windows).toBe(1);
    expect(metrics.negativeTypeMetrics.empty_negative.preGateFalseAcceptRate).toBe(1);
    expect(metrics.negativeTypeMetrics.empty_negative.postGateFalseAcceptRate).toBe(0);
    expect(metrics.negativeTypeMetrics.empty_negative.falseAcceptRate).toBe(0);
    expect(metrics.negativeTypeMetrics.set_mismatch_negative.windows).toBe(1);
    expect(metrics.negativeTypeMetrics.set_mismatch_negative.falseAcceptRate).toBe(1);
    expect(metrics.negativeTypeMetrics.transition_ambiguous_negative.windows).toBe(1);
    expect(metrics.transitionWindowAcceptRate).toBe(0);
  });
});

describe('Activation gate policies', () => {
  test('suppresses weak spurious activation in empty windows', () => {
    const decision = config();
    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_empty_weak',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'solo',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [],
      rawDetectedMidis: [67],
      rawDetectionMaxConfidence: 0.12,
      perNoteRows: [],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        emptyWindowMustBeQuiet: true
      },
      activationGatePolicy: gatePolicy({
        emptyWindowMustBeQuiet: true
      })
    });

    expect(result.preGateAccept).toBe(true);
    expect(result.postGateAccept).toBe(false);
    expect(result.gateRejectReason).toBe('empty_window_requires_quiet');
    expect(result.postGateFalseAccept).toBe(false);
  });

  test('suppresses strong false activation in empty windows via confidence cap', () => {
    const decision = config();
    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_empty_strong',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'solo',
      startSec: 0,
      endSec: 0.5,
      expectedMidis: [],
      rawDetectedMidis: [69],
      rawDetectionMaxConfidence: 0.91,
      perNoteRows: [],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        emptyWindowMustBeQuiet: false
      },
      activationGatePolicy: gatePolicy({
        emptyWindowMustBeQuiet: false,
        emptyWindowMaxExtraNotes: 2,
        emptyWindowMaxValidatedNotes: 0,
        emptyWindowMaxConfidence: 0.6
      })
    });

    expect(result.preGateAccept).toBe(true);
    expect(result.postGateAccept).toBe(false);
    expect(result.gateRejectReason).toBe('empty_window_confidence_exceeded');
  });

  test('applies stricter gating in transition windows with partial overlap', () => {
    const decision = config();
    const hit60 = toRow(60, true, decision);
    const miss64 = toRow(64, false, decision);
    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_transition_partial',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 0.5,
      endSec: 1.0,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60, 67],
      windowCategory: 'transition_window',
      baseWindowCategory: 'poly_window',
      isStableWindow: false,
      stableSetRatio: 0.82,
      transitionOverlapRatio: 0.75,
      perNoteRows: [hit60, miss64],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'min_ratio_required',
        minNoteRatio: 0.5
      },
      activationGatePolicy: gatePolicy({
        minExpectedNoteRatioForActivation: 0.5,
        transitionMinNoteRatio: 0.5,
        transitionMinStableRatio: 0.7,
        transitionMaxOverlapRatio: 0.6
      })
    });

    expect(result.setRelation).toBe('partial_overlap');
    expect(result.preGateAccept).toBe(true);
    expect(result.postGateAccept).toBe(false);
    expect(result.gateRejectReason).toBe('transition_overlap_too_high');
  });

  test('keeps stable exact windows accepted', () => {
    const decision = config();
    const hit60 = toRow(60, true, decision);
    const hit64 = toRow(64, true, decision);
    const result = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_stable_exact',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 1.0,
      endSec: 1.5,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60, 64],
      perNoteRows: [hit60, hit64],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required'
      },
      activationGatePolicy: gatePolicy()
    });

    expect(result.setRelation).toBe('exact');
    expect(result.preGateAccept).toBe(true);
    expect(result.postGateAccept).toBe(true);
    expect(result.gateRejectReason).toBe('passed');
  });

  test('handles stable superset gating and stricter subset rejection', () => {
    const decision = config();
    const hit60 = toRow(60, true, decision);
    const hit64 = toRow(64, true, decision);
    const miss64 = toRow(64, false, decision);

    const stableSupersetAllowed = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_stable_superset_allowed',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 2.0,
      endSec: 2.5,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60, 64, 67],
      perNoteRows: [hit60, hit64],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required',
        allowSupersetIfExpectedCovered: true,
        maxExtraDetectedNotes: null
      },
      activationGatePolicy: gatePolicy({
        stableAllowSupersetIfExpectedCovered: true
      })
    });
    expect(stableSupersetAllowed.preGateAccept).toBe(true);
    expect(stableSupersetAllowed.postGateAccept).toBe(true);
    expect(stableSupersetAllowed.setRelation).toBe('superset');

    const stableSupersetBlocked = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_stable_superset_blocked',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 2.5,
      endSec: 3.0,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60, 64, 67],
      perNoteRows: [hit60, hit64],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required',
        allowSupersetIfExpectedCovered: true,
        maxExtraDetectedNotes: null
      },
      activationGatePolicy: gatePolicy({
        stableAllowSupersetIfExpectedCovered: false
      })
    });
    expect(stableSupersetBlocked.preGateAccept).toBe(true);
    expect(stableSupersetBlocked.postGateAccept).toBe(false);
    expect(stableSupersetBlocked.gateRejectReason).toBe('stable_superset_not_allowed');

    const stableSubsetRejected = evaluateNoteSetWindow({
      algorithm: 'MASP',
      noteDecisionConfigId: decision.id,
      windowId: 'w_stable_subset_rejected',
      fileId: 'f',
      wavRelativePath: 'mock.wav',
      subset: 'comp',
      startSec: 3.0,
      endSec: 3.5,
      expectedMidis: [60, 64],
      rawDetectedMidis: [60],
      perNoteRows: [hit60, miss64],
      policy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'min_ratio_required',
        minNoteRatio: 0.5
      },
      activationGatePolicy: gatePolicy({
        minExpectedNoteRatioForActivation: 0.75
      })
    });
    expect(stableSubsetRejected.setRelation).toBe('subset');
    expect(stableSubsetRejected.preGateAccept).toBe(true);
    expect(stableSubsetRejected.postGateAccept).toBe(false);
    expect(stableSubsetRejected.gateRejectReason).toBe('expected_note_ratio_too_low');
  });

  test('separates pre-gate and post-gate metrics in aggregates', () => {
    const decision = config();
    const telemetry: PolyphonicWindowTelemetry[] = [
      {
        algorithm: 'MASP',
        windowId: 'w_empty',
        fileId: 'f',
        wavRelativePath: 'f.wav',
        subset: 'comp',
        startSec: 0,
        endSec: 0.5,
        expectedMidis: [],
        windowCategory: 'empty_window',
        baseWindowCategory: 'empty_window',
        isStableWindow: false,
        rawDetectedMidis: [67],
        rawDetectionMaxConfidence: 0.3,
        perNoteTelemetry: []
      },
      {
        algorithm: 'MASP',
        windowId: 'w_transition',
        fileId: 'f',
        wavRelativePath: 'f.wav',
        subset: 'comp',
        startSec: 0.5,
        endSec: 1.0,
        expectedMidis: [60, 64],
        windowCategory: 'transition_window',
        baseWindowCategory: 'poly_window',
        isStableWindow: false,
        stableSetRatio: 0.4,
        transitionOverlapRatio: 0.7,
        rawDetectedMidis: [60, 64],
        perNoteTelemetry: [
          caseTelemetry(60, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })]),
          caseTelemetry(64, [
            frame({ frameIndex: 0, expectedScore: 6, bestCompetitorScore: 90 }),
            frame({ frameIndex: 1, expectedScore: 7, bestCompetitorScore: 92 })
          ])
        ]
      },
      {
        algorithm: 'MASP',
        windowId: 'w_stable_exact',
        fileId: 'f',
        wavRelativePath: 'f.wav',
        subset: 'comp',
        startSec: 1.0,
        endSec: 1.5,
        expectedMidis: [67],
        windowCategory: 'single_note_window',
        baseWindowCategory: 'single_note_window',
        isStableWindow: true,
        stableSetRatio: 1,
        transitionOverlapRatio: 0,
        rawDetectedMidis: [67],
        perNoteTelemetry: [caseTelemetry(67, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })])]
      }
    ];

    const evaluation = evaluatePolyphonicTelemetryForConfig({
      windowTelemetry: telemetry,
      decisionConfig: decision,
      noteSetPolicy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'min_ratio_required',
        minNoteRatio: 0.5,
        allowSupersetIfExpectedCovered: true
      },
      activationGatePolicy: gatePolicy({
        emptyWindowMustBeQuiet: true,
        transitionMinStableRatio: 0.7,
        transitionMaxOverlapRatio: 0.6,
        transitionMinNoteRatio: 0.5
      }),
      algorithms: ['MASP', 'spectral_game_runtime_unified_v3']
    });

    const metrics = evaluation.aggregates.MASP.comp;
    expect(metrics.preGateEmptyWindowFalseAcceptRate).toBe(1);
    expect(metrics.postGateEmptyWindowFalseAcceptRate).toBe(0);
    expect(metrics.preGateTransitionWindowAcceptRate).toBe(1);
    expect(metrics.postGateTransitionWindowAcceptRate).toBe(0);
    expect(metrics.preGateExpectedNoteRecall).toBeCloseTo(2 / 3, 6);
    expect(metrics.postGateExpectedNoteRecall).toBeCloseTo(1 / 3, 6);
  });

  test('supports optional temporal hysteresis for post-gate activation', () => {
    const decision = config();
    const stableTelemetry = (windowId: string, startSec: number): PolyphonicWindowTelemetry => ({
      algorithm: 'MASP',
      windowId,
      fileId: 'f_hys',
      wavRelativePath: 'f.wav',
      subset: 'comp',
      startSec,
      endSec: startSec + 0.5,
      expectedMidis: [60],
      windowCategory: 'single_note_window',
      baseWindowCategory: 'single_note_window',
      isStableWindow: true,
      stableSetRatio: 1,
      transitionOverlapRatio: 0,
      rawDetectedMidis: [60],
      perNoteTelemetry: [caseTelemetry(60, [frame({ frameIndex: 0 }), frame({ frameIndex: 1 })])]
    });

    const evaluation = evaluatePolyphonicTelemetryForConfig({
      windowTelemetry: [
        stableTelemetry('w1', 0),
        stableTelemetry('w2', 0.5)
      ],
      decisionConfig: decision,
      noteSetPolicy: {
        ...DEFAULT_NOTE_SET_POLICY,
        mode: 'all_notes_required'
      },
      activationGatePolicy: gatePolicy({
        hysteresisFrames: 2
      }),
      algorithms: ['MASP', 'spectral_game_runtime_unified_v3']
    });

    const rows = evaluation.windowResults.filter((row) => row.algorithm === 'MASP');
    expect(rows).toHaveLength(2);
    expect(rows[0].gateCoreAccept).toBe(true);
    expect(rows[0].postGateAccept).toBe(false);
    expect(rows[0].gateSuppressedByHysteresis).toBe(true);
    expect(rows[0].gateRejectReason).toBe('hysteresis_not_satisfied');
    expect(rows[1].postGateAccept).toBe(true);
  });

  test('exposes canonical mono gate-off and poly gate-on defaults', () => {
    expect(MONO_NOTE_SET_POLICY.id).toContain('mono');
    expect(MONO_NOTE_SET_POLICY.minNoteCount).toBe(1);
    expect(MONO_ACTIVATION_GATE_POLICY.gateEnabled).toBe(false);
    expect(DEFAULT_NOTE_SET_POLICY.emptyWindowMustBeQuiet).toBe(true);
    expect(DEFAULT_ACTIVATION_GATE_POLICY.gateEnabled).toBe(true);
  });
});
