import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  loadSessionSettingsPreference,
  resetAllSongHighScores,
  resolveSongHighScore,
  saveSessionSettingsPreference,
  saveSongHighScoreIfHigher
} from '../src/app/sessionPersistence';

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key) ?? null : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    }
  };
}

describe('sessionPersistence high score reset', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: createLocalStorageMock() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('clears all stored best scores', () => {
    expect(saveSongHighScoreIfHigher('song-a', 42)).toBe(42);
    expect(resolveSongHighScore('song-a')).toBe(42);

    resetAllSongHighScores();

    expect(resolveSongHighScore('song-a')).toBe(0);
  });

  test('keeps manifest fallback after reset', () => {
    expect(saveSongHighScoreIfHigher('song-b', 25)).toBe(25);
    resetAllSongHighScores();

    expect(resolveSongHighScore('song-b', 11)).toBe(11);
  });

  test('defaults audio input mode to speaker when preference field is missing', () => {
    window.localStorage.setItem(
      'gh_session_settings_v1',
      JSON.stringify({
        difficulty: 'Medium',
        selectedStrings: [6, 5, 4],
        selectedFingers: [1, 2],
        selectedFrets: [0, 1, 2]
      })
    );

    expect(loadSessionSettingsPreference()).toEqual({
      difficulty: 'Medium',
      audioInputMode: 'speaker',
      selectedStrings: [4, 5, 6],
      selectedFingers: [1, 2],
      selectedFrets: [0, 1, 2]
    });
  });

  test('persists and restores audio input mode', () => {
    saveSessionSettingsPreference({
      difficulty: 'Hard',
      audioInputMode: 'headphones',
      selectedStrings: [1, 3, 2],
      selectedFingers: [3, 2],
      selectedFrets: [7, 5, 6]
    });

    expect(loadSessionSettingsPreference()).toEqual({
      difficulty: 'Hard',
      audioInputMode: 'headphones',
      selectedStrings: [1, 2, 3],
      selectedFingers: [2, 3],
      selectedFrets: [5, 6, 7]
    });
  });
});
