import {
  evaluateNoteEvidence as evaluateRuntimeNoteEvidence,
  estimateQualifiedSupportSeconds
} from '../../src/gameplay/validation';
import type {
  ValidatorNoteEvidence as RuntimeValidatorNoteEvidence
} from '../../src/gameplay/validation';

export type AlgorithmName = 'MASP' | 'spectral_game_runtime_unified_v3';

export type MismatchType =
  | 'correct_target'
  | 'neighbor_fret'
  | 'octave_distractor'
  | 'same_pitch_alt_string'
  | 'nearby_note_distractor';

export type TargetKind = 'single_note';

export type DecisionMode = 'legacy_hit_ratio' | 'note_only' | 'exact_position';

export type StringBand = 'low' | 'mid' | 'high';
export type FretBand = 'low' | 'mid' | 'high';

export type SpectralProbeCompetitorClass =
  | 'source_actual'
  | 'neighbor'
  | 'octave'
  | 'same_pitch_alt'
  | 'nearby_note'
  | 'other';

export type SpectralProbeCandidateScore = {
  noteId: string;
  midi: number;
  stringId: number;
  fret: number;
  rawScore: number;
  relativeScore: number | null;
  rank: number;
  competitorClass: SpectralProbeCompetitorClass;
};

export type SpectralProbePairwiseTelemetry = {
  noteId: string;
  midi: number;
  stringId: number;
  fret: number;
  competitorClass: SpectralProbeCompetitorClass;
  expectedScore: number | null;
  competitorScore: number | null;
  expectedWon: boolean | null;
  detectedString: number | null;
  detectedFret: number | null;
  positionAmbiguous: boolean;
};

export type SpectralProbeFrameTelemetry = {
  probeVersion: 'spectral_probe_v1';
  expectedNoteId: string;
  candidateCount: number;
  availableCandidateScoreCount: number;
  topCandidates: SpectralProbeCandidateScore[];
  pairwise: SpectralProbePairwiseTelemetry[];
  expectedRank: number | null;
  expectedTop1: boolean;
  expectedTop3: boolean;
  expectedPairwiseWinRate: number | null;
  octaveCompetitorOutranked: boolean;
  expectedVsSourceWon: boolean | null;
  positionAmbiguous: boolean;
  missingEvidence: string[];
};

export type FrameTelemetry = {
  frameIndex: number;
  timestampMs: number;
  runtimeMs: number;
  detectorAccepted: boolean;
  detectorConfidence: number;
  detectedMidi: number | null;
  detectedString: number | null;
  detectedFret: number | null;
  expectedCentsError: number | null;
  expectedScore: number;
  bestCompetitorScore: number;
  bestCompetitorMidi: number | null;
  bestOctaveScore: number;
  neighborScore: number;
  samePitchAltScore: number | null;
  expectedRank: number | null;
  expectedTop1: boolean;
  expectedTop3: boolean;
  expectedPairwiseWinRate: number | null;
  octaveCompetitorOutranked: boolean;
  expectedVsSourceWon: boolean | null;
  positionAmbiguous: boolean;
  candidateScoreCount: number | null;
  sharedEvidenceAvailability: string[];
  sharedEvidenceLimitations: string[];
  evidenceSource: 'masp_proxy' | 'spectral_probe';
  spectralProbe: SpectralProbeFrameTelemetry | null;
  samePitchAltDetected: boolean;
  expectedPositionMatch: boolean;
};

export type ValidatorCaseTelemetry = {
  algorithm: AlgorithmName;
  caseId: string;
  sourceFileId: string;
  sourceRelativeFilePath: string;
  sourceStringId: number;
  sourceFret: number;
  sourceTake: number;
  sourceStringBand: StringBand;
  targetKind: TargetKind;
  mismatchType: MismatchType;
  expectedAccept: boolean;
  expectedString: number;
  expectedFret: number;
  expectedMidi: number;
  samePitchAltCandidateExists: boolean;
  frames: FrameTelemetry[];
};

export type NoteEvidenceConfig = {
  minExpectedScore: number;
  minExpectedSupportSeconds: number;
  minConsecutiveExpectedFrames: number;
  maxExpectedCentsError: number;
  minExpectedConfidence: number;
  minExpectedVsBestMargin: number;
  minExpectedVsBestRatio: number;
  minExpectedVsOctaveMargin: number;
  ignoreAttackMs: number;
  minExpectedTop1FrameRatio: number;
  minExpectedTop3FrameRatio: number;
  minExpectedPairwiseWinRate: number;
  maxOctaveConfusionFrameRatio: number;
  minExpectedVsSourceFrameRatio: number;
  minExpectedTargetConfirmationFrameRatio?: number;
};

export type PositionEvidenceConfig = {
  minPositionFrameRatio: number;
  minConsecutivePositionFrames: number;
  rejectSamePitchAltFrames: boolean;
};

export type LegacyHitRatioConfig = {
  frameToleranceCents: number;
  acceptFrameRatio: number;
};

export type ValidatorDecisionConfig = {
  id: string;
  label: string;
  mode: DecisionMode;
  note: NoteEvidenceConfig;
  position: PositionEvidenceConfig;
  legacy: LegacyHitRatioConfig;
};

export type ValidatorTopKPresence = {
  top1: boolean;
  top3: boolean;
  top1FrameRatio: number;
  top3FrameRatio: number;
};

export type ValidatorPairwiseCompetitorOutcome = {
  competitorClass: SpectralProbeCompetitorClass;
  comparisonCount: number;
  expectedWinRate: number | null;
  expectedScoreMean: number | null;
  competitorScoreMean: number | null;
  detectedPositionAmbiguousFrameRatio: number | null;
};

export type ValidatorNoteEvidence = {
  algorithm: AlgorithmName;
  caseId: string;
  sourceFileId: string;
  sourceRelativeFilePath: string;
  sourceStringId: number;
  sourceFret: number;
  sourceTake: number;
  sourceStringBand: StringBand;
  sourceFretBand: FretBand;
  targetKind: TargetKind;
  mismatchType: MismatchType;
  expectedAccept: boolean;
  expectedString: number;
  expectedFret: number;
  expectedMidi: number;
  noteDecisionConfigId: string;
  expectedTargetScore: number;
  nearbyCompetitorScore: number;
  rawDetectionMaxConfidence: number | null;
  rawDetectionFrameRatio: number | null;
  supportFrames: number;
  supportSeconds: number;
  minValidatedSupportFrames: number;
  minValidatedSupportSeconds: number;
  positionSupportFrames: number;
  positionMinValidatedSupportFrames: number;
  legacySupportFrames: number;
  legacyMinValidatedSupportFrames: number;
  minConsecutiveExpectedFrames: number;
  minConsecutivePositionFrames: number;
  pairwiseCompetitorOutcomes: ValidatorPairwiseCompetitorOutcome[] | null;
  acceptedNote: boolean | null;
  topKPresence: ValidatorTopKPresence;
  evidenceAvailability: string[];
  evidenceLimitations: string[];
  expectedVsBestMargin: number;
  expectedVsBestRatio: number;
  expectedVsOctaveMargin: number;
  expectedPairwiseWinRate: number | null;
  expectedTop1FrameRatio: number;
  expectedTop3FrameRatio: number;
  octaveConfusionFrameRatio: number;
  expectedVsSourceFrameRatio: number;
  targetConfirmationFrameRatio: number;
  positionAmbiguousFrameRatio: number;
  samePitchAltDetectedFrameCount: number;
  samePitchAltCandidateExists: boolean;
  confidenceScore: number;
  expectedSupportSeconds: number;
  positionFrameRatio: number;
  expectedCentsErrorMedian: number | null;
  expectedScoreMedian: number;
  bestCompetitorScoreMedian: number;
  bestCompetitorMidiMode: number | null;
  bestOctaveCompetitorScoreMedian: number;
  expectedVsBestMarginMedian: number;
  expectedVsBestRatioMedian: number;
  expectedVsOctaveMarginMedian: number;
  expectedRankMedian: number | null;
  expectedPairwiseWinRateMean: number | null;
};

export type ValidatorRow = ValidatorNoteEvidence & {
  decisionMode: DecisionMode;
  decisionAccept: boolean;
  decisionReason: string;
  hitFrameCount: number;
  wrongAcceptFrameCount: number;
  totalFrameCount: number;
  decisionLatencyMs: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
  hitFrameCountExpected: number;
  hitFrameCountAny: number;
  hitFrameCountPosition: number;
  minConsecutiveExpectedFrames: number;
  minConsecutivePositionFrames: number;
  firstExpectedHitLatencyMs: number | null;
  firstAnyHitLatencyMs: number | null;
  expectedSupportSeconds: number;
  positionFrameRatio: number;
  expectedCentsErrorMedian: number | null;
  expectedScoreMedian: number;
  bestCompetitorScoreMedian: number;
  bestCompetitorMidiMode: number | null;
  bestOctaveCompetitorScoreMedian: number;
  expectedVsBestMarginMedian: number;
  expectedVsBestRatioMedian: number;
  expectedVsOctaveMarginMedian: number;
  expectedRankMedian: number | null;
  expectedTop1FrameRatio: number;
  expectedTop3FrameRatio: number;
  expectedPairwiseWinRateMean: number | null;
  octaveConfusionFrameRatio: number;
  expectedVsSourceFrameRatio: number;
  targetConfirmationFrameRatio: number;
  positionAmbiguousFrameRatio: number;
  samePitchAltDetectedFrameCount: number;
  thresholdsApplied: {
    note: NoteEvidenceConfig;
    position: PositionEvidenceConfig;
    legacy: LegacyHitRatioConfig;
  };
};

export type BandTarFar = {
  positives: number;
  negatives: number;
  tar: number;
  far: number;
};

export type ValidatorAggregate = {
  algorithm: AlgorithmName;
  cases: number;
  positives: number;
  negatives: number;
  trueAccept: number;
  falseReject: number;
  falseAccept: number;
  trueReject: number;
  tar: number;
  far: number;
  strictFar: number;
  noteMismatchFar: number;
  positionOnlyFar: number;
  precision: number;
  recall: number;
  f1: number;
  medianDecisionLatencyMs: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
  lowStringTar: number;
  lowStringFar: number;
  mismatchFarByType: Record<string, number>;
  tarFarByStringBand: Record<StringBand, BandTarFar>;
  tarFarByFretBand: Record<FretBand, BandTarFar>;
};

const EPS = 1e-9;
export const ALGORITHMS: AlgorithmName[] = ['MASP', 'spectral_game_runtime_unified_v3'];

export const LEGACY_VALIDATOR_DECISION_CONFIG: ValidatorDecisionConfig = {
  id: 'legacy_hit_ratio_v1',
  label: 'Legacy hit-ratio decision',
  mode: 'legacy_hit_ratio',
  note: {
    minExpectedScore: 0,
    minExpectedSupportSeconds: 0.02,
    minConsecutiveExpectedFrames: 1,
    maxExpectedCentsError: 50,
    minExpectedConfidence: 0,
    minExpectedVsBestMargin: Number.NEGATIVE_INFINITY,
    minExpectedVsBestRatio: 0,
    minExpectedVsOctaveMargin: Number.NEGATIVE_INFINITY,
    ignoreAttackMs: 0,
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
    acceptFrameRatio: 0.12
  }
};

export const DEFAULT_VALIDATOR_DECISION_CONFIG: ValidatorDecisionConfig = {
  id: 'target_aware_note_only_v2_conf_gate',
  label: 'Target-aware note-only decision (confidence-gated)',
  mode: 'note_only',
  note: {
    minExpectedScore: 0,
    minExpectedSupportSeconds: 0.02,
    minConsecutiveExpectedFrames: 1,
    maxExpectedCentsError: 50,
    minExpectedConfidence: 0.4298,
    minExpectedVsBestMargin: -1000000,
    minExpectedVsBestRatio: 0,
    minExpectedVsOctaveMargin: -1000000,
    ignoreAttackMs: 0,
    minExpectedTop1FrameRatio: 0,
    minExpectedTop3FrameRatio: 0,
    minExpectedPairwiseWinRate: 0,
    maxOctaveConfusionFrameRatio: 1,
    minExpectedVsSourceFrameRatio: 0
  },
  position: {
    minPositionFrameRatio: 0.3,
    minConsecutivePositionFrames: 2,
    rejectSamePitchAltFrames: true
  },
  legacy: {
    frameToleranceCents: 50,
    acceptFrameRatio: 0.12
  }
};

export function deriveConfigWithMode(base: ValidatorDecisionConfig, mode: DecisionMode): ValidatorDecisionConfig {
  return {
    ...base,
    id: `${base.id}__${mode}`,
    label: `${base.label} (${mode})`,
    mode
  };
}

export function parseDecisionConfigFromEnv(base = DEFAULT_VALIDATOR_DECISION_CONFIG): ValidatorDecisionConfig {
  const rawMode = process.env.GAMEPLAY_VALIDATOR_DECISION_MODE;
  const mode: DecisionMode | null =
    rawMode === 'legacy_hit_ratio' || rawMode === 'note_only' || rawMode === 'exact_position'
      ? rawMode
      : null;

  const jsonOverrideRaw = process.env.GAMEPLAY_VALIDATOR_DECISION_CONFIG_JSON;
  const fromJson = jsonOverrideRaw ? safeParseConfigJson(jsonOverrideRaw, base) : base;
  return mode ? { ...fromJson, mode } : fromJson;
}

export function evaluateCaseTelemetry(caseTelemetry: ValidatorCaseTelemetry, config: ValidatorDecisionConfig): ValidatorRow {
  const eligibleFrames = caseTelemetry.frames.filter((frame) => frame.timestampMs >= config.note.ignoreAttackMs);
  const frames = eligibleFrames.length > 0 ? eligibleFrames : caseTelemetry.frames;

  const expectedDetectorHit = frames.map((frame) => (
    frame.detectorAccepted &&
    frame.expectedCentsError !== null &&
    Math.abs(frame.expectedCentsError) <= config.note.maxExpectedCentsError
  ));

  const expectedQualified = frames.map((frame, index) => {
    if (!expectedDetectorHit[index]) return false;
    const margin = frame.expectedScore - frame.bestCompetitorScore;
    const octaveMargin = frame.expectedScore - frame.bestOctaveScore;
    const ratio = frame.expectedScore / Math.max(EPS, frame.bestCompetitorScore);
    return (
      frame.expectedScore >= config.note.minExpectedScore &&
      margin >= config.note.minExpectedVsBestMargin &&
      ratio >= config.note.minExpectedVsBestRatio &&
      octaveMargin >= config.note.minExpectedVsOctaveMargin
    );
  });

  const expectedTop1Mask = frames.map((frame) => frame.expectedTop1);
  const expectedTop3Mask = frames.map((frame) => frame.expectedTop3);
  const octaveConfusionMask = frames.map((frame) => frame.octaveCompetitorOutranked);
  const sourceComparableMask = frames.map((frame) => frame.expectedVsSourceWon !== null);
  const expectedVsSourceWinMask = frames.map((frame) => frame.expectedVsSourceWon === true);
  const pairwiseWinRates = frames
    .map((frame) => frame.expectedPairwiseWinRate)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const positionQualified = frames.map((frame, index) => expectedQualified[index] && frame.expectedPositionMatch);
  const anyAccepted = frames.map((frame) => frame.detectorAccepted);

  const expectedQualifiedCount = countTrue(expectedQualified);
  const positionQualifiedCount = countTrue(positionQualified);
  const anyAcceptedCount = countTrue(anyAccepted);

  const expectedHitConfidenceMedian = median(frames.map((frame) => frame.detectorConfidence)) ?? 0;
  const supportSeconds = estimateQualifiedSupportSeconds(frames, expectedQualified);
  const minValidatedSupportSeconds = Math.max(0, config.note.minExpectedSupportSeconds);
  const minValidatedSupportFrames = Math.max(1, Math.round(config.note.minConsecutiveExpectedFrames));
  const minPositionFrames = Math.max(1, Math.ceil(frames.length * config.position.minPositionFrameRatio));
  const minLegacyFrames = Math.max(1, Math.ceil(frames.length * config.legacy.acceptFrameRatio));

  const legacyExpectedHit = frames.map((frame) => (
    frame.detectorAccepted &&
    frame.expectedCentsError !== null &&
    Math.abs(frame.expectedCentsError) <= config.legacy.frameToleranceCents
  ));

  const legacyExpectedCount = countTrue(legacyExpectedHit);
  const stageALegacyPass = legacyExpectedCount >= minLegacyFrames;

  const stageANotePass =
    supportSeconds >= minValidatedSupportSeconds &&
    longestConsecutiveTrue(expectedQualified) >= config.note.minConsecutiveExpectedFrames &&
    expectedHitConfidenceMedian >= config.note.minExpectedConfidence &&
    ratioTrue(expectedTop1Mask) >= config.note.minExpectedTop1FrameRatio &&
    ratioTrue(expectedTop3Mask) >= config.note.minExpectedTop3FrameRatio &&
    average(pairwiseWinRates) >= config.note.minExpectedPairwiseWinRate &&
    ratioTrue(octaveConfusionMask) <= config.note.maxOctaveConfusionFrameRatio &&
    ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask) >= config.note.minExpectedVsSourceFrameRatio;

  const stageBPositionPass =
    positionQualifiedCount >= minPositionFrames &&
    longestConsecutiveTrue(positionQualified) >= config.position.minConsecutivePositionFrames &&
    (!config.position.rejectSamePitchAltFrames || countTrue(frames.map((frame) => frame.samePitchAltDetected)) === 0);

  let decisionAccept = false;
  let decisionReason = 'rejected';

  if (config.mode === 'legacy_hit_ratio') {
    decisionAccept = stageALegacyPass;
    decisionReason = stageALegacyPass ? 'legacy_expected_hit_ratio_pass' : 'legacy_expected_hit_ratio_failed';
  } else if (config.mode === 'note_only') {
    decisionAccept = stageANotePass;
    decisionReason = stageANotePass ? 'note_stage_passed' : noteStageRejectReason({
      supportSeconds,
      minSupportSeconds: minValidatedSupportSeconds,
      consecutive: longestConsecutiveTrue(expectedQualified),
      minConsecutive: config.note.minConsecutiveExpectedFrames,
      expectedConfidence: expectedHitConfidenceMedian,
      minExpectedConfidence: config.note.minExpectedConfidence,
      expectedTop1FrameRatio: ratioTrue(expectedTop1Mask),
      minExpectedTop1FrameRatio: config.note.minExpectedTop1FrameRatio,
      expectedTop3FrameRatio: ratioTrue(expectedTop3Mask),
      minExpectedTop3FrameRatio: config.note.minExpectedTop3FrameRatio,
      expectedPairwiseWinRate: average(pairwiseWinRates),
      minExpectedPairwiseWinRate: config.note.minExpectedPairwiseWinRate,
      octaveConfusionFrameRatio: ratioTrue(octaveConfusionMask),
      maxOctaveConfusionFrameRatio: config.note.maxOctaveConfusionFrameRatio,
      expectedVsSourceFrameRatio: ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask),
      targetConfirmationFrameRatio: ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask),
      minExpectedVsSourceFrameRatio: config.note.minExpectedVsSourceFrameRatio,
      minTargetConfirmationFrameRatio: config.note.minExpectedTargetConfirmationFrameRatio ?? config.note.minExpectedVsSourceFrameRatio
    });
  } else {
    decisionAccept = stageANotePass && stageBPositionPass;
    if (!stageANotePass) {
      decisionReason = noteStageRejectReason({
        supportSeconds,
        minSupportSeconds: minValidatedSupportSeconds,
        consecutive: longestConsecutiveTrue(expectedQualified),
        minConsecutive: config.note.minConsecutiveExpectedFrames,
        expectedConfidence: expectedHitConfidenceMedian,
        minExpectedConfidence: config.note.minExpectedConfidence,
        expectedTop1FrameRatio: ratioTrue(expectedTop1Mask),
        minExpectedTop1FrameRatio: config.note.minExpectedTop1FrameRatio,
        expectedTop3FrameRatio: ratioTrue(expectedTop3Mask),
        minExpectedTop3FrameRatio: config.note.minExpectedTop3FrameRatio,
        expectedPairwiseWinRate: average(pairwiseWinRates),
        minExpectedPairwiseWinRate: config.note.minExpectedPairwiseWinRate,
        octaveConfusionFrameRatio: ratioTrue(octaveConfusionMask),
        maxOctaveConfusionFrameRatio: config.note.maxOctaveConfusionFrameRatio,
        expectedVsSourceFrameRatio: ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask),
        targetConfirmationFrameRatio: ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask),
        minExpectedVsSourceFrameRatio: config.note.minExpectedVsSourceFrameRatio,
        minTargetConfirmationFrameRatio: config.note.minExpectedTargetConfirmationFrameRatio ?? config.note.minExpectedVsSourceFrameRatio
      });
    } else if (!stageBPositionPass) {
      decisionReason = positionStageRejectReason({
        positionQualifiedCount,
        minPositionFrames,
        consecutive: longestConsecutiveTrue(positionQualified),
        minConsecutive: config.position.minConsecutivePositionFrames,
        samePitchAltDetectedFrameCount: countTrue(frames.map((frame) => frame.samePitchAltDetected)),
        rejectSamePitchAltFrames: config.position.rejectSamePitchAltFrames
      });
    } else {
      decisionReason = 'note_and_position_stages_passed';
    }
  }

  const confidenceScore = roundNumber(
    median(frames.filter((_, index) => expectedQualified[index]).map((frame) => frame.detectorConfidence)) ??
      median(frames.filter((_, index) => expectedDetectorHit[index]).map((frame) => frame.detectorConfidence)) ??
      median(frames.filter((frame) => frame.detectorAccepted).map((frame) => frame.detectorConfidence)) ??
      0,
    6
  );

  const expectedMargins = frames.map((frame) => frame.expectedScore - frame.bestCompetitorScore);
  const expectedRatios = frames.map((frame) => frame.expectedScore / Math.max(EPS, frame.bestCompetitorScore));
  const octaveMargins = frames.map((frame) => frame.expectedScore - frame.bestOctaveScore);

  const row: ValidatorRow = {
    algorithm: caseTelemetry.algorithm,
    caseId: caseTelemetry.caseId,
    sourceFileId: caseTelemetry.sourceFileId,
    sourceRelativeFilePath: caseTelemetry.sourceRelativeFilePath,
    sourceStringId: caseTelemetry.sourceStringId,
    sourceFret: caseTelemetry.sourceFret,
    sourceTake: caseTelemetry.sourceTake,
    sourceStringBand: caseTelemetry.sourceStringBand,
    sourceFretBand: fretBand(caseTelemetry.sourceFret),
    targetKind: caseTelemetry.targetKind,
    mismatchType: caseTelemetry.mismatchType,
    expectedAccept: caseTelemetry.expectedAccept,
    expectedString: caseTelemetry.expectedString,
    expectedFret: caseTelemetry.expectedFret,
    expectedMidi: caseTelemetry.expectedMidi,
    noteDecisionConfigId: config.id,
    expectedTargetScore: roundNumber(median(frames.map((frame) => frame.expectedScore)) ?? 0, 6),
    nearbyCompetitorScore: roundNumber(median(frames.map((frame) => frame.neighborScore)) ?? 0, 6),
    rawDetectionMaxConfidence: roundNullable(frames.length > 0 ? Math.max(...frames.map((frame) => frame.detectorConfidence)) : null, 6),
    rawDetectionFrameRatio: roundNullable(frames.length > 0 ? anyAcceptedCount / frames.length : null, 6),
    supportFrames: expectedQualifiedCount,
    supportSeconds: roundNumber(supportSeconds, 6),
    minValidatedSupportFrames,
    minValidatedSupportSeconds: roundNumber(minValidatedSupportSeconds, 6),
    positionSupportFrames: positionQualifiedCount,
    positionMinValidatedSupportFrames: minPositionFrames,
    legacySupportFrames: legacyExpectedCount,
    legacyMinValidatedSupportFrames: minLegacyFrames,
    minConsecutiveExpectedFrames: longestConsecutiveTrue(expectedQualified),
    minConsecutivePositionFrames: longestConsecutiveTrue(positionQualified),
    pairwiseCompetitorOutcomes: aggregatePairwiseCompetitorOutcomes(frames),
    acceptedNote: decisionAccept,
    topKPresence: {
      top1: ratioTrue(expectedTop1Mask) > 0,
      top3: ratioTrue(expectedTop3Mask) > 0,
      top1FrameRatio: roundNumber(ratioTrue(expectedTop1Mask), 6),
      top3FrameRatio: roundNumber(ratioTrue(expectedTop3Mask), 6)
    },
    evidenceAvailability: uniqueSortedStrings(frames.flatMap((frame) => frame.sharedEvidenceAvailability)),
    evidenceLimitations: uniqueSortedStrings(frames.flatMap((frame) => frame.sharedEvidenceLimitations)),
    expectedVsBestMargin: roundNumber(median(expectedMargins) ?? 0, 6),
    expectedVsBestRatio: roundNumber(median(expectedRatios) ?? 0, 6),
    expectedVsOctaveMargin: roundNumber(median(octaveMargins) ?? 0, 6),
    expectedPairwiseWinRate: pairwiseWinRates.length > 0 ? roundNumber(average(pairwiseWinRates), 6) : null,
    expectedTop1FrameRatio: roundNumber(ratioTrue(expectedTop1Mask), 6),
    expectedTop3FrameRatio: roundNumber(ratioTrue(expectedTop3Mask), 6),
    expectedPairwiseWinRateMean: pairwiseWinRates.length > 0 ? roundNumber(average(pairwiseWinRates), 6) : null,
    octaveConfusionFrameRatio: roundNumber(ratioTrue(octaveConfusionMask), 6),
    expectedVsSourceFrameRatio: roundNumber(ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask), 6),
    targetConfirmationFrameRatio: roundNumber(ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask), 6),
    positionAmbiguousFrameRatio: roundNumber(ratioTrue(frames.map((frame) => frame.positionAmbiguous)), 6),
    samePitchAltDetectedFrameCount: countTrue(frames.map((frame) => frame.samePitchAltDetected)),
    samePitchAltCandidateExists: caseTelemetry.samePitchAltCandidateExists,
    confidenceScore,
    decisionMode: config.mode,
    decisionAccept,
    decisionReason,
    hitFrameCount: config.mode === 'legacy_hit_ratio' ? legacyExpectedCount : expectedQualifiedCount,
    wrongAcceptFrameCount: frames.filter((frame) => frame.detectorAccepted && (frame.expectedCentsError === null || Math.abs(frame.expectedCentsError) > config.legacy.frameToleranceCents)).length,
    totalFrameCount: frames.length,
    decisionLatencyMs: roundNullable(firstTimestampWhere(config.mode === 'legacy_hit_ratio' ? legacyExpectedHit : expectedQualified, frames), 3),
    runtimeAvgMs: roundNumber(average(frames.map((frame) => frame.runtimeMs)), 6),
    runtimeP95Ms: roundNullable(percentile(frames.map((frame) => frame.runtimeMs), 0.95), 6) ?? 0,
    hitFrameCountExpected: expectedQualifiedCount,
    hitFrameCountAny: anyAcceptedCount,
    hitFrameCountPosition: positionQualifiedCount,
    firstExpectedHitLatencyMs: roundNullable(firstTimestampWhere(expectedQualified, frames), 3),
    firstAnyHitLatencyMs: roundNullable(firstTimestampWhere(anyAccepted, frames), 3),
    expectedSupportSeconds: roundNumber(supportSeconds, 6),
    positionFrameRatio: roundNumber(frames.length > 0 ? positionQualifiedCount / frames.length : 0, 6),
    expectedCentsErrorMedian: roundNullable(median(frames.map((frame) => frame.expectedCentsError).filter((value): value is number => value !== null)), 6),
    expectedScoreMedian: roundNumber(median(frames.map((frame) => frame.expectedScore)) ?? 0, 6),
    bestCompetitorScoreMedian: roundNumber(median(frames.map((frame) => frame.bestCompetitorScore)) ?? 0, 6),
    bestCompetitorMidiMode: modeNumber(frames.map((frame) => frame.bestCompetitorMidi)),
    bestOctaveCompetitorScoreMedian: roundNumber(median(frames.map((frame) => frame.bestOctaveScore)) ?? 0, 6),
    expectedVsBestMarginMedian: roundNumber(median(expectedMargins) ?? 0, 6),
    expectedVsBestRatioMedian: roundNumber(median(expectedRatios) ?? 0, 6),
    expectedVsOctaveMarginMedian: roundNumber(median(octaveMargins) ?? 0, 6),
    expectedRankMedian: roundNullable(median(frames.map((frame) => frame.expectedRank).filter((value): value is number => value !== null)), 6),
    thresholdsApplied: {
      note: config.note,
      position: config.position,
      legacy: config.legacy
    }
  };

  return row;
}

export function buildNoteEvidenceFromCaseTelemetry(
  caseTelemetry: ValidatorCaseTelemetry,
  config: ValidatorDecisionConfig
): ValidatorNoteEvidence {
  const row = evaluateCaseTelemetry(caseTelemetry, config);
  const {
    decisionMode,
    decisionAccept,
    decisionReason,
    hitFrameCount,
    wrongAcceptFrameCount,
    totalFrameCount,
    decisionLatencyMs,
    runtimeAvgMs,
    runtimeP95Ms,
    hitFrameCountExpected,
    hitFrameCountAny,
    hitFrameCountPosition,
    firstExpectedHitLatencyMs,
    firstAnyHitLatencyMs,
    thresholdsApplied,
    ...evidence
  } = row;
  return {
    ...evidence,
    acceptedNote: null
  };
}

export function evaluateNoteEvidence(
  evidence: ValidatorNoteEvidence,
  config: ValidatorDecisionConfig
): { decisionAccept: boolean; decisionReason: string; acceptedNote: boolean } {
  const runtimeEvidence: RuntimeValidatorNoteEvidence = {
    noteMidi: evidence.expectedMidi,
    noteDecisionConfigId: evidence.noteDecisionConfigId,
    targetSemitoneTolerance: 0,
    expectedTargetScore: evidence.expectedTargetScore,
    nearbyCompetitorScore: evidence.nearbyCompetitorScore,
    rawDetectionMaxConfidence: evidence.rawDetectionMaxConfidence,
    rawDetectionFrameRatio: evidence.rawDetectionFrameRatio,
    matchedMidi: null,
    matchedSemitoneDistance: null,
    supportFrames: evidence.supportFrames,
    supportSeconds: evidence.supportSeconds,
    minValidatedSupportFrames: evidence.minValidatedSupportFrames,
    minValidatedSupportSeconds: evidence.minValidatedSupportSeconds,
    positionSupportFrames: evidence.positionSupportFrames,
    positionMinValidatedSupportFrames: evidence.positionMinValidatedSupportFrames,
    legacySupportFrames: evidence.legacySupportFrames,
    legacyMinValidatedSupportFrames: evidence.legacyMinValidatedSupportFrames,
    minConsecutiveExpectedFrames: evidence.minConsecutiveExpectedFrames,
    minConsecutivePositionFrames: evidence.minConsecutivePositionFrames,
    pairwiseCompetitorOutcomes: evidence.pairwiseCompetitorOutcomes,
    acceptedNote: evidence.acceptedNote,
    topKPresence: evidence.topKPresence,
    evidenceAvailability: evidence.evidenceAvailability,
    evidenceLimitations: evidence.evidenceLimitations,
    expectedVsBestMargin: evidence.expectedVsBestMargin,
    expectedVsBestRatio: evidence.expectedVsBestRatio,
    expectedVsOctaveMargin: evidence.expectedVsOctaveMargin,
    expectedPairwiseWinRate: evidence.expectedPairwiseWinRate,
    expectedTop1FrameRatio: evidence.expectedTop1FrameRatio,
    expectedTop3FrameRatio: evidence.expectedTop3FrameRatio,
    octaveConfusionFrameRatio: evidence.octaveConfusionFrameRatio,
    expectedVsSourceFrameRatio: evidence.expectedVsSourceFrameRatio,
    targetConfirmationFrameRatio: evidence.targetConfirmationFrameRatio,
    positionAmbiguousFrameRatio: evidence.positionAmbiguousFrameRatio,
    samePitchAltDetectedFrameCount: evidence.samePitchAltDetectedFrameCount,
    samePitchAltCandidateExists: evidence.samePitchAltCandidateExists,
    confidenceScore: evidence.confidenceScore,
    expectedSupportSeconds: evidence.expectedSupportSeconds,
    positionFrameRatio: evidence.positionFrameRatio,
    expectedCentsErrorMedian: evidence.expectedCentsErrorMedian,
    expectedScoreMedian: evidence.expectedScoreMedian,
    bestCompetitorScoreMedian: evidence.bestCompetitorScoreMedian,
    bestCompetitorMidiMode: evidence.bestCompetitorMidiMode,
    bestOctaveCompetitorScoreMedian: evidence.bestOctaveCompetitorScoreMedian,
    expectedVsBestMarginMedian: evidence.expectedVsBestMarginMedian,
    expectedVsBestRatioMedian: evidence.expectedVsBestRatioMedian,
    expectedVsOctaveMarginMedian: evidence.expectedVsOctaveMarginMedian,
    expectedRankMedian: evidence.expectedRankMedian,
    expectedPairwiseWinRateMean: evidence.expectedPairwiseWinRateMean
  };

  const decision = evaluateRuntimeNoteEvidence(runtimeEvidence, config);
  return decision;
}

function aggregatePairwiseCompetitorOutcomes(frames: FrameTelemetry[]): ValidatorPairwiseCompetitorOutcome[] | null {
  const pairwiseEntries = frames.flatMap((frame) => frame.spectralProbe?.pairwise ?? []);
  if (pairwiseEntries.length <= 0) return null;

  const byClass = new Map<SpectralProbeCompetitorClass, SpectralProbePairwiseTelemetry[]>();
  for (const pairwise of pairwiseEntries) {
    const bucket = byClass.get(pairwise.competitorClass) ?? [];
    bucket.push(pairwise);
    byClass.set(pairwise.competitorClass, bucket);
  }

  return [...byClass.entries()].map(([competitorClass, values]) => {
    const comparisons = values.length;
    return {
      competitorClass,
      comparisonCount: comparisons,
      expectedWinRate: comparisons > 0
        ? values.filter((value) => value.expectedWon === true).length / comparisons
        : null,
      expectedScoreMean: roundNullable(average(values.map((value) => value.expectedScore).filter((value): value is number => value !== null)), 6),
      competitorScoreMean: roundNullable(average(values.map((value) => value.competitorScore).filter((value): value is number => value !== null)), 6),
      detectedPositionAmbiguousFrameRatio: roundNullable(average(values.map((value) => (value.positionAmbiguous ? 1 : 0))), 6)
    };
  }).sort((left, right) => left.competitorClass.localeCompare(right.competitorClass));
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}

export function aggregateValidatorRows(rows: ValidatorRow[]): ValidatorAggregate {
  const positives = rows.filter((row) => row.expectedAccept);
  const negatives = rows.filter((row) => !row.expectedAccept);

  const trueAccept = positives.filter((row) => row.decisionAccept).length;
  const falseReject = positives.length - trueAccept;
  const falseAccept = negatives.filter((row) => row.decisionAccept).length;
  const trueReject = negatives.length - falseAccept;
  const noteMismatchNegatives = negatives.filter((row) => row.mismatchType !== 'same_pitch_alt_string');
  const noteMismatchFalseAccept = noteMismatchNegatives.filter((row) => row.decisionAccept).length;
  const positionOnlyNegatives = negatives.filter((row) => row.mismatchType === 'same_pitch_alt_string');
  const positionOnlyFalseAccept = positionOnlyNegatives.filter((row) => row.decisionAccept).length;

  const precision = trueAccept + falseAccept > 0 ? trueAccept / (trueAccept + falseAccept) : 0;
  const recall = positives.length > 0 ? trueAccept / positives.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const mismatchFarByType = Object.fromEntries(
    [...new Set(negatives.map((row) => row.mismatchType))].map((mismatchType) => {
      const bucket = negatives.filter((row) => row.mismatchType === mismatchType);
      const far = bucket.length > 0 ? bucket.filter((row) => row.decisionAccept).length / bucket.length : 0;
      return [mismatchType, roundNumber(far, 6)];
    })
  );

  const byStringBand = {
    low: buildBandTarFar(rows, 'sourceStringBand', 'low'),
    mid: buildBandTarFar(rows, 'sourceStringBand', 'mid'),
    high: buildBandTarFar(rows, 'sourceStringBand', 'high')
  } satisfies Record<StringBand, BandTarFar>;

  const byFretBand = {
    low: buildBandTarFar(rows, 'sourceFretBand', 'low'),
    mid: buildBandTarFar(rows, 'sourceFretBand', 'mid'),
    high: buildBandTarFar(rows, 'sourceFretBand', 'high')
  } satisfies Record<FretBand, BandTarFar>;

  return {
    algorithm: rows[0]?.algorithm ?? 'MASP',
    cases: rows.length,
    positives: positives.length,
    negatives: negatives.length,
    trueAccept,
    falseReject,
    falseAccept,
    trueReject,
    tar: positives.length > 0 ? trueAccept / positives.length : 0,
    far: negatives.length > 0 ? falseAccept / negatives.length : 0,
    strictFar: negatives.length > 0 ? falseAccept / negatives.length : 0,
    noteMismatchFar: noteMismatchNegatives.length > 0 ? noteMismatchFalseAccept / noteMismatchNegatives.length : 0,
    positionOnlyFar: positionOnlyNegatives.length > 0 ? positionOnlyFalseAccept / positionOnlyNegatives.length : 0,
    precision,
    recall,
    f1,
    medianDecisionLatencyMs: roundNullable(median(positives.map((row) => row.decisionLatencyMs).filter((value): value is number => value !== null)), 3),
    runtimeAvgMs: roundNumber(average(rows.map((row) => row.runtimeAvgMs)), 6),
    runtimeP95Ms: roundNullable(percentile(rows.map((row) => row.runtimeP95Ms), 0.95), 6) ?? 0,
    lowStringTar: byStringBand.low.tar,
    lowStringFar: byStringBand.low.far,
    mismatchFarByType,
    tarFarByStringBand: byStringBand,
    tarFarByFretBand: byFretBand
  };
}

export function evaluateRowsForConfig(
  caseTelemetry: ValidatorCaseTelemetry[],
  config: ValidatorDecisionConfig,
  algorithms: AlgorithmName[]
): { rows: ValidatorRow[]; aggregates: Record<AlgorithmName, ValidatorAggregate> } {
  const rows = caseTelemetry.map((item) => evaluateCaseTelemetry(item, config));
  const aggregates = Object.fromEntries(
    algorithms.map((algorithm) => [algorithm, aggregateValidatorRows(rows.filter((row) => row.algorithm === algorithm))])
  ) as Record<AlgorithmName, ValidatorAggregate>;
  return { rows, aggregates };
}

export function noteMismatchFar(aggregate: ValidatorAggregate): number {
  return aggregate.noteMismatchFar;
}

export function passesTar100Constraint(aggregates: Record<AlgorithmName, ValidatorAggregate>): boolean {
  return ALGORITHMS.every((algorithm) => aggregates[algorithm].tar >= 1);
}

export function passesTar100ConstraintForAlgorithm(
  aggregates: Record<AlgorithmName, ValidatorAggregate>,
  algorithm: AlgorithmName
): boolean {
  return aggregates[algorithm].tar >= 1;
}

function buildBandTarFar(
  rows: ValidatorRow[],
  key: 'sourceStringBand' | 'sourceFretBand',
  value: StringBand | FretBand
): BandTarFar {
  const bandRows = rows.filter((row) => row[key] === value);
  const positives = bandRows.filter((row) => row.expectedAccept);
  const negatives = bandRows.filter((row) => !row.expectedAccept);
  const tar = positives.length > 0 ? positives.filter((row) => row.decisionAccept).length / positives.length : 0;
  const far = negatives.length > 0 ? negatives.filter((row) => row.decisionAccept).length / negatives.length : 0;
  return {
    positives: positives.length,
    negatives: negatives.length,
    tar: roundNumber(tar, 6),
    far: roundNumber(far, 6)
  };
}

function noteStageRejectReason(input: {
  supportSeconds: number;
  minSupportSeconds: number;
  consecutive: number;
  minConsecutive: number;
  expectedConfidence: number;
  minExpectedConfidence: number;
  expectedTop1FrameRatio: number;
  minExpectedTop1FrameRatio: number;
  expectedTop3FrameRatio: number;
  minExpectedTop3FrameRatio: number;
  expectedPairwiseWinRate: number;
  minExpectedPairwiseWinRate: number;
  octaveConfusionFrameRatio: number;
  maxOctaveConfusionFrameRatio: number;
  expectedVsSourceFrameRatio: number;
  minExpectedVsSourceFrameRatio: number;
  targetConfirmationFrameRatio: number;
  minTargetConfirmationFrameRatio: number;
}): string {
  if (input.supportSeconds < input.minSupportSeconds) {
    return 'stage_a_expected_support_seconds_failed';
  }
  if (input.consecutive < input.minConsecutive) {
    return 'stage_a_expected_consecutive_failed';
  }
  if (input.expectedConfidence < input.minExpectedConfidence) {
    return 'stage_a_expected_confidence_failed';
  }
  if (input.expectedTop1FrameRatio < input.minExpectedTop1FrameRatio) {
    return 'stage_a_expected_top1_ratio_failed';
  }
  if (input.expectedTop3FrameRatio < input.minExpectedTop3FrameRatio) {
    return 'stage_a_expected_top3_ratio_failed';
  }
  if (input.expectedPairwiseWinRate < input.minExpectedPairwiseWinRate) {
    return 'stage_a_expected_pairwise_win_rate_failed';
  }
  if (input.octaveConfusionFrameRatio > input.maxOctaveConfusionFrameRatio) {
    return 'stage_a_octave_confusion_ratio_failed';
  }
  if (input.targetConfirmationFrameRatio < input.minTargetConfirmationFrameRatio) {
    return 'stage_a_target_confirmation_ratio_failed';
  }
  return 'stage_a_expected_evidence_failed';
}

function positionStageRejectReason(input: {
  positionQualifiedCount: number;
  minPositionFrames: number;
  consecutive: number;
  minConsecutive: number;
  samePitchAltDetectedFrameCount: number;
  rejectSamePitchAltFrames: boolean;
}): string {
  if (input.positionQualifiedCount < input.minPositionFrames) {
    return 'stage_b_position_frame_ratio_failed';
  }
  if (input.consecutive < input.minConsecutive) {
    return 'stage_b_position_consecutive_failed';
  }
  if (input.rejectSamePitchAltFrames && input.samePitchAltDetectedFrameCount > 0) {
    return 'stage_b_same_pitch_alt_detected';
  }
  return 'stage_b_position_evidence_failed';
}

function safeParseConfigJson(raw: string, fallback: ValidatorDecisionConfig): ValidatorDecisionConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<ValidatorDecisionConfig>;
    return {
      ...fallback,
      ...parsed,
      note: {
        ...fallback.note,
        ...(parsed.note ?? {})
      },
      position: {
        ...fallback.position,
        ...(parsed.position ?? {})
      },
      legacy: {
        ...fallback.legacy,
        ...(parsed.legacy ?? {})
      }
    };
  } catch {
    return fallback;
  }
}

function firstTimestampWhere(mask: boolean[], frames: FrameTelemetry[]): number | null {
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      return frames[index]?.timestampMs ?? null;
    }
  }
  return null;
}

function longestConsecutiveTrue(values: boolean[]): number {
  let best = 0;
  let run = 0;
  for (const value of values) {
    if (value) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

function countTrue(values: boolean[]): number {
  let out = 0;
  for (const value of values) {
    if (value) out += 1;
  }
  return out;
}

function ratioTrue(values: boolean[]): number {
  if (values.length <= 0) return 1;
  return countTrue(values) / values.length;
}

function ratioTrueByMask(values: boolean[], mask: boolean[]): number {
  let hit = 0;
  let total = 0;
  const length = Math.min(values.length, mask.length);
  for (let index = 0; index < length; index += 1) {
    if (!mask[index]) continue;
    total += 1;
    if (values[index]) hit += 1;
  }
  if (total <= 0) return 1;
  return hit / total;
}

function modeNumber(values: Array<number | null>): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let bestValue: number | null = null;
  let bestCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

function percentile(values: number[], q: number): number | null {
  if (values.length <= 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clampedQ = Math.min(1, Math.max(0, q));
  const position = clampedQ * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return percentile(finite, 0.5);
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundNumber(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundNullable(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return roundNumber(value, digits);
}

function fretBand(fret: number): FretBand {
  if (fret <= 4) return 'low';
  if (fret <= 8) return 'mid';
  return 'high';
}
