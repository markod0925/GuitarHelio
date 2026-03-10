import type { PitchFrame, TargetNote } from '../types/models';

export type SceneData = {
  songId?: string;
  midiUrl: string;
  audioUrl: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  allowedStrings?: number[];
  allowedFingers?: number[];
  allowedFrets?: number[];
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
