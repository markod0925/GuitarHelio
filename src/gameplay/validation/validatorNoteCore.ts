import type {
  ActivationGatePolicy,
  ActivationGateRejectReason,
  RuntimeNoteSetPolicy,
  RuntimeNoteDecision,
  RuntimeValidatorOutput,
  ValidationTarget,
  ValidatorDecisionConfig,
  ValidatorFrameCandidateEvidence,
  ValidatorNoteEvidence,
  ValidatorPairwiseCompetitorOutcome
} from './validatorTypes';
import {
  normalizeActivationGatePolicy,
  normalizeNoteDecisionConfig,
  normalizeRuntimeNoteSetPolicy
} from './validatorPolicies';

const EPS = 1e-9;

export function buildValidatorNoteEvidence(
  noteMidi: number,
  frames: ValidatorFrameCandidateEvidence[],
  config: ValidatorDecisionConfig,
  targetStartedAtMs: number | null,
  targetSemitoneTolerance: number
): ValidatorNoteEvidence {
  const normalizedConfig = normalizeNoteDecisionConfig(config);
  const pitchToleranceCents = Math.max(0, Math.abs(targetSemitoneTolerance) * 100);
  const attackCutoffMs = targetStartedAtMs === null ? normalizedConfig.note.ignoreAttackMs : targetStartedAtMs + normalizedConfig.note.ignoreAttackMs;
  const eligibleFrames = frames.filter((frame) => frame.timestampMs >= attackCutoffMs);
  const usableFrames = eligibleFrames.length > 0 ? eligibleFrames : frames;

  const expectedDetectorHit = usableFrames.map((frame) => (
    frame.detectorAccepted &&
    frame.matchedMidi !== null &&
    frame.expectedCentsError !== null &&
    Math.abs(frame.expectedCentsError) <= pitchToleranceCents
  ));

  const expectedQualified = usableFrames.map((frame, index) => {
    if (!expectedDetectorHit[index]) return false;
    const margin = frame.expectedScore - frame.bestCompetitorScore;
    const octaveMargin = frame.expectedScore - frame.bestOctaveScore;
    const ratio = frame.expectedScore / Math.max(EPS, frame.bestCompetitorScore);
    return (
      frame.expectedScore >= normalizedConfig.note.minExpectedScore &&
      margin >= normalizedConfig.note.minExpectedVsBestMargin &&
      ratio >= normalizedConfig.note.minExpectedVsBestRatio &&
      octaveMargin >= normalizedConfig.note.minExpectedVsOctaveMargin
    );
  });

  const expectedTop1Mask = usableFrames.map((frame) => frame.expectedTop1);
  const expectedTop3Mask = usableFrames.map((frame) => frame.expectedTop3);
  const octaveConfusionMask = usableFrames.map((frame) => frame.octaveCompetitorOutranked);
  const sourceComparableMask = usableFrames.map((frame) => frame.expectedVsSourceWon !== null);
  const expectedVsSourceWinMask = usableFrames.map((frame) => frame.expectedVsSourceWon === true);
  const pairwiseWinRates = usableFrames
    .map((frame) => frame.expectedPairwiseWinRate)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const positionQualified = usableFrames.map((frame, index) => expectedQualified[index] && frame.expectedPositionMatch);
  const anyAccepted = usableFrames.map((frame) => frame.detectorAccepted);
  const supportSeconds = estimateQualifiedSupportSeconds(usableFrames, expectedQualified);
  const minValidatedSupportSeconds = Math.max(0, normalizedConfig.note.minExpectedSupportSeconds);

  const expectedQualifiedCount = countTrue(expectedQualified);
  const positionQualifiedCount = countTrue(positionQualified);
  const anyAcceptedCount = countTrue(anyAccepted);

  const minValidatedSupportFrames = Math.max(1, Math.round(normalizedConfig.note.minConsecutiveExpectedFrames));
  const minPositionFrames = Math.max(1, Math.ceil(usableFrames.length * normalizedConfig.position.minPositionFrameRatio));
  const minLegacyFrames = Math.max(1, Math.ceil(usableFrames.length * normalizedConfig.legacy.acceptFrameRatio));

  const legacyExpectedHit = usableFrames.map((frame) => (
    frame.detectorAccepted &&
    frame.matchedMidi !== null &&
    frame.expectedCentsError !== null &&
    Math.abs(frame.expectedCentsError) <= pitchToleranceCents
  ));

  const legacyExpectedCount = countTrue(legacyExpectedHit);
  const confidenceScore = roundNumber(
    median(usableFrames.filter((_, index) => expectedQualified[index]).map((frame) => frame.detectorConfidence)) ??
    median(usableFrames.filter((_, index) => expectedDetectorHit[index]).map((frame) => frame.detectorConfidence)) ??
    median(usableFrames.filter((frame) => frame.detectorAccepted).map((frame) => frame.detectorConfidence)) ??
    0,
    6
  );

  const expectedMargins = usableFrames.map((frame) => frame.expectedScore - frame.bestCompetitorScore);
  const expectedRatios = usableFrames.map((frame) => frame.expectedScore / Math.max(EPS, frame.bestCompetitorScore));
  const octaveMargins = usableFrames.map((frame) => frame.expectedScore - frame.bestOctaveScore);

  return {
    noteMidi,
    noteDecisionConfigId: normalizedConfig.id,
    targetSemitoneTolerance: roundNumber(targetSemitoneTolerance, 6),
    expectedTargetScore: roundNumber(median(usableFrames.map((frame) => frame.expectedScore)) ?? 0, 6),
    nearbyCompetitorScore: roundNumber(median(usableFrames.map((frame) => frame.neighborScore)) ?? 0, 6),
    rawDetectionMaxConfidence: roundNullable(usableFrames.length > 0 ? Math.max(...usableFrames.map((frame) => frame.detectorConfidence)) : null, 6),
    rawDetectionFrameRatio: roundNullable(usableFrames.length > 0 ? anyAcceptedCount / usableFrames.length : null, 6),
    matchedMidi: modeNumber(usableFrames.map((frame) => frame.matchedMidi)),
    matchedSemitoneDistance: roundNullable(median(usableFrames.map((frame) => frame.matchedSemitoneDistance).filter((value): value is number => value !== null)), 6),
    supportFrames: expectedQualifiedCount,
    supportSeconds: roundNumber(supportSeconds, 6),
    minValidatedSupportFrames: minValidatedSupportFrames,
    minValidatedSupportSeconds: roundNumber(minValidatedSupportSeconds, 6),
    positionSupportFrames: positionQualifiedCount,
    positionMinValidatedSupportFrames: minPositionFrames,
    legacySupportFrames: legacyExpectedCount,
    legacyMinValidatedSupportFrames: minLegacyFrames,
    minConsecutiveExpectedFrames: longestConsecutiveTrue(expectedQualified),
    minConsecutivePositionFrames: longestConsecutiveTrue(positionQualified),
    pairwiseCompetitorOutcomes: aggregatePairwiseCompetitorOutcomes(usableFrames),
    acceptedNote: null,
    topKPresence: {
      top1: ratioTrue(expectedTop1Mask) > 0,
      top3: ratioTrue(expectedTop3Mask) > 0,
      top1FrameRatio: roundNumber(ratioTrue(expectedTop1Mask), 6),
      top3FrameRatio: roundNumber(ratioTrue(expectedTop3Mask), 6)
    },
    evidenceAvailability: uniqueSortedStrings(usableFrames.flatMap((frame) => frame.sharedEvidenceAvailability)),
    evidenceLimitations: uniqueSortedStrings(usableFrames.flatMap((frame) => frame.sharedEvidenceLimitations)),
    expectedVsBestMargin: roundNumber(median(expectedMargins) ?? 0, 6),
    expectedVsBestRatio: roundNumber(median(expectedRatios) ?? 0, 6),
    expectedVsOctaveMargin: roundNumber(median(octaveMargins) ?? 0, 6),
    expectedPairwiseWinRate: pairwiseWinRates.length > 0 ? roundNumber(average(pairwiseWinRates), 6) : null,
    expectedTop1FrameRatio: roundNumber(ratioTrue(expectedTop1Mask), 6),
    expectedTop3FrameRatio: roundNumber(ratioTrue(expectedTop3Mask), 6),
    octaveConfusionFrameRatio: roundNumber(ratioTrue(octaveConfusionMask), 6),
    expectedVsSourceFrameRatio: roundNumber(ratioTrueByMask(expectedVsSourceWinMask, sourceComparableMask), 6),
    positionAmbiguousFrameRatio: roundNumber(ratioTrue(usableFrames.map((frame) => frame.positionAmbiguous)), 6),
    samePitchAltDetectedFrameCount: countTrue(usableFrames.map((frame) => frame.samePitchAltDetected)),
    samePitchAltCandidateExists: usableFrames.some((frame) => frame.samePitchAltScore !== null),
    confidenceScore,
    expectedSupportSeconds: roundNumber(supportSeconds, 6),
    positionFrameRatio: roundNumber(usableFrames.length > 0 ? positionQualifiedCount / usableFrames.length : 0, 6),
    expectedCentsErrorMedian: roundNullable(median(usableFrames.map((frame) => frame.expectedCentsError).filter((value): value is number => value !== null)), 6),
    expectedScoreMedian: roundNumber(median(usableFrames.map((frame) => frame.expectedScore)) ?? 0, 6),
    bestCompetitorScoreMedian: roundNumber(median(usableFrames.map((frame) => frame.bestCompetitorScore)) ?? 0, 6),
    bestCompetitorMidiMode: modeNumber(usableFrames.map((frame) => frame.bestCompetitorMidi)),
    bestOctaveCompetitorScoreMedian: roundNumber(median(usableFrames.map((frame) => frame.bestOctaveScore)) ?? 0, 6),
    expectedVsBestMarginMedian: roundNumber(median(expectedMargins) ?? 0, 6),
    expectedVsBestRatioMedian: roundNumber(median(expectedRatios) ?? 0, 6),
    expectedVsOctaveMarginMedian: roundNumber(median(octaveMargins) ?? 0, 6),
    expectedRankMedian: roundNullable(median(usableFrames.map((frame) => frame.expectedRank).filter((value): value is number => value !== null)), 6),
    expectedPairwiseWinRateMean: pairwiseWinRates.length > 0 ? roundNumber(average(pairwiseWinRates), 6) : null
  };
}

export function evaluateNoteEvidence(
  evidence: ValidatorNoteEvidence,
  config: ValidatorDecisionConfig
): { decisionAccept: boolean; decisionReason: string; acceptedNote: boolean } {
  const normalizedConfig = normalizeNoteDecisionConfig(config);
  const stageANotePass =
    evidence.supportSeconds >= evidence.minValidatedSupportSeconds &&
    evidence.minConsecutiveExpectedFrames >= normalizedConfig.note.minConsecutiveExpectedFrames &&
    evidence.confidenceScore >= normalizedConfig.note.minExpectedConfidence &&
    evidence.topKPresence.top1FrameRatio >= normalizedConfig.note.minExpectedTop1FrameRatio &&
    evidence.topKPresence.top3FrameRatio >= normalizedConfig.note.minExpectedTop3FrameRatio &&
    (evidence.expectedPairwiseWinRate ?? 0) >= normalizedConfig.note.minExpectedPairwiseWinRate &&
    evidence.octaveConfusionFrameRatio <= normalizedConfig.note.maxOctaveConfusionFrameRatio &&
    evidence.expectedVsSourceFrameRatio >= normalizedConfig.note.minExpectedVsSourceFrameRatio;

  const stageBPositionPass =
    evidence.positionSupportFrames >= evidence.positionMinValidatedSupportFrames &&
    evidence.minConsecutivePositionFrames >= normalizedConfig.position.minConsecutivePositionFrames &&
    (!normalizedConfig.position.rejectSamePitchAltFrames || evidence.samePitchAltDetectedFrameCount === 0);

  let decisionAccept = false;
  let decisionReason = 'rejected';

  if (normalizedConfig.mode === 'legacy_hit_ratio') {
    decisionAccept = evidence.legacySupportFrames >= evidence.legacyMinValidatedSupportFrames;
    decisionReason = decisionAccept ? 'legacy_expected_hit_ratio_pass' : 'legacy_expected_hit_ratio_failed';
  } else if (normalizedConfig.mode === 'note_only') {
    decisionAccept = stageANotePass;
    decisionReason = stageANotePass ? 'note_stage_passed' : noteStageRejectReason({
      supportSeconds: evidence.supportSeconds,
      minSupportSeconds: evidence.minValidatedSupportSeconds,
      consecutive: evidence.minConsecutiveExpectedFrames,
      minConsecutive: normalizedConfig.note.minConsecutiveExpectedFrames,
      expectedConfidence: evidence.confidenceScore,
      minExpectedConfidence: normalizedConfig.note.minExpectedConfidence,
      expectedTop1FrameRatio: evidence.topKPresence.top1FrameRatio,
      minExpectedTop1FrameRatio: normalizedConfig.note.minExpectedTop1FrameRatio,
      expectedTop3FrameRatio: evidence.topKPresence.top3FrameRatio,
      minExpectedTop3FrameRatio: normalizedConfig.note.minExpectedTop3FrameRatio,
      expectedPairwiseWinRate: evidence.expectedPairwiseWinRate ?? 0,
      minExpectedPairwiseWinRate: normalizedConfig.note.minExpectedPairwiseWinRate,
      octaveConfusionFrameRatio: evidence.octaveConfusionFrameRatio,
      maxOctaveConfusionFrameRatio: normalizedConfig.note.maxOctaveConfusionFrameRatio,
      expectedVsSourceFrameRatio: evidence.expectedVsSourceFrameRatio,
      minExpectedVsSourceFrameRatio: normalizedConfig.note.minExpectedVsSourceFrameRatio
    });
  } else {
    decisionAccept = stageANotePass && stageBPositionPass;
    if (!stageANotePass) {
      decisionReason = noteStageRejectReason({
        supportSeconds: evidence.supportSeconds,
        minSupportSeconds: evidence.minValidatedSupportSeconds,
        consecutive: evidence.minConsecutiveExpectedFrames,
        minConsecutive: normalizedConfig.note.minConsecutiveExpectedFrames,
        expectedConfidence: evidence.confidenceScore,
        minExpectedConfidence: normalizedConfig.note.minExpectedConfidence,
        expectedTop1FrameRatio: evidence.topKPresence.top1FrameRatio,
        minExpectedTop1FrameRatio: normalizedConfig.note.minExpectedTop1FrameRatio,
        expectedTop3FrameRatio: evidence.topKPresence.top3FrameRatio,
        minExpectedTop3FrameRatio: normalizedConfig.note.minExpectedTop3FrameRatio,
        expectedPairwiseWinRate: evidence.expectedPairwiseWinRate ?? 0,
        minExpectedPairwiseWinRate: normalizedConfig.note.minExpectedPairwiseWinRate,
        octaveConfusionFrameRatio: evidence.octaveConfusionFrameRatio,
        maxOctaveConfusionFrameRatio: normalizedConfig.note.maxOctaveConfusionFrameRatio,
        expectedVsSourceFrameRatio: evidence.expectedVsSourceFrameRatio,
        minExpectedVsSourceFrameRatio: normalizedConfig.note.minExpectedVsSourceFrameRatio
      });
    } else if (!stageBPositionPass) {
      decisionReason = positionStageRejectReason({
        positionQualifiedCount: evidence.positionSupportFrames,
        minPositionFrames: evidence.positionMinValidatedSupportFrames,
        consecutive: evidence.minConsecutivePositionFrames,
        minConsecutive: normalizedConfig.position.minConsecutivePositionFrames,
        samePitchAltDetectedFrameCount: evidence.samePitchAltDetectedFrameCount,
        rejectSamePitchAltFrames: normalizedConfig.position.rejectSamePitchAltFrames
      });
    } else {
      decisionReason = 'note_and_position_stages_passed';
    }
  }

  return {
    decisionAccept,
    decisionReason,
    acceptedNote: decisionAccept
  };
}

export function evaluateRuntimeTargetDecision(input: {
  target: ValidationTarget;
  noteDecisions: RuntimeNoteDecision[];
  rawDetectedMidis: number[];
  rawDetectionMaxConfidence?: number | null;
  rawDetectionFrameRatio?: number | null;
  noteSetPolicy: RuntimeNoteSetPolicy;
  activationGatePolicy?: ActivationGatePolicy;
  windowCategory?: 'empty_window' | 'single_note_window' | 'poly_window' | 'transition_window';
  isStableWindow?: boolean;
  setRelation?: 'empty_match' | 'empty_false_activation' | 'exact' | 'superset' | 'subset' | 'partial_overlap' | 'disjoint';
  stableSetRatio?: number;
  transitionOverlapRatio?: number;
}): RuntimeValidatorOutput {
  const expectedMidis = uniqueSortedNumbers(input.target.midiNotes);
  const semitoneTolerance = normalizeSemitoneTolerance(input.target.semitoneTolerance);
  const noteSetPolicy = normalizeRuntimeNoteSetPolicy(input.noteSetPolicy);
  const activationGatePolicy = normalizeActivationGatePolicy(input.activationGatePolicy ?? {
    id: 'runtime_gate_default',
    gateEnabled: false,
    emptyWindowMustBeQuiet: true,
    emptyWindowMaxValidatedNotes: 0,
    emptyWindowMaxExtraNotes: 0,
    emptyWindowMaxConfidence: null,
    transitionMinStableRatio: 0.7,
    transitionMaxOverlapRatio: 0.6,
    transitionMinNoteRatio: 0.5,
    transitionAllowSuperset: true,
    stableAllowSupersetIfExpectedCovered: true,
    minExpectedNoteRatioForActivation: 0.75,
    requireExactOnTransition: false,
    minConsecutiveExpectedSupportFrames: 1,
    hysteresisFrames: 1
  });

  const validatedNotes = uniqueSortedNumbers(input.noteDecisions.filter((note) => note.accepted).map((note) => note.midi));
  const matchedValidatedNotes = uniqueSortedNumbers(input.noteDecisions
    .filter((note) => note.accepted)
    .map((note) => note.evidence.matchedMidi)
    .filter((value): value is number => value !== null));
  const validatedSet = new Set(validatedNotes);
  const rawDetectedMidis = uniqueSortedNumbers(input.rawDetectedMidis);
  const rawDetectedSet = new Set(rawDetectedMidis);

  const missingNotes = expectedMidis.filter((midi) => !validatedSet.has(midi));
  const extraNotes = rawDetectedMidis.filter((midi) => !isMidiAcceptableForAnyTarget(midi, expectedMidis, semitoneTolerance));
  const expectedNoteCount = expectedMidis.length;
  const validatedNoteCount = validatedNotes.length;
  const noteValidationRatio = expectedNoteCount > 0 ? validatedNoteCount / expectedNoteCount : 1;
  const activationDetected = rawDetectedSet.size > 0;
  const windowCategory = input.windowCategory ?? (expectedNoteCount <= 0
    ? 'empty_window'
    : expectedNoteCount === 1
      ? 'single_note_window'
      : 'poly_window');
  const setRelation = input.setRelation ?? (expectedNoteCount <= 0
    ? (activationDetected ? 'empty_false_activation' : 'empty_match')
    : validatedNoteCount === expectedNoteCount && missingNotes.length === 0 && extraNotes.length === 0
      ? 'exact'
      : missingNotes.length === 0 && extraNotes.length > 0
        ? 'superset'
        : missingNotes.length > 0 && extraNotes.length === 0
          ? 'subset'
          : validatedNoteCount <= 0
            ? 'disjoint'
            : 'partial_overlap');
  const isStableWindow = input.isStableWindow ?? (windowCategory === 'single_note_window' || windowCategory === 'poly_window');
  const stableSetRatio = input.stableSetRatio ?? (expectedNoteCount > 0 ? validatedNoteCount / expectedNoteCount : 1);
  const transitionOverlapRatio = input.transitionOverlapRatio ?? (expectedNoteCount > 0 ? extraNotes.length / Math.max(1, expectedNoteCount) : 0);

  const acceptedPreGate = finalizePreGateDecision({
    target: input.target,
    noteSetPolicy,
    expectedMidis,
    validatedNotes,
    missingNotes,
    extraNotes,
    noteValidationRatio,
    activationDetected,
    rawDetectionMaxConfidence: input.rawDetectionMaxConfidence ?? null,
    noteDecisions: input.noteDecisions
  });

  const gateDecision = evaluateActivationGateDecision({
    policy: activationGatePolicy,
    preGateAccept: acceptedPreGate,
    expectedWindowActive: expectedNoteCount > 0,
    windowCategory,
    isStableWindow,
    setRelation,
    expectedCovered: missingNotes.length === 0,
    noteValidationRatio,
    stableSetRatio,
    transitionOverlapRatio,
    validatedNoteCount,
    extraDetectedNoteCount: extraNotes.length,
    activationDetected,
    rawDetectionMaxConfidence: input.rawDetectionMaxConfidence ?? null,
    minValidatedSupportFrames: Math.min(...input.noteDecisions.map((note) => note.evidence.minValidatedSupportFrames).filter((value) => Number.isFinite(value) && value > 0))
  });

  const acceptedPostGate = gateDecision.accept;
  const accepted = acceptedPostGate;
  const rejectReasons: string[] = [];
  let rejectStage: RuntimeValidatorOutput['rejectStage'] = 'none';
  if (!acceptedPreGate) {
    const noteFailures = input.noteDecisions.filter((note) => !note.accepted).map((note) => `note:${note.midi}:${note.decisionReason}`);
    rejectReasons.push(...noteFailures);
    rejectStage = noteFailures.length > 0 ? 'note_level' : 'aggregation';
  }
  if (acceptedPreGate && !acceptedPostGate) {
    rejectStage = 'gate';
    rejectReasons.push(`gate:${gateDecision.rejectReason}`);
  }

  const confidence = input.noteDecisions.length > 0
    ? average(input.noteDecisions.map((note) => note.evidence.confidenceScore))
    : 0;

  return {
    accepted,
    acceptedPreGate,
    acceptedPostGate,
    targetMode: input.target.mode,
    validatedNotes,
    matchedNotes: matchedValidatedNotes,
    missingNotes,
    extraNotes,
    noteValidationRatio,
    confidence,
    rejectReasons,
    rejectStage: accepted ? 'none' : rejectStage,
    gateRejectReason: gateDecision.rejectReason
  };
}

export function evaluateActivationGateDecision(input: {
  policy: ActivationGatePolicy;
  preGateAccept: boolean;
  expectedWindowActive: boolean;
  windowCategory: 'empty_window' | 'single_note_window' | 'poly_window' | 'transition_window';
  isStableWindow: boolean;
  setRelation: 'empty_match' | 'empty_false_activation' | 'exact' | 'superset' | 'subset' | 'partial_overlap' | 'disjoint';
  expectedCovered: boolean;
  noteValidationRatio: number;
  stableSetRatio: number;
  transitionOverlapRatio: number;
  validatedNoteCount: number;
  extraDetectedNoteCount: number;
  activationDetected: boolean;
  rawDetectionMaxConfidence: number | null;
  minValidatedSupportFrames: number;
}): { accept: boolean; rejectReason: ActivationGateRejectReason } {
  const policy = normalizeActivationGatePolicy(input.policy);
  if (!policy.gateEnabled) {
    return { accept: input.preGateAccept, rejectReason: input.preGateAccept ? 'disabled' : 'pre_gate_inactive' };
  }
  if (!input.preGateAccept) {
    return { accept: false, rejectReason: 'pre_gate_inactive' };
  }

  if (!input.expectedWindowActive || input.windowCategory === 'empty_window') {
    if (policy.emptyWindowMustBeQuiet && input.activationDetected) {
      return { accept: false, rejectReason: 'empty_window_requires_quiet' };
    }
    if (input.validatedNoteCount > policy.emptyWindowMaxValidatedNotes) {
      return { accept: false, rejectReason: 'empty_window_validated_notes_exceeded' };
    }
    if (input.extraDetectedNoteCount > policy.emptyWindowMaxExtraNotes) {
      return { accept: false, rejectReason: 'empty_window_extra_notes_exceeded' };
    }
    if (
      policy.emptyWindowMaxConfidence !== null &&
      input.rawDetectionMaxConfidence !== null &&
      input.rawDetectionMaxConfidence > policy.emptyWindowMaxConfidence
    ) {
      return { accept: false, rejectReason: 'empty_window_confidence_exceeded' };
    }
    return { accept: true, rejectReason: 'passed' };
  }

  const minRequiredNoteRatio = Math.max(
    clamp(policy.minExpectedNoteRatioForActivation, 0, 1),
    input.windowCategory === 'transition_window' ? clamp(policy.transitionMinNoteRatio, 0, 1) : 0
  );
  if (input.noteValidationRatio < minRequiredNoteRatio) {
    return { accept: false, rejectReason: 'expected_note_ratio_too_low' };
  }

  if (input.minValidatedSupportFrames < Math.max(1, Math.round(policy.minConsecutiveExpectedSupportFrames))) {
    return { accept: false, rejectReason: 'expected_support_frames_too_low' };
  }

  if (input.windowCategory === 'transition_window') {
    if (input.stableSetRatio < clamp(policy.transitionMinStableRatio, 0, 1)) {
      return { accept: false, rejectReason: 'transition_stability_too_low' };
    }
    if (input.transitionOverlapRatio > clamp(policy.transitionMaxOverlapRatio, 0, 1)) {
      return { accept: false, rejectReason: 'transition_overlap_too_high' };
    }
    if (policy.requireExactOnTransition && input.setRelation !== 'exact') {
      return { accept: false, rejectReason: 'transition_requires_exact' };
    }
    if (!policy.transitionAllowSuperset && input.setRelation === 'superset') {
      return { accept: false, rejectReason: 'transition_superset_not_allowed' };
    }
    return { accept: true, rejectReason: 'passed' };
  }

  if (
    input.isStableWindow &&
    input.setRelation === 'superset' &&
    input.expectedCovered &&
    !policy.stableAllowSupersetIfExpectedCovered
  ) {
    return { accept: false, rejectReason: 'stable_superset_not_allowed' };
  }

  return { accept: true, rejectReason: 'passed' };
}

function finalizePreGateDecision(input: {
  target: ValidationTarget;
  noteSetPolicy: RuntimeNoteSetPolicy;
  expectedMidis: number[];
  validatedNotes: number[];
  missingNotes: number[];
  extraNotes: number[];
  noteValidationRatio: number;
  activationDetected: boolean;
  rawDetectionMaxConfidence: number | null;
  noteDecisions: RuntimeNoteDecision[];
}): boolean {
  const noteSetPolicy = normalizeRuntimeNoteSetPolicy(input.noteSetPolicy);
  const expectedWindowActive = input.expectedMidis.length > 0;
  if (!expectedWindowActive) {
    return input.activationDetected;
  }

  let accept = false;
  if (noteSetPolicy.mode === 'all_notes_required') {
    accept = input.validatedNotes.length >= input.expectedMidis.length;
  } else if (noteSetPolicy.mode === 'min_count_required') {
    accept = input.validatedNotes.length >= Math.max(1, Math.round(noteSetPolicy.minNoteCount));
  } else {
    const targetRatio = typeof input.target.minNoteRatio === 'number' ? input.target.minNoteRatio : noteSetPolicy.minNoteRatio;
    accept = input.noteValidationRatio >= clamp(targetRatio, 0, 1);
  }

  if (accept && noteSetPolicy.extraNotePenaltyWeight > 0) {
    const penalty = noteSetPolicy.extraNotePenaltyWeight * (input.extraNotes.length / Math.max(1, input.expectedMidis.length));
    const adjustedRatio = input.noteValidationRatio - penalty;
    if (noteSetPolicy.mode === 'all_notes_required') {
      accept = adjustedRatio >= 1;
    } else if (noteSetPolicy.mode === 'min_count_required') {
      accept = adjustedRatio * input.expectedMidis.length >= Math.max(1, Math.round(noteSetPolicy.minNoteCount));
    } else {
      const targetRatio = typeof input.target.minNoteRatio === 'number' ? input.target.minNoteRatio : noteSetPolicy.minNoteRatio;
      accept = adjustedRatio >= clamp(targetRatio, 0, 1);
    }
  }

  if (accept && input.expectedMidis.length > 0 && noteSetPolicy.maxExtraDetectedNotes !== null && input.extraNotes.length > noteSetPolicy.maxExtraDetectedNotes) {
    accept = false;
  }

  if (
    accept &&
    input.expectedMidis.length > 0 &&
    input.missingNotes.length === 0 &&
    input.extraNotes.length > 0 &&
    !input.target.allowSuperset &&
    !noteSetPolicy.allowSupersetIfExpectedCovered
  ) {
    accept = false;
  }

  return accept;
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
  if (input.expectedVsSourceFrameRatio < input.minExpectedVsSourceFrameRatio) {
    return 'stage_a_expected_vs_source_ratio_failed';
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

function aggregatePairwiseCompetitorOutcomes(frames: ValidatorFrameCandidateEvidence[]): ValidatorPairwiseCompetitorOutcome[] | null {
  const pairwiseEntries = frames.flatMap((frame) => frame.spectralProbe?.pairwise ?? []);
  if (pairwiseEntries.length <= 0) return null;

  const byClass = new Map<string, Array<{
    expectedScore: number | null;
    competitorScore: number | null;
    expectedWon: boolean | null;
    positionAmbiguous: boolean;
  }>>();

  for (const pairwise of pairwiseEntries) {
    const bucket = byClass.get(pairwise.competitorClass) ?? [];
    bucket.push({
      expectedScore: pairwise.expectedScore,
      competitorScore: pairwise.competitorScore,
      expectedWon: pairwise.expectedWon,
      positionAmbiguous: pairwise.positionAmbiguous
    });
    byClass.set(pairwise.competitorClass, bucket);
  }

  return [...byClass.entries()].map(([competitorClass, values]) => {
    const comparisons = values.length;
    return {
      competitorClass,
      comparisonCount: comparisons,
      expectedWinRate: comparisons > 0 ? values.filter((value) => value.expectedWon === true).length / comparisons : null,
      expectedScoreMean: roundNullable(average(values.map((value) => value.expectedScore).filter((value): value is number => value !== null)), 6),
      competitorScoreMean: roundNullable(average(values.map((value) => value.competitorScore).filter((value): value is number => value !== null)), 6),
      detectedPositionAmbiguousFrameRatio: roundNullable(average(values.map((value) => (value.positionAmbiguous ? 1 : 0))), 6)
    };
  }).sort((left, right) => left.competitorClass.localeCompare(right.competitorClass));
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.round(value)))].sort((left, right) => left - right);
}

function normalizeSemitoneTolerance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function isMidiAcceptableForAnyTarget(midi: number, expectedMidis: number[], semitoneTolerance: number): boolean {
  return expectedMidis.some((expectedMidi) => Math.abs(midi - expectedMidi) <= semitoneTolerance + EPS);
}

function longestConsecutiveTrue(values: boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function countTrue(values: boolean[]): number {
  return values.filter((value) => value).length;
}

function ratioTrue(values: boolean[]): number {
  if (values.length === 0) return 0;
  return countTrue(values) / values.length;
}

function ratioTrueByMask(values: boolean[], mask: boolean[]): number {
  let count = 0;
  let hits = 0;
  for (let index = 0; index < Math.min(values.length, mask.length); index += 1) {
    if (!mask[index]) continue;
    count += 1;
    if (values[index]) hits += 1;
  }
  return count > 0 ? hits / count : 0;
}

function modeNumber(values: Array<number | null>): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let bestValue: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function roundNumber(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundNullable(value: number | null, decimals: number): number | null {
  return value === null ? null : roundNumber(value, decimals);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function estimateQualifiedSupportSeconds(
  frames: Array<{ timestampMs: number }>,
  qualifiedMask: boolean[]
): number {
  const frameIntervalsSeconds = estimateFrameIntervalSeconds(frames);
  if (frameIntervalsSeconds <= 0) return 0;
  return roundNumber(countTrue(qualifiedMask) * frameIntervalsSeconds, 6);
}

function estimateFrameIntervalSeconds(frames: Array<{ timestampMs: number }>): number {
  const deltas = frames
    .slice(1)
    .map((frame, index) => (frame.timestampMs - frames[index].timestampMs) / 1000)
    .filter((delta) => Number.isFinite(delta) && delta > 0);
  return Math.max(0.02, median(deltas) ?? 0.02);
}
