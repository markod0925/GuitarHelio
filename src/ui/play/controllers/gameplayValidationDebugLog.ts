import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { GameplayValidationDebugSnapshot } from '../../playSceneTypes';

const LOG_ROOT_DIRECTORY = 'GuitarHelio/debug-overlay-logs';
const LOG_DIRECTORY = Directory.Cache;
const LOG_SESSION_PREFIX = 'playscene-debug-overlay';
const LOG_SESSION_FILE_NAME = 'session.json';

let nextSessionOrdinal = 1;

export type GameplayValidationDebugLogMetadata = {
  songId?: string;
  midiUrl?: string;
};

type GameplayValidationDebugLogState = {
  sessionId: string;
  startedAtMs: number;
  sessionDirectoryPath: string;
  fileUri: string | null;
  lastError: string | null;
  writeChain: Promise<void>;
  closed: boolean;
  metadata: GameplayValidationDebugLogMetadata;
  entries: GameplayValidationDebugLogEntry[];
};

type GameplayValidationDebugLogEntry =
  | {
      kind: 'session-start';
      sessionId: string;
      startedAtMs: number;
      metadata: GameplayValidationDebugLogMetadata;
      logicalPath: string;
    }
  | {
      kind: 'session-open';
      sessionId: string;
      openedAtMs: number;
      metadata: GameplayValidationDebugLogMetadata;
      logicalPath: string;
    }
  | {
      kind: 'snapshot';
      sessionId: string;
      capturedAtMs: number;
      metadata: GameplayValidationDebugLogMetadata;
      logicalPath: string;
      lines: string[];
      snapshot: GameplayValidationDebugSnapshot;
    }
  | {
      kind: 'session-end';
      sessionId: string;
      endedAtMs: number;
      metadata: GameplayValidationDebugLogMetadata;
      logicalPath: string;
      lastSnapshot?: GameplayValidationDebugSnapshot;
      lines?: string[];
    }
  | {
      kind: 'error';
      sessionId: string;
      atMs: number;
      metadata: GameplayValidationDebugLogMetadata;
      logicalPath: string;
      message: string;
    };

let state: GameplayValidationDebugLogState | null = null;

export function beginGameplayValidationDebugLogSession(metadata: GameplayValidationDebugLogMetadata = {}): void {
  if (!Capacitor.isNativePlatform()) {
    state = null;
    return;
  }

  if (state && !state.closed) {
    finalizeGameplayValidationDebugLog();
  }

  const nextState = createInitialState(metadata);
  state = nextState;
  nextState.entries.push({
    kind: 'session-start',
    sessionId: nextState.sessionId,
    startedAtMs: nextState.startedAtMs,
    metadata: nextState.metadata,
    logicalPath: nextState.sessionDirectoryPath
  });
  nextState.entries.push({
    kind: 'session-open',
    sessionId: nextState.sessionId,
    openedAtMs: readClockMs(),
    metadata: nextState.metadata,
    logicalPath: nextState.sessionDirectoryPath
  });
}

export function recordGameplayValidationDebugLog(
  snapshot: GameplayValidationDebugSnapshot,
  lines: string[],
  metadata: GameplayValidationDebugLogMetadata = {}
): void {
  if (!Capacitor.isNativePlatform()) return;

  const current = ensureState(metadata, snapshot.capturedAtMs);
  current.entries.push({
    kind: 'snapshot',
    sessionId: current.sessionId,
    capturedAtMs: snapshot.capturedAtMs,
    metadata: current.metadata,
    logicalPath: current.sessionDirectoryPath,
    lines,
    snapshot
  });
}

export function finalizeGameplayValidationDebugLog(
  lastSnapshot?: GameplayValidationDebugSnapshot,
  lines: string[] = [],
  metadata: GameplayValidationDebugLogMetadata = {}
): void {
  if (!state) return;

  const current = state;
  state = null;
  current.closed = true;
  const endedAtMs = lastSnapshot?.capturedAtMs ?? readClockMs();
  current.entries.push({
    kind: 'session-end',
    sessionId: current.sessionId,
    endedAtMs,
    logicalPath: current.sessionDirectoryPath,
    lastSnapshot,
    lines,
    metadata: current.metadata.songId || current.metadata.midiUrl ? current.metadata : metadata
  });
  void flushSessionToDisk(current);
}

export function describeGameplayValidationDebugLogLocation(): string {
  if (!state) {
    return `Cache/${LOG_ROOT_DIRECTORY}/pending/${LOG_SESSION_FILE_NAME}`;
  }
  return state.fileUri ?? `Cache/${state.sessionDirectoryPath}/${LOG_SESSION_FILE_NAME}`;
}

export function buildGameplayValidationDebugLogSessionDirectoryName(
  startedAtMs: number,
  sessionOrdinal: number
): string {
  return `${LOG_SESSION_PREFIX}-${formatTimestampForFile(startedAtMs)}-${sessionOrdinal.toString().padStart(3, '0')}`;
}

export function buildGameplayValidationDebugLogSessionDirectoryPath(
  startedAtMs: number,
  sessionOrdinal: number
): string {
  return `${LOG_ROOT_DIRECTORY}/${buildGameplayValidationDebugLogSessionDirectoryName(startedAtMs, sessionOrdinal)}`;
}

export function buildGameplayValidationDebugLogSessionFilePath(
  startedAtMs: number,
  sessionOrdinal: number
): string {
  return `${buildGameplayValidationDebugLogSessionDirectoryPath(startedAtMs, sessionOrdinal)}/${LOG_SESSION_FILE_NAME}`;
}

function ensureState(metadata: GameplayValidationDebugLogMetadata, atMs: number): GameplayValidationDebugLogState {
  if (!state || state.closed) {
    state = createInitialState(metadata, atMs);
    const current = state;
    current.entries.push({
      kind: 'session-start',
      sessionId: current.sessionId,
      startedAtMs: current.startedAtMs,
      metadata: current.metadata,
      logicalPath: current.sessionDirectoryPath
    });
    current.entries.push({
      kind: 'session-open',
      sessionId: current.sessionId,
      openedAtMs: atMs,
      metadata: current.metadata,
      logicalPath: current.sessionDirectoryPath
    });
  }
  return state;
}

function createInitialState(
  metadata: GameplayValidationDebugLogMetadata,
  startedAtMs: number = readClockMs()
): GameplayValidationDebugLogState {
  const sessionOrdinal = nextSessionOrdinal;
  nextSessionOrdinal += 1;
  const sessionId = `${formatTimestampForFile(startedAtMs)}-${sessionOrdinal.toString().padStart(3, '0')}`;
  return {
    sessionId,
    startedAtMs,
    sessionDirectoryPath: buildGameplayValidationDebugLogSessionDirectoryPath(startedAtMs, sessionOrdinal),
    fileUri: null,
    lastError: null,
    writeChain: Promise.resolve(),
    closed: false,
    metadata: {
      songId: metadata.songId?.trim() || undefined,
      midiUrl: metadata.midiUrl?.trim() || undefined
    },
    entries: []
  };
}

async function flushSessionToDisk(state: GameplayValidationDebugLogState): Promise<void> {
  state.writeChain = state.writeChain.then(async () => {
    if (!Capacitor.isNativePlatform()) return;

    await ensureSessionDirectory(state.sessionDirectoryPath);
    const entryPath = `${state.sessionDirectoryPath}/${LOG_SESSION_FILE_NAME}`;
    await Filesystem.writeFile({
      directory: LOG_DIRECTORY,
      path: entryPath,
      data: `${JSON.stringify({
        sessionId: state.sessionId,
        startedAtMs: state.startedAtMs,
        metadata: state.metadata,
        entries: state.entries
      })}\n`,
      encoding: Encoding.UTF8
    });
    try {
      const fileInfo = await Filesystem.getUri({
        directory: LOG_DIRECTORY,
        path: entryPath
      });
      state.fileUri = fileInfo.uri;
    } catch {
      state.fileUri = null;
    }
    state.lastError = null;
  }).catch(async (error: unknown) => {
    state.lastError = formatError(error);
    try {
      await ensureSessionDirectory(state.sessionDirectoryPath);
      const errorEntry: GameplayValidationDebugLogEntry = {
        kind: 'error',
        sessionId: state.sessionId,
        atMs: readClockMs(),
        metadata: state.metadata,
        logicalPath: state.sessionDirectoryPath,
        message: state.lastError
      };
      state.entries.push(errorEntry);
      const errorPath = `${state.sessionDirectoryPath}/${LOG_SESSION_FILE_NAME}`;
      await Filesystem.writeFile({
        directory: LOG_DIRECTORY,
        path: errorPath,
        data: `${JSON.stringify({
          sessionId: state.sessionId,
          startedAtMs: state.startedAtMs,
          metadata: state.metadata,
          entries: state.entries
        })}\n`,
        encoding: Encoding.UTF8
      });
    } catch {
      // Best effort only. The log should never interrupt gameplay.
    }
  });
  await state.writeChain;
}

async function ensureSessionDirectory(sessionDirectoryPath: string): Promise<void> {
  await Filesystem.mkdir({
    directory: LOG_DIRECTORY,
    path: sessionDirectoryPath,
    recursive: true
  });
}

function formatTimestampForFile(value: number): string {
  return new Date(value)
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '-')
    .replace(/Z$/, 'Z');
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown log error';
  }
}

function readClockMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
