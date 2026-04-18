import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateRuntimeTargetDecision,
  resolveDifficultySemitoneTolerance,
  type RuntimeNoteDecision,
  type ValidatorNoteEvidence as RuntimeValidatorNoteEvidence
} from '../../src/gameplay/validation';
import {
  evaluateCaseTelemetry,
  type AlgorithmName,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig,
  type ValidatorRow
} from './gameplay_validator_core';

export type DatasetSubset = 'solo' | 'comp' | 'unknown';
export type DatasetBucket = DatasetSubset | 'combined';

export type WavJamsPair = {
  fileId: string;
  subset: DatasetSubset;
  wavPath: string;
  jamsPath: string;
  wavRelativePath: string;
  jamsRelativePath: string;
};

export type JamsNoteEvent = {
  startSec: number;
  endSec: number;
  midi: number;
  sourceTrack: string | null;
  annotationIndex: number;
  observationIndex: number;
};

export type JamsParseAudit = {
  filePath: string;
  selectedNamespace: 'note_midi';
  annotationCount: number;
  namespaceCounts: Record<string, number>;
  noteEventCount: number;
  sourceTrackCount: number;
  droppedObservationCount: number;
  fileDurationSec: number | null;
};

export type ExpectedNoteWindow = {
  windowId: string;
  fileId: string;
  wavRelativePath: string;
  subset: DatasetSubset;
  startSec: number;
  endSec: number;
  expectedMidis: number[];
  expectedDominantMidis: number[];
  expectedSegmentCount: number;
  expectedActiveRatio: number;
  stableSetRatio: number;
  transitionOverlapRatio: number;
  noteSetChangeCount: number;
  baseWindowCategory: WindowBaseCategory;
  windowCategory: WindowCategory;
  isStableWindow: boolean;
};

export type WindowBaseCategory = 'empty_window' | 'single_note_window' | 'poly_window';
export type WindowCategory = WindowBaseCategory | 'transition_window';
export type WindowNegativeType = 'none' | 'empty_negative' | 'set_mismatch_negative' | 'transition_ambiguous_negative';
export type WindowSetRelation =
  | 'empty_match'
  | 'empty_false_activation'
  | 'exact'
  | 'superset'
  | 'subset'
  | 'partial_overlap'
  | 'disjoint';

export type WindowStabilityConfig = {
  stableWindowMinRatio: number;
  transitionOverlapThreshold: number;
};

export type NoteSetAggregationMode = 'all_notes_required' | 'min_ratio_required' | 'min_count_required';

export type NoteSetAggregationPolicy = {
  id: string;
  mode: NoteSetAggregationMode;
  minNoteRatio: number;
  minNoteCount: number;
  maxExtraDetectedNotes: number | null;
  extraNotePenaltyWeight: number;
  allowSupersetIfExpectedCovered: boolean;
  emptyWindowMustBeQuiet: boolean;
};

export type UnifiedAggregationMode = 'mono_aggregation_mode' | 'poly_aggregation_mode';

export type ValidationStackDescriptor = {
  noteDecisionConfigId: string;
  aggregationPolicyId: string;
  activationGatePolicyId: string;
  aggregationMode: UnifiedAggregationMode;
  noteSetCardinality: number;
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

export type PolyphonicWindowTelemetry = {
  algorithm: AlgorithmName;
  windowId: string;
  fileId: string;
  wavRelativePath: string;
  subset: DatasetSubset;
  startSec: number;
  endSec: number;
  expectedMidis: number[];
  expectedDominantMidis?: number[];
  expectedSegmentCount?: number;
  expectedActiveRatio?: number;
  stableSetRatio?: number;
  transitionOverlapRatio?: number;
  noteSetChangeCount?: number;
  baseWindowCategory?: WindowBaseCategory;
  windowCategory?: WindowCategory;
  isStableWindow?: boolean;
  rawDetectedMidis: number[];
  rawDetectionMaxConfidence?: number | null;
  rawDetectionFrameRatio?: number | null;
  perNoteTelemetry: ValidatorCaseTelemetry[];
};

export type NoteSetWindowResult = {
  algorithm: AlgorithmName;
  noteDecisionConfigId: string;
  aggregationPolicyId: string;
  activationGatePolicyId: string;
  aggregationMode: UnifiedAggregationMode;
  noteSetCardinality: number;
  windowId: string;
  fileId: string;
  wavRelativePath: string;
  subset: DatasetSubset;
  startSec: number;
  endSec: number;
  expectedMidis: number[];
  expectedDominantMidis: number[];
  expectedSegmentCount: number;
  expectedActiveRatio: number;
  stableSetRatio: number;
  transitionOverlapRatio: number;
  noteSetChangeCount: number;
  baseWindowCategory: WindowBaseCategory;
  windowCategory: WindowCategory;
  isStableWindow: boolean;
  setRelation: WindowSetRelation;
  negativeType: WindowNegativeType;
  rawDetectedMidis: number[];
  rawDetectionMaxConfidence: number | null;
  rawDetectionFrameRatio: number | null;
  activationDetected: boolean;
  expectedNoteCount: number;
  validatedExpectedNotes: number[];
  validatedNoteCount: number;
  noteValidationRatio: number;
  minValidatedSupportFrames: number;
  missingExpectedNotes: number[];
  extraDetectedNotes: number[];
  supersetMatch: boolean;
  subsetMatch: boolean;
  disjointSetMatch: boolean;
  accept: boolean;
  policyAccept: boolean;
  preGateAccept: boolean;
  gateCoreAccept: boolean;
  postGateAccept: boolean;
  gateRejectReason: ActivationGateRejectReason | null;
  gateSuppressed: boolean;
  gateSuppressedByHysteresis: boolean;
  strictAccept: boolean;
  expectedWindowActive: boolean;
  falseReject: boolean;
  falseAccept: boolean;
  policyFalseReject: boolean;
  policyFalseAccept: boolean;
  preGateFalseReject: boolean;
  preGateFalseAccept: boolean;
  postGateFalseReject: boolean;
  postGateFalseAccept: boolean;
  exactSetMatch: boolean;
  partialSetMatch: boolean;
  perNoteRows: ValidatorRow[];
  averagePerNoteRuntimeMs: number | null;
  averageOctaveConfusionRatio: number | null;
};

export type WindowCategoryMetrics = {
  windows: number;
  expectedNoteCountTotal: number;
  validatedNoteCountTotal: number;
  expectedNoteRecall: number | null;
  expectedNotePrecision: number | null;
  noteValidationRatio: number | null;
  legacyAcceptRate: number | null;
  policyAcceptRate: number | null;
  preGateAcceptRate: number | null;
  postGateAcceptRate: number | null;
  strictAcceptRate: number | null;
  averageExtraNoteCount: number | null;
};

export type NegativeTypeMetrics = {
  windows: number;
  falseAcceptCount: number;
  falseAcceptRate: number | null;
  preGateFalseAcceptCount: number;
  preGateFalseAcceptRate: number | null;
  postGateFalseAcceptCount: number;
  postGateFalseAcceptRate: number | null;
  averageDetectedNoteCount: number | null;
  averageExtraNoteCount: number | null;
};

export type NoteSetMetrics = {
  windows: number;
  positiveWindows: number;
  negativeWindows: number;
  stableWindows: number;
  transitionWindows: number;
  emptyWindows: number;
  singleNoteWindows: number;
  polyWindows: number;
  expectedNoteCountTotal: number;
  validatedNoteCountTotal: number;
  missingExpectedNoteCountTotal: number;
  extraDetectedNoteCountTotal: number;
  noteValidationRatio: number;
  noteLevelPrecision: number | null;
  noteLevelRecall: number | null;
  noteLevelF1: number | null;
  expectedNotePrecision: number | null;
  expectedNoteRecall: number | null;
  extraNoteRate: number | null;
  windowAcceptRate: number | null;
  falseAcceptRate: number | null;
  falseRejectRate: number | null;
  falseAcceptCount: number;
  falseRejectCount: number;
  policyAcceptRate: number | null;
  strictAcceptRate: number | null;
  policyFalseAcceptRate: number | null;
  policyFalseRejectRate: number | null;
  policyFalseAcceptCount: number;
  policyFalseRejectCount: number;
  preGateAcceptRate: number | null;
  preGateFalseAcceptRate: number | null;
  preGateFalseRejectRate: number | null;
  preGateFalseAcceptCount: number;
  preGateFalseRejectCount: number;
  postGateAcceptRate: number | null;
  postGateFalseAcceptRate: number | null;
  postGateFalseRejectRate: number | null;
  postGateFalseAcceptCount: number;
  postGateFalseRejectCount: number;
  gateSuppressedCount: number;
  gateSuppressedRate: number | null;
  gateSuppressedByHysteresisCount: number;
  emptyWindowFalseAcceptRate: number | null;
  emptyWindowFalseAcceptCount: number;
  preGateEmptyWindowFalseAcceptRate: number | null;
  preGateEmptyWindowFalseAcceptCount: number;
  postGateEmptyWindowFalseAcceptRate: number | null;
  postGateEmptyWindowFalseAcceptCount: number;
  transitionWindowAcceptRate: number | null;
  preGateTransitionWindowAcceptRate: number | null;
  postGateTransitionWindowAcceptRate: number | null;
  stableWindowAcceptRate: number | null;
  preGateStableWindowAcceptRate: number | null;
  postGateStableWindowAcceptRate: number | null;
  stableWindowCoverageRate: number | null;
  preGateStableWindowCoverageRate: number | null;
  postGateStableWindowCoverageRate: number | null;
  exactSetMatchRate: number | null;
  partialSetMatchRate: number | null;
  supersetRate: number | null;
  subsetRate: number | null;
  disjointSetRate: number | null;
  partialOverlapRate: number | null;
  averageValidatedRatio: number | null;
  averageExpectedNoteCount: number | null;
  averageValidatedNoteCount: number | null;
  averageExtraNoteCount: number | null;
  averageDetectedNoteCount: number | null;
  averagePerNoteRuntimeMs: number | null;
  averageOctaveConfusionRatio: number | null;
  categoryMetrics: Record<WindowCategory, WindowCategoryMetrics>;
  negativeTypeMetrics: Record<Exclude<WindowNegativeType, 'none'>, NegativeTypeMetrics>;
  stableNonEmptyWindows: number;
  stableNonEmptyExpectedNoteRecall: number | null;
  preGateStableNonEmptyExpectedNoteRecall: number | null;
  postGateStableNonEmptyExpectedNoteRecall: number | null;
  stableNonEmptyExactSetMatchRate: number | null;
  preGateStableNonEmptyExactSetMatchRate: number | null;
  postGateStableNonEmptyExactSetMatchRate: number | null;
  stableNonEmptySupersetRate: number | null;
  preGateStableNonEmptySupersetRate: number | null;
  postGateStableNonEmptySupersetRate: number | null;
  preGateStableNonEmptySupersetAcceptRate: number | null;
  postGateStableNonEmptySupersetAcceptRate: number | null;
  stableNonEmptySubsetRate: number | null;
  preGateExpectedNoteRecall: number | null;
  postGateExpectedNoteRecall: number | null;
  preGateExpectedNotePrecision: number | null;
  postGateExpectedNotePrecision: number | null;
  preGateExactSetRate: number | null;
  postGateExactSetRate: number | null;
  preGateSupersetRate: number | null;
  postGateSupersetRate: number | null;
  preGateExtraNoteRate: number | null;
  postGateExtraNoteRate: number | null;
  transitionWindowsWithExpectedNotes: number;
};

export type PolyphonicEvaluationResult = {
  windowResults: NoteSetWindowResult[];
  aggregates: Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>;
};

const EPS = 1e-9;
const WAV_FILE_PATTERN = /_mic\.wav$/i;
const SOLO_PATTERN = /_solo(?:_mic)?\.wav$/i;
const COMP_PATTERN = /_comp(?:_mic)?\.wav$/i;

function toRuntimeNoteDecision(row: ValidatorRow, semitoneTolerance: number): RuntimeNoteDecision {
  const evidence: RuntimeValidatorNoteEvidence = {
    noteMidi: row.expectedMidi,
    noteDecisionConfigId: row.noteDecisionConfigId,
    targetSemitoneTolerance: semitoneTolerance,
    expectedTargetScore: row.expectedTargetScore,
    nearbyCompetitorScore: row.nearbyCompetitorScore,
    rawDetectionMaxConfidence: row.rawDetectionMaxConfidence,
    rawDetectionFrameRatio: row.rawDetectionFrameRatio,
    matchedMidi: row.acceptedNote ? row.expectedMidi : null,
    matchedSemitoneDistance: row.acceptedNote ? 0 : null,
    supportFrames: row.supportFrames,
    supportSeconds: row.supportSeconds,
    minValidatedSupportFrames: row.minValidatedSupportFrames,
    minValidatedSupportSeconds: row.minValidatedSupportSeconds,
    positionSupportFrames: row.positionSupportFrames,
    positionMinValidatedSupportFrames: row.positionMinValidatedSupportFrames,
    legacySupportFrames: row.legacySupportFrames,
    legacyMinValidatedSupportFrames: row.legacyMinValidatedSupportFrames,
    minConsecutiveExpectedFrames: row.minConsecutiveExpectedFrames,
    minConsecutivePositionFrames: row.minConsecutivePositionFrames,
    pairwiseCompetitorOutcomes: row.pairwiseCompetitorOutcomes,
    acceptedNote: row.acceptedNote,
    topKPresence: row.topKPresence,
    evidenceAvailability: row.evidenceAvailability,
    evidenceLimitations: row.evidenceLimitations,
    expectedVsBestMargin: row.expectedVsBestMargin,
    expectedVsBestRatio: row.expectedVsBestRatio,
    expectedVsOctaveMargin: row.expectedVsOctaveMargin,
    expectedPairwiseWinRate: row.expectedPairwiseWinRate,
    expectedTop1FrameRatio: row.expectedTop1FrameRatio,
    expectedTop3FrameRatio: row.expectedTop3FrameRatio,
    octaveConfusionFrameRatio: row.octaveConfusionFrameRatio,
    expectedVsSourceFrameRatio: row.expectedVsSourceFrameRatio,
    targetConfirmationFrameRatio: row.targetConfirmationFrameRatio,
    positionAmbiguousFrameRatio: row.positionAmbiguousFrameRatio,
    samePitchAltDetectedFrameCount: row.samePitchAltDetectedFrameCount,
    samePitchAltCandidateExists: row.samePitchAltCandidateExists,
    confidenceScore: row.confidenceScore,
    expectedSupportSeconds: row.expectedSupportSeconds,
    positionFrameRatio: row.positionFrameRatio,
    expectedCentsErrorMedian: row.expectedCentsErrorMedian,
    expectedScoreMedian: row.expectedScoreMedian,
    bestCompetitorScoreMedian: row.bestCompetitorScoreMedian,
    bestCompetitorMidiMode: row.bestCompetitorMidiMode,
    bestOctaveCompetitorScoreMedian: row.bestOctaveCompetitorScoreMedian,
    expectedVsBestMarginMedian: row.expectedVsBestMarginMedian,
    expectedVsBestRatioMedian: row.expectedVsBestRatioMedian,
    expectedVsOctaveMarginMedian: row.expectedVsOctaveMarginMedian,
    expectedRankMedian: row.expectedRankMedian,
    expectedPairwiseWinRateMean: row.expectedPairwiseWinRateMean
  };

  return {
    midi: row.expectedMidi,
    accepted: row.decisionAccept,
    decisionReason: row.decisionReason,
    evidence
  };
}

export const DEFAULT_NOTE_SET_POLICY: NoteSetAggregationPolicy = {
  id: 'note_set_min_ratio_v1',
  mode: 'min_ratio_required',
  minNoteRatio: 0.67,
  minNoteCount: 1,
  maxExtraDetectedNotes: null,
  extraNotePenaltyWeight: 0,
  allowSupersetIfExpectedCovered: true,
  emptyWindowMustBeQuiet: true
};

export const MONO_NOTE_SET_POLICY: NoteSetAggregationPolicy = {
  ...DEFAULT_NOTE_SET_POLICY,
  id: 'mono_note_set_cardinality_1_v1',
  mode: 'all_notes_required',
  minNoteRatio: 1,
  minNoteCount: 1,
  maxExtraDetectedNotes: 0,
  allowSupersetIfExpectedCovered: false,
  emptyWindowMustBeQuiet: true
};

export const DEFAULT_ACTIVATION_GATE_POLICY: ActivationGatePolicy = {
  id: 'post_validator_activation_gate_v1',
  gateEnabled: true,
  emptyWindowMustBeQuiet: true,
  emptyWindowMaxValidatedNotes: 0,
  emptyWindowMaxExtraNotes: 0,
  emptyWindowMaxConfidence: 0.45,
  transitionMinStableRatio: 0.86,
  transitionMaxOverlapRatio: 0.22,
  transitionMinNoteRatio: 0.8,
  transitionAllowSuperset: false,
  stableAllowSupersetIfExpectedCovered: true,
  minExpectedNoteRatioForActivation: 0.6,
  requireExactOnTransition: false,
  minConsecutiveExpectedSupportFrames: 1,
  hysteresisFrames: 1
};

export const MONO_ACTIVATION_GATE_POLICY: ActivationGatePolicy = {
  ...DEFAULT_ACTIVATION_GATE_POLICY,
  id: 'mono_activation_gate_off_v1',
  gateEnabled: false
};

export function buildValidationStackDescriptor(input: ValidationStackDescriptor): ValidationStackDescriptor {
  return {
    noteDecisionConfigId: input.noteDecisionConfigId.trim(),
    aggregationPolicyId: input.aggregationPolicyId.trim(),
    activationGatePolicyId: input.activationGatePolicyId.trim(),
    aggregationMode: input.aggregationMode,
    noteSetCardinality: Math.max(0, Math.round(input.noteSetCardinality))
  };
}

export const DEFAULT_WINDOW_STABILITY_CONFIG: WindowStabilityConfig = {
  stableWindowMinRatio: 0.85,
  transitionOverlapThreshold: 0.15
};

export async function discoverWavJamsPairs(datasetDir: string): Promise<WavJamsPair[]> {
  const entries = await fs.readdir(datasetDir);
  const out: WavJamsPair[] = [];
  for (const entry of entries) {
    if (!WAV_FILE_PATTERN.test(entry)) continue;
    const base = entry.replace(/_mic\.wav$/i, '');
    const jamsName = `${base}.jams`;
    if (!entries.includes(jamsName)) continue;
    const wavPath = path.join(datasetDir, entry);
    const jamsPath = path.join(datasetDir, jamsName);
    out.push({
      fileId: base,
      subset: parseDatasetSubsetFromFileName(entry),
      wavPath,
      jamsPath,
      wavRelativePath: path.relative(process.cwd(), wavPath).replace(/\\/g, '/'),
      jamsRelativePath: path.relative(process.cwd(), jamsPath).replace(/\\/g, '/')
    });
  }
  out.sort((left, right) => left.fileId.localeCompare(right.fileId));
  return out;
}

export function parseDatasetSubsetFromFileName(fileName: string): DatasetSubset {
  if (SOLO_PATTERN.test(fileName)) return 'solo';
  if (COMP_PATTERN.test(fileName)) return 'comp';
  return 'unknown';
}

export async function parseJamsNoteEventsFromFile(filePath: string): Promise<{ events: JamsNoteEvent[]; audit: JamsParseAudit }> {
  const raw = await fs.readFile(filePath, 'utf8');
  return parseJamsNoteEvents(raw, filePath);
}

export function parseJamsNoteEvents(raw: string, filePath = '<memory>'): { events: JamsNoteEvent[]; audit: JamsParseAudit } {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const annotations = Array.isArray(root.annotations) ? root.annotations : null;
  if (!annotations) {
    throw new Error(`JAMS ${filePath} missing annotations array`);
  }

  const namespaceCounts = new Map<string, number>();
  const sourceTracks = new Set<string>();
  const events: JamsNoteEvent[] = [];
  let droppedObservationCount = 0;

  for (let annotationIndex = 0; annotationIndex < annotations.length; annotationIndex += 1) {
    const annotation = asRecord(annotations[annotationIndex]);
    const namespace = asString(annotation.namespace) ?? 'unknown';
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
    if (namespace !== 'note_midi') continue;

    const annotationMetadata = asRecord(annotation.annotation_metadata);
    const sourceTrack = asString(annotationMetadata.data_source) ?? asFiniteString(annotationMetadata.data_source);
    if (sourceTrack) sourceTracks.add(sourceTrack);

    const observations = Array.isArray(annotation.data) ? annotation.data : null;
    if (!observations) continue;

    for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
      const observation = asRecord(observations[observationIndex]);
      const startSec = Math.max(0, asFiniteNumber(observation.time) ?? 0);
      const durationSec = Math.max(0, asFiniteNumber(observation.duration) ?? 0);
      const midiValue = extractMidiValue(observation.value);
      if (midiValue === null || durationSec <= 0) {
        droppedObservationCount += 1;
        continue;
      }
      const endSec = Math.max(startSec, startSec + durationSec);
      events.push({
        startSec,
        endSec,
        midi: Math.round(midiValue),
        sourceTrack: sourceTrack ?? null,
        annotationIndex,
        observationIndex
      });
    }
  }

  if (events.length <= 0) {
    throw new Error(`JAMS ${filePath} has no note_midi events`);
  }

  events.sort((left, right) => (
    left.startSec - right.startSec ||
    left.endSec - right.endSec ||
    left.midi - right.midi ||
    (left.sourceTrack ?? '').localeCompare(right.sourceTrack ?? '')
  ));

  const deduped: JamsNoteEvent[] = [];
  const dedupeKeys = new Set<string>();
  for (const event of events) {
    const key = [
      event.startSec.toFixed(6),
      event.endSec.toFixed(6),
      event.midi,
      event.sourceTrack ?? ''
    ].join('|');
    if (dedupeKeys.has(key)) continue;
    dedupeKeys.add(key);
    deduped.push(event);
  }

  const fileDurationSec = asFiniteNumber(asRecord(root.file_metadata).duration);
  const audit: JamsParseAudit = {
    filePath,
    selectedNamespace: 'note_midi',
    annotationCount: annotations.length,
    namespaceCounts: Object.fromEntries([...namespaceCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    noteEventCount: deduped.length,
    sourceTrackCount: sourceTracks.size,
    droppedObservationCount,
    fileDurationSec
  };

  return { events: deduped, audit };
}

export function buildExpectedNoteWindows(input: {
  events: JamsNoteEvent[];
  fileId: string;
  wavRelativePath: string;
  subset: DatasetSubset;
  durationSec: number;
  windowDurationSec: number;
  windowHopSec: number;
  minEventOverlapSec: number;
  includeSilentWindows: boolean;
  maxWindowsPerFile: number | null;
  stableWindowMinRatio?: number;
  transitionOverlapThreshold?: number;
}): ExpectedNoteWindow[] {
  const durationSec = input.durationSec > 0
    ? input.durationSec
    : Math.max(...input.events.map((event) => event.endSec), 0);
  const windowDurationSec = Math.max(0.05, input.windowDurationSec);
  const windowHopSec = Math.max(0.01, input.windowHopSec);
  const minEventOverlapSec = Math.max(0, input.minEventOverlapSec);
  const stabilityConfig = normalizeWindowStabilityConfig({
    stableWindowMinRatio: input.stableWindowMinRatio ?? DEFAULT_WINDOW_STABILITY_CONFIG.stableWindowMinRatio,
    transitionOverlapThreshold: input.transitionOverlapThreshold ?? DEFAULT_WINDOW_STABILITY_CONFIG.transitionOverlapThreshold
  });

  const rawWindows: ExpectedNoteWindow[] = [];
  for (let startSec = 0, windowIndex = 0; startSec < durationSec + EPS; startSec += windowHopSec, windowIndex += 1) {
    const endSec = Math.min(durationSec, startSec + windowDurationSec);
    if (endSec <= startSec + EPS) continue;
    const overlappingEvents = input.events.filter((event) => overlapSec(event.startSec, event.endSec, startSec, endSec) > EPS);

    const expectedMidis = uniqueSorted(
      overlappingEvents
        .filter((event) => overlapSec(event.startSec, event.endSec, startSec, endSec) >= minEventOverlapSec)
        .map((event) => event.midi)
    );

    if (!input.includeSilentWindows && expectedMidis.length <= 0) continue;
    const expectedTimeline = analyzeWindowExpectedSets(overlappingEvents, startSec, endSec);
    const categoryNoteCount = expectedTimeline.expectedDominantMidis.length > 0
      ? expectedTimeline.expectedDominantMidis.length
      : expectedMidis.length;
    const baseWindowCategory: WindowBaseCategory = expectedMidis.length <= 0
      ? 'empty_window'
      : categoryNoteCount <= 1
        ? 'single_note_window'
        : 'poly_window';

    const transitionWindow = expectedMidis.length > 0 && (
      expectedTimeline.transitionOverlapRatio >= stabilityConfig.transitionOverlapThreshold ||
      expectedTimeline.stableSetRatio < stabilityConfig.stableWindowMinRatio
    );
    const windowCategory: WindowCategory = transitionWindow ? 'transition_window' : baseWindowCategory;
    const isStableWindow = windowCategory === 'single_note_window' || windowCategory === 'poly_window';

    rawWindows.push({
      windowId: `${input.fileId}__w${String(windowIndex).padStart(4, '0')}`,
      fileId: input.fileId,
      wavRelativePath: input.wavRelativePath,
      subset: input.subset,
      startSec,
      endSec,
      expectedMidis,
      expectedDominantMidis: expectedTimeline.expectedDominantMidis,
      expectedSegmentCount: expectedTimeline.segmentCount,
      expectedActiveRatio: expectedTimeline.expectedActiveRatio,
      stableSetRatio: expectedTimeline.stableSetRatio,
      transitionOverlapRatio: expectedTimeline.transitionOverlapRatio,
      noteSetChangeCount: expectedTimeline.noteSetChangeCount,
      baseWindowCategory,
      windowCategory,
      isStableWindow
    });
  }

  if (rawWindows.length <= 0) {
    return [];
  }

  const maxWindows = input.maxWindowsPerFile;
  if (maxWindows === null || maxWindows <= 0 || rawWindows.length <= maxWindows) {
    return rawWindows;
  }

  const selectedIndexes = sampleEvenlyIndexes(rawWindows.length, maxWindows);
  return selectedIndexes.map((index, sampledIndex) => {
    const row = rawWindows[index];
    return {
      ...row,
      windowId: `${input.fileId}__w${String(sampledIndex).padStart(4, '0')}`
    };
  });
}

export function parseWindowStabilityConfigFromEnv(
  fallback: WindowStabilityConfig = DEFAULT_WINDOW_STABILITY_CONFIG
): WindowStabilityConfig {
  const stableWindowMinRatio = parseEnvNumber(
    process.env.GAMEPLAY_VALIDATOR_POLY_STABLE_WINDOW_MIN_RATIO,
    fallback.stableWindowMinRatio
  );
  const transitionOverlapThreshold = parseEnvNumber(
    process.env.GAMEPLAY_VALIDATOR_POLY_TRANSITION_OVERLAP_THRESHOLD,
    fallback.transitionOverlapThreshold
  );
  return normalizeWindowStabilityConfig({ stableWindowMinRatio, transitionOverlapThreshold });
}

export function parseNoteSetAggregationPolicyFromEnv(
  basePolicy: NoteSetAggregationPolicy = DEFAULT_NOTE_SET_POLICY
): NoteSetAggregationPolicy {
  const rawMode = process.env.GAMEPLAY_VALIDATOR_NOTE_SET_MODE;
  const mode: NoteSetAggregationMode | null =
    rawMode === 'all_notes_required' || rawMode === 'min_ratio_required' || rawMode === 'min_count_required'
      ? rawMode
      : null;

  const jsonOverrideRaw = process.env.GAMEPLAY_VALIDATOR_NOTE_SET_POLICY_JSON;
  const fromJson = jsonOverrideRaw ? safeParsePolicyJson(jsonOverrideRaw, basePolicy) : basePolicy;

  const allowSuperset = parseEnvBoolean(
    process.env.GAMEPLAY_VALIDATOR_NOTE_SET_ALLOW_SUPERSET_IF_EXPECTED_COVERED,
    fromJson.allowSupersetIfExpectedCovered
  );
  const emptyMustBeQuiet = parseEnvBoolean(
    process.env.GAMEPLAY_VALIDATOR_NOTE_SET_EMPTY_WINDOW_MUST_BE_QUIET,
    fromJson.emptyWindowMustBeQuiet
  );

  const withEnvFlags: NoteSetAggregationPolicy = {
    ...fromJson,
    allowSupersetIfExpectedCovered: allowSuperset,
    emptyWindowMustBeQuiet: emptyMustBeQuiet
  };

  if (!mode) return withEnvFlags;
  return { ...withEnvFlags, mode, id: `${withEnvFlags.id}__${mode}` };
}

export function parseActivationGatePolicyFromEnv(
  basePolicy: ActivationGatePolicy = DEFAULT_ACTIVATION_GATE_POLICY
): ActivationGatePolicy {
  const jsonOverrideRaw = process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_POLICY_JSON;
  const fromJson = jsonOverrideRaw
    ? safeParseActivationGatePolicyJson(jsonOverrideRaw, basePolicy)
    : basePolicy;

  const withEnv: ActivationGatePolicy = {
    ...fromJson,
    gateEnabled: parseEnvBoolean(process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_ENABLED, fromJson.gateEnabled),
    emptyWindowMustBeQuiet: parseEnvBoolean(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_EMPTY_WINDOW_MUST_BE_QUIET,
      fromJson.emptyWindowMustBeQuiet
    ),
    emptyWindowMaxValidatedNotes: parseEnvInteger(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_EMPTY_WINDOW_MAX_VALIDATED_NOTES,
      fromJson.emptyWindowMaxValidatedNotes,
      0
    ),
    emptyWindowMaxExtraNotes: parseEnvInteger(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_EMPTY_WINDOW_MAX_EXTRA_NOTES,
      fromJson.emptyWindowMaxExtraNotes,
      0
    ),
    emptyWindowMaxConfidence: parseEnvNullableNumber(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_EMPTY_WINDOW_MAX_CONFIDENCE,
      fromJson.emptyWindowMaxConfidence
    ),
    transitionMinStableRatio: parseEnvNumber(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_TRANSITION_MIN_STABLE_RATIO,
      fromJson.transitionMinStableRatio
    ),
    transitionMaxOverlapRatio: parseEnvNumber(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_TRANSITION_MAX_OVERLAP_RATIO,
      fromJson.transitionMaxOverlapRatio
    ),
    transitionMinNoteRatio: parseEnvNumber(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_TRANSITION_MIN_NOTE_RATIO,
      fromJson.transitionMinNoteRatio
    ),
    transitionAllowSuperset: parseEnvBoolean(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_TRANSITION_ALLOW_SUPERSET,
      fromJson.transitionAllowSuperset
    ),
    stableAllowSupersetIfExpectedCovered: parseEnvBoolean(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_STABLE_ALLOW_SUPERSET_IF_EXPECTED_COVERED,
      fromJson.stableAllowSupersetIfExpectedCovered
    ),
    minExpectedNoteRatioForActivation: parseEnvNumber(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_MIN_EXPECTED_NOTE_RATIO_FOR_ACTIVATION,
      fromJson.minExpectedNoteRatioForActivation
    ),
    requireExactOnTransition: parseEnvBoolean(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_REQUIRE_EXACT_ON_TRANSITION,
      fromJson.requireExactOnTransition
    ),
    minConsecutiveExpectedSupportFrames: parseEnvInteger(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_MIN_CONSECUTIVE_EXPECTED_SUPPORT_FRAMES,
      fromJson.minConsecutiveExpectedSupportFrames,
      1
    ),
    hysteresisFrames: parseEnvInteger(
      process.env.GAMEPLAY_VALIDATOR_ACTIVATION_GATE_HYSTERESIS_FRAMES,
      fromJson.hysteresisFrames,
      1
    )
  };

  return normalizeActivationGatePolicy(withEnv);
}

export function evaluateNoteSetWindow(input: {
  algorithm: AlgorithmName;
  noteDecisionConfigId?: string;
  windowId: string;
  fileId: string;
  wavRelativePath: string;
  subset: DatasetSubset;
  startSec: number;
  endSec: number;
  expectedMidis: number[];
  expectedDominantMidis?: number[];
  expectedSegmentCount?: number;
  expectedActiveRatio?: number;
  stableSetRatio?: number;
  transitionOverlapRatio?: number;
  noteSetChangeCount?: number;
  baseWindowCategory?: WindowBaseCategory;
  windowCategory?: WindowCategory;
  isStableWindow?: boolean;
  rawDetectedMidis: number[];
  rawDetectionMaxConfidence?: number | null;
  rawDetectionFrameRatio?: number | null;
  perNoteRows: ValidatorRow[];
  policy: NoteSetAggregationPolicy;
  activationGatePolicy?: ActivationGatePolicy;
}): NoteSetWindowResult {
  const expectedMidis = uniqueSorted(input.expectedMidis.map((value) => Math.round(value)));
  const expectedDominantMidis = uniqueSorted((input.expectedDominantMidis ?? expectedMidis).map((value) => Math.round(value)));
  const validatedExpectedNotes = uniqueSorted(
    input.perNoteRows
      .filter((row) => row.decisionAccept)
      .map((row) => Math.round(row.expectedMidi))
      .filter((midi) => expectedMidis.includes(midi))
  );
  const rawDetectedMidis = uniqueSorted(input.rawDetectedMidis.map((value) => Math.round(value)));

  const expectedSet = new Set<number>(expectedMidis);
  const validatedSet = new Set<number>(validatedExpectedNotes);
  const rawDetectedSet = new Set<number>(rawDetectedMidis);

  const missingExpectedNotes = expectedMidis.filter((midi) => !validatedSet.has(midi));
  const extraDetectedNotes = rawDetectedMidis.filter((midi) => !expectedSet.has(midi));

  const expectedNoteCount = expectedMidis.length;
  const validatedNoteCount = validatedExpectedNotes.length;
  const noteValidationRatio = expectedNoteCount > 0 ? validatedNoteCount / expectedNoteCount : 1;
  const activationDetected = rawDetectedSet.size > 0;
  const rawDetectionMaxConfidence = finiteOrNull(input.rawDetectionMaxConfidence ?? null);
  const rawDetectionFrameRatio = finiteOrNull(input.rawDetectionFrameRatio ?? null);

  const validatedSupportFrames = input.perNoteRows
    .filter((row) => row.decisionAccept && expectedSet.has(Math.round(row.expectedMidi)))
    .map((row) => Math.max(0, Math.round(row.hitFrameCountExpected)));
  const minValidatedSupportFrames = validatedSupportFrames.length > 0
    ? Math.min(...validatedSupportFrames)
    : 0;

  const inferredBaseWindowCategory: WindowBaseCategory = expectedNoteCount <= 0
    ? 'empty_window'
    : expectedDominantMidis.length <= 1
      ? 'single_note_window'
      : 'poly_window';
  const baseWindowCategory = input.baseWindowCategory ?? inferredBaseWindowCategory;
  const windowCategory = input.windowCategory ?? baseWindowCategory;
  const isStableWindow = input.isStableWindow ?? (windowCategory === 'single_note_window' || windowCategory === 'poly_window');
  const expectedSegmentCount = Math.max(1, Math.round(input.expectedSegmentCount ?? 1));
  const expectedActiveRatio = clamp(
    input.expectedActiveRatio ?? (expectedNoteCount > 0 ? 1 : 0),
    0,
    1
  );
  const aggregationMode: UnifiedAggregationMode = expectedNoteCount > 1 ? 'poly_aggregation_mode' : 'mono_aggregation_mode';
  const stableSetRatio = clamp(input.stableSetRatio ?? 1, 0, 1);
  const transitionOverlapRatio = clamp(input.transitionOverlapRatio ?? (1 - stableSetRatio), 0, 1);
  const noteSetChangeCount = Math.max(0, Math.round(input.noteSetChangeCount ?? 0));

  const expectedWindowActive = expectedNoteCount > 0;
  const expectedCovered = expectedWindowActive && missingExpectedNotes.length === 0;
  const exactSetMatch = expectedWindowActive &&
    validatedExpectedNotes.length === expectedMidis.length &&
    missingExpectedNotes.length === 0 &&
    extraDetectedNotes.length === 0;
  const partialSetMatch = expectedWindowActive && validatedNoteCount > 0 && validatedNoteCount < expectedNoteCount;
  const supersetMatch = expectedWindowActive && expectedCovered && extraDetectedNotes.length > 0;
  const subsetMatch = expectedWindowActive && missingExpectedNotes.length > 0 && extraDetectedNotes.length === 0;
  const disjointSetMatch = expectedWindowActive && missingExpectedNotes.length > 0 && extraDetectedNotes.length > 0 && validatedNoteCount <= 0;

  let setRelation: WindowSetRelation = 'empty_match';
  if (!expectedWindowActive) {
    setRelation = activationDetected ? 'empty_false_activation' : 'empty_match';
  } else if (exactSetMatch) {
    setRelation = 'exact';
  } else if (supersetMatch) {
    setRelation = 'superset';
  } else if (subsetMatch) {
    setRelation = 'subset';
  } else if (disjointSetMatch) {
    setRelation = 'disjoint';
  } else {
    setRelation = 'partial_overlap';
  }

  const activationGatePolicy = normalizeActivationGatePolicy(input.activationGatePolicy ?? DEFAULT_ACTIVATION_GATE_POLICY);
  const semitoneTolerance = resolveBenchmarkSemitoneTolerance();
  const runtimeDecision = evaluateRuntimeTargetDecision({
    target: {
      mode: expectedNoteCount <= 1 ? 'mono' : 'poly',
      midiNotes: expectedMidis,
      semitoneTolerance,
      minNoteRatio: input.policy.mode === 'min_ratio_required' ? input.policy.minNoteRatio : undefined,
      allowSuperset: input.policy.allowSupersetIfExpectedCovered
    },
    noteDecisions: input.perNoteRows.map((row) => toRuntimeNoteDecision(row, semitoneTolerance)),
    rawDetectedMidis,
    rawDetectionMaxConfidence,
    rawDetectionFrameRatio,
    noteSetPolicy: input.policy,
    activationGatePolicy,
    windowCategory,
    isStableWindow,
    setRelation,
    stableSetRatio,
    transitionOverlapRatio
  });

  const legacyAccept = runtimeDecision.acceptedPreGate;
  const falseReject = expectedWindowActive && !legacyAccept;
  const falseAccept = !expectedWindowActive && legacyAccept;

  const policyAccept = legacyAccept;

  const preGateAccept = runtimeDecision.acceptedPreGate;
  const gateDecision = {
    accept: runtimeDecision.acceptedPostGate,
    rejectReason: runtimeDecision.gateRejectReason
  } as const;

  const strictAccept = expectedWindowActive ? exactSetMatch : !activationDetected;
  const policyFalseReject = expectedWindowActive && !policyAccept;
  const policyFalseAccept = !expectedWindowActive && activationDetected;
  const preGateFalseReject = expectedWindowActive && !preGateAccept;
  const preGateFalseAccept = !expectedWindowActive && preGateAccept;
  const postGateFalseReject = expectedWindowActive && !gateDecision.accept;
  const postGateFalseAccept = !expectedWindowActive && gateDecision.accept;

  let negativeType: WindowNegativeType = 'none';
  if (windowCategory === 'empty_window') {
    negativeType = 'empty_negative';
  } else if (windowCategory === 'transition_window') {
    negativeType = 'transition_ambiguous_negative';
  } else if (expectedWindowActive && setRelation !== 'exact') {
    negativeType = 'set_mismatch_negative';
  }

  const runtimeValues = input.perNoteRows
    .map((row) => row.runtimeAvgMs)
    .filter((value) => Number.isFinite(value));
  const octaveValues = input.perNoteRows
    .map((row) => row.octaveConfusionFrameRatio)
    .filter((value) => Number.isFinite(value));

  return {
    algorithm: input.algorithm,
    noteDecisionConfigId: input.noteDecisionConfigId ?? input.perNoteRows[0]?.noteDecisionConfigId ?? 'unknown_note_decision_config',
    aggregationPolicyId: input.policy.id,
    activationGatePolicyId: activationGatePolicy.id,
    aggregationMode,
    noteSetCardinality: expectedNoteCount,
    windowId: input.windowId,
    fileId: input.fileId,
    wavRelativePath: input.wavRelativePath,
    subset: input.subset,
    startSec: input.startSec,
    endSec: input.endSec,
    expectedMidis,
    expectedDominantMidis,
    expectedSegmentCount,
    expectedActiveRatio,
    stableSetRatio,
    transitionOverlapRatio,
    noteSetChangeCount,
    baseWindowCategory,
    windowCategory,
    isStableWindow,
    setRelation,
    negativeType,
    rawDetectedMidis,
    rawDetectionMaxConfidence,
    rawDetectionFrameRatio,
    activationDetected,
    expectedNoteCount,
    validatedExpectedNotes,
    validatedNoteCount,
    noteValidationRatio,
    minValidatedSupportFrames,
    missingExpectedNotes,
    extraDetectedNotes,
    supersetMatch,
    subsetMatch,
    disjointSetMatch,
    accept: legacyAccept,
    policyAccept,
    preGateAccept,
    gateCoreAccept: gateDecision.accept,
    postGateAccept: gateDecision.accept,
    gateRejectReason: gateDecision.rejectReason,
    gateSuppressed: preGateAccept && !gateDecision.accept,
    gateSuppressedByHysteresis: false,
    strictAccept,
    expectedWindowActive,
    falseReject,
    falseAccept,
    policyFalseReject,
    policyFalseAccept,
    preGateFalseReject,
    preGateFalseAccept,
    postGateFalseReject,
    postGateFalseAccept,
    exactSetMatch,
    partialSetMatch,
    perNoteRows: input.perNoteRows,
    averagePerNoteRuntimeMs: runtimeValues.length > 0 ? average(runtimeValues) : null,
    averageOctaveConfusionRatio: octaveValues.length > 0 ? average(octaveValues) : null
  };
}

function resolveBenchmarkSemitoneTolerance(): number {
  const difficulty = process.env.GH_VALIDATION_DIFFICULTY;
  if (difficulty === 'Easy' || difficulty === 'Medium' || difficulty === 'Hard') {
    return resolveDifficultySemitoneTolerance(difficulty);
  }

  const envTolerance = Number(process.env.GH_VALIDATION_SEMITONE_TOLERANCE);
  if (Number.isFinite(envTolerance)) {
    return Math.max(0, envTolerance);
  }

  return resolveDifficultySemitoneTolerance('Medium');
}

export function aggregateNoteSetWindowResults(results: NoteSetWindowResult[]): NoteSetMetrics {
  const positives = results.filter((result) => result.expectedWindowActive);
  const negatives = results.filter((result) => !result.expectedWindowActive);
  const stableRows = results.filter((row) => row.isStableWindow);
  const stableNonEmptyRows = stableRows.filter((row) => row.expectedWindowActive);
  const transitionRows = results.filter((row) => row.windowCategory === 'transition_window');
  const emptyRows = results.filter((row) => row.windowCategory === 'empty_window');
  const singleRows = results.filter((row) => row.windowCategory === 'single_note_window');
  const polyRows = results.filter((row) => row.windowCategory === 'poly_window');
  const setMismatchRows = results.filter((row) => row.negativeType === 'set_mismatch_negative');
  const transitionNegativeRows = results.filter((row) => row.negativeType === 'transition_ambiguous_negative');

  const expectedNoteCountTotal = positives.reduce((sum, row) => sum + row.expectedNoteCount, 0);
  const validatedNoteCountTotal = positives.reduce((sum, row) => sum + row.validatedNoteCount, 0);
  const missingExpectedNoteCountTotal = positives.reduce((sum, row) => sum + row.missingExpectedNotes.length, 0);
  const extraDetectedNoteCountTotal = results.reduce((sum, row) => sum + row.extraDetectedNotes.length, 0);

  const noteLevelPrecision = validatedNoteCountTotal + extraDetectedNoteCountTotal > 0
    ? validatedNoteCountTotal / (validatedNoteCountTotal + extraDetectedNoteCountTotal)
    : null;
  const noteLevelRecall = expectedNoteCountTotal > 0
    ? validatedNoteCountTotal / expectedNoteCountTotal
    : null;
  const noteLevelF1 = (
    noteLevelPrecision !== null &&
    noteLevelRecall !== null &&
    noteLevelPrecision + noteLevelRecall > 0
  )
    ? (2 * noteLevelPrecision * noteLevelRecall) / (noteLevelPrecision + noteLevelRecall)
    : null;

  const falseRejectCount = positives.filter((row) => row.falseReject).length;
  const falseAcceptCount = negatives.filter((row) => row.falseAccept).length;
  const policyFalseRejectCount = positives.filter((row) => row.policyFalseReject).length;
  const policyFalseAcceptCount = negatives.filter((row) => row.policyFalseAccept).length;
  const preGateFalseRejectCount = positives.filter((row) => row.preGateFalseReject).length;
  const preGateFalseAcceptCount = negatives.filter((row) => row.preGateFalseAccept).length;
  const postGateFalseRejectCount = positives.filter((row) => row.postGateFalseReject).length;
  const postGateFalseAcceptCount = negatives.filter((row) => row.postGateFalseAccept).length;

  const runtimeValues = results
    .map((row) => row.averagePerNoteRuntimeMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const octaveValues = results
    .map((row) => row.averageOctaveConfusionRatio)
    .filter((value): value is number => value !== null && Number.isFinite(value));


  const preGateView = buildAcceptanceViewMetrics(results, (row) => row.preGateAccept);
  const postGateView = buildAcceptanceViewMetrics(results, (row) => row.postGateAccept);

  const gateSuppressedCount = results.filter((row) => row.gateSuppressed).length;
  const gateSuppressedByHysteresisCount = results.filter((row) => row.gateSuppressedByHysteresis).length;

  return {
    windows: results.length,
    positiveWindows: positives.length,
    negativeWindows: negatives.length,
    stableWindows: stableRows.length,
    transitionWindows: transitionRows.length,
    emptyWindows: emptyRows.length,
    singleNoteWindows: singleRows.length,
    polyWindows: polyRows.length,
    expectedNoteCountTotal,
    validatedNoteCountTotal,
    missingExpectedNoteCountTotal,
    extraDetectedNoteCountTotal,
    noteValidationRatio: expectedNoteCountTotal > 0 ? validatedNoteCountTotal / expectedNoteCountTotal : 1,
    noteLevelPrecision,
    noteLevelRecall,
    noteLevelF1,
    expectedNotePrecision: postGateView.expectedNotePrecision,
    expectedNoteRecall: postGateView.expectedNoteRecall,
    extraNoteRate: postGateView.extraNoteRate,
    windowAcceptRate: positives.length > 0 ? positives.filter((row) => row.accept).length / positives.length : null,
    falseAcceptRate: negatives.length > 0 ? falseAcceptCount / negatives.length : null,
    falseRejectRate: positives.length > 0 ? falseRejectCount / positives.length : null,
    falseAcceptCount,
    falseRejectCount,
    policyAcceptRate: positives.length > 0 ? positives.filter((row) => row.policyAccept).length / positives.length : null,
    strictAcceptRate: results.length > 0 ? results.filter((row) => row.strictAccept).length / results.length : null,
    policyFalseAcceptRate: negatives.length > 0 ? policyFalseAcceptCount / negatives.length : null,
    policyFalseRejectRate: positives.length > 0 ? policyFalseRejectCount / positives.length : null,
    policyFalseAcceptCount,
    policyFalseRejectCount,
    preGateAcceptRate: positives.length > 0 ? positives.filter((row) => row.preGateAccept).length / positives.length : null,
    preGateFalseAcceptRate: negatives.length > 0 ? preGateFalseAcceptCount / negatives.length : null,
    preGateFalseRejectRate: positives.length > 0 ? preGateFalseRejectCount / positives.length : null,
    preGateFalseAcceptCount,
    preGateFalseRejectCount,
    postGateAcceptRate: positives.length > 0 ? positives.filter((row) => row.postGateAccept).length / positives.length : null,
    postGateFalseAcceptRate: negatives.length > 0 ? postGateFalseAcceptCount / negatives.length : null,
    postGateFalseRejectRate: positives.length > 0 ? postGateFalseRejectCount / positives.length : null,
    postGateFalseAcceptCount,
    postGateFalseRejectCount,
    gateSuppressedCount,
    gateSuppressedRate: results.length > 0 ? gateSuppressedCount / results.length : null,
    gateSuppressedByHysteresisCount,
    emptyWindowFalseAcceptRate: postGateView.emptyWindowFalseAcceptRate,
    emptyWindowFalseAcceptCount: postGateView.emptyWindowFalseAcceptCount,
    preGateEmptyWindowFalseAcceptRate: preGateView.emptyWindowFalseAcceptRate,
    preGateEmptyWindowFalseAcceptCount: preGateView.emptyWindowFalseAcceptCount,
    postGateEmptyWindowFalseAcceptRate: postGateView.emptyWindowFalseAcceptRate,
    postGateEmptyWindowFalseAcceptCount: postGateView.emptyWindowFalseAcceptCount,
    transitionWindowAcceptRate: postGateView.transitionWindowAcceptRate,
    preGateTransitionWindowAcceptRate: preGateView.transitionWindowAcceptRate,
    postGateTransitionWindowAcceptRate: postGateView.transitionWindowAcceptRate,
    stableWindowAcceptRate: postGateView.stableWindowAcceptRate,
    preGateStableWindowAcceptRate: preGateView.stableWindowAcceptRate,
    postGateStableWindowAcceptRate: postGateView.stableWindowAcceptRate,
    stableWindowCoverageRate: postGateView.stableWindowCoverageRate,
    preGateStableWindowCoverageRate: preGateView.stableWindowCoverageRate,
    postGateStableWindowCoverageRate: postGateView.stableWindowCoverageRate,
    exactSetMatchRate: postGateView.exactSetRate,
    partialSetMatchRate: positives.length > 0 ? positives.filter((row) => row.partialSetMatch).length / positives.length : null,
    supersetRate: postGateView.supersetRate,
    subsetRate: positives.length > 0 ? positives.filter((row) => row.subsetMatch).length / positives.length : null,
    disjointSetRate: positives.length > 0 ? positives.filter((row) => row.disjointSetMatch).length / positives.length : null,
    partialOverlapRate: positives.length > 0 ? positives.filter((row) => row.setRelation === 'partial_overlap').length / positives.length : null,
    averageValidatedRatio: positives.length > 0 ? average(positives.map((row) => row.noteValidationRatio)) : null,
    averageExpectedNoteCount: results.length > 0 ? average(results.map((row) => row.expectedNoteCount)) : null,
    averageValidatedNoteCount: results.length > 0 ? average(results.map((row) => row.validatedNoteCount)) : null,
    averageExtraNoteCount: results.length > 0 ? average(results.map((row) => row.extraDetectedNotes.length)) : null,
    averageDetectedNoteCount: results.length > 0 ? average(results.map((row) => row.rawDetectedMidis.length)) : null,
    averagePerNoteRuntimeMs: runtimeValues.length > 0 ? average(runtimeValues) : null,
    averageOctaveConfusionRatio: octaveValues.length > 0 ? average(octaveValues) : null,
    categoryMetrics: {
      empty_window: buildCategoryMetrics(emptyRows),
      single_note_window: buildCategoryMetrics(singleRows),
      poly_window: buildCategoryMetrics(polyRows),
      transition_window: buildCategoryMetrics(transitionRows)
    },
    negativeTypeMetrics: {
      empty_negative: buildNegativeTypeMetrics(
        emptyRows,
        (row) => row.preGateAccept,
        (row) => row.postGateAccept
      ),
      set_mismatch_negative: buildNegativeTypeMetrics(
        setMismatchRows,
        (row) => row.preGateAccept,
        (row) => row.postGateAccept
      ),
      transition_ambiguous_negative: buildNegativeTypeMetrics(
        transitionNegativeRows,
        (row) => row.preGateAccept,
        (row) => row.postGateAccept
      )
    },
    stableNonEmptyWindows: stableNonEmptyRows.length,
    stableNonEmptyExpectedNoteRecall: postGateView.stableNonEmptyExpectedNoteRecall,
    preGateStableNonEmptyExpectedNoteRecall: preGateView.stableNonEmptyExpectedNoteRecall,
    postGateStableNonEmptyExpectedNoteRecall: postGateView.stableNonEmptyExpectedNoteRecall,
    stableNonEmptyExactSetMatchRate: postGateView.stableNonEmptyExactSetRate,
    preGateStableNonEmptyExactSetMatchRate: preGateView.stableNonEmptyExactSetRate,
    postGateStableNonEmptyExactSetMatchRate: postGateView.stableNonEmptyExactSetRate,
    stableNonEmptySupersetRate: postGateView.stableNonEmptySupersetRate,
    preGateStableNonEmptySupersetRate: preGateView.stableNonEmptySupersetRate,
    postGateStableNonEmptySupersetRate: postGateView.stableNonEmptySupersetRate,
    preGateStableNonEmptySupersetAcceptRate: preGateView.stableNonEmptySupersetAcceptRate,
    postGateStableNonEmptySupersetAcceptRate: postGateView.stableNonEmptySupersetAcceptRate,
    stableNonEmptySubsetRate: stableNonEmptyRows.length > 0
      ? stableNonEmptyRows.filter((row) => row.subsetMatch).length / stableNonEmptyRows.length
      : null,
    preGateExpectedNoteRecall: preGateView.expectedNoteRecall,
    postGateExpectedNoteRecall: postGateView.expectedNoteRecall,
    preGateExpectedNotePrecision: preGateView.expectedNotePrecision,
    postGateExpectedNotePrecision: postGateView.expectedNotePrecision,
    preGateExactSetRate: preGateView.exactSetRate,
    postGateExactSetRate: postGateView.exactSetRate,
    preGateSupersetRate: preGateView.supersetRate,
    postGateSupersetRate: postGateView.supersetRate,
    preGateExtraNoteRate: preGateView.extraNoteRate,
    postGateExtraNoteRate: postGateView.extraNoteRate,
    transitionWindowsWithExpectedNotes: transitionRows.filter((row) => row.expectedWindowActive).length
  };
}

export function evaluatePolyphonicTelemetryForConfig(input: {
  windowTelemetry: PolyphonicWindowTelemetry[];
  decisionConfig: ValidatorDecisionConfig;
  noteSetPolicy: NoteSetAggregationPolicy;
  activationGatePolicy?: ActivationGatePolicy;
  algorithms: AlgorithmName[];
}): PolyphonicEvaluationResult {
  const activationGatePolicy = normalizeActivationGatePolicy(input.activationGatePolicy ?? DEFAULT_ACTIVATION_GATE_POLICY);

  const rawWindowResults: NoteSetWindowResult[] = input.windowTelemetry.map((window) => {
    const perNoteRows = window.perNoteTelemetry.map((telemetry) => evaluateCaseTelemetry(telemetry, input.decisionConfig));
    return evaluateNoteSetWindow({
      algorithm: window.algorithm,
      noteDecisionConfigId: input.decisionConfig.id,
      windowId: window.windowId,
      fileId: window.fileId,
      wavRelativePath: window.wavRelativePath,
      subset: window.subset,
      startSec: window.startSec,
      endSec: window.endSec,
      expectedMidis: window.expectedMidis,
      expectedDominantMidis: window.expectedDominantMidis,
      expectedSegmentCount: window.expectedSegmentCount,
      expectedActiveRatio: window.expectedActiveRatio,
      stableSetRatio: window.stableSetRatio,
      transitionOverlapRatio: window.transitionOverlapRatio,
      noteSetChangeCount: window.noteSetChangeCount,
      baseWindowCategory: window.baseWindowCategory,
      windowCategory: window.windowCategory,
      isStableWindow: window.isStableWindow,
      rawDetectedMidis: window.rawDetectedMidis,
      rawDetectionMaxConfidence: window.rawDetectionMaxConfidence,
      rawDetectionFrameRatio: window.rawDetectionFrameRatio,
      perNoteRows,
      policy: input.noteSetPolicy,
      activationGatePolicy
    });
  });

  const windowResults = applyTemporalGateHysteresis(rawWindowResults, activationGatePolicy.hysteresisFrames);

  const aggregates = Object.fromEntries(input.algorithms.map((algorithm) => {
    const algorithmRows = windowResults.filter((row) => row.algorithm === algorithm);
    const buckets: Record<DatasetBucket, NoteSetMetrics> = {
      solo: aggregateNoteSetWindowResults(algorithmRows.filter((row) => row.subset === 'solo')),
      comp: aggregateNoteSetWindowResults(algorithmRows.filter((row) => row.subset === 'comp')),
      unknown: aggregateNoteSetWindowResults(algorithmRows.filter((row) => row.subset === 'unknown')),
      combined: aggregateNoteSetWindowResults(algorithmRows)
    };
    return [algorithm, buckets];
  })) as Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>;

  return { windowResults, aggregates };
}

type AcceptanceViewMetrics = {
  expectedNoteRecall: number | null;
  expectedNotePrecision: number | null;
  exactSetRate: number | null;
  supersetRate: number | null;
  extraNoteRate: number | null;
  emptyWindowFalseAcceptRate: number | null;
  emptyWindowFalseAcceptCount: number;
  transitionWindowAcceptRate: number | null;
  stableWindowAcceptRate: number | null;
  stableWindowCoverageRate: number | null;
  stableNonEmptyExpectedNoteRecall: number | null;
  stableNonEmptyExactSetRate: number | null;
  stableNonEmptySupersetRate: number | null;
  stableNonEmptySupersetAcceptRate: number | null;
};

function buildAcceptanceViewMetrics(
  rows: NoteSetWindowResult[],
  acceptedPredicate: (row: NoteSetWindowResult) => boolean
): AcceptanceViewMetrics {
  const positives = rows.filter((row) => row.expectedWindowActive);
  const acceptedRows = rows.filter(acceptedPredicate);
  const acceptedPositives = acceptedRows.filter((row) => row.expectedWindowActive);

  const expectedNoteTotal = positives.reduce((sum, row) => sum + row.expectedNoteCount, 0);
  const acceptedValidatedTotal = acceptedPositives.reduce((sum, row) => sum + row.validatedNoteCount, 0);
  const acceptedExtraTotal = acceptedRows.reduce((sum, row) => sum + row.extraDetectedNotes.length, 0);
  const acceptedDetectedTotal = acceptedRows.reduce((sum, row) => sum + row.rawDetectedMidis.length, 0);

  const emptyRows = rows.filter((row) => row.windowCategory === 'empty_window');
  const transitionRows = rows.filter((row) => row.windowCategory === 'transition_window');
  const stableNonEmptyRows = rows.filter((row) => row.isStableWindow && row.expectedWindowActive);
  const stableSupersetRows = stableNonEmptyRows.filter((row) => row.supersetMatch);

  const stableExpectedTotal = stableNonEmptyRows.reduce((sum, row) => sum + row.expectedNoteCount, 0);
  const stableAcceptedValidatedTotal = stableNonEmptyRows
    .filter(acceptedPredicate)
    .reduce((sum, row) => sum + row.validatedNoteCount, 0);

  const emptyWindowFalseAcceptCount = emptyRows.filter(acceptedPredicate).length;

  return {
    expectedNoteRecall: expectedNoteTotal > 0 ? acceptedValidatedTotal / expectedNoteTotal : null,
    expectedNotePrecision: acceptedValidatedTotal + acceptedExtraTotal > 0
      ? acceptedValidatedTotal / (acceptedValidatedTotal + acceptedExtraTotal)
      : null,
    exactSetRate: positives.length > 0
      ? positives.filter((row) => row.exactSetMatch && acceptedPredicate(row)).length / positives.length
      : null,
    supersetRate: positives.length > 0
      ? positives.filter((row) => row.supersetMatch && acceptedPredicate(row)).length / positives.length
      : null,
    extraNoteRate: acceptedDetectedTotal > 0 ? acceptedExtraTotal / acceptedDetectedTotal : null,
    emptyWindowFalseAcceptRate: emptyRows.length > 0
      ? emptyWindowFalseAcceptCount / emptyRows.length
      : null,
    emptyWindowFalseAcceptCount,
    transitionWindowAcceptRate: transitionRows.length > 0
      ? transitionRows.filter(acceptedPredicate).length / transitionRows.length
      : null,
    stableWindowAcceptRate: stableNonEmptyRows.length > 0
      ? stableNonEmptyRows.filter(acceptedPredicate).length / stableNonEmptyRows.length
      : null,
    stableWindowCoverageRate: stableNonEmptyRows.length > 0
      ? stableNonEmptyRows.filter((row) => acceptedPredicate(row) && row.missingExpectedNotes.length === 0).length / stableNonEmptyRows.length
      : null,
    stableNonEmptyExpectedNoteRecall: stableExpectedTotal > 0
      ? stableAcceptedValidatedTotal / stableExpectedTotal
      : null,
    stableNonEmptyExactSetRate: stableNonEmptyRows.length > 0
      ? stableNonEmptyRows.filter((row) => acceptedPredicate(row) && row.exactSetMatch).length / stableNonEmptyRows.length
      : null,
    stableNonEmptySupersetRate: stableNonEmptyRows.length > 0
      ? stableNonEmptyRows.filter((row) => acceptedPredicate(row) && row.supersetMatch).length / stableNonEmptyRows.length
      : null,
    stableNonEmptySupersetAcceptRate: stableSupersetRows.length > 0
      ? stableSupersetRows.filter(acceptedPredicate).length / stableSupersetRows.length
      : null
  };
}

export function evaluateActivationGateDecision(input: {
  policy: ActivationGatePolicy;
  preGateAccept: boolean;
  expectedWindowActive: boolean;
  windowCategory: WindowCategory;
  isStableWindow: boolean;
  setRelation: WindowSetRelation;
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
  if (!input.policy.gateEnabled) {
    return { accept: input.preGateAccept, rejectReason: input.preGateAccept ? 'disabled' : 'pre_gate_inactive' };
  }
  if (!input.preGateAccept) {
    return { accept: false, rejectReason: 'pre_gate_inactive' };
  }

  if (!input.expectedWindowActive || input.windowCategory === 'empty_window') {
    if (input.policy.emptyWindowMustBeQuiet && input.activationDetected) {
      return { accept: false, rejectReason: 'empty_window_requires_quiet' };
    }
    if (input.validatedNoteCount > input.policy.emptyWindowMaxValidatedNotes) {
      return { accept: false, rejectReason: 'empty_window_validated_notes_exceeded' };
    }
    if (input.extraDetectedNoteCount > input.policy.emptyWindowMaxExtraNotes) {
      return { accept: false, rejectReason: 'empty_window_extra_notes_exceeded' };
    }
    if (
      input.policy.emptyWindowMaxConfidence !== null &&
      input.rawDetectionMaxConfidence !== null &&
      input.rawDetectionMaxConfidence > input.policy.emptyWindowMaxConfidence
    ) {
      return { accept: false, rejectReason: 'empty_window_confidence_exceeded' };
    }
    return { accept: true, rejectReason: 'passed' };
  }

  const minRequiredNoteRatio = Math.max(
    clamp(input.policy.minExpectedNoteRatioForActivation, 0, 1),
    input.windowCategory === 'transition_window' ? clamp(input.policy.transitionMinNoteRatio, 0, 1) : 0
  );
  if (input.noteValidationRatio < minRequiredNoteRatio) {
    return { accept: false, rejectReason: 'expected_note_ratio_too_low' };
  }

  if (input.minValidatedSupportFrames < Math.max(1, Math.round(input.policy.minConsecutiveExpectedSupportFrames))) {
    return { accept: false, rejectReason: 'expected_support_frames_too_low' };
  }

  if (input.windowCategory === 'transition_window') {
    if (input.stableSetRatio < clamp(input.policy.transitionMinStableRatio, 0, 1)) {
      return { accept: false, rejectReason: 'transition_stability_too_low' };
    }
    if (input.transitionOverlapRatio > clamp(input.policy.transitionMaxOverlapRatio, 0, 1)) {
      return { accept: false, rejectReason: 'transition_overlap_too_high' };
    }
    if (input.policy.requireExactOnTransition && input.setRelation !== 'exact') {
      return { accept: false, rejectReason: 'transition_requires_exact' };
    }
    if (!input.policy.transitionAllowSuperset && input.setRelation === 'superset') {
      return { accept: false, rejectReason: 'transition_superset_not_allowed' };
    }
    return { accept: true, rejectReason: 'passed' };
  }

  if (
    input.isStableWindow &&
    input.setRelation === 'superset' &&
    input.expectedCovered &&
    !input.policy.stableAllowSupersetIfExpectedCovered
  ) {
    return { accept: false, rejectReason: 'stable_superset_not_allowed' };
  }

  return { accept: true, rejectReason: 'passed' };
}

function applyTemporalGateHysteresis(
  rows: NoteSetWindowResult[],
  hysteresisFrames: number
): NoteSetWindowResult[] {
  const normalizedFrames = Math.max(1, Math.round(hysteresisFrames));
  const out = rows.map((row) => ({
    ...row,
    postGateAccept: row.gateCoreAccept,
    gateSuppressedByHysteresis: false,
    postGateFalseReject: row.expectedWindowActive && !row.gateCoreAccept,
    postGateFalseAccept: !row.expectedWindowActive && row.gateCoreAccept
  }));

  if (normalizedFrames <= 1) {
    return out.map((row) => ({
      ...row,
      gateSuppressed: row.preGateAccept && !row.postGateAccept
    }));
  }

  const byAlgorithmFile = new Map<string, NoteSetWindowResult[]>();
  for (const row of out) {
    const key = `${row.algorithm}__${row.fileId}`;
    const bucket = byAlgorithmFile.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byAlgorithmFile.set(key, [row]);
    }
  }

  for (const bucket of byAlgorithmFile.values()) {
    bucket.sort((left, right) => (
      left.startSec - right.startSec ||
      left.endSec - right.endSec ||
      left.windowId.localeCompare(right.windowId)
    ));

    let streak = 0;
    for (const row of bucket) {
      if (row.gateCoreAccept) {
        streak += 1;
      } else {
        streak = 0;
      }

      const hysteresisAccept = row.gateCoreAccept && streak >= normalizedFrames;
      row.postGateAccept = hysteresisAccept;
      row.gateSuppressedByHysteresis = row.gateCoreAccept && !hysteresisAccept;
      row.gateSuppressed = row.preGateAccept && !hysteresisAccept;
      row.postGateFalseReject = row.expectedWindowActive && !hysteresisAccept;
      row.postGateFalseAccept = !row.expectedWindowActive && hysteresisAccept;

      if (row.gateSuppressedByHysteresis) {
        row.gateRejectReason = 'hysteresis_not_satisfied';
      }
    }
  }

  return out;
}

function safeParsePolicyJson(raw: string, fallback: NoteSetAggregationPolicy): NoteSetAggregationPolicy {
  try {
    const parsed = JSON.parse(raw) as Partial<NoteSetAggregationPolicy>;
    return normalizePolicy({
      ...fallback,
      ...parsed
    });
  } catch {
    return fallback;
  }
}

function safeParseActivationGatePolicyJson(
  raw: string,
  fallback: ActivationGatePolicy
): ActivationGatePolicy {
  try {
    const parsed = JSON.parse(raw) as Partial<ActivationGatePolicy>;
    return normalizeActivationGatePolicy({
      ...fallback,
      ...parsed
    });
  } catch {
    return fallback;
  }
}

function normalizeActivationGatePolicy(policy: ActivationGatePolicy): ActivationGatePolicy {
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

function normalizePolicy(policy: NoteSetAggregationPolicy): NoteSetAggregationPolicy {
  return {
    ...policy,
    id: policy.id || DEFAULT_NOTE_SET_POLICY.id,
    mode: (
      policy.mode === 'all_notes_required' ||
      policy.mode === 'min_ratio_required' ||
      policy.mode === 'min_count_required'
    ) ? policy.mode : DEFAULT_NOTE_SET_POLICY.mode,
    minNoteRatio: clamp(policy.minNoteRatio, 0, 1),
    minNoteCount: Math.max(1, Math.round(policy.minNoteCount)),
    maxExtraDetectedNotes:
      policy.maxExtraDetectedNotes === null
        ? null
        : Number.isFinite(policy.maxExtraDetectedNotes)
          ? Math.max(0, Math.round(policy.maxExtraDetectedNotes))
          : null,
    extraNotePenaltyWeight: Math.max(0, policy.extraNotePenaltyWeight),
    allowSupersetIfExpectedCovered: policy.allowSupersetIfExpectedCovered !== false,
    emptyWindowMustBeQuiet: policy.emptyWindowMustBeQuiet !== false
  };
}

function normalizeWindowStabilityConfig(config: WindowStabilityConfig): WindowStabilityConfig {
  return {
    stableWindowMinRatio: clamp(config.stableWindowMinRatio, 0, 1),
    transitionOverlapThreshold: clamp(config.transitionOverlapThreshold, 0, 1)
  };
}

function analyzeWindowExpectedSets(
  overlappingEvents: JamsNoteEvent[],
  startSec: number,
  endSec: number
): {
  expectedDominantMidis: number[];
  segmentCount: number;
  expectedActiveRatio: number;
  stableSetRatio: number;
  transitionOverlapRatio: number;
  noteSetChangeCount: number;
} {
  const windowDuration = Math.max(EPS, endSec - startSec);
  const boundariesRaw = [startSec, endSec];
  for (const event of overlappingEvents) {
    boundariesRaw.push(clamp(event.startSec, startSec, endSec));
    boundariesRaw.push(clamp(event.endSec, startSec, endSec));
  }
  boundariesRaw.sort((left, right) => left - right);

  const boundaries: number[] = [];
  for (const boundary of boundariesRaw) {
    if (boundaries.length <= 0 || Math.abs(boundary - boundaries[boundaries.length - 1]) > EPS) {
      boundaries.push(boundary);
    }
  }
  if (boundaries.length < 2) {
    boundaries.push(endSec);
  }

  let segmentCount = 0;
  let expectedActiveSec = 0;
  let noteSetChangeCount = 0;
  let previousSetKey: string | null = null;
  const setDurations = new Map<string, { midis: number[]; durationSec: number }>();

  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const segStart = boundaries[index];
    const segEnd = boundaries[index + 1];
    const segDuration = segEnd - segStart;
    if (segDuration <= EPS) continue;
    segmentCount += 1;

    const activeMidis = uniqueSorted(
      overlappingEvents
        .filter((event) => overlapSec(event.startSec, event.endSec, segStart, segEnd) > EPS)
        .map((event) => event.midi)
    );

    if (activeMidis.length > 0) {
      expectedActiveSec += segDuration;
    }

    const key = noteSetKey(activeMidis);
    const existing = setDurations.get(key);
    if (existing) {
      existing.durationSec += segDuration;
    } else {
      setDurations.set(key, { midis: activeMidis, durationSec: segDuration });
    }
    if (previousSetKey !== null && previousSetKey !== key) {
      noteSetChangeCount += 1;
    }
    previousSetKey = key;
  }

  let expectedDominantMidis: number[] = [];
  let dominantDuration = 0;
  for (const entry of setDurations.values()) {
    if (entry.durationSec > dominantDuration + EPS) {
      dominantDuration = entry.durationSec;
      expectedDominantMidis = entry.midis;
      continue;
    }
    if (Math.abs(entry.durationSec - dominantDuration) <= EPS) {
      if (entry.midis.length > expectedDominantMidis.length) {
        expectedDominantMidis = entry.midis;
      } else if (entry.midis.length === expectedDominantMidis.length && noteSetKey(entry.midis) < noteSetKey(expectedDominantMidis)) {
        expectedDominantMidis = entry.midis;
      }
    }
  }

  const stableSetRatio = dominantDuration > 0 ? clamp(dominantDuration / windowDuration, 0, 1) : 0;
  const transitionOverlapRatio = clamp(1 - stableSetRatio, 0, 1);
  return {
    expectedDominantMidis,
    segmentCount: Math.max(1, segmentCount),
    expectedActiveRatio: clamp(expectedActiveSec / windowDuration, 0, 1),
    stableSetRatio,
    transitionOverlapRatio,
    noteSetChangeCount
  };
}

function buildCategoryMetrics(rows: NoteSetWindowResult[]): WindowCategoryMetrics {
  if (rows.length <= 0) {
    return {
      windows: 0,
      expectedNoteCountTotal: 0,
      validatedNoteCountTotal: 0,
      expectedNoteRecall: null,
      expectedNotePrecision: null,
      noteValidationRatio: null,
      legacyAcceptRate: null,
      policyAcceptRate: null,
      preGateAcceptRate: null,
      postGateAcceptRate: null,
      strictAcceptRate: null,
      averageExtraNoteCount: null
    };
  }

  const expectedNoteCountTotal = rows.reduce((sum, row) => sum + row.expectedNoteCount, 0);
  const validatedNoteCountTotal = rows.reduce((sum, row) => sum + row.validatedNoteCount, 0);
  const extraDetectedNoteCountTotal = rows.reduce((sum, row) => sum + row.extraDetectedNotes.length, 0);

  return {
    windows: rows.length,
    expectedNoteCountTotal,
    validatedNoteCountTotal,
    expectedNoteRecall: expectedNoteCountTotal > 0 ? validatedNoteCountTotal / expectedNoteCountTotal : null,
    expectedNotePrecision: validatedNoteCountTotal + extraDetectedNoteCountTotal > 0
      ? validatedNoteCountTotal / (validatedNoteCountTotal + extraDetectedNoteCountTotal)
      : null,
    noteValidationRatio: expectedNoteCountTotal > 0 ? validatedNoteCountTotal / expectedNoteCountTotal : null,
    legacyAcceptRate: rows.filter((row) => row.accept).length / rows.length,
    policyAcceptRate: rows.filter((row) => row.policyAccept).length / rows.length,
    preGateAcceptRate: rows.filter((row) => row.preGateAccept).length / rows.length,
    postGateAcceptRate: rows.filter((row) => row.postGateAccept).length / rows.length,
    strictAcceptRate: rows.filter((row) => row.strictAccept).length / rows.length,
    averageExtraNoteCount: average(rows.map((row) => row.extraDetectedNotes.length))
  };
}

function buildNegativeTypeMetrics(
  rows: NoteSetWindowResult[],
  preGateFalseAcceptPredicate: (row: NoteSetWindowResult) => boolean,
  postGateFalseAcceptPredicate: (row: NoteSetWindowResult) => boolean
): NegativeTypeMetrics {
  if (rows.length <= 0) {
    return {
      windows: 0,
      falseAcceptCount: 0,
      falseAcceptRate: null,
      preGateFalseAcceptCount: 0,
      preGateFalseAcceptRate: null,
      postGateFalseAcceptCount: 0,
      postGateFalseAcceptRate: null,
      averageDetectedNoteCount: null,
      averageExtraNoteCount: null
    };
  }
  const preGateFalseAcceptCount = rows.filter(preGateFalseAcceptPredicate).length;
  const postGateFalseAcceptCount = rows.filter(postGateFalseAcceptPredicate).length;
  return {
    windows: rows.length,
    falseAcceptCount: postGateFalseAcceptCount,
    falseAcceptRate: postGateFalseAcceptCount / rows.length,
    preGateFalseAcceptCount,
    preGateFalseAcceptRate: preGateFalseAcceptCount / rows.length,
    postGateFalseAcceptCount,
    postGateFalseAcceptRate: postGateFalseAcceptCount / rows.length,
    averageDetectedNoteCount: average(rows.map((row) => row.rawDetectedMidis.length)),
    averageExtraNoteCount: average(rows.map((row) => row.extraDetectedNotes.length))
  };
}

function noteSetKey(midis: number[]): string {
  if (midis.length <= 0) return '_';
  return midis.join(',');
}

function parseEnvBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseEnvInteger(raw: string | undefined, fallback: number, minValue: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

function parseEnvNullableNumber(raw: string | undefined, fallback: number | null): number | null {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'null' || normalized === '-1') return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function overlapSec(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function sampleEvenlyIndexes(length: number, count: number): number[] {
  if (count >= length) {
    return Array.from({ length }, (_, index) => index);
  }
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0.5 : index / (count - 1);
    out.push(Math.min(length - 1, Math.round(ratio * (length - 1))));
  }
  return uniqueSorted(out);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function extractMidiValue(rawValue: unknown): number | null {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }
  if (Array.isArray(rawValue)) {
    const firstNumeric = rawValue.find((entry) => typeof entry === 'number' && Number.isFinite(entry));
    return typeof firstNumeric === 'number' ? firstNumeric : null;
  }
  if (rawValue && typeof rawValue === 'object') {
    const value = asRecord(rawValue);
    const midi = asFiniteNumber(value.midi);
    if (midi !== null) return midi;
    const nested = asFiniteNumber(value.value);
    if (nested !== null) return nested;
    const frequencyHz = asFiniteNumber(value.frequency) ?? asFiniteNumber(value.frequency_hz);
    if (frequencyHz !== null && frequencyHz > 0) {
      return 69 + 12 * Math.log2(frequencyHz / 440);
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value));
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
