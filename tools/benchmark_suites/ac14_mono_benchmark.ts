import type { DatasetRow } from './shared';
import type { JamsNoteEvent } from './gameplay_validator_polyphonic';

export type MonoDatasetName = 'android' | 'guitarset_solo';

export type MonoWindowKind = 'guard' | 'transition' | 'stable';

export type MonoWindowCategory = 'empty_window' | 'transition_window' | 'single_note_window';

export type MonoStringBand = 'low' | 'mid' | 'high';

export type MonoBenchmarkConfig = {
  probeSpacingSec: number;
  minStableSupportSeconds: number;
  minTransitionSupportSeconds: number;
  minStableTargetRatio: number;
  minTransitionTargetRatio: number;
  minStableConfidence: number;
  minTransitionConfidence: number;
  maxWrongNoteRatio: number;
  maxTransitionWrongNoteRatio: number;
  emptyMaxConfidence: number;
  semitoneTolerance: number;
};

export type AndroidWindowConfig = {
  preGuardStartSec: number;
  preGuardDurationSec: number;
  attackStartSec: number;
  attackDurationSec: number;
  stable1StartSec: number;
  stable1DurationSec: number;
  stable2StartSec: number;
  stable2DurationSec: number;
  stable3StartSec: number;
  stable3DurationSec: number;
  tailGuardStartSec: number;
  tailGuardDurationSec: number;
};

export type GuitarSetWindowConfig = {
  onsetTransitionSec: number;
  stableWindowSec: number;
  releaseTransitionSec: number;
  gapPaddingSec: number;
  gapMinSec: number;
};

export type MonoWindowSpec = {
  windowId: string;
  fileId: string;
  relativeFilePath: string;
  dataset: MonoDatasetName;
  startSec: number;
  endSec: number;
  expectedMidi: number | null;
  expectedAccept: boolean;
  windowKind: MonoWindowKind;
  windowCategory: MonoWindowCategory;
  isStableWindow: boolean;
  sourceStringId: number | null;
  sourceFret: number | null;
  sourceTake: number | null;
  sourceBand: MonoStringBand | null;
  noteLabel: string | null;
};

export type MonoFrameObservation = {
  frameIndex: number;
  timestampMs: number;
  runtimeMs: number;
  detectorAccepted: boolean;
  detectorConfidence: number;
  detectedMidi: number | null;
  rejectReason: string | null;
};

export type MonoWindowEvidence = {
  frameCount: number;
  acceptedFrameCount: number;
  targetHitCount: number;
  wrongNoteFrameCount: number;
  anyActivationFrameCount: number;
  targetHitRatio: number;
  wrongNoteRatio: number;
  supportSeconds: number;
  targetConsecutiveSeconds: number;
  maxConfidence: number;
  medianConfidence: number;
  firstTargetHitLatencyMs: number | null;
  firstAnyHitLatencyMs: number | null;
  dominantDetectedMidi: number | null;
  dominantDetectedMidiCount: number;
  rawDetectedMidis: number[];
  runtimeAvgMs: number;
  runtimeP95Ms: number;
};

export type MonoWindowResult = MonoWindowSpec & {
  observations: MonoFrameObservation[];
  evidence: MonoWindowEvidence;
  acceptPreGate: boolean;
  acceptPostGate: boolean;
  accept: boolean;
  rejectReason: string;
  falseReject: boolean;
  falseAccept: boolean;
  noteMismatch: boolean;
  mismatchType: MonoMismatchType;
  decisionLatencyMs: number | null;
  validatorRuntimeMs: number;
  detectorRuntimeMs: number;
  totalRuntimeMs: number;
};

export type MonoMismatchType =
  | 'correct_target'
  | 'empty_window'
  | 'false_activation'
  | 'missed_target'
  | 'octave_distractor'
  | 'neighbor_note'
  | 'wrong_note';

export type MonoAggregateMetrics = {
  dataset: MonoDatasetName;
  windows: number;
  positiveWindows: number;
  negativeWindows: number;
  stableWindows: number;
  transitionWindows: number;
  guardWindows: number;
  tar: number;
  strictFar: number;
  noteMismatchFar: number;
  precision: number;
  recall: number;
  lowBandTar: number | null;
  lowBandFar: number | null;
  stableWindowAcceptRate: number | null;
  transitionWindowAcceptRate: number | null;
  guardWindowFalseAcceptRate: number | null;
  averageSupportSeconds: number;
  averageTargetHitRatio: number;
  averageWrongNoteRatio: number;
  firstTargetHitLatencyMsAvg: number | null;
  firstTargetHitLatencyMsP95: number | null;
  firstAnyHitLatencyMsAvg: number | null;
  firstAnyHitLatencyMsP95: number | null;
  detectorRuntimeAvgMs: number;
  detectorRuntimeP95Ms: number;
  validatorRuntimeAvgMs: number;
  validatorRuntimeP95Ms: number;
  totalRuntimeAvgMs: number;
  totalRuntimeP95Ms: number;
};

export const DEFAULT_MONO_BENCHMARK_CONFIG: MonoBenchmarkConfig = {
  probeSpacingSec: 0.05,
  minStableSupportSeconds: 0.15,
  minTransitionSupportSeconds: 0.10,
  minStableTargetRatio: 0.6,
  minTransitionTargetRatio: 0.4,
  minStableConfidence: 0.35,
  minTransitionConfidence: 0.3,
  maxWrongNoteRatio: 0.25,
  maxTransitionWrongNoteRatio: 0.4,
  emptyMaxConfidence: 0.25,
  semitoneTolerance: 0
};

export const DEFAULT_ANDROID_WINDOW_CONFIG: AndroidWindowConfig = {
  preGuardStartSec: 0,
  preGuardDurationSec: 0.20,
  attackStartSec: 0.20,
  attackDurationSec: 0.30,
  stable1StartSec: 0.50,
  stable1DurationSec: 0.60,
  stable2StartSec: 1.15,
  stable2DurationSec: 0.60,
  stable3StartSec: 1.80,
  stable3DurationSec: 0.60,
  tailGuardStartSec: 2.95,
  tailGuardDurationSec: 0.20
};

export const DEFAULT_GUITARSET_WINDOW_CONFIG: GuitarSetWindowConfig = {
  onsetTransitionSec: 0.12,
  stableWindowSec: 0.45,
  releaseTransitionSec: 0.12,
  gapPaddingSec: 0.05,
  gapMinSec: 0.25
};

export function buildAndroidMonoWindows(input: {
  datasetRow: DatasetRow;
  midi: number;
  durationSec: number;
  config?: AndroidWindowConfig;
}): MonoWindowSpec[] {
  const config = input.config ?? DEFAULT_ANDROID_WINDOW_CONFIG;
  const fileId = input.datasetRow.fileId;
  const relativeFilePath = input.datasetRow.relativeFilePath;
  const sourceBand = stringBandFor(input.datasetRow.stringId);
  const windows: MonoWindowSpec[] = [];

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__pre_guard`,
    startSec: config.preGuardStartSec,
    endSec: config.preGuardStartSec + config.preGuardDurationSec,
    expectedMidi: null,
    expectedAccept: false,
    windowKind: 'guard',
    windowCategory: 'empty_window',
    isStableWindow: false,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: null
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__attack_transition`,
    startSec: config.attackStartSec,
    endSec: config.attackStartSec + config.attackDurationSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'transition',
    windowCategory: 'transition_window',
    isStableWindow: false,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__stable_1`,
    startSec: config.stable1StartSec,
    endSec: config.stable1StartSec + config.stable1DurationSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'stable',
    windowCategory: 'single_note_window',
    isStableWindow: true,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__stable_2`,
    startSec: config.stable2StartSec,
    endSec: config.stable2StartSec + config.stable2DurationSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'stable',
    windowCategory: 'single_note_window',
    isStableWindow: true,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__stable_3`,
    startSec: config.stable3StartSec,
    endSec: config.stable3StartSec + config.stable3DurationSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'stable',
    windowCategory: 'single_note_window',
    isStableWindow: true,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__tail_guard`,
    startSec: config.tailGuardStartSec,
    endSec: config.tailGuardStartSec + config.tailGuardDurationSec,
    expectedMidi: null,
    expectedAccept: false,
    windowKind: 'guard',
    windowCategory: 'empty_window',
    isStableWindow: false,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: null
  }, input.durationSec);

  return windows;
}

export function buildGuitarSetSoloWindows(input: {
  fileId: string;
  relativeFilePath: string;
  durationSec: number;
  events: JamsNoteEvent[];
  config?: GuitarSetWindowConfig;
}): MonoWindowSpec[] {
  const config = input.config ?? DEFAULT_GUITARSET_WINDOW_CONFIG;
  const windows: MonoWindowSpec[] = [];
  const events = [...input.events].sort((left, right) =>
    left.startSec - right.startSec ||
    left.endSec - right.endSec ||
    left.midi - right.midi
  );

  if (events.length === 0) {
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__gap_0`,
      startSec: 0,
      endSec: Math.max(0, Math.min(input.durationSec, config.gapMinSec)),
      expectedMidi: null,
      expectedAccept: false,
      windowKind: 'guard',
      windowCategory: 'empty_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel: null
    }, input.durationSec);
    return windows;
  }

  const leadingGapEnd = Math.max(0, events[0].startSec - config.gapPaddingSec);
  if (leadingGapEnd >= config.gapMinSec) {
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__gap_lead`,
      startSec: 0,
      endSec: leadingGapEnd,
      expectedMidi: null,
      expectedAccept: false,
      windowKind: 'guard',
      windowCategory: 'empty_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel: null
    }, input.durationSec);
  }

  events.forEach((event, index) => {
    const noteLabel = noteLabelFor(event.midi);
    const onsetEnd = Math.min(event.endSec, event.startSec + config.onsetTransitionSec);
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__n${String(index).padStart(4, '0')}__attack`,
      startSec: event.startSec,
      endSec: onsetEnd,
      expectedMidi: event.midi,
      expectedAccept: true,
      windowKind: 'transition',
      windowCategory: 'transition_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel
    }, input.durationSec);

    const stableStart = onsetEnd;
    const stableTargetEnd = Math.min(event.endSec - config.releaseTransitionSec, stableStart + config.stableWindowSec);
    if (stableTargetEnd - stableStart >= config.gapMinSec / 2) {
      addWindow(windows, {
        fileId: input.fileId,
        relativeFilePath: input.relativeFilePath,
        dataset: 'guitarset_solo',
        windowId: `${input.fileId}__n${String(index).padStart(4, '0')}__stable`,
        startSec: stableStart,
        endSec: stableTargetEnd,
        expectedMidi: event.midi,
        expectedAccept: true,
        windowKind: 'stable',
        windowCategory: 'single_note_window',
        isStableWindow: true,
        sourceStringId: null,
        sourceFret: null,
        sourceTake: null,
        sourceBand: null,
        noteLabel
      }, input.durationSec);
    }

    const releaseStart = Math.max(event.startSec, event.endSec - config.releaseTransitionSec);
    if (event.endSec - releaseStart >= config.gapMinSec / 4) {
      addWindow(windows, {
        fileId: input.fileId,
        relativeFilePath: input.relativeFilePath,
        dataset: 'guitarset_solo',
        windowId: `${input.fileId}__n${String(index).padStart(4, '0')}__release`,
        startSec: releaseStart,
        endSec: event.endSec,
        expectedMidi: event.midi,
        expectedAccept: true,
        windowKind: 'transition',
        windowCategory: 'transition_window',
        isStableWindow: false,
        sourceStringId: null,
        sourceFret: null,
        sourceTake: null,
        sourceBand: null,
        noteLabel
      }, input.durationSec);
    }

    const next = events[index + 1] ?? null;
    if (next) {
      const gapStart = event.endSec + config.gapPaddingSec;
      const gapEnd = next.startSec - config.gapPaddingSec;
      if (gapEnd - gapStart >= config.gapMinSec) {
        addWindow(windows, {
          fileId: input.fileId,
          relativeFilePath: input.relativeFilePath,
          dataset: 'guitarset_solo',
          windowId: `${input.fileId}__gap_${String(index).padStart(4, '0')}`,
          startSec: gapStart,
          endSec: gapEnd,
          expectedMidi: null,
          expectedAccept: false,
          windowKind: 'guard',
          windowCategory: 'empty_window',
          isStableWindow: false,
          sourceStringId: null,
          sourceFret: null,
          sourceTake: null,
          sourceBand: null,
          noteLabel: null
        }, input.durationSec);
      }
    }
  });

  const last = events[events.length - 1];
  const trailingStart = last.endSec + config.gapPaddingSec;
  if (input.durationSec - trailingStart >= config.gapMinSec) {
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__gap_tail`,
      startSec: trailingStart,
      endSec: input.durationSec,
      expectedMidi: null,
      expectedAccept: false,
      windowKind: 'guard',
      windowCategory: 'empty_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel: null
    }, input.durationSec);
  }

  return windows;
}

export function buildProbeTimes(input: {
  startSec: number;
  endSec: number;
  spacingSec: number;
}): number[] {
  const startSec = Math.max(0, input.startSec);
  const endSec = Math.max(startSec, input.endSec);
  const spacingSec = Math.max(0.01, input.spacingSec);
  if (endSec <= startSec) return [roundSec(startSec)];

  const times: number[] = [];
  for (let current = startSec; current <= endSec + 1e-9; current += spacingSec) {
    times.push(roundSec(current));
  }
  if (times[times.length - 1] !== roundSec(endSec)) {
    times.push(roundSec(endSec));
  }
  return uniqueSortedFloats(times);
}

export function secondsToSampleIndex(timeSec: number, sampleRate: number): number {
  if (!Number.isFinite(timeSec) || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return Math.max(0, Math.floor(roundSec(timeSec) * sampleRate));
}

export function evaluateMonoWindow(input: {
  spec: MonoWindowSpec;
  observations: MonoFrameObservation[];
  config: MonoBenchmarkConfig;
}): MonoWindowResult {
  const evidence = buildMonoWindowEvidence(
    input.observations,
    input.spec.expectedMidi,
    input.config.probeSpacingSec
  );
  const expectedMidi = input.spec.expectedMidi;
  const isPositive = expectedMidi !== null && input.spec.expectedAccept;

  let acceptPreGate = false;
  let acceptPostGate = false;
  let rejectReason = 'rejected';

  if (!isPositive) {
    acceptPreGate = evidence.anyActivationFrameCount === 0;
    acceptPostGate = acceptPreGate && evidence.maxConfidence <= input.config.emptyMaxConfidence;
    rejectReason = acceptPostGate ? 'empty_window_quiet' : emptyRejectReason(evidence, input.config);
  } else {
    const targetRatioThreshold = input.spec.windowKind === 'stable'
      ? input.config.minStableTargetRatio
      : input.config.minTransitionTargetRatio;
    const supportThresholdSeconds = input.spec.windowKind === 'stable'
      ? input.config.minStableSupportSeconds
      : input.config.minTransitionSupportSeconds;
    const confidenceThreshold = input.spec.windowKind === 'stable'
      ? input.config.minStableConfidence
      : input.config.minTransitionConfidence;
    const wrongRatioThreshold = input.spec.windowKind === 'stable'
      ? input.config.maxWrongNoteRatio
      : input.config.maxTransitionWrongNoteRatio;

    acceptPreGate =
      evidence.targetHitRatio >= targetRatioThreshold &&
      evidence.supportSeconds >= supportThresholdSeconds &&
      evidence.targetConsecutiveSeconds >= supportThresholdSeconds / 2;

    acceptPostGate =
      acceptPreGate &&
      evidence.wrongNoteRatio <= wrongRatioThreshold &&
      evidence.medianConfidence >= confidenceThreshold;

    rejectReason = acceptPostGate
      ? 'target_window_passed'
      : positiveRejectReason({
        evidence,
        targetRatioThreshold,
        supportThresholdSeconds,
        confidenceThreshold,
        wrongRatioThreshold,
        spec: input.spec
      });
  }

  const accept = acceptPostGate;
  const falseReject = isPositive && !accept;
  const falseAccept = !isPositive && accept;
  const noteMismatch = isPositive && evidence.dominantDetectedMidi !== null && evidence.dominantDetectedMidi !== expectedMidi;
  const mismatchType = classifyMismatch(input.spec, evidence);
  const decisionLatencyMs = input.spec.expectedMidi !== null
    ? evidence.firstTargetHitLatencyMs
    : evidence.firstAnyHitLatencyMs;

  return {
    ...input.spec,
    observations: input.observations,
    evidence,
    acceptPreGate,
    acceptPostGate,
    accept,
    rejectReason,
    falseReject,
    falseAccept,
    noteMismatch,
    mismatchType,
    decisionLatencyMs,
    validatorRuntimeMs: 0,
    detectorRuntimeMs: evidence.runtimeAvgMs * evidence.frameCount,
    totalRuntimeMs: evidence.runtimeAvgMs * evidence.frameCount
  };
}

export function aggregateMonoResults(results: MonoWindowResult[]): MonoAggregateMetrics {
  const positive = results.filter((row) => row.expectedAccept);
  const negative = results.filter((row) => !row.expectedAccept);
  const stable = results.filter((row) => row.windowKind === 'stable');
  const transition = results.filter((row) => row.windowKind === 'transition');
  const guard = results.filter((row) => row.windowKind === 'guard');
  const lowBand = results.filter((row) => row.sourceBand === 'low');

  const detectorRuntime = flatten(results.map((row) => row.observations.map((obs) => obs.runtimeMs)));
  const validatorRuntime = results.map((row) => row.validatorRuntimeMs);
  const totalRuntime = results.map((row) => row.totalRuntimeMs);

  const targetHitLatencies = flatten(results.map((row) => row.evidence.firstTargetHitLatencyMs === null ? [] : [row.evidence.firstTargetHitLatencyMs]));
  const anyHitLatencies = flatten(results.map((row) => row.evidence.firstAnyHitLatencyMs === null ? [] : [row.evidence.firstAnyHitLatencyMs]));

  return {
    dataset: results[0]?.dataset ?? 'android',
    windows: results.length,
    positiveWindows: positive.length,
    negativeWindows: negative.length,
    stableWindows: stable.length,
    transitionWindows: transition.length,
    guardWindows: guard.length,
    tar: ratio(positive.map((row) => row.accept)),
    strictFar: ratio(negative.map((row) => row.accept)),
    noteMismatchFar: positive.length > 0 ? positive.filter((row) => row.accept && row.noteMismatch).length / positive.length : 0,
    precision: (positive.filter((row) => row.accept).length + negative.filter((row) => row.accept).length) > 0
      ? positive.filter((row) => row.accept).length /
        Math.max(1, positive.filter((row) => row.accept).length + negative.filter((row) => row.accept).length)
      : 0,
    recall: positive.length > 0 ? positive.filter((row) => row.accept).length / positive.length : 0,
    lowBandTar: lowBand.filter((row) => row.expectedAccept).length > 0
      ? lowBand.filter((row) => row.expectedAccept && row.accept).length / lowBand.filter((row) => row.expectedAccept).length
      : null,
    lowBandFar: lowBand.filter((row) => !row.expectedAccept).length > 0
      ? lowBand.filter((row) => !row.expectedAccept && row.accept).length / lowBand.filter((row) => !row.expectedAccept).length
      : null,
    stableWindowAcceptRate: stable.length > 0 ? stable.filter((row) => row.accept).length / stable.length : null,
    transitionWindowAcceptRate: transition.length > 0 ? transition.filter((row) => row.accept).length / transition.length : null,
    guardWindowFalseAcceptRate: guard.length > 0 ? guard.filter((row) => row.accept).length / guard.length : null,
    averageSupportSeconds: average(results.map((row) => row.evidence.supportSeconds)),
    averageTargetHitRatio: average(results.map((row) => row.evidence.targetHitRatio)),
    averageWrongNoteRatio: average(results.map((row) => row.evidence.wrongNoteRatio)),
    firstTargetHitLatencyMsAvg: targetHitLatencies.length > 0 ? average(targetHitLatencies) : null,
    firstTargetHitLatencyMsP95: targetHitLatencies.length > 0 ? percentile(targetHitLatencies, 0.95) : null,
    firstAnyHitLatencyMsAvg: anyHitLatencies.length > 0 ? average(anyHitLatencies) : null,
    firstAnyHitLatencyMsP95: anyHitLatencies.length > 0 ? percentile(anyHitLatencies, 0.95) : null,
    detectorRuntimeAvgMs: average(detectorRuntime),
    detectorRuntimeP95Ms: percentile(detectorRuntime, 0.95),
    validatorRuntimeAvgMs: average(validatorRuntime),
    validatorRuntimeP95Ms: percentile(validatorRuntime, 0.95),
    totalRuntimeAvgMs: average(totalRuntime),
    totalRuntimeP95Ms: percentile(totalRuntime, 0.95)
  };
}

export function noteLevelSummary(results: MonoWindowResult[]): {
  noteCount: number;
  recoveredNotes: number;
  acceptedStableNotes: number;
  falseActivationNotes: number;
  noteRecall: number;
  notePrecision: number;
} {
  const positive = results.filter((row) => row.expectedAccept && row.windowKind === 'stable');
  const recoveredNotes = positive.filter((row) => row.accept).length;
  const falseActivationNotes = results.filter((row) => !row.expectedAccept && row.accept).length;
  const acceptedStableNotes = positive.filter((row) => row.accept).length;
  const noteCount = positive.length;
  const notePrecision = acceptedStableNotes + falseActivationNotes > 0
    ? acceptedStableNotes / (acceptedStableNotes + falseActivationNotes)
    : 0;
  const noteRecall = noteCount > 0 ? recoveredNotes / noteCount : 0;
  return {
    noteCount,
    recoveredNotes,
    acceptedStableNotes,
    falseActivationNotes,
    noteRecall,
    notePrecision
  };
}

function buildMonoWindowEvidence(
  observations: MonoFrameObservation[],
  expectedMidi: number | null,
  probeSpacingSec: number
): MonoWindowEvidence {
  const accepted = observations.filter((obs) => obs.detectorAccepted && obs.detectedMidi !== null);
  const detectedMidis = accepted.map((obs) => Math.round(obs.detectedMidi as number));
  const rawDetectedMidis = uniqueSortedIntegers(detectedMidis);
  const dominantDetectedMidi = mostCommonNumber(detectedMidis);
  const dominantDetectedMidiCount = dominantDetectedMidi === null
    ? 0
    : detectedMidis.filter((midi) => midi === dominantDetectedMidi).length;
  const acceptedFrameCount = accepted.length;
  const targetHitMask = observations.map((obs) => (
    expectedMidi !== null &&
    obs.detectorAccepted &&
    obs.detectedMidi !== null &&
    Math.round(obs.detectedMidi) === expectedMidi
  ));
  const wrongNoteMask = observations.map((obs) => (
    expectedMidi !== null &&
    obs.detectorAccepted &&
    obs.detectedMidi !== null &&
    Math.round(obs.detectedMidi) !== expectedMidi
  ));
  const confidences = accepted.map((obs) => obs.detectorConfidence);
  const maxConfidence = confidences.length > 0 ? Math.max(...confidences) : 0;
  const medianConfidence = confidences.length > 0 ? median(confidences) : 0;
  const runtimeMs = observations.map((obs) => obs.runtimeMs);
  const targetHitCount = targetHitMask.filter(Boolean).length;
  const wrongNoteFrameCount = wrongNoteMask.filter(Boolean).length;
  const anyActivationFrameCount = acceptedFrameCount;
  const targetHitRatio = observations.length > 0 ? targetHitCount / observations.length : 0;
  const wrongNoteRatio = observations.length > 0 ? wrongNoteFrameCount / observations.length : 0;
  const targetConsecutiveFrames = longestConsecutiveTrue(targetHitMask);
  const targetConsecutiveSeconds = targetConsecutiveFrames * probeSpacingSec;
  const windowStartMs = observations[0]?.timestampMs ?? 0;
  const firstTargetHit = observations.find((obs) => (
    expectedMidi !== null &&
    obs.detectorAccepted &&
    obs.detectedMidi !== null &&
    Math.round(obs.detectedMidi) === expectedMidi
  ));
  const firstAnyHit = observations.find((obs) => obs.detectorAccepted && obs.detectedMidi !== null);
  const firstTargetHitLatencyMs = firstTargetHit ? firstTargetHit.timestampMs - windowStartMs : null;
  const firstAnyHitLatencyMs = firstAnyHit ? firstAnyHit.timestampMs - windowStartMs : null;

  return {
    frameCount: observations.length,
    acceptedFrameCount,
    targetHitCount,
    wrongNoteFrameCount,
    anyActivationFrameCount,
    targetHitRatio,
    wrongNoteRatio,
    supportSeconds: targetHitCount * probeSpacingSec,
    targetConsecutiveSeconds,
    maxConfidence,
    medianConfidence,
    firstTargetHitLatencyMs,
    firstAnyHitLatencyMs,
    dominantDetectedMidi,
    dominantDetectedMidiCount,
    rawDetectedMidis,
    runtimeAvgMs: average(runtimeMs),
    runtimeP95Ms: percentile(runtimeMs, 0.95)
  };
}

function positiveRejectReason(input: {
  evidence: MonoWindowEvidence;
  targetRatioThreshold: number;
  supportThresholdSeconds: number;
  confidenceThreshold: number;
  wrongRatioThreshold: number;
  spec: MonoWindowSpec;
}): string {
  if (input.evidence.targetHitRatio < input.targetRatioThreshold) {
    return input.spec.windowKind === 'stable'
      ? 'stable_target_ratio_too_low'
      : 'transition_target_ratio_too_low';
  }
  if (input.evidence.supportSeconds < input.supportThresholdSeconds) {
    return input.spec.windowKind === 'stable'
      ? 'stable_support_seconds_too_low'
      : 'transition_support_seconds_too_low';
  }
  if (input.evidence.wrongNoteRatio > input.wrongRatioThreshold) {
    return input.spec.windowKind === 'stable'
      ? 'stable_wrong_note_ratio_too_high'
      : 'transition_wrong_note_ratio_too_high';
  }
  if (input.evidence.medianConfidence < input.confidenceThreshold) {
    return input.spec.windowKind === 'stable'
      ? 'stable_confidence_too_low'
      : 'transition_confidence_too_low';
  }
  return 'rejected';
}

function emptyRejectReason(evidence: MonoWindowEvidence, config: MonoBenchmarkConfig): string {
  if (evidence.anyActivationFrameCount > 0 && evidence.maxConfidence > config.emptyMaxConfidence) {
    return 'empty_activation_confidence_too_high';
  }
  if (evidence.anyActivationFrameCount > 0) {
    return 'empty_activation_detected';
  }
  return 'empty_window_rejected';
}

function classifyMismatch(spec: MonoWindowSpec, evidence: MonoWindowEvidence): MonoMismatchType {
  if (!spec.expectedAccept) {
    return evidence.anyActivationFrameCount > 0 ? 'false_activation' : 'empty_window';
  }
  if (evidence.dominantDetectedMidi === null) {
    return 'missed_target';
  }
  const expectedMidi = spec.expectedMidi;
  if (expectedMidi === null) {
    return 'empty_window';
  }
  if (evidence.dominantDetectedMidi === expectedMidi) {
    return 'correct_target';
  }
  const diff = evidence.dominantDetectedMidi - expectedMidi;
  if (Math.abs(diff) === 12) {
    return 'octave_distractor';
  }
  if (Math.abs(diff) <= 2) {
    return 'neighbor_note';
  }
  return 'wrong_note';
}

function addWindow(windows: MonoWindowSpec[], window: MonoWindowSpec, durationSec: number): void {
  const startSec = Math.max(0, roundSec(window.startSec));
  const endSec = Math.min(durationSec, roundSec(window.endSec));
  if (endSec <= startSec) return;
  windows.push({
    ...window,
    startSec,
    endSec
  });
}

function stringBandFor(stringId: number): MonoStringBand {
  if (stringId >= 5) return 'low';
  if (stringId >= 3) return 'mid';
  return 'high';
}

function noteLabelFor(midi: number): string {
  return `midi_${midi}`;
}

function roundSec(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length <= 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: number[], q: number): number {
  if (values.length <= 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.max(0, Math.min(1, q));
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function ratio(values: boolean[]): number {
  if (values.length <= 0) return 0;
  return values.filter(Boolean).length / values.length;
}

function longestConsecutiveTrue(values: boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function uniqueSortedFloats(values: number[]): number[] {
  return [...new Set(values.map((value) => roundSec(value)))].sort((a, b) => a - b);
}

function uniqueSortedIntegers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
}

function mostCommonNumber(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
}

function flatten(values: number[][]): number[] {
  return values.flatMap((value) => value);
}
