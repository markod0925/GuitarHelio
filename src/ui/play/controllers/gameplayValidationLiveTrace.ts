import { midiToNoteName } from '../../../ui/song-select/utils/songSelectUtils';
import { buildValidationTargetFromTargetGroup, buildValidatorFrameEvidenceFromPitchFrame, RealtimeGameplayValidator, type RuntimeValidatorOutput, type ValidationTarget, type ValidatorFrameEvidence } from '../../../gameplay/validation';
import type { PitchFrame, TargetNote } from '../../../types/models';
import type { ValidationWindowState } from '../../playSceneTypes';

export type GameplayValidationLiveCandidate = {
  midi: number;
  noteName: string;
  score: number;
  rank: number;
  expected: boolean;
  acceptable: boolean;
};

export type GameplayValidationLiveWindowOutcome =
  | 'accepted'
  | 'expired'
  | 'suppressed'
  | 'no_target'
  | 'dead_time';

export type GameplayValidationLiveTraceFrame = {
  timestampMs: number;
  songSeconds: number | null;
  windowPhase: ValidationWindowState['phase'];
  deadTime: boolean;
  targetKey: string | null;
  targetMode: 'mono' | 'poly' | null;
  target: ValidationTarget | null;
  frameEvidence: ValidatorFrameEvidence | null;
  runtimeOutput: Pick<
    RuntimeValidatorOutput,
    'accepted' | 'acceptedPreGate' | 'acceptedPostGate' | 'rejectStage' | 'rejectReasons' | 'gateRejectReason' | 'noteValidationRatio' | 'confidence'
  > | null;
  topCandidates: GameplayValidationLiveCandidate[];
  confirmationState: 'confirmed' | 'near' | 'far' | 'suppressed' | 'idle';
  summary: string;
};

export type GameplayValidationLiveWindowTrace = {
  windowId: string;
  targetKey: string | null;
  targetMode: 'mono' | 'poly' | null;
  target: ValidationTarget | null;
  difficulty: 'Easy' | 'Medium' | 'Hard' | null;
  semitoneTolerance: number | null;
  windowStartSeconds: number | null;
  windowEndSeconds: number | null;
  armedAtMs: number | null;
  acceptedAtMs: number | null;
  expiredAtMs: number | null;
  acceptedAtSongSeconds: number | null;
  expiredAtSongSeconds: number | null;
  outcome: GameplayValidationLiveWindowOutcome;
  outcomeReason: string;
  samples: GameplayValidationLiveTraceFrame[];
};

export type GameplayValidationLiveTraceMetrics = {
  armedWindows: number;
  // Acceptance metrics are counted per logical armed window / run, never per accepted sample.
  acceptedWindows: number;
  expiredWindows: number;
  suppressedWindows: number;
  noTargetWindows: number;
  deadTimeWindows: number;
  gateSuppressedWindows: number;
  windowsWithTopCandidateConfirmation: number;
  windowsWithNoMeaningfulEvidence: number;
  earlyAcceptWindows: number;
  lateAcceptWindows: number;
  timeoutMissWindows: number;
  totalSamples: number;
  averageConfirmationLatencyMs: number | null;
  medianConfirmationLatencyMs: number | null;
};

export type GameplayValidationLiveTraceSession = {
  sessionStartedAtMs: number;
  updatedAtMs: number;
  activeWindowIndex: number | null;
  windows: GameplayValidationLiveWindowTrace[];
  metrics: GameplayValidationLiveTraceMetrics;
};

type TraceInput = {
  timestampMs: number;
  songSecondsNow: number | undefined;
  frame?: PitchFrame;
  validationWindow: ValidationWindowState;
  runtimeOutput: RuntimeValidatorOutput | undefined;
  targetGroup: TargetNote[];
  difficulty: 'Easy' | 'Medium' | 'Hard' | null;
};

export function createGameplayValidationLiveTraceSession(nowMs: number = performance.now()): GameplayValidationLiveTraceSession {
  return {
    sessionStartedAtMs: nowMs,
    updatedAtMs: nowMs,
    activeWindowIndex: null,
    windows: [],
    metrics: {
      armedWindows: 0,
      acceptedWindows: 0,
      expiredWindows: 0,
      suppressedWindows: 0,
      noTargetWindows: 0,
      deadTimeWindows: 0,
      gateSuppressedWindows: 0,
      windowsWithTopCandidateConfirmation: 0,
      windowsWithNoMeaningfulEvidence: 0,
      earlyAcceptWindows: 0,
      lateAcceptWindows: 0,
      timeoutMissWindows: 0,
      totalSamples: 0,
      averageConfirmationLatencyMs: null,
      medianConfirmationLatencyMs: null
    }
  };
}

export function resetGameplayValidationLiveTraceSession(session: GameplayValidationLiveTraceSession, nowMs: number = performance.now()): void {
  session.sessionStartedAtMs = nowMs;
  session.updatedAtMs = nowMs;
  session.activeWindowIndex = null;
  session.windows = [];
  session.metrics = createGameplayValidationLiveTraceSession(nowMs).metrics;
}

export function recordGameplayValidationLiveTrace(session: GameplayValidationLiveTraceSession, input: TraceInput): void {
  session.updatedAtMs = input.timestampMs;

  const target = buildValidationTargetFromTargetGroup(input.targetGroup, input.difficulty ?? undefined);
  const currentWindowId = resolveWindowId(input.validationWindow);
  const activeWindow = session.activeWindowIndex !== null ? session.windows[session.activeWindowIndex] : undefined;
  const shouldHaveWindow = input.validationWindow.phase === 'armed' || input.validationWindow.phase === 'accepted' || input.validationWindow.phase === 'expired';
  const lastSample = activeWindow?.samples[activeWindow.samples.length - 1];

  if (
    lastSample &&
    lastSample.timestampMs === input.timestampMs &&
    lastSample.windowPhase === input.validationWindow.phase &&
    lastSample.targetKey === input.validationWindow.targetKey
  ) {
    session.updatedAtMs = input.timestampMs;
    refreshSessionMetrics(session);
    return;
  }

  if (activeWindow && currentWindowId !== activeWindow.windowId) {
    finalizeWindow(activeWindow, input.validationWindow, input.runtimeOutput, input.timestampMs);
    session.activeWindowIndex = null;
  }

  if (!shouldHaveWindow) {
    if (activeWindow && activeWindow.outcome === 'suppressed' && activeWindow.samples.length === 0) {
      activeWindow.outcome = input.validationWindow.lastReason === 'no_target' ? 'no_target' : 'dead_time';
      activeWindow.outcomeReason = input.validationWindow.lastReason;
      activeWindow.expiredAtMs = input.timestampMs;
      activeWindow.expiredAtSongSeconds = input.songSecondsNow ?? activeWindow.expiredAtSongSeconds;
    }
    refreshSessionMetrics(session);
    return;
  }

  let windowTrace = activeWindow;
  if (!windowTrace && currentWindowId !== null) {
    const lastWindow = session.windows[session.windows.length - 1];
    if (lastWindow?.windowId === currentWindowId) {
      windowTrace = lastWindow;
      session.activeWindowIndex = session.windows.length - 1;
    }
  }
  if (!windowTrace) {
    windowTrace = {
      windowId: currentWindowId ?? resolveWindowId(input.validationWindow, input.timestampMs) ?? `window-${input.timestampMs}`,
      targetKey: input.validationWindow.targetKey,
      targetMode: input.validationWindow.targetMode,
      target,
      difficulty: input.validationWindow.difficulty,
      semitoneTolerance: input.validationWindow.semitoneTolerance,
      windowStartSeconds: input.validationWindow.windowStartSeconds,
      windowEndSeconds: input.validationWindow.windowEndSeconds,
      armedAtMs: input.validationWindow.armedAtMs,
      acceptedAtMs: null,
      expiredAtMs: null,
      acceptedAtSongSeconds: null,
      expiredAtSongSeconds: null,
      outcome: 'dead_time',
      outcomeReason: input.validationWindow.lastReason,
      samples: []
    };
    session.windows.push(windowTrace);
    session.activeWindowIndex = session.windows.length - 1;
    session.metrics.armedWindows += 1;
  }

  const frameEvidence = input.frame ? buildValidatorFrameEvidenceFromPitchFrame(input.frame, input.timestampMs, target) : null;
  const topCandidates = input.frame
    ? buildTopCandidates(input.frame, target?.midiNotes ?? [], input.validationWindow.semitoneTolerance)
    : [];
  const runtimeOutput = input.runtimeOutput
    ? {
        accepted: input.runtimeOutput.accepted,
        acceptedPreGate: input.runtimeOutput.acceptedPreGate,
        acceptedPostGate: input.runtimeOutput.acceptedPostGate,
        rejectStage: input.runtimeOutput.rejectStage,
        rejectReasons: input.runtimeOutput.rejectReasons,
        gateRejectReason: input.runtimeOutput.gateRejectReason,
        noteValidationRatio: input.runtimeOutput.noteValidationRatio,
        confidence: input.runtimeOutput.confidence
      }
    : null;

  windowTrace.samples.push({
    timestampMs: input.timestampMs,
    songSeconds: input.songSecondsNow ?? null,
    windowPhase: input.validationWindow.phase,
    deadTime: input.validationWindow.deadTime,
    targetKey: input.validationWindow.targetKey,
    targetMode: input.validationWindow.targetMode,
    target,
    frameEvidence,
    runtimeOutput,
    topCandidates,
    confirmationState: resolveConfirmationState(input.validationWindow, input.runtimeOutput),
    summary: buildFrameSummary(input.validationWindow, input.runtimeOutput, topCandidates)
  });

  session.metrics.totalSamples += 1;

  if (input.validationWindow.phase === 'accepted') {
    windowTrace.acceptedAtMs = input.timestampMs;
    windowTrace.acceptedAtSongSeconds = input.validationWindow.acceptedAtSongSeconds ?? input.songSecondsNow ?? null;
    windowTrace.outcome = 'accepted';
    windowTrace.outcomeReason = input.validationWindow.lastReason;
  } else if (input.validationWindow.phase === 'expired') {
    windowTrace.expiredAtMs = input.timestampMs;
    windowTrace.expiredAtSongSeconds = input.validationWindow.expiredAtSongSeconds ?? input.songSecondsNow ?? null;
    windowTrace.outcome = resolveTerminalOutcome(input.validationWindow, input.runtimeOutput);
    windowTrace.outcomeReason = input.validationWindow.lastReason;
  } else if (input.runtimeOutput?.acceptedPostGate) {
    windowTrace.acceptedAtMs = input.timestampMs;
    windowTrace.acceptedAtSongSeconds = input.songSecondsNow ?? null;
    windowTrace.outcome = 'accepted';
    windowTrace.outcomeReason = 'accepted';
  }

  refreshSessionMetrics(session);
}

export function summarizeGameplayValidationLiveTrace(session: GameplayValidationLiveTraceSession): GameplayValidationLiveTraceMetrics {
  refreshSessionMetrics(session);
  return session.metrics;
}

export function replayGameplayValidationLiveTrace(
  session: GameplayValidationLiveTraceSession,
  validator: RealtimeGameplayValidator = new RealtimeGameplayValidator()
): {
  acceptedWindows: number;
  mismatchedWindows: number;
  replayedWindows: number;
} {
  let acceptedWindows = 0;
  let mismatchedWindows = 0;
  let replayedWindows = 0;

  for (const windowTrace of session.windows) {
    if (!windowTrace.target) continue;
    validator.reset();
    validator.setTarget(windowTrace.target);
    let lastOutput: RuntimeValidatorOutput | undefined;
    for (const sample of windowTrace.samples) {
      if (!sample.frameEvidence) continue;
      lastOutput = validator.update({
        timestampMs: sample.timestampMs,
        frameEvidence: sample.frameEvidence
      });
    }
    if (lastOutput?.accepted) {
      acceptedWindows += 1;
    }
    if ((lastOutput?.accepted ? 'accepted' : 'rejected') !== windowTrace.outcome && windowTrace.outcome !== 'dead_time') {
      mismatchedWindows += 1;
    }
    replayedWindows += 1;
  }

  return {
    acceptedWindows,
    mismatchedWindows,
    replayedWindows
  };
}

export function serializeGameplayValidationLiveTrace(session: GameplayValidationLiveTraceSession): string {
  return JSON.stringify(session, null, 2);
}

function resolveWindowId(windowState: ValidationWindowState, fallbackTimestampMs?: number): string | null {
  if (windowState.targetKey === null) return null;
  const armKey = windowState.armedAtMs ?? windowState.lastSetTargetAtMs ?? fallbackTimestampMs ?? performance.now();
  return `${windowState.targetKey}@${armKey}`;
}

function finalizeWindow(
  windowTrace: GameplayValidationLiveWindowTrace,
  windowState: ValidationWindowState,
  runtimeOutput: RuntimeValidatorOutput | undefined,
  timestampMs: number
): void {
  if (windowTrace.outcome === 'accepted' || windowTrace.outcome === 'expired') {
    return;
  }
  windowTrace.outcome = resolveTerminalOutcome(windowState, runtimeOutput);
  windowTrace.outcomeReason = windowState.lastReason;
  if (windowTrace.outcome === 'expired') {
    windowTrace.expiredAtMs = timestampMs;
    windowTrace.expiredAtSongSeconds = windowState.expiredAtSongSeconds ?? null;
  }
}

function resolveTerminalOutcome(
  windowState: ValidationWindowState,
  runtimeOutput: RuntimeValidatorOutput | undefined
): GameplayValidationLiveWindowOutcome {
  if (windowState.phase === 'accepted' || runtimeOutput?.acceptedPostGate) {
    return 'accepted';
  }
  if (windowState.phase === 'expired') {
    return 'expired';
  }
  if (runtimeOutput?.rejectStage === 'gate' || runtimeOutput?.gateRejectReason != null) {
    return 'suppressed';
  }
  if (windowState.targetKey === null || windowState.lastReason === 'no_target') {
    return 'no_target';
  }
  if (windowState.deadTime) {
    return 'dead_time';
  }
  return 'suppressed';
}

function resolveConfirmationState(
  windowState: ValidationWindowState,
  runtimeOutput: RuntimeValidatorOutput | undefined
): GameplayValidationLiveTraceFrame['confirmationState'] {
  if (runtimeOutput?.acceptedPostGate) {
    return 'confirmed';
  }
  if (windowState.deadTime) {
    return runtimeOutput?.rejectStage === 'gate' ? 'suppressed' : 'idle';
  }
  if (windowState.phase === 'armed') {
    if (runtimeOutput?.acceptedPreGate) {
      return 'near';
    }
    return runtimeOutput?.noteValidationRatio !== undefined && runtimeOutput.noteValidationRatio > 0 ? 'near' : 'far';
  }
  if (runtimeOutput?.rejectStage === 'gate') {
    return 'suppressed';
  }
  return windowState.phase === 'accepted' ? 'confirmed' : 'idle';
}

function buildFrameSummary(
  windowState: ValidationWindowState,
  runtimeOutput: RuntimeValidatorOutput | undefined,
  topCandidates: GameplayValidationLiveCandidate[]
): string {
  const bestCandidate = topCandidates[0];
  const candidateLabel = bestCandidate ? `${bestCandidate.rank}:${bestCandidate.midi}` : '-';
  const ratio = runtimeOutput?.noteValidationRatio ?? 0;
  const status = resolveConfirmationState(windowState, runtimeOutput);
  return `status=${status} ratio=${ratio.toFixed(2)} top=${candidateLabel}`;
}

function buildTopCandidates(
  frame: PitchFrame,
  expectedMidis: number[],
  semitoneTolerance: number | null
): GameplayValidationLiveCandidate[] {
  const fallbackScore = frame.confidence ?? 0;
  const sortedNotes = [...(Array.isArray(frame.selected_notes) ? frame.selected_notes : [])].sort((left, right) => {
    const leftScore = left.score ?? fallbackScore;
    const rightScore = right.score ?? fallbackScore;
    return rightScore - leftScore || left.midi - right.midi;
  });
  const deduped = new Map<number, GameplayValidationLiveCandidate>();
  for (const note of sortedNotes) {
    if (!Number.isFinite(note.midi)) continue;
    const midi = Math.round(note.midi);
    if (deduped.has(midi)) continue;
    deduped.set(midi, {
      midi,
      noteName: midiToNoteName(midi),
      score: note.score ?? fallbackScore,
      rank: deduped.size + 1,
      expected: expectedMidis.includes(midi),
      acceptable: isAcceptableMidi(expectedMidis, midi, semitoneTolerance)
    });
    if (deduped.size >= 5) break;
  }
  if (deduped.size === 0 && frame.midi_estimate !== null && frame.midi_estimate !== undefined && Number.isFinite(frame.midi_estimate)) {
    const midi = Math.round(frame.midi_estimate);
    deduped.set(midi, {
      midi,
      noteName: midiToNoteName(midi),
      score: fallbackScore,
      rank: 1,
      expected: expectedMidis.includes(midi),
      acceptable: isAcceptableMidi(expectedMidis, midi, semitoneTolerance)
    });
  }
  return [...deduped.values()];
}

function isAcceptableMidi(expectedMidis: number[], midi: number, semitoneTolerance: number | null): boolean {
  if (semitoneTolerance === null) return expectedMidis.includes(midi);
  return expectedMidis.some((expectedMidi) => Math.abs(expectedMidi - midi) <= semitoneTolerance + 1e-9);
}

function refreshSessionMetrics(session: GameplayValidationLiveTraceSession): void {
  const latencies: number[] = [];
  let acceptedWindows = 0;
  let expiredWindows = 0;
  let suppressedWindows = 0;
  let noTargetWindows = 0;
  let deadTimeWindows = 0;
  let gateSuppressedWindows = 0;
  let windowsWithTopCandidateConfirmation = 0;
  let windowsWithNoMeaningfulEvidence = 0;
  let earlyAcceptWindows = 0;
  let lateAcceptWindows = 0;
  let timeoutMissWindows = 0;
  let totalSamples = 0;

  for (const windowTrace of session.windows) {
    totalSamples += windowTrace.samples.length;
    if (windowTrace.outcome === 'accepted') {
      acceptedWindows += 1;
      if (windowTrace.armedAtMs !== null && windowTrace.acceptedAtMs !== null) {
        latencies.push(windowTrace.acceptedAtMs - windowTrace.armedAtMs);
      }
      if (windowTrace.acceptedAtSongSeconds !== null) {
        if (windowTrace.windowStartSeconds !== null && windowTrace.acceptedAtSongSeconds < windowTrace.windowStartSeconds) {
          earlyAcceptWindows += 1;
        } else if (windowTrace.windowEndSeconds !== null && windowTrace.acceptedAtSongSeconds > windowTrace.windowEndSeconds) {
          lateAcceptWindows += 1;
        }
      }
    } else if (windowTrace.outcome === 'expired') {
      expiredWindows += 1;
      timeoutMissWindows += 1;
    } else if (windowTrace.outcome === 'suppressed') {
      suppressedWindows += 1;
      gateSuppressedWindows += 1;
    } else if (windowTrace.outcome === 'no_target') {
      noTargetWindows += 1;
    } else {
      deadTimeWindows += 1;
    }

    if (windowTrace.samples.some((sample) => sample.topCandidates.some((candidate) => candidate.expected))) {
      windowsWithTopCandidateConfirmation += 1;
    }
    if (windowTrace.samples.length > 0 && windowTrace.samples.every((sample) => sample.topCandidates.every((candidate) => !candidate.expected))) {
      windowsWithNoMeaningfulEvidence += 1;
    }
  }

  session.metrics = {
    armedWindows: session.windows.length,
    acceptedWindows,
    expiredWindows,
    suppressedWindows,
    noTargetWindows,
    deadTimeWindows,
    gateSuppressedWindows,
    windowsWithTopCandidateConfirmation,
    windowsWithNoMeaningfulEvidence,
    earlyAcceptWindows,
    lateAcceptWindows,
    timeoutMissWindows,
    totalSamples,
    averageConfirmationLatencyMs: latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    medianConfirmationLatencyMs: median(latencies)
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}
