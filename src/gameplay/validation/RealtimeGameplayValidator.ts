import {
  DEFAULT_RUNTIME_VALIDATOR_CONFIG,
  DEFAULT_ACTIVATION_GATE_POLICY,
  DEFAULT_NOTE_SET_POLICY,
  MONO_ACTIVATION_GATE_POLICY,
  MONO_NOTE_SET_POLICY,
  normalizeActivationGatePolicy,
  normalizeNoteDecisionConfig,
  normalizeRuntimeNoteSetPolicy
} from './validatorPolicies';
import type {
  RuntimeValidatorConfig,
  RuntimeValidatorInput,
  RuntimeValidatorOutput,
  RuntimeValidatorStateSnapshot,
  ValidationTarget,
  ValidatorFrameCandidateEvidence,
  ValidatorNoteEvidence,
  RuntimeNoteDecision
} from './validatorTypes';
import {
  buildValidatorNoteEvidence,
  evaluateNoteEvidence,
  evaluateRuntimeTargetDecision
} from './validatorNoteCore';

type NoteHistory = {
  midi: number;
  frames: ValidatorFrameCandidateEvidence[];
  decision: RuntimeNoteDecision | null;
};

type RuntimeTargetState = {
  target: ValidationTarget;
  startedAtMs: number | null;
  revision: number;
  noteHistories: Map<number, NoteHistory>;
};

export class RealtimeGameplayValidator {
  private config: RuntimeValidatorConfig = DEFAULT_RUNTIME_VALIDATOR_CONFIG;
  private targetState: RuntimeTargetState | null = null;
  private frameCount = 0;
  private lastTimestampMs: number | null = null;
  private lastOutput: RuntimeValidatorOutput | null = null;

  constructor(config?: Partial<RuntimeValidatorConfig>) {
    if (config) {
      this.configure(config);
    }
  }

  configure(config: Partial<RuntimeValidatorConfig>): void {
    const next: RuntimeValidatorConfig = {
      ...DEFAULT_RUNTIME_VALIDATOR_CONFIG,
      ...config,
      noteDecisionConfig: normalizeNoteDecisionConfig(config.noteDecisionConfig ?? this.config.noteDecisionConfig ?? DEFAULT_RUNTIME_VALIDATOR_CONFIG.noteDecisionConfig),
      monoNoteSetPolicy: normalizeRuntimeNoteSetPolicy(config.monoNoteSetPolicy ?? this.config.monoNoteSetPolicy ?? MONO_NOTE_SET_POLICY),
      polyNoteSetPolicy: normalizeRuntimeNoteSetPolicy(config.polyNoteSetPolicy ?? this.config.polyNoteSetPolicy ?? DEFAULT_NOTE_SET_POLICY),
      monoGatePolicy: normalizeActivationGatePolicy(config.monoGatePolicy ?? this.config.monoGatePolicy ?? MONO_ACTIVATION_GATE_POLICY),
      polyGatePolicy: normalizeActivationGatePolicy(config.polyGatePolicy ?? this.config.polyGatePolicy ?? DEFAULT_ACTIVATION_GATE_POLICY),
      defaultMode: config.defaultMode ?? this.config.defaultMode ?? 'mono'
    };
    this.config = next;
  }

  reset(): void {
    this.targetState = null;
    this.frameCount = 0;
    this.lastTimestampMs = null;
    this.lastOutput = null;
  }

  setTarget(target: ValidationTarget | null): void {
    if (target === null) {
      this.targetState = null;
      return;
    }

    const normalizedTarget = normalizeTarget(target);
    const current = this.targetState;
    if (!current || !targetsEqual(current.target, normalizedTarget)) {
      this.targetState = {
        target: normalizedTarget,
        startedAtMs: null,
        revision: current ? current.revision + 1 : 1,
        noteHistories: new Map(normalizedTarget.midiNotes.map((midi) => [midi, { midi, frames: [], decision: null }]))
      };
    }
  }

  update(input: RuntimeValidatorInput): RuntimeValidatorOutput {
    if (input.target !== undefined) {
      this.setTarget(input.target);
    }

    this.frameCount += 1;
    this.lastTimestampMs = input.timestampMs;

    if (!this.targetState) {
      this.lastOutput = {
        accepted: false,
        acceptedPreGate: false,
        acceptedPostGate: false,
        targetMode: 'mono',
        validatedNotes: [],
        matchedNotes: [],
        missingNotes: [],
        extraNotes: uniqueSortedNumbers(input.frameEvidence.rawDetectedMidis ?? []),
        noteValidationRatio: 0,
        confidence: 0,
        rejectReasons: ['no_target'],
        rejectStage: 'no_target',
        gateRejectReason: null
      };
      return this.lastOutput;
    }

    if (this.targetState.startedAtMs === null) {
      this.targetState.startedAtMs = input.timestampMs;
    }

    const noteEvidenceByMidi = new Map<number, ValidatorFrameCandidateEvidence>();
    for (const note of input.frameEvidence.notes) {
      if (note.midi !== null) {
        noteEvidenceByMidi.set(note.midi, note);
      }
    }

    for (const midi of this.targetState.target.midiNotes) {
      const history = this.targetState.noteHistories.get(midi);
      if (!history) continue;
      const evidence = noteEvidenceByMidi.get(midi) ?? buildFallbackNoteEvidence(midi, input.frameEvidence.timestampMs);
      history.frames.push(evidence);

      const noteSummary = buildValidatorNoteEvidence(
        midi,
        history.frames,
        this.config.noteDecisionConfig,
        this.targetState.startedAtMs,
        this.targetState.target.semitoneTolerance
      );
      history.decision = mapNoteDecision(
        noteSummary,
        evaluateNoteEvidence(noteSummary, this.config.noteDecisionConfig)
      );
    }

    const noteDecisions = [...this.targetState.noteHistories.values()].map((history) => {
      const decision = history.decision ?? mapNoteDecision(
        buildValidatorNoteEvidence(
          history.midi,
          history.frames,
          this.config.noteDecisionConfig,
          this.targetState?.startedAtMs ?? null,
          this.targetState?.target.semitoneTolerance ?? 0
        ),
        evaluateNoteEvidence(
          buildValidatorNoteEvidence(
            history.midi,
            history.frames,
            this.config.noteDecisionConfig,
            this.targetState?.startedAtMs ?? null,
            this.targetState?.target.semitoneTolerance ?? 0
          ),
          this.config.noteDecisionConfig
        )
      );
      return decision;
    });

    const policy = this.targetState.target.mode === 'mono'
      ? this.config.monoNoteSetPolicy
      : this.config.polyNoteSetPolicy;
    const gatePolicy = this.targetState.target.mode === 'mono'
      ? this.config.monoGatePolicy
      : this.config.polyGatePolicy;

    const output = evaluateRuntimeTargetDecision({
      target: this.targetState.target,
      noteDecisions,
      rawDetectedMidis: input.frameEvidence.rawDetectedMidis ?? [],
      rawDetectionMaxConfidence: input.frameEvidence.rawDetectionMaxConfidence ?? null,
      rawDetectionFrameRatio: input.frameEvidence.rawDetectionFrameRatio ?? null,
      noteSetPolicy: policy,
      activationGatePolicy: gatePolicy
    });

    this.lastOutput = applyLiveFrameEvidenceGuard(
      output,
      input.frameEvidence,
      this.targetState.target,
      this.config.noteDecisionConfig.note.minExpectedConfidence,
      this.config.noteDecisionConfig.note.minMicRms
    );
    return this.lastOutput;
  }

  getState(): RuntimeValidatorStateSnapshot {
    return {
      target: this.targetState?.target ?? null,
      targetRevision: this.targetState?.revision ?? 0,
      targetStartedAtMs: this.targetState?.startedAtMs ?? null,
      mode: this.targetState?.target.mode ?? null,
      frameCount: this.frameCount,
      lastTimestampMs: this.lastTimestampMs,
      lastOutput: this.lastOutput,
      noteDecisions: this.targetState
        ? [...this.targetState.noteHistories.values()].map((history) => history.decision).filter((value): value is RuntimeNoteDecision => value !== null)
        : []
    };
  }
}

function normalizeTarget(target: ValidationTarget): ValidationTarget {
  const midiNotes = uniqueSortedNumbers(target.midiNotes);
  const mode = target.mode === 'poly' || midiNotes.length > 1 ? 'poly' : 'mono';
  return {
    ...target,
    mode,
    midiNotes,
    semitoneTolerance: normalizeSemitoneTolerance(target.semitoneTolerance),
    allowSuperset: target.allowSuperset !== false
  };
}

function targetsEqual(left: ValidationTarget, right: ValidationTarget): boolean {
  if (left.mode !== right.mode) return false;
  if (left.midiNotes.length !== right.midiNotes.length) return false;
  for (let index = 0; index < left.midiNotes.length; index += 1) {
    if (left.midiNotes[index] !== right.midiNotes[index]) return false;
  }
  if (left.semitoneTolerance !== right.semitoneTolerance) return false;
  if ((left.minNoteRatio ?? null) !== (right.minNoteRatio ?? null)) return false;
  if ((left.allowSuperset ?? true) !== (right.allowSuperset ?? true)) return false;
  return true;
}

function buildFallbackNoteEvidence(midi: number, timestampMs: number): ValidatorFrameCandidateEvidence {
  return {
    timestampMs,
    midi,
    targetSemitoneTolerance: 0,
    micRms: null,
    matchedMidi: null,
    matchedSemitoneDistance: null,
    detectorAccepted: false,
    detectorConfidence: 0,
    expectedCentsError: null,
    expectedScore: 0,
    bestCompetitorScore: 0,
    bestCompetitorMidi: null,
    bestOctaveScore: 0,
    neighborScore: 0,
    samePitchAltScore: null,
    expectedRank: null,
    expectedTop1: false,
    expectedTop3: false,
    expectedPairwiseWinRate: null,
    octaveCompetitorOutranked: false,
    expectedVsSourceWon: null,
    positionAmbiguous: false,
    candidateScoreCount: null,
    sharedEvidenceAvailability: [],
    sharedEvidenceLimitations: ['missing_frame_evidence'],
    evidenceSource: 'masp_proxy',
    spectralProbe: null,
    samePitchAltDetected: false,
    expectedPositionMatch: false
  };
}

function applyLiveFrameEvidenceGuard(
  output: RuntimeValidatorOutput,
  frameEvidence: RuntimeValidatorInput['frameEvidence'],
  target: ValidationTarget,
  minExpectedConfidence: number,
  minMicRms: number
): RuntimeValidatorOutput {
  if (!output.acceptedPostGate) {
    return output;
  }

  const maxExpectedCentsError = Math.max(0, target.semitoneTolerance * 100);
  const currentMicRms = resolveFrameMicRms(frameEvidence);
  if (currentMicRms !== null && currentMicRms < minMicRms) {
    const rejectReasons = output.rejectReasons.includes('gate:mic_rms_below_floor')
      ? output.rejectReasons
      : [...output.rejectReasons, 'gate:mic_rms_below_floor'];

    return {
      ...output,
      accepted: false,
      acceptedPostGate: false,
      rejectReasons,
      rejectStage: 'gate',
      gateRejectReason: 'mic_rms_below_floor'
    };
  }

  const hasCurrentTargetEvidence = frameEvidence.notes.some((note) => (
    note.detectorAccepted &&
    note.matchedMidi !== null &&
    note.detectorConfidence >= minExpectedConfidence &&
    note.expectedCentsError !== null &&
    Math.abs(note.expectedCentsError) <= maxExpectedCentsError
  ));

  if (hasCurrentTargetEvidence) {
    return output;
  }

  const rejectReasons = output.rejectReasons.includes('gate:no_live_frame_evidence')
    ? output.rejectReasons
    : [...output.rejectReasons, 'gate:no_live_frame_evidence'];

  return {
    ...output,
    accepted: false,
    acceptedPostGate: false,
    rejectReasons,
    rejectStage: 'gate',
    gateRejectReason: 'no_live_frame_evidence'
  };
}

function resolveFrameMicRms(frameEvidence: RuntimeValidatorInput['frameEvidence']): number | null {
  if (Number.isFinite(frameEvidence.micRms ?? Number.NaN)) {
    return frameEvidence.micRms ?? null;
  }

  const noteMicRms = frameEvidence.notes
    .map((note) => note.micRms)
    .filter((value): value is number => Number.isFinite(value));

  if (noteMicRms.length === 0) {
    return null;
  }

  return Math.max(...noteMicRms);
}

function mapNoteDecision(
  evidence: ValidatorNoteEvidence,
  decision: { decisionAccept: boolean; decisionReason: string; acceptedNote: boolean }
): RuntimeNoteDecision {
  return {
    midi: evidence.noteMidi,
    accepted: decision.decisionAccept,
    decisionReason: decision.decisionReason,
    evidence: {
      ...evidence,
      acceptedNote: decision.acceptedNote
    }
  };
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.round(value)))].sort((left, right) => left - right);
}

function normalizeSemitoneTolerance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
