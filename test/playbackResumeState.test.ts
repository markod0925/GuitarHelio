import { describe, expect, test } from 'vitest';
import { TempoMap } from '../src/midi/tempoMap';
import {
  computePauseState,
  resolveResumeSongSeconds,
  resolveResumeSongSecondsForAudio,
  resolveSongSecondsForRuntime,
  sanitizeSongSeconds
} from '../src/ui/playbackResumeState';

function buildLinearTempoMap(): TempoMap {
  return TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
}

describe('playbackResumeState', () => {
  test('resume uses runtime tick timeline and does not jump to zero when paused seconds are stale', () => {
    const tempoMap = buildLinearTempoMap();
    const resumeSeconds = resolveResumeSongSeconds(1920, 0, tempoMap);

    expect(resumeSeconds).toBeCloseTo(2, 6);
  });

  test('pause snapshot clamps invalid song time and keeps previous seconds', () => {
    const tempoMap = buildLinearTempoMap();
    const snapshot = computePauseState(Number.NaN, 1.25, 999, tempoMap);

    expect(snapshot.pausedSongSeconds).toBe(1.25);
    expect(snapshot.currentTick).toBe(1200);
  });

  test('sanitizeSongSeconds falls back to zero when both values are invalid', () => {
    expect(sanitizeSongSeconds(Number.NaN, Number.NaN)).toBe(0);
  });

  test('runtime song seconds ignores anomalous backward jump from backing audio time', () => {
    const resolved = resolveSongSecondsForRuntime(18.4, 17.9, 0);
    expect(resolved).toBeCloseTo(18.4, 6);
  });

  test('runtime song seconds accepts forward audio position when audio is ahead of clock', () => {
    const resolved = resolveSongSecondsForRuntime(0, 0, 2.663);
    expect(resolved).toBeCloseTo(2.663, 6);
  });

  test('audio resume prefers paused audio position when runtime resume is stale behind', () => {
    const resolved = resolveResumeSongSecondsForAudio(2.1, 14.6);
    expect(resolved).toBeCloseTo(14.6, 6);
  });
});
