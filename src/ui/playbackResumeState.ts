import type { TempoMap } from '../midi/tempoMap';

type TempoMapLike = Pick<TempoMap, 'tickToSeconds' | 'secondsToTick'>;

export type PauseStateSnapshot = {
  pausedSongSeconds: number;
  currentTick: number;
};

const AUDIO_DRIFT_TOLERANCE_SECONDS = 0.25;
const RESUME_SYNC_TOLERANCE_SECONDS = 0.25;

export function sanitizeSongSeconds(value: number, fallback: number): number {
  if (Number.isFinite(value) && value >= 0) return value;
  if (Number.isFinite(fallback) && fallback >= 0) return fallback;
  return 0;
}

export function resolveResumeSongSeconds(
  runtimeTick: number,
  pausedSongSeconds: number,
  tempoMap: TempoMapLike | null
): number {
  const safeTick = Math.max(0, runtimeTick);
  if (!tempoMap) {
    return sanitizeSongSeconds(pausedSongSeconds, 0);
  }
  return sanitizeSongSeconds(tempoMap.tickToSeconds(safeTick), pausedSongSeconds);
}

export function computePauseState(
  songSecondsNow: number,
  previousPausedSongSeconds: number,
  currentTick: number,
  tempoMap: TempoMapLike | null
): PauseStateSnapshot {
  const pausedSongSeconds = sanitizeSongSeconds(songSecondsNow, previousPausedSongSeconds);
  if (!tempoMap) {
    return { pausedSongSeconds, currentTick: Math.max(0, currentTick) };
  }
  return {
    pausedSongSeconds,
    currentTick: Math.max(0, tempoMap.secondsToTick(pausedSongSeconds))
  };
}

export function resolveSongSecondsForRuntime(
  expectedClockSongSeconds: number,
  pausedSongSeconds: number,
  backingAudioSongSeconds: number | undefined
): number {
  const expected = sanitizeSongSeconds(expectedClockSongSeconds, pausedSongSeconds);
  if (backingAudioSongSeconds === undefined) return expected;

  const fromAudio = sanitizeSongSeconds(backingAudioSongSeconds, expected);
  if (fromAudio + AUDIO_DRIFT_TOLERANCE_SECONDS < expected) {
    return expected;
  }
  return fromAudio;
}

export function resolveResumeSongSecondsForAudio(
  runtimeResumeSongSeconds: number,
  pausedAudioSongSeconds: number | undefined
): number {
  if (pausedAudioSongSeconds === undefined) {
    return sanitizeSongSeconds(runtimeResumeSongSeconds, 0);
  }

  const runtimeResume = sanitizeSongSeconds(runtimeResumeSongSeconds, 0);
  const audioResume = sanitizeSongSeconds(pausedAudioSongSeconds, runtimeResume);
  if (audioResume + RESUME_SYNC_TOLERANCE_SECONDS >= runtimeResume) {
    return audioResume;
  }
  return runtimeResume;
}
