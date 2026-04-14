import type { PitchFrame, TargetNote } from '../types/models';
import type { AudioInputMode } from '../types/audioInputMode';

export type SceneData = {
  songId?: string;
  midiUrl: string;
  audioUrl: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  audioInputMode?: AudioInputMode;
  allowedStrings?: number[];
  allowedFingers?: number[];
  allowedFrets?: number[];
  showGameplayValidationDebug?: boolean;
};

export type Layout = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  laneSpacing: number;
  hitLineX: number;
  pxPerTick: number;
  noteHeight: number;
};

export type MutablePoint = {
  x: number;
  y: number;
};

export type PlaybackMode = 'midi' | 'audio';

export type HitDebugSnapshot = {
  songSecondsNow?: number;
  targetSeconds?: number;
  targetDeltaMs?: number;
  isWithinGraceWindow: boolean;
  canValidateHit: boolean;
  validHit: boolean;
  activeTarget?: TargetNote;
  activeChordSize?: number;
  validatedChordNotes?: number;
  latestFrame?: PitchFrame;
  holdMs: number;
  holdRequiredMs: number;
  minConfidence: number;
  validFrameCount: number;
  sampleCount: number;
};

export type ValidationWindowPhase = 'idle' | 'armed' | 'accepted' | 'expired';

export type ValidationWindowState = {
  phase: ValidationWindowPhase;
  deadTime: boolean;
  targetKey: string | null;
  targetIds: string[];
  targetMode: 'mono' | 'poly' | null;
  aggregationPolicyId: string | null;
  activationGatePolicyId: string | null;
  noteDecisionConfigId: string | null;
  windowStartSeconds: number | null;
  windowEndSeconds: number | null;
  earlyToleranceSeconds: number | null;
  lateToleranceSeconds: number | null;
  armedAtMs: number | null;
  acceptedAtSongSeconds: number | null;
  expiredAtSongSeconds: number | null;
  lastSongSeconds: number | null;
  lastReason: string;
  setTargetCount: number;
  resetCount: number;
  armCount: number;
  lastSetTargetAtMs: number | null;
  lastResetAtMs: number | null;
  lastTargetChangeAtMs: number | null;
};

export type GameplayValidationDebugSeverity = 'good' | 'warning' | 'danger';

export type GameplayValidationDebugCandidate = {
  midi: number;
  noteName: string;
  score: number;
  rank: number;
  expected: boolean;
};

export type GameplayValidationDebugSnapshot = {
  capturedAtMs: number;
  severity: GameplayValidationDebugSeverity;
  playbackSongSeconds: number | null;
  targetSongSeconds: number | null;
  targetDeltaMs: number | null;
  inActiveToleranceWindow: boolean;
  window: {
    phase: ValidationWindowPhase;
    deadTime: boolean;
    targetKey: string | null;
    targetMode: 'mono' | 'poly' | null;
    currentArmedTargetId: string | null;
    targetIds: string[];
    windowStartSeconds: number | null;
    windowEndSeconds: number | null;
    earlyToleranceSeconds: number | null;
    lateToleranceSeconds: number | null;
    lastReason: string;
    targetChangedThisFrame: boolean;
    lastSetTargetAtMs: number | null;
    lastResetAtMs: number | null;
    lastTargetChangeAtMs: number | null;
    setTargetCount: number;
    resetCount: number;
    armCount: number;
  };
  target: {
    expectedMidis: number[];
    expectedNames: string[];
    targetKey: string | null;
    targetIds: string[];
    targetMode: 'mono' | 'poly' | null;
    aggregationPolicyId: string | null;
    activationGatePolicyId: string | null;
    noteDecisionConfigId: string | null;
  };
  spectral: {
    topCandidates: GameplayValidationDebugCandidate[];
    expectedRanks: string;
    bestCompetitor: { midi: number | null; noteName: string | null; score: number | null };
    octaveCompetitor: { midi: number | null; noteName: string | null; score: number | null };
    rawDetectionMaxConfidence: number | null;
    rawDetectionFrameRatio: number | null;
    expectedNotePresent: boolean;
    bestNoteId: string | null;
    latestMidiEstimate: number | null;
    latestConfidence: number | null;
  };
  runtime: {
    acceptedPreGate: boolean;
    acceptedPostGate: boolean;
    noteValidationRatio: number;
    validatedNotes: number[];
    missingNotes: number[];
    extraNotes: number[];
    rejectReasons: string[];
    rejectStage: 'none' | 'note_level' | 'aggregation' | 'gate' | 'no_target';
    gateRejectReason: string | null;
    confidence: number;
    summary: string;
  };
};

export type GameplayValidationDebugEventKind = 'accepted' | 'expired' | 'rejected';

export type GameplayValidationDebugRetainedSnapshot = GameplayValidationDebugSnapshot & {
  eventKind: GameplayValidationDebugEventKind;
  eventLabel: string;
};

export type HeldHitAnalysis = {
  valid: boolean;
  streakMs: number;
  validFrameCount: number;
  sampleCount: number;
  latestFrame?: PitchFrame;
};

export type TopStar = {
  baseX: number;
  y: number;
  radius: number;
  baseAlpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
};

export type SongMinimapLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  innerLeft: number;
  innerTop: number;
  innerWidth: number;
  innerHeight: number;
  rowHeight: number;
  totalTicks: number;
};

export type AudioSeekDebugInfo = {
  requestedSongSeconds: number;
  targetSeconds: number;
  beforeSeekSeconds: number;
  afterPlaySeconds?: number;
  afterRetrySeconds?: number;
  fallbackToMidi: boolean;
  seekDisabled: boolean;
  ok: boolean;
  atMs: number;
};
