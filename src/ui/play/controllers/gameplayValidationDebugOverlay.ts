import { midiToNoteName } from '../../../ui/song-select/utils/songSelectUtils';
import { resolveTargetGroup } from '../../../guitar/targetGrouping';
import { PlayState, type PitchFrame, type TargetNote } from '../../../types/models';
import type {
  GameplayValidationDebugCandidate,
  GameplayValidationDebugSeverity,
  GameplayValidationDebugSnapshot,
  ValidationWindowState
} from '../../playSceneTypes';
import { formatDebugBool, formatDebugNumber, formatSignedMs } from '../../playSceneDebug';
import type { PlaySceneContext } from './PlaySceneContext';

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
  const allCandidates = buildTopCandidates(latestFrame, expectedMidis, Number.POSITIVE_INFINITY);
  const topCandidates = allCandidates.slice(0, TOP_CANDIDATE_LIMIT);
  const bestCompetitor = resolveBestCompetitor(allCandidates, expectedMidis);
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

  const snapshot: GameplayValidationDebugSnapshot = {
      capturedAtMs: nowMs,
      severity: resolveSeverity(validationWindow, runtimeOutput, topCandidates, expectedMidis, playbackSongSeconds, targetSongSeconds),
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
      expectedNotePresent: allCandidates.some((candidate) => expectedMidis.includes(candidate.midi)),
      bestNoteId: latestFrame?.best_note_id ?? null,
      latestMidiEstimate: latestFrame?.midi_estimate ?? null,
      latestConfidence: latestFrame?.confidence ?? null
    },
    runtime: {
      acceptedPreGate: runtimeOutput?.acceptedPreGate ?? false,
      acceptedPostGate: runtimeOutput?.acceptedPostGate ?? false,
      noteValidationRatio: runtimeOutput?.noteValidationRatio ?? 0,
      validatedNotes: runtimeOutput?.validatedNotes ?? [],
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
  const lastSetTargetAge = snapshot.window.lastSetTargetAtMs !== null
    ? formatSignedMs(snapshot.capturedAtMs - snapshot.window.lastSetTargetAtMs)
    : '-';
  const lastResetAge = snapshot.window.lastResetAtMs !== null
    ? formatSignedMs(snapshot.capturedAtMs - snapshot.window.lastResetAtMs)
    : '-';
  const topCandidateSummary = snapshot.spectral.topCandidates.length > 0
    ? snapshot.spectral.topCandidates
        .map((candidate) => `${candidate.rank}:${candidate.midi} ${candidate.noteName} ${formatDebugNumber(candidate.score, 2)}${candidate.expected ? '*' : ''}`)
        .join(' | ')
    : '-';

  return [
    `Gameplay Validation Debug [${paletteLabel}]`,
    `Timing: phase=${snapshot.window.phase} dead=${formatDebugBool(snapshot.window.deadTime)} activeWindow=${activeWindowLabel} song=${formatDebugNumber(snapshot.playbackSongSeconds, 3)}s target=${formatDebugNumber(snapshot.targetSongSeconds, 3)}s dt=${formatSignedMs(snapshot.targetDeltaMs ?? undefined)} early=${formatDebugNumber(snapshot.window.earlyToleranceSeconds, 3)}s late=${formatDebugNumber(snapshot.window.lateToleranceSeconds, 3)}s`,
    `Target: mode=${targetLabel} armed=${snapshot.window.currentArmedTargetId ?? '-'} key=${snapshot.target.targetKey ?? '-'} expected=${snapshot.target.expectedMidis.map((midi, index) => `${midi} ${snapshot.target.expectedNames[index]}`).join(', ') || '-'} ranks=${snapshot.spectral.expectedRanks} agg=${snapshot.target.aggregationPolicyId ?? '-'} gate=${snapshot.target.activationGatePolicyId ?? '-'} noteCfg=${snapshot.target.noteDecisionConfigId ?? '-'}`,
    `Spectral: top5=${topCandidateSummary}`,
    `Spectral: bestComp=${formatCandidatePeer(snapshot.spectral.bestCompetitor)} octave=${formatCandidatePeer(snapshot.spectral.octaveCompetitor)} rawMax=${formatDebugNumber(snapshot.spectral.rawDetectionMaxConfidence, 2)} frameRatio=${formatDebugNumber(snapshot.spectral.rawDetectionFrameRatio, 2)} expectedPresent=${formatDebugBool(snapshot.spectral.expectedNotePresent)} bestNote=${snapshot.spectral.bestNoteId ?? '-'}`,
    `Runtime: pre=${formatDebugBool(snapshot.runtime.acceptedPreGate)} post=${formatDebugBool(snapshot.runtime.acceptedPostGate)} ratio=${formatDebugNumber(snapshot.runtime.noteValidationRatio, 2)} conf=${formatDebugNumber(snapshot.runtime.confidence, 2)} validated=${formatMidiList(snapshot.runtime.validatedNotes)} missing=${formatMidiList(snapshot.runtime.missingNotes)} extra=${formatMidiList(snapshot.runtime.extraNotes)} stage=${snapshot.runtime.rejectStage}`,
    `Runtime: gate=${snapshot.runtime.gateRejectReason ?? '-'} reasons=${snapshot.runtime.rejectReasons.length > 0 ? snapshot.runtime.rejectReasons.join('|') : '-'} summary=${snapshot.runtime.summary}`,
    `Reset: changed=${formatDebugBool(snapshot.window.targetChangedThisFrame)} setTarget=${snapshot.window.setTargetCount} reset=${snapshot.window.resetCount} arm=${snapshot.window.armCount} lastSet=${lastSetTargetAge} lastReset=${lastResetAge} changeAt=${snapshot.window.lastTargetChangeAtMs !== null ? formatSignedMs(snapshot.capturedAtMs - snapshot.window.lastTargetChangeAtMs) : '-'}`,
  ];
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
      expected: expectedMidis.includes(midi)
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
      expected: expectedMidis.includes(midi)
    });
  }

  return [...deduped.values()];
}

function resolveBestCompetitor(
  candidates: GameplayValidationDebugCandidate[],
  expectedMidis: number[]
): { midi: number | null; noteName: string | null; score: number | null } | null {
  const expectedSet = new Set(expectedMidis);
  const competitor = candidates.find((candidate) => !expectedSet.has(candidate.midi));
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
  targetSongSeconds: number | null
): GameplayValidationDebugSeverity {
  if (runtimeOutput?.acceptedPostGate) {
    return 'good';
  }

  const expectedCovered = expectedMidis.every((midi) => topCandidates.some((candidate) => candidate.midi === midi));
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

function sanitizeCandidateScore(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  return value ?? fallback;
}
