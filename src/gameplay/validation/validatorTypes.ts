export type DecisionMode = 'legacy_hit_ratio' | 'note_only' | 'exact_position';

export type NoteEvidenceConfig = {
  minExpectedScore: number;
  minExpectedFrameRatio: number;
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
  competitorClass: string;
  comparisonCount: number;
  expectedWinRate: number | null;
  expectedScoreMean: number | null;
  competitorScoreMean: number | null;
  detectedPositionAmbiguousFrameRatio: number | null;
};

export type ValidatorNoteEvidence = {
  noteMidi: number;
  noteDecisionConfigId: string;
  expectedTargetScore: number;
  nearbyCompetitorScore: number;
  rawDetectionMaxConfidence: number | null;
  rawDetectionFrameRatio: number | null;
  supportFrames: number;
  minValidatedSupportFrames: number;
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
  positionAmbiguousFrameRatio: number;
  samePitchAltDetectedFrameCount: number;
  samePitchAltCandidateExists: boolean;
  confidenceScore: number;
  expectedFrameRatio: number;
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

export type ValidationMode = 'mono' | 'poly';

export type ValidationTarget = {
  mode: ValidationMode;
  midiNotes: number[];
  minNoteRatio?: number;
  allowSuperset?: boolean;
  metadata?: Record<string, unknown>;
};

export type ValidatorFrameCandidateEvidence = {
  timestampMs: number;
  midi: number | null;
  detectedMidi?: number | null;
  detectedString?: number | null;
  detectedFret?: number | null;
  detectorAccepted: boolean;
  detectorConfidence: number;
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
  spectralProbe: {
    probeVersion: 'spectral_probe_v1';
    expectedNoteId: string;
    candidateCount: number;
    availableCandidateScoreCount: number;
    topCandidates: Array<{
      noteId: string;
      midi: number;
      stringId: number;
      fret: number;
      rawScore: number;
      relativeScore: number | null;
      rank: number;
      competitorClass: string;
    }>;
    pairwise: Array<{
      noteId: string;
      midi: number;
      stringId: number;
      fret: number;
      competitorClass: string;
      expectedScore: number | null;
      competitorScore: number | null;
      expectedWon: boolean | null;
      detectedString: number | null;
      detectedFret: number | null;
      positionAmbiguous: boolean;
    }>;
    expectedRank: number | null;
    expectedTop1: boolean;
    expectedTop3: boolean;
    expectedPairwiseWinRate: number | null;
    octaveCompetitorOutranked: boolean;
    expectedVsSourceWon: boolean | null;
    positionAmbiguous: boolean;
    missingEvidence: string[];
  } | null;
  samePitchAltDetected: boolean;
  expectedPositionMatch: boolean;
};

export type ValidatorFrameEvidence = {
  frameIndex?: number;
  timestampMs: number;
  notes: ValidatorFrameCandidateEvidence[];
  rawDetectedMidis?: number[];
  rawDetectionMaxConfidence?: number | null;
  rawDetectionFrameRatio?: number | null;
  metadata?: Record<string, unknown>;
};

export type RuntimeValidatorConfig = {
  noteDecisionConfig: ValidatorDecisionConfig;
  monoNoteSetPolicy: RuntimeNoteSetPolicy;
  polyNoteSetPolicy: RuntimeNoteSetPolicy;
  monoGatePolicy: ActivationGatePolicy;
  polyGatePolicy: ActivationGatePolicy;
  defaultMode: ValidationMode;
};

export type RuntimeModePolicy = {
  noteSetPolicy: RuntimeNoteSetPolicy;
  activationGatePolicy: ActivationGatePolicy;
};

export type RuntimeNoteSetPolicyMode = 'all_notes_required' | 'min_ratio_required' | 'min_count_required';

export type RuntimeNoteSetPolicy = {
  id: string;
  mode: RuntimeNoteSetPolicyMode;
  minNoteRatio: number;
  minNoteCount: number;
  maxExtraDetectedNotes: number | null;
  extraNotePenaltyWeight: number;
  allowSupersetIfExpectedCovered: boolean;
  emptyWindowMustBeQuiet: boolean;
};

export type ActivationGateRejectReason =
  | 'passed'
  | 'disabled'
  | 'pre_gate_inactive'
  | 'empty_window_requires_quiet'
  | 'empty_window_validated_notes_exceeded'
  | 'empty_window_extra_notes_exceeded'
  | 'empty_window_confidence_exceeded'
  | 'expected_note_ratio_too_low'
  | 'expected_support_frames_too_low'
  | 'transition_stability_too_low'
  | 'transition_overlap_too_high'
  | 'transition_requires_exact'
  | 'transition_superset_not_allowed'
  | 'stable_superset_not_allowed'
  | 'hysteresis_not_satisfied';

export type ActivationGatePolicy = {
  id: string;
  gateEnabled: boolean;
  emptyWindowMustBeQuiet: boolean;
  emptyWindowMaxValidatedNotes: number;
  emptyWindowMaxExtraNotes: number;
  emptyWindowMaxConfidence: number | null;
  transitionMinStableRatio: number;
  transitionMaxOverlapRatio: number;
  transitionMinNoteRatio: number;
  transitionAllowSuperset: boolean;
  stableAllowSupersetIfExpectedCovered: boolean;
  minExpectedNoteRatioForActivation: number;
  requireExactOnTransition: boolean;
  minConsecutiveExpectedSupportFrames: number;
  hysteresisFrames: number;
};

export type RuntimeNoteDecision = {
  midi: number;
  accepted: boolean;
  decisionReason: string;
  evidence: ValidatorNoteEvidence;
};

export type RuntimeValidatorOutput = {
  accepted: boolean;
  acceptedPreGate: boolean;
  acceptedPostGate: boolean;
  targetMode: ValidationMode;
  validatedNotes: number[];
  missingNotes: number[];
  extraNotes: number[];
  noteValidationRatio: number;
  confidence: number;
  rejectReasons: string[];
  rejectStage: 'none' | 'note_level' | 'aggregation' | 'gate' | 'no_target';
  gateRejectReason: ActivationGateRejectReason | null;
};

export type RuntimeValidatorStateSnapshot = {
  target: ValidationTarget | null;
  targetRevision: number;
  targetStartedAtMs: number | null;
  mode: ValidationMode | null;
  frameCount: number;
  lastTimestampMs: number | null;
  lastOutput: RuntimeValidatorOutput | null;
  noteDecisions: RuntimeNoteDecision[];
};

export type RuntimeValidatorInput = {
  timestampMs: number;
  frameEvidence: ValidatorFrameEvidence;
  target?: ValidationTarget | null;
};
