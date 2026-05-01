import type {
  ActivationGatePolicy,
  LegacyHitRatioConfig,
  NoteEvidenceConfig,
  PositionEvidenceConfig,
  RuntimeNoteSetPolicy,
  RuntimeModePolicy,
  RuntimeValidatorConfig,
  ValidationMode,
  ValidatorDecisionConfig
} from './validatorTypes';

export const DEFAULT_VALIDATOR_DECISION_CONFIG: ValidatorDecisionConfig = {
  id: 'runtime_shared_note_only_v1',
  label: 'Runtime shared note-only config',
  mode: 'note_only',
  note: {
    minExpectedScore: 0,
    minExpectedSupportSeconds: 0.02,
    minConsecutiveExpectedFrames: 1,
    maxExpectedCentsError: 35,
    minExpectedConfidence: 0.2,
    minExpectedVsBestMargin: 10,
    minExpectedVsBestRatio: 1.4,
    minExpectedVsOctaveMargin: 10,
    ignoreAttackMs: 0,
    minMicRms: 0.008,
    minExpectedTop1FrameRatio: 0,
    minExpectedTop3FrameRatio: 0,
    minExpectedPairwiseWinRate: 0,
    maxOctaveConfusionFrameRatio: 1,
    minExpectedVsSourceFrameRatio: 0,
    minExpectedTargetConfirmationFrameRatio: 0
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

// Canonical Android mono benchmark-aligned note gate used by PlayScene.
export const PLAY_SCENE_VALIDATOR_DECISION_CONFIG: ValidatorDecisionConfig = {
  ...DEFAULT_VALIDATOR_DECISION_CONFIG,
  note: {
    ...DEFAULT_VALIDATOR_DECISION_CONFIG.note,
    maxExpectedCentsError: 50,
    minExpectedConfidence: 0.65,
    // Use a tiny epsilon above 0.5 so the inclusive note-stage comparator behaves as a strict > 0.5 guard.
    minExpectedTop1FrameRatio: 0.500001,
    minExpectedVsSourceFrameRatio: 0.6,
    minExpectedTargetConfirmationFrameRatio: 0.6,
    minExpectedVsBestMargin: -1_000_000,
    minExpectedVsBestRatio: 0,
    minExpectedVsOctaveMargin: -1_000_000,
    minMicRms: DEFAULT_VALIDATOR_DECISION_CONFIG.note.minMicRms
  }
};

export const DEFAULT_NOTE_SET_POLICY: RuntimeNoteSetPolicy = {
  id: 'runtime_poly_min_ratio_v1',
  mode: 'min_ratio_required',
  minNoteRatio: 1,
  minNoteCount: 1,
  maxExtraDetectedNotes: null,
  extraNotePenaltyWeight: 0,
  allowSupersetIfExpectedCovered: true,
  emptyWindowMustBeQuiet: true
};

export const MONO_NOTE_SET_POLICY: RuntimeNoteSetPolicy = {
  id: 'runtime_mono_all_notes_required_v1',
  mode: 'all_notes_required',
  minNoteRatio: 1,
  minNoteCount: 1,
  maxExtraDetectedNotes: 0,
  extraNotePenaltyWeight: 0,
  allowSupersetIfExpectedCovered: true,
  emptyWindowMustBeQuiet: false
};

export const DEFAULT_ACTIVATION_GATE_POLICY: ActivationGatePolicy = {
  id: 'runtime_poly_activation_gate_v1',
  gateEnabled: true,
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
};

export const MONO_ACTIVATION_GATE_POLICY: ActivationGatePolicy = {
  id: 'runtime_mono_activation_gate_off_v1',
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
};

export const DEFAULT_RUNTIME_VALIDATOR_CONFIG: RuntimeValidatorConfig = {
  noteDecisionConfig: DEFAULT_VALIDATOR_DECISION_CONFIG,
  monoNoteSetPolicy: MONO_NOTE_SET_POLICY,
  polyNoteSetPolicy: DEFAULT_NOTE_SET_POLICY,
  monoGatePolicy: MONO_ACTIVATION_GATE_POLICY,
  polyGatePolicy: DEFAULT_ACTIVATION_GATE_POLICY,
  defaultMode: 'mono'
};

export function normalizeNoteDecisionConfig(config: ValidatorDecisionConfig): ValidatorDecisionConfig {
  return {
    ...config,
    id: config.id || DEFAULT_VALIDATOR_DECISION_CONFIG.id,
    mode: config.mode === 'legacy_hit_ratio' || config.mode === 'exact_position' || config.mode === 'note_only'
      ? config.mode
      : DEFAULT_VALIDATOR_DECISION_CONFIG.mode,
    note: normalizeNoteEvidenceConfig(config.note),
    position: normalizePositionEvidenceConfig(config.position),
    legacy: normalizeLegacyHitRatioConfig(config.legacy)
  };
}

export function normalizeNoteEvidenceConfig(config: NoteEvidenceConfig): NoteEvidenceConfig {
  return {
    ...config,
    minExpectedScore: Number.isFinite(config.minExpectedScore) ? config.minExpectedScore : 0,
    minExpectedSupportSeconds: Number.isFinite(config.minExpectedSupportSeconds) ? Math.max(0, config.minExpectedSupportSeconds) : 0.02,
    minConsecutiveExpectedFrames: Math.max(1, Math.round(config.minConsecutiveExpectedFrames)),
    maxExpectedCentsError: Number.isFinite(config.maxExpectedCentsError) ? Math.max(0, config.maxExpectedCentsError) : 35,
    minExpectedConfidence: clamp(config.minExpectedConfidence, 0, 1),
    minExpectedVsBestMargin: Number.isFinite(config.minExpectedVsBestMargin) ? config.minExpectedVsBestMargin : 0,
    minExpectedVsBestRatio: Number.isFinite(config.minExpectedVsBestRatio) ? Math.max(0, config.minExpectedVsBestRatio) : 0,
    minExpectedVsOctaveMargin: Number.isFinite(config.minExpectedVsOctaveMargin) ? config.minExpectedVsOctaveMargin : 0,
    ignoreAttackMs: Math.max(0, Math.round(config.ignoreAttackMs)),
    minMicRms: Number.isFinite(config.minMicRms) ? Math.max(0, config.minMicRms) : DEFAULT_VALIDATOR_DECISION_CONFIG.note.minMicRms,
    minExpectedTop1FrameRatio: clamp(config.minExpectedTop1FrameRatio, 0, 1),
    minExpectedTop3FrameRatio: clamp(config.minExpectedTop3FrameRatio, 0, 1),
    minExpectedPairwiseWinRate: clamp(config.minExpectedPairwiseWinRate, 0, 1),
    maxOctaveConfusionFrameRatio: clamp(config.maxOctaveConfusionFrameRatio, 0, 1),
    minExpectedVsSourceFrameRatio: clamp(config.minExpectedVsSourceFrameRatio, 0, 1),
    minExpectedTargetConfirmationFrameRatio: config.minExpectedTargetConfirmationFrameRatio === undefined
      ? undefined
      : clamp(config.minExpectedTargetConfirmationFrameRatio, 0, 1)
  };
}

export function normalizePositionEvidenceConfig(config: PositionEvidenceConfig): PositionEvidenceConfig {
  return {
    ...config,
    minPositionFrameRatio: clamp(config.minPositionFrameRatio, 0, 1),
    minConsecutivePositionFrames: Math.max(1, Math.round(config.minConsecutivePositionFrames)),
    rejectSamePitchAltFrames: config.rejectSamePitchAltFrames !== false
  };
}

export function normalizeLegacyHitRatioConfig(config: LegacyHitRatioConfig): LegacyHitRatioConfig {
  return {
    ...config,
    frameToleranceCents: Number.isFinite(config.frameToleranceCents) ? Math.max(0, config.frameToleranceCents) : 50,
    acceptFrameRatio: clamp(config.acceptFrameRatio, 0, 1)
  };
}

export function normalizeRuntimeNoteSetPolicy(policy: RuntimeNoteSetPolicy): RuntimeNoteSetPolicy {
  return {
    ...policy,
    id: policy.id || DEFAULT_NOTE_SET_POLICY.id,
    mode: policy.mode === 'all_notes_required' || policy.mode === 'min_ratio_required' || policy.mode === 'min_count_required'
      ? policy.mode
      : DEFAULT_NOTE_SET_POLICY.mode,
    minNoteRatio: clamp(policy.minNoteRatio, 0, 1),
    minNoteCount: Math.max(1, Math.round(policy.minNoteCount)),
    maxExtraDetectedNotes: policy.maxExtraDetectedNotes === null
      ? null
      : Number.isFinite(policy.maxExtraDetectedNotes)
        ? Math.max(0, Math.round(policy.maxExtraDetectedNotes))
        : null,
    extraNotePenaltyWeight: Math.max(0, policy.extraNotePenaltyWeight),
    allowSupersetIfExpectedCovered: policy.allowSupersetIfExpectedCovered !== false,
    emptyWindowMustBeQuiet: policy.emptyWindowMustBeQuiet !== false
  };
}

export function normalizeActivationGatePolicy(policy: ActivationGatePolicy): ActivationGatePolicy {
  return {
    ...policy,
    id: policy.id || DEFAULT_ACTIVATION_GATE_POLICY.id,
    gateEnabled: policy.gateEnabled !== false,
    emptyWindowMustBeQuiet: policy.emptyWindowMustBeQuiet !== false,
    emptyWindowMaxValidatedNotes: Math.max(0, Math.round(policy.emptyWindowMaxValidatedNotes)),
    emptyWindowMaxExtraNotes: Math.max(0, Math.round(policy.emptyWindowMaxExtraNotes)),
    emptyWindowMaxConfidence: policy.emptyWindowMaxConfidence === null
      ? null
      : Number.isFinite(policy.emptyWindowMaxConfidence)
        ? clamp(policy.emptyWindowMaxConfidence, 0, 1)
        : null,
    transitionMinStableRatio: clamp(policy.transitionMinStableRatio, 0, 1),
    transitionMaxOverlapRatio: clamp(policy.transitionMaxOverlapRatio, 0, 1),
    transitionMinNoteRatio: clamp(policy.transitionMinNoteRatio, 0, 1),
    transitionAllowSuperset: policy.transitionAllowSuperset !== false,
    stableAllowSupersetIfExpectedCovered: policy.stableAllowSupersetIfExpectedCovered !== false,
    minExpectedNoteRatioForActivation: clamp(policy.minExpectedNoteRatioForActivation, 0, 1),
    requireExactOnTransition: policy.requireExactOnTransition === true,
    minConsecutiveExpectedSupportFrames: Math.max(1, Math.round(policy.minConsecutiveExpectedSupportFrames)),
    hysteresisFrames: Math.max(1, Math.round(policy.hysteresisFrames))
  };
}

export function createModePolicy(mode: ValidationMode): RuntimeModePolicy {
  return mode === 'mono'
    ? {
        noteSetPolicy: MONO_NOTE_SET_POLICY,
        activationGatePolicy: MONO_ACTIVATION_GATE_POLICY
      }
    : {
        noteSetPolicy: DEFAULT_NOTE_SET_POLICY,
        activationGatePolicy: DEFAULT_ACTIVATION_GATE_POLICY
      };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
