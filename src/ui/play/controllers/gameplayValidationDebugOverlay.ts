import { midiToNoteName } from '../../../ui/song-select/utils/songSelectUtils';
import { resolveTargetGroup } from '../../../guitar/targetGrouping';
import { resolveDifficultySemitoneTolerance } from '../../../gameplay/validation';
import { PlayState, type PitchFrame, type TargetNote } from '../../../types/models';
import { summarizeGameplayValidationLiveTrace } from './gameplayValidationLiveTrace';
import type {
  GameplayValidationDebugCandidate,
  GameplayValidationDebugSeverity,
  GameplayValidationDebugSnapshot,
  ValidationWindowState
} from '../../playSceneTypes';
import { formatDebugBool, formatDebugNumber, formatSignedMs } from '../../playSceneDebug';
import type { PlaySceneContext } from './PlaySceneContext';
import {
  describeGameplayValidationDebugLogLocation,
  recordGameplayValidationDebugLog
} from './gameplayValidationDebugLog';

const TOP_CANDIDATE_LIMIT = 5;
const FRAME_CHANGE_THRESHOLD_MS = 34;

export type GameplayValidationDebugPalette = {
  panelStroke: number;
  textColor: string;
  accentColor: number;
};

export function buildGameplayValidationDebugSnapshot(
  scene: PlaySceneContext,
  nowMs: number = performance.now()
): GameplayValidationDebugSnapshot {
  const validationWindow = scene.validationWindowState;
  const activeGroup = resolveTargetGroup(scene.targets, scene.runtime.active_target_index);
  const target = activeGroup[0];
  const latestFrame = scene.latestFrames.latest();
  const targetKey = validationWindow?.targetKey ?? (activeGroup.length > 0 ? buildTargetKey(activeGroup) : null);
  const targetMode = validationWindow?.targetMode ?? (activeGroup.length > 1 ? 'poly' : activeGroup.length === 1 ? 'mono' : null);
  const difficulty = validationWindow?.difficulty ?? scene.sceneData?.difficulty ?? null;
  const semitoneTolerance = validationWindow?.semitoneTolerance ?? (difficulty !== null ? resolveDifficultySemitoneTolerance(difficulty) : null);
  const expectedMidis = activeGroup.map((item) => item.expected_midi);
  const expectedNames = expectedMidis.map((midi) => midiToNoteName(midi));

  const playbackSongSeconds =
    scene.playbackStarted && scene.runtime.state === PlayState.Playing
      ? scene.getSongSecondsNow()
      : scene.pausedSongSeconds;
  const targetSongSeconds =
    target && scene.tempoMap ? scene.tempoMap.tickToSeconds(target.tick) : null;
  const targetDeltaMs =
    playbackSongSeconds !== undefined && targetSongSeconds !== null
      ? (playbackSongSeconds - targetSongSeconds) * 1000
      : null;
  const validationWindowActive = validationWindow?.phase === 'armed' && validationWindow.deadTime === false;

  const runtimeOutput = scene.realtimeValidationOutput;
  const runtimeState = scene.realtimeValidationState;
  const noteEvidence = runtimeState?.noteDecisions?.[0]?.evidence;
  const liveTraceMetrics = scene.gameplayValidationLiveTrace ? summarizeGameplayValidationLiveTrace(scene.gameplayValidationLiveTrace) : null;
  const allCandidates = buildTopCandidates(latestFrame, expectedMidis, semitoneTolerance ?? Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const topCandidates = allCandidates.slice(0, TOP_CANDIDATE_LIMIT);
  const bestCompetitor = resolveBestCompetitor(allCandidates, expectedMidis, semitoneTolerance);
  const octaveCompetitor = resolveOctaveCompetitor(allCandidates, expectedMidis);
  const expectedRanks = expectedMidis.length > 0
    ? expectedMidis
        .map((midi) => {
          const match = topCandidates.find((candidate) => candidate.midi === midi);
          return `${midiToNoteName(midi)}@${match ? match.rank : '-'}`;
        })
        .join(', ')
    : '-';

  const rawDetectionMaxConfidence = noteEvidence?.rawDetectionMaxConfidence ?? latestFrame?.confidence ?? null;
  const rawDetectionFrameRatio = noteEvidence?.rawDetectionFrameRatio ?? resolveRawDetectionFrameRatio(latestFrame);
  const targetChangedThisFrame =
    validationWindow?.lastTargetChangeAtMs !== null &&
    validationWindow?.lastTargetChangeAtMs !== undefined &&
    nowMs - validationWindow.lastTargetChangeAtMs <= FRAME_CHANGE_THRESHOLD_MS;
  const selectedNoteCount = Array.isArray(latestFrame?.selected_notes) ? latestFrame.selected_notes.length : 0;
  const stabilizerLockedMidi = scene.gameplayPitchStabilizer?.getLockedMidi() ?? null;

  const snapshot: GameplayValidationDebugSnapshot = {
      capturedAtMs: nowMs,
      severity: resolveSeverity(validationWindow, runtimeOutput, allCandidates, expectedMidis, playbackSongSeconds, targetSongSeconds, semitoneTolerance),
      playbackSongSeconds: playbackSongSeconds ?? null,
      targetSongSeconds,
      targetDeltaMs,
      inActiveToleranceWindow: validationWindowActive,
    window: {
      phase: validationWindow?.phase ?? 'idle',
      deadTime: validationWindow?.deadTime ?? true,
      targetKey,
      targetMode,
      currentArmedTargetId: validationWindow?.phase === 'armed' ? targetKey : null,
      targetIds: validationWindow?.targetIds ?? activeGroup.map((item) => item.id),
      windowStartSeconds: validationWindow?.windowStartSeconds ?? null,
      windowEndSeconds: validationWindow?.windowEndSeconds ?? null,
      earlyToleranceSeconds: validationWindow?.earlyToleranceSeconds ?? null,
      lateToleranceSeconds: validationWindow?.lateToleranceSeconds ?? null,
      lastReason: validationWindow?.lastReason ?? 'unknown',
      targetChangedThisFrame,
      lastSetTargetAtMs: validationWindow?.lastSetTargetAtMs ?? null,
      lastResetAtMs: validationWindow?.lastResetAtMs ?? null,
      lastTargetChangeAtMs: validationWindow?.lastTargetChangeAtMs ?? null,
      setTargetCount: validationWindow?.setTargetCount ?? 0,
      resetCount: validationWindow?.resetCount ?? 0,
      armCount: validationWindow?.armCount ?? 0
    },
      target: {
      difficulty,
      semitoneTolerance,
      expectedMidis,
      expectedNames,
      targetKey,
      targetIds: validationWindow?.targetIds ?? activeGroup.map((item) => item.id),
      targetMode,
      aggregationPolicyId: validationWindow?.aggregationPolicyId ?? null,
      activationGatePolicyId: validationWindow?.activationGatePolicyId ?? null,
      noteDecisionConfigId: validationWindow?.noteDecisionConfigId ?? null
    },
    spectral: {
      topCandidates,
      expectedRanks,
      bestCompetitor: bestCompetitor ?? { midi: null, noteName: null, score: null },
      octaveCompetitor: octaveCompetitor ?? { midi: null, noteName: null, score: null },
      rawDetectionMaxConfidence,
      rawDetectionFrameRatio,
      expectedNotePresent: allCandidates.some((candidate) => isAcceptableMidi(expectedMidis, candidate.midi, semitoneTolerance)),
      bestNoteId: latestFrame?.best_note_id ?? null,
      latestMidiEstimate: latestFrame?.midi_estimate ?? null,
      latestConfidence: latestFrame?.confidence ?? null
    },
    detector: {
      latestMidiEstimate: latestFrame?.midi_estimate ?? null,
      latestConfidence: latestFrame?.confidence ?? null,
      selectedNoteCount,
      bestNoteId: latestFrame?.best_note_id ?? null,
      micRms: latestFrame?.mic_rms ?? null,
      referenceMidi: latestFrame?.reference_midi ?? null,
      referenceCorrelation: latestFrame?.reference_correlation ?? null,
      energyRatioDb: latestFrame?.energy_ratio_db ?? null,
      onsetStrength: latestFrame?.onset_strength ?? null,
      contaminationScore: latestFrame?.contamination_score ?? null,
      rejectedAsReferenceBleed: latestFrame?.rejected_as_reference_bleed ?? null,
      stabilizerLockedMidi
    },
      runtime: {
      acceptedPreGate: runtimeOutput?.acceptedPreGate ?? false,
      acceptedPostGate: runtimeOutput?.acceptedPostGate ?? false,
      noteValidationRatio: runtimeOutput?.noteValidationRatio ?? 0,
      frameCount: runtimeState?.frameCount ?? 0,
      targetStartedAtMs: runtimeState?.targetStartedAtMs ?? null,
      validatedNotes: runtimeOutput?.validatedNotes ?? [],
      noteDecisions: runtimeState?.noteDecisions?.map((decision) => ({
        midi: decision.midi,
        accepted: decision.accepted,
        decisionReason: decision.decisionReason,
        matchedMidi: decision.evidence.matchedMidi,
        matchedSemitoneDistance: decision.evidence.matchedSemitoneDistance,
        targetSemitoneTolerance: decision.evidence.targetSemitoneTolerance,
        supportFrames: decision.evidence.supportFrames,
        supportSeconds: decision.evidence.supportSeconds,
        minValidatedSupportFrames: decision.evidence.minValidatedSupportFrames,
        minValidatedSupportSeconds: decision.evidence.minValidatedSupportSeconds,
        confidenceScore: decision.evidence.confidenceScore,
        expectedVsSourceFrameRatio: decision.evidence.expectedVsSourceFrameRatio,
        targetConfirmationFrameRatio: decision.evidence.targetConfirmationFrameRatio,
        expectedTop1FrameRatio: decision.evidence.expectedTop1FrameRatio,
        expectedTop3FrameRatio: decision.evidence.expectedTop3FrameRatio,
        octaveConfusionFrameRatio: decision.evidence.octaveConfusionFrameRatio,
        rawDetectionFrameRatio: decision.evidence.rawDetectionFrameRatio,
        rawDetectionMaxConfidence: decision.evidence.rawDetectionMaxConfidence
      })) ?? [],
      live: liveTraceMetrics
        ? {
            ...liveTraceMetrics,
            confirmationState: resolveConfirmationState(validationWindow, runtimeOutput, allCandidates, expectedMidis, playbackSongSeconds, targetSongSeconds, semitoneTolerance)
          }
        : null,
      missingNotes: runtimeOutput?.missingNotes ?? [],
      extraNotes: runtimeOutput?.extraNotes ?? [],
      rejectReasons: runtimeOutput?.rejectReasons ?? [],
      rejectStage: runtimeOutput?.rejectStage ?? 'none',
      gateRejectReason: runtimeOutput?.gateRejectReason ?? null,
      confidence: runtimeOutput?.confidence ?? 0,
      summary: buildRuntimeSummary(runtimeOutput)
    }
  };

  return snapshot;
}

export function formatGameplayValidationDebugSnapshot(snapshot: GameplayValidationDebugSnapshot): string[] {
  const paletteLabel = snapshot.severity === 'good' ? 'GOOD' : snapshot.severity === 'warning' ? 'WARN' : 'DANGER';
  const targetLabel = snapshot.target.targetMode ?? '-';
  const activeWindowLabel = formatDebugBool(snapshot.inActiveToleranceWindow);
  const toleranceLabel = snapshot.target.semitoneTolerance !== null ? `±${formatDebugNumber(snapshot.target.semitoneTolerance, snapshot.target.semitoneTolerance % 1 === 0 ? 0 : 1)}st` : '-';
  const lastSetTargetAge = snapshot.window.lastSetTargetAtMs !== null
    ? formatSignedMs(snapshot.capturedAtMs - snapshot.window.lastSetTargetAtMs)
    : '-';
  const lastResetAge = snapshot.window.lastResetAtMs !== null
    ? formatSignedMs(snapshot.capturedAtMs - snapshot.window.lastResetAtMs)
    : '-';
  const topCandidateSummary = snapshot.spectral.topCandidates.length > 0
    ? snapshot.spectral.topCandidates
        .map((candidate) => `${candidate.rank}:${candidate.midi} ${candidate.noteName} ${formatDebugNumber(candidate.score, 2)}${candidate.expected ? '*' : candidate.acceptable ? '+' : ''}`)
        .join(' | ')
    : '-';
  const noteDecisionSummary = snapshot.runtime.noteDecisions.length > 0
    ? snapshot.runtime.noteDecisions
        .map((decision) => formatNoteDecisionSummary(snapshot.target.expectedMidis, decision, snapshot.target.semitoneTolerance))
        .join(' | ')
    : '-';
  const targetAgeMs = snapshot.runtime.targetStartedAtMs !== null ? snapshot.capturedAtMs - snapshot.runtime.targetStartedAtMs : null;
  const referenceBleedLabel = snapshot.detector.rejectedAsReferenceBleed === null
    ? '-'
    : formatDebugBool(snapshot.detector.rejectedAsReferenceBleed);

  const lines = [
    `Gameplay Validation Debug [${paletteLabel}]`,
    `Timing: phase=${snapshot.window.phase} dead=${formatDebugBool(snapshot.window.deadTime)} activeWindow=${activeWindowLabel} difficulty=${snapshot.target.difficulty ?? '-'} tol=${toleranceLabel} song=${formatDebugNumber(snapshot.playbackSongSeconds, 3)}s target=${formatDebugNumber(snapshot.targetSongSeconds, 3)}s dt=${formatSignedMs(snapshot.targetDeltaMs ?? undefined)} early=${formatDebugNumber(snapshot.window.earlyToleranceSeconds, 3)}s late=${formatDebugNumber(snapshot.window.lateToleranceSeconds, 3)}s`,
    `Target: mode=${targetLabel} armed=${snapshot.window.currentArmedTargetId ?? '-'} key=${snapshot.target.targetKey ?? '-'} expected=${formatCanonicalTargets(snapshot.target.expectedMidis, snapshot.target.expectedNames, snapshot.target.semitoneTolerance)} ranks=${snapshot.spectral.expectedRanks} agg=${snapshot.target.aggregationPolicyId ?? '-'} gate=${snapshot.target.activationGatePolicyId ?? '-'} noteCfg=${snapshot.target.noteDecisionConfigId ?? '-'}`,
    `Spectral: top5=${topCandidateSummary}`,
    `Spectral: bestComp=${formatCandidatePeer(snapshot.spectral.bestCompetitor)} octave=${formatCandidatePeer(snapshot.spectral.octaveCompetitor)} rawMax=${formatDebugNumber(snapshot.spectral.rawDetectionMaxConfidence, 2)} frameRatio=${formatDebugNumber(snapshot.spectral.rawDetectionFrameRatio, 2)} expectedPresent=${formatDebugBool(snapshot.spectral.expectedNotePresent)} bestNote=${snapshot.spectral.bestNoteId ?? '-'}`,
    `Detector: midi=${formatDebugNumber(snapshot.detector.latestMidiEstimate, 2)} conf=${formatDebugNumber(snapshot.detector.latestConfidence, 2)} selected=${snapshot.detector.selectedNoteCount} locked=${snapshot.detector.stabilizerLockedMidi ?? '-'} micRms=${formatDebugNumber(snapshot.detector.micRms, 3)} ref=${formatDebugNumber(snapshot.detector.referenceMidi, 2)} corr=${formatDebugNumber(snapshot.detector.referenceCorrelation, 3)} eDb=${formatDebugNumber(snapshot.detector.energyRatioDb, 2)} onset=${formatDebugNumber(snapshot.detector.onsetStrength, 3)} contam=${formatDebugNumber(snapshot.detector.contaminationScore, 3)} bleed=${referenceBleedLabel}`,
    `Runtime: pre=${formatDebugBool(snapshot.runtime.acceptedPreGate)} post=${formatDebugBool(snapshot.runtime.acceptedPostGate)} ratio=${formatDebugNumber(snapshot.runtime.noteValidationRatio, 2)} conf=${formatDebugNumber(snapshot.runtime.confidence, 2)} validated=${formatMidiList(snapshot.runtime.validatedNotes)} missing=${formatMidiList(snapshot.runtime.missingNotes)} extra=${formatMidiList(snapshot.runtime.extraNotes)} stage=${snapshot.runtime.rejectStage}`,
    `Runtime: history=frames${snapshot.runtime.frameCount} targetAge=${formatSignedMs(targetAgeMs ?? undefined)} targetStarted=${snapshot.runtime.targetStartedAtMs !== null ? formatSignedMs(snapshot.capturedAtMs - snapshot.runtime.targetStartedAtMs) : '-'}`,
    `Runtime: notes=${noteDecisionSummary}`,
    `Runtime: gate=${snapshot.runtime.gateRejectReason ?? '-'} reasons=${snapshot.runtime.rejectReasons.length > 0 ? snapshot.runtime.rejectReasons.join('|') : '-'} summary=${snapshot.runtime.summary}`,
    snapshot.runtime.live
      ? `Live: state=${snapshot.runtime.live.confirmationState} armed=${snapshot.runtime.live.armedWindows} accepted=${snapshot.runtime.live.acceptedWindows} expired=${snapshot.runtime.live.expiredWindows} suppressed=${snapshot.runtime.live.suppressedWindows} dead=${snapshot.runtime.live.deadTimeWindows} noTarget=${snapshot.runtime.live.noTargetWindows} medianLatency=${formatDebugNumber(snapshot.runtime.live.medianConfirmationLatencyMs, 0)}ms avgLatency=${formatDebugNumber(snapshot.runtime.live.averageConfirmationLatencyMs, 0)}ms topConfirm=${snapshot.runtime.live.windowsWithTopCandidateConfirmation} noEvidence=${snapshot.runtime.live.windowsWithNoMeaningfulEvidence}`
      : 'Live: -',
    `Reset: changed=${formatDebugBool(snapshot.window.targetChangedThisFrame)} setTarget=${snapshot.window.setTargetCount} reset=${snapshot.window.resetCount} arm=${snapshot.window.armCount} lastSet=${lastSetTargetAge} lastReset=${lastResetAge} changeAt=${snapshot.window.lastTargetChangeAtMs !== null ? formatSignedMs(snapshot.capturedAtMs - snapshot.window.lastTargetChangeAtMs) : '-'}`,
    `Log: ${describeGameplayValidationDebugLogLocation()}`
  ];

  recordGameplayValidationDebugLog(snapshot, lines);
  return lines;
}

export function resolveGameplayValidationDebugPalette(severity: GameplayValidationDebugSeverity): GameplayValidationDebugPalette {
  if (severity === 'good') {
    return {
      panelStroke: 0x22c55e,
      textColor: '#dcfce7',
      accentColor: 0x22c55e
    };
  }
  if (severity === 'warning') {
    return {
      panelStroke: 0xfacc15,
      textColor: '#fef9c3',
      accentColor: 0xfacc15
    };
  }
  return {
    panelStroke: 0xef4444,
    textColor: '#fee2e2',
    accentColor: 0xef4444
  };
}

function buildTopCandidates(
  frame: PitchFrame | undefined,
  expectedMidis: number[],
  tolerance: number = Number.POSITIVE_INFINITY,
  limit: number = TOP_CANDIDATE_LIMIT
): GameplayValidationDebugCandidate[] {
  const notes = Array.isArray(frame?.selected_notes) ? frame.selected_notes : [];
  const deduped = new Map<number, GameplayValidationDebugCandidate>();
  const sortedNotes = [...notes].sort((left, right) => {
    const leftScore = sanitizeCandidateScore(left.score, frame?.confidence ?? 0);
    const rightScore = sanitizeCandidateScore(right.score, frame?.confidence ?? 0);
    return rightScore - leftScore || left.midi - right.midi;
  });

  for (const note of sortedNotes) {
    if (!Number.isFinite(note.midi)) continue;
    const midi = Math.round(note.midi);
    if (deduped.has(midi)) continue;
    deduped.set(midi, {
      midi,
      noteName: midiToNoteName(midi),
      score: sanitizeCandidateScore(note.score, frame?.confidence ?? 0),
      rank: deduped.size + 1,
      expected: expectedMidis.includes(midi),
      acceptable: isAcceptableMidi(expectedMidis, midi, tolerance)
    });
    if (deduped.size >= limit) break;
  }

  if (deduped.size === 0 && frame?.midi_estimate !== null && frame?.midi_estimate !== undefined && Number.isFinite(frame.midi_estimate)) {
    const midi = Math.round(frame.midi_estimate);
    deduped.set(midi, {
      midi,
      noteName: midiToNoteName(midi),
      score: frame.confidence,
      rank: 1,
      expected: expectedMidis.includes(midi),
      acceptable: isAcceptableMidi(expectedMidis, midi, tolerance)
    });
  }

  return [...deduped.values()];
}

function resolveBestCompetitor(
  candidates: GameplayValidationDebugCandidate[],
  expectedMidis: number[],
  semitoneTolerance: number | null
): { midi: number | null; noteName: string | null; score: number | null } | null {
  const competitor = candidates.find((candidate) => !isAcceptableMidi(expectedMidis, candidate.midi, semitoneTolerance));
  if (!competitor) return null;
  return {
    midi: competitor.midi,
    noteName: competitor.noteName,
    score: competitor.score
  };
}

function resolveOctaveCompetitor(
  candidates: GameplayValidationDebugCandidate[],
  expectedMidis: number[]
): { midi: number | null; noteName: string | null; score: number | null } | null {
  let best: GameplayValidationDebugCandidate | null = null;
  for (const candidate of candidates) {
    if (expectedMidis.some((expectedMidi) => candidate.midi !== expectedMidi && Math.abs(candidate.midi - expectedMidi) % 12 === 0)) {
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
  }
  if (!best) return null;
  return {
    midi: best.midi,
    noteName: best.noteName,
    score: best.score
  };
}

function formatCandidatePeer(
  candidate: { midi: number | null; noteName: string | null; score: number | null } | null
): string {
  if (!candidate) return '-';
  return `${candidate.midi ?? '-'} ${candidate.noteName ?? '-'} ${formatDebugNumber(candidate.score, 2)}`;
}

function formatMidiList(values: number[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((value) => `${value} ${midiToNoteName(value)}`).join(', ')}]`;
}

function buildRuntimeSummary(
  runtimeOutput:
    | {
        acceptedPreGate: boolean;
        acceptedPostGate: boolean;
        rejectStage: 'none' | 'note_level' | 'aggregation' | 'gate' | 'no_target';
      }
    | undefined
): string {
  if (!runtimeOutput) {
    return 'no runtime output';
  }
  return `pre=${formatDebugBool(runtimeOutput.acceptedPreGate)} post=${formatDebugBool(runtimeOutput.acceptedPostGate)} stage=${runtimeOutput.rejectStage}`;
}

function resolveConfirmationState(
  validationWindow: ValidationWindowState | undefined,
  runtimeOutput:
    | {
        acceptedPreGate: boolean;
        acceptedPostGate: boolean;
        rejectStage: 'none' | 'note_level' | 'aggregation' | 'gate' | 'no_target';
        gateRejectReason: string | null;
        noteValidationRatio: number;
      }
    | undefined,
  topCandidates: GameplayValidationDebugCandidate[],
  expectedMidis: number[],
  playbackSongSeconds: number | undefined,
  targetSongSeconds: number | null,
  semitoneTolerance: number | null
): 'confirmed' | 'near' | 'far' | 'suppressed' | 'idle' {
  if (runtimeOutput?.acceptedPostGate) {
    return 'confirmed';
  }
  if (runtimeOutput?.rejectStage === 'gate' || runtimeOutput?.gateRejectReason !== null) {
    return 'suppressed';
  }
  const expectedCovered = expectedMidis.every((midi) => topCandidates.some((candidate) => isAcceptableMidi([midi], candidate.midi, semitoneTolerance)));
  const inWindow =
    validationWindow?.phase === 'armed' &&
    playbackSongSeconds !== undefined &&
    targetSongSeconds !== null &&
    validationWindow.windowStartSeconds !== null &&
    validationWindow.windowEndSeconds !== null &&
    playbackSongSeconds >= validationWindow.windowStartSeconds &&
    playbackSongSeconds <= validationWindow.windowEndSeconds;
  if (validationWindow?.phase === 'armed' && validationWindow.deadTime === false) {
    if (runtimeOutput?.acceptedPreGate) {
      return 'near';
    }
    return runtimeOutput?.noteValidationRatio !== undefined && runtimeOutput.noteValidationRatio > 0 ? 'near' : 'far';
  }
  if (validationWindow?.phase === 'accepted') {
    return 'confirmed';
  }
  if (validationWindow?.phase === 'expired' || validationWindow?.phase === 'idle') {
    return expectedCovered && inWindow ? 'near' : 'idle';
  }
  return 'idle';
}

function resolveSeverity(
  validationWindow: ValidationWindowState | undefined,
  runtimeOutput:
    | {
        acceptedPreGate: boolean;
        acceptedPostGate: boolean;
        rejectStage: 'none' | 'note_level' | 'aggregation' | 'gate' | 'no_target';
        gateRejectReason: string | null;
      }
    | undefined,
  topCandidates: GameplayValidationDebugCandidate[],
  expectedMidis: number[],
  playbackSongSeconds: number | undefined,
  targetSongSeconds: number | null,
  semitoneTolerance: number | null
): GameplayValidationDebugSeverity {
  if (runtimeOutput?.acceptedPostGate) {
    return 'good';
  }

  const expectedCovered = expectedMidis.every((midi) => topCandidates.some((candidate) => isAcceptableMidi([midi], candidate.midi, semitoneTolerance)));
  const inWindow =
    validationWindow?.phase === 'armed' &&
    playbackSongSeconds !== undefined &&
    targetSongSeconds !== null &&
    validationWindow.windowStartSeconds !== null &&
    validationWindow.windowEndSeconds !== null &&
    playbackSongSeconds >= validationWindow.windowStartSeconds &&
    playbackSongSeconds <= validationWindow.windowEndSeconds;

  if (runtimeOutput?.rejectStage === 'gate' || runtimeOutput?.gateRejectReason != null) {
    return 'danger';
  }

  if (validationWindow?.phase === 'armed' && validationWindow.deadTime === false) {
    return 'warning';
  }

  if (validationWindow?.phase === 'expired' || validationWindow?.phase === 'idle') {
    return expectedCovered && inWindow ? 'warning' : 'danger';
  }

  if (inWindow) {
    return expectedCovered ? 'warning' : 'danger';
  }

  return runtimeOutput?.acceptedPreGate ? 'warning' : 'danger';
}

function resolveRawDetectionFrameRatio(frame: PitchFrame | undefined): number | null {
  if (!frame) return null;
  return (Array.isArray(frame.selected_notes) && frame.selected_notes.length > 0) || frame.midi_estimate !== null ? 1 : 0;
}

function buildTargetKey(targetGroup: TargetNote[]): string {
  return targetGroup.map((target) => target.id).join('|');
}

function formatCanonicalTargets(expectedMidis: number[], expectedNames: string[], semitoneTolerance: number | null): string {
  if (expectedMidis.length === 0) return '-';
  return expectedMidis
    .map((midi, index) => `${midi} ${expectedNames[index]}${formatToleranceSuffix(midi, semitoneTolerance)}`)
    .join(', ');
}

function formatToleranceSuffix(midi: number, semitoneTolerance: number | null): string {
  if (semitoneTolerance === null) return '';
  return ` [${formatDebugNumber(midi - semitoneTolerance, 1)}..${formatDebugNumber(midi + semitoneTolerance, 1)}]`;
}

function formatNoteDecisionSummary(
  expectedMidis: number[],
  decision: {
    midi: number;
    accepted: boolean;
    decisionReason: string;
    matchedMidi: number | null;
    matchedSemitoneDistance: number | null;
    targetSemitoneTolerance: number;
    supportFrames: number;
    supportSeconds: number;
    minValidatedSupportFrames: number;
    minValidatedSupportSeconds: number;
    confidenceScore: number;
    expectedVsSourceFrameRatio: number;
    targetConfirmationFrameRatio: number;
    expectedTop1FrameRatio: number;
    expectedTop3FrameRatio: number;
    octaveConfusionFrameRatio: number;
    rawDetectionFrameRatio: number | null;
    rawDetectionMaxConfidence: number | null;
  },
  semitoneTolerance: number | null
): string {
  const canonical = expectedMidis.includes(decision.midi) ? `${decision.midi} ${midiToNoteName(Math.round(decision.midi))}` : `${decision.midi}`;
  const matched = decision.matchedMidi !== null ? `${decision.matchedMidi} ${midiToNoteName(Math.round(decision.matchedMidi))}` : '-';
  const distance = decision.matchedSemitoneDistance !== null ? `${formatDebugNumber(decision.matchedSemitoneDistance, 2)}st` : '-';
  const tol = semitoneTolerance !== null ? ` tol=${formatDebugNumber(semitoneTolerance, semitoneTolerance % 1 === 0 ? 0 : 1)}st` : '';
  const support = `${formatDebugNumber(decision.supportSeconds, 3)}s/${formatDebugNumber(decision.minValidatedSupportSeconds, 3)}s`;
  const frames = `${decision.supportFrames}/${decision.minValidatedSupportFrames}`;
  const conf = formatDebugNumber(decision.confidenceScore, 2);
  const raw = decision.rawDetectionFrameRatio !== null ? formatDebugNumber(decision.rawDetectionFrameRatio, 2) : '-';
  return `${canonical}->${matched} ${distance}${tol} support=${support} frames=${frames} conf=${conf} raw=${raw} top1=${formatDebugNumber(decision.expectedTop1FrameRatio, 2)} top3=${formatDebugNumber(decision.expectedTop3FrameRatio, 2)} confirm=${formatDebugNumber(decision.targetConfirmationFrameRatio, 2)} octave=${formatDebugNumber(decision.octaveConfusionFrameRatio, 2)} ${decision.accepted ? 'accepted' : 'rejected'} ${decision.decisionReason}`;
}

function isAcceptableMidi(expectedMidis: number[], midi: number, semitoneTolerance: number | null): boolean {
  if (semitoneTolerance === null) return expectedMidis.includes(midi);
  return expectedMidis.some((expectedMidi) => Math.abs(expectedMidi - midi) <= semitoneTolerance + 1e-9);
}

function sanitizeCandidateScore(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  return value ?? fallback;
}
