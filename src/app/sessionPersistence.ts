export type PersistedDifficulty = 'Easy' | 'Medium' | 'Hard';

export type PersistedSessionSettings = {
  difficulty: PersistedDifficulty;
  selectedStrings: number[];
  selectedFingers: number[];
  selectedFrets: number[];
};

const SESSION_SETTINGS_STORAGE_KEY = 'gh_session_settings_v1';
const SONG_HIGH_SCORES_STORAGE_KEY = 'gh_song_high_scores_v1';

type SongHighScoreMap = Record<string, number>;

export function loadSessionSettingsPreference(): PersistedSessionSettings | null {
  const raw = readStoredJson(SESSION_SETTINGS_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;

  const difficulty = parseDifficulty(data.difficulty);
  const selectedStrings = parseNumberList(data.selectedStrings, 1, 6);
  const selectedFingers = parseNumberList(data.selectedFingers, 1, 4);
  const selectedFrets = parseNumberList(data.selectedFrets, 0, 21);
  if (!difficulty || !selectedStrings || !selectedFingers || !selectedFrets) {
    return null;
  }

  return {
    difficulty,
    selectedStrings,
    selectedFingers,
    selectedFrets
  };
}

export function saveSessionSettingsPreference(settings: PersistedSessionSettings): void {
  const difficulty = parseDifficulty(settings.difficulty);
  if (!difficulty) return;

  const selectedStrings = normalizeNumberList(settings.selectedStrings, 1, 6);
  const selectedFingers = normalizeNumberList(settings.selectedFingers, 1, 4);
  const selectedFrets = normalizeNumberList(settings.selectedFrets, 0, 21);

  writeStoredJson(SESSION_SETTINGS_STORAGE_KEY, {
    difficulty,
    selectedStrings,
    selectedFingers,
    selectedFrets
  });
}

export function resolveSongHighScore(songId: string, manifestHighScore?: number): number {
  const normalizedSongId = normalizeSongId(songId);
  if (!normalizedSongId) return 0;

  const allScores = loadSongHighScoreMap();
  const stored = allScores[normalizedSongId] ?? 0;
  const fromManifest = normalizeScore(manifestHighScore) ?? 0;
  const best = Math.max(stored, fromManifest);

  if (best > stored) {
    allScores[normalizedSongId] = best;
    writeStoredJson(SONG_HIGH_SCORES_STORAGE_KEY, allScores);
  }

  return best;
}

export function saveSongHighScoreIfHigher(songId: string, score: number): number {
  const normalizedSongId = normalizeSongId(songId);
  if (!normalizedSongId) return 0;

  const allScores = loadSongHighScoreMap();
  const stored = allScores[normalizedSongId] ?? 0;
  const next = normalizeScore(score) ?? 0;
  const best = Math.max(stored, next);

  if (best !== stored) {
    allScores[normalizedSongId] = best;
    writeStoredJson(SONG_HIGH_SCORES_STORAGE_KEY, allScores);
  }

  return best;
}

function loadSongHighScoreMap(): SongHighScoreMap {
  const raw = readStoredJson(SONG_HIGH_SCORES_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return {};

  const source = raw as Record<string, unknown>;
  const normalized: SongHighScoreMap = {};
  for (const [key, value] of Object.entries(source)) {
    const songId = normalizeSongId(key);
    const score = normalizeScore(value);
    if (!songId || score === undefined) continue;
    normalized[songId] = score;
  }

  return normalized;
}

function parseDifficulty(value: unknown): PersistedDifficulty | null {
  return value === 'Easy' || value === 'Medium' || value === 'Hard' ? value : null;
}

function parseNumberList(value: unknown, min: number, max: number): number[] | null {
  if (!Array.isArray(value)) return null;
  return normalizeNumberList(value, min, max);
}

function normalizeNumberList(value: unknown, min: number, max: number): number[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<number>();

  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) continue;
    const rounded = Math.round(item);
    if (rounded < min || rounded > max) continue;
    unique.add(rounded);
  }

  return Array.from(unique).sort((a, b) => a - b);
}

function normalizeScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.round(value);
}

function normalizeSongId(value: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStoredJson(key: string): unknown {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore persistence failures (quota/private mode).
  }
}
