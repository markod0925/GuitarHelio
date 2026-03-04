import type { TempoMap } from '../midi/tempoMap';
import { computePauseState, sanitizeSongSeconds } from './playbackResumeState';

export type PlaybackClockState = {
  playbackStartSongSeconds: number;
  pausedSongSeconds: number;
  playbackStartAudioTime: number | null;
};

export function startPlaybackClock(state: PlaybackClockState, audioCtx: AudioContext | undefined, songSeconds: number): void {
  const safeSongSeconds = sanitizeSongSeconds(songSeconds, state.pausedSongSeconds);
  state.playbackStartSongSeconds = safeSongSeconds;
  state.pausedSongSeconds = safeSongSeconds;
  state.playbackStartAudioTime = audioCtx ? audioCtx.currentTime : null;
}

export function pausePlaybackClock(
  state: PlaybackClockState,
  audioCtx: AudioContext | undefined,
  runtimeCurrentTick: number,
  tempoMap: TempoMap | null,
  playbackSpeedMultiplier: number
): number {
  if (!audioCtx) {
    return runtimeCurrentTick;
  }
  const pauseSnapshot = computePauseState(
    getSongSecondsFromClock(state, audioCtx, playbackSpeedMultiplier),
    state.pausedSongSeconds,
    runtimeCurrentTick,
    tempoMap
  );
  state.pausedSongSeconds = pauseSnapshot.pausedSongSeconds;
  state.playbackStartAudioTime = null;
  state.playbackStartSongSeconds = state.pausedSongSeconds;
  return pauseSnapshot.currentTick;
}

export function getSongSecondsFromClock(
  state: PlaybackClockState,
  audioCtx: AudioContext | undefined,
  playbackSpeedMultiplier: number
): number {
  if (!audioCtx || state.playbackStartAudioTime === null) {
    return state.pausedSongSeconds;
  }
  const elapsed = Math.max(0, audioCtx.currentTime - state.playbackStartAudioTime);
  return sanitizeSongSeconds(
    state.playbackStartSongSeconds + elapsed * playbackSpeedMultiplier,
    state.pausedSongSeconds
  );
}

export function releaseMicStream(stream: MediaStream | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
