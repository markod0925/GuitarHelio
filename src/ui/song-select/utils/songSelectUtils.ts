import { Capacitor } from '@capacitor/core';
import {
  DEBUG_CONVERTER_MODE_STORAGE_KEY,
  IMPORT_SOURCE_STORAGE_KEY
} from '../constants';
import type {
  DebugConverterMode,
  Difficulty,
  ImportSourceMode,
  SongManifestEntry
} from '../types';

export function toSongManifestEntry(value: unknown): SongManifestEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string' || typeof data.name !== 'string') return null;

  const folder = typeof data.folder === 'string' && data.folder.trim().length > 0 ? data.folder : data.id;
  const cover = typeof data.cover === 'string' ? data.cover : undefined;
  const midi = typeof data.midi === 'string' ? data.midi : undefined;
  const audio = typeof data.audio === 'string' ? data.audio : undefined;
  const file = typeof data.file === 'string' ? data.file : undefined;
  const highScore =
    typeof data.highScore === 'number' && Number.isFinite(data.highScore) && data.highScore >= 0
      ? Math.round(data.highScore)
      : undefined;

  return {
    id: data.id,
    name: data.name,
    folder,
    cover,
    midi,
    audio,
    file,
    highScore
  };
}

export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

export async function parseJsonSafe(response: Response): Promise<unknown | null> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function encodePathSegments(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function resolveSongAssetPath(folder: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
    return trimmed;
  }

  const relativeValue = trimmed.replace(/^\.?\//, '');
  return `/songs/${encodePathSegments(folder)}/${encodePathSegments(relativeValue)}`;
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), Math.max(0, ms));
  });
}

export async function requestQuitApplication(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { App } = await import('@capacitor/app');
      App.exitApp();
      return true;
    } catch (error) {
      console.warn('Failed to quit native app', error);
      return false;
    }
  }

  if (isElectronRuntime() && typeof window !== 'undefined') {
    window.close();
    return true;
  }

  return false;
}

function isElectronRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /electron/i.test(navigator.userAgent);
}

export function truncateLabel(value: string, maxLength: number): string {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

export function inferUploadMimeType(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.mid') || lowered.endsWith('.midi')) {
    return 'audio/midi';
  }
  if (lowered.endsWith('.ogg') || lowered.endsWith('.oga') || lowered.endsWith('.opus')) {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

export function detectSongImportKind(fileName: string, mimeType: string): 'audio' | 'midi' | null {
  const lowered = fileName.toLowerCase();
  if (/\.(mid|midi)$/i.test(lowered)) return 'midi';
  if (/\.(mp3|ogg)$/i.test(lowered)) return 'audio';

  const loweredMime = String(mimeType || '').toLowerCase();
  if (/^(audio\/midi|audio\/mid|audio\/x-midi|audio\/sp-midi|application\/midi|application\/x-midi)/i.test(loweredMime)) {
    return 'midi';
  }
  if (/^audio\/(mpeg|mp3|ogg|x-ogg|opus)/i.test(loweredMime)) {
    return 'audio';
  }
  return null;
}

export function stripFileExtension(fileName: string): string {
  const sanitized = fileName.trim();
  if (!sanitized) return 'song';
  return sanitized.replace(/\.[^/.]+$/g, '') || sanitized;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return 'Import failed.';
}

export function describeMicFailure(error: unknown): string | null {
  const name = extractErrorName(error);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'no microphone found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'microphone busy in another app';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'unsupported audio constraints';
    case 'SecurityError':
      return 'runtime security policy blocked mic';
    case 'AbortError':
      return 'microphone start aborted by system';
    default: {
      const message = extractErrorMessage(error);
      if (message) return message;
      return name ? name : null;
    }
  }
}

function extractErrorName(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if (!('name' in error)) return null;
  const rawName = (error as { name?: unknown }).name;
  if (typeof rawName !== 'string') return null;
  const normalized = rawName.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if (!('message' in error)) return null;
  const rawMessage = (error as { message?: unknown }).message;
  if (typeof rawMessage !== 'string') return null;
  const normalized = rawMessage.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

export function isImportSourceDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  return params.get('debugImportSource') === '1';
}

export function loadImportSourceModePreference(): ImportSourceMode {
  if (typeof window === 'undefined') return 'auto';

  const value = window.localStorage.getItem(IMPORT_SOURCE_STORAGE_KEY);
  if (value === 'server' || value === 'native' || value === 'auto') {
    return value;
  }
  return 'auto';
}

export function saveImportSourceModePreference(mode: ImportSourceMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(IMPORT_SOURCE_STORAGE_KEY, mode);
}

export function parseDebugConverterMode(value: string | null): DebugConverterMode | null {
  if (value === 'legacy' || value === 'neuralnote' || value === 'ab') {
    return value;
  }
  return null;
}

export function loadDebugConverterModePreference(): DebugConverterMode {
  if (typeof window === 'undefined') return 'legacy';

  const params = new URLSearchParams(window.location.search);
  const fromQuery = parseDebugConverterMode(params.get('debugConverterMode'));
  if (fromQuery) {
    window.localStorage.setItem(DEBUG_CONVERTER_MODE_STORAGE_KEY, fromQuery);
    return fromQuery;
  }

  const fromStorage = parseDebugConverterMode(window.localStorage.getItem(DEBUG_CONVERTER_MODE_STORAGE_KEY));
  return fromStorage ?? 'legacy';
}

export function sanitizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeFolder(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

export function isValidAssetResponse(url: string, response: Response): boolean {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType) return true;
  if (contentType.includes('text/html')) return false;

  const loweredUrl = url.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(loweredUrl)) {
    return contentType.startsWith('image/');
  }
  if (/\.(mp3|wav|ogg|m4a)$/.test(loweredUrl)) {
    return contentType.startsWith('audio/');
  }
  if (/\.(mid|midi)$/.test(loweredUrl)) {
    return contentType.startsWith('audio/') || contentType.includes('midi') || contentType.includes('octet-stream');
  }

  return true;
}

export function isCapacitorFileUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return lowered.includes('/_capacitor_file_/') || lowered.startsWith('capacitor://localhost/_capacitor_file_/');
}

export function midiToNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const note = names[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function nextDifficulty(difficulty: Difficulty): Difficulty {
  if (difficulty === 'Easy') return 'Medium';
  if (difficulty === 'Medium') return 'Hard';
  return 'Easy';
}

export function previousDifficulty(difficulty: Difficulty): Difficulty {
  if (difficulty === 'Hard') return 'Medium';
  if (difficulty === 'Medium') return 'Easy';
  return 'Hard';
}

export function sortedValues(values: Set<number>): number[] {
  return Array.from(values).sort((a, b) => a - b);
}

export function rangeInclusive(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}

export function sanitizeSettingValues(values: number[], min: number, max: number): number[] {
  const unique = new Set<number>();
  values.forEach((value) => {
    if (!Number.isInteger(value)) return;
    if (value < min || value > max) return;
    unique.add(value);
  });
  return Array.from(unique).sort((a, b) => a - b);
}
