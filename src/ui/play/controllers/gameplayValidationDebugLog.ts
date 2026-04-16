import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { GameplayValidationDebugSnapshot } from '../../playSceneTypes';

const LOG_ROOT_DIRECTORY = 'GuitarHelio/debug-overlay-logs';
const LOG_THROTTLE_MS = 1000;

export type GameplayValidationDebugLogMetadata = {
  songId?: string;
  midiUrl?: string;
};

type GameplayValidationDebugLogState = {
  sessionId: string;
  startedAtMs: number;
  logicalPath: string;
  fileUri: string | null;
  lastWrittenAtMs: number;
  lastSignature: string;
  lastError: string | null;
  writeChain: Promise<void>;
  closed: boolean;
  metadata: GameplayValidationDebugLogMetadata;
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

  const nextState = createInitialState(metadata);
  state = nextState;
  enqueueEntry(nextState, {
    kind: 'session-start',
    sessionId: nextState.sessionId,
    startedAtMs: nextState.startedAtMs,
    metadata: nextState.metadata,
    logicalPath: nextState.logicalPath
  });
}

export function recordGameplayValidationDebugLog(
  snapshot: GameplayValidationDebugSnapshot,
  lines: string[],
  metadata: GameplayValidationDebugLogMetadata = {}
): void {
  if (!Capacitor.isNativePlatform()) return;

  const current = ensureState(metadata, snapshot.capturedAtMs);
  const signature = buildSnapshotSignature(snapshot);
  if (!shouldEmitSnapshot(current, signature, snapshot.capturedAtMs)) return;

  current.lastSignature = signature;
  current.lastWrittenAtMs = snapshot.capturedAtMs;
  enqueueEntry(current, {
    kind: 'snapshot',
    sessionId: current.sessionId,
    capturedAtMs: snapshot.capturedAtMs,
    metadata: current.metadata,
    logicalPath: current.logicalPath,
    lines,
    snapshot
  });
}

export function finalizeGameplayValidationDebugLog(): void {
  if (!state) return;

  const current = state;
  state = null;
  current.closed = true;
  enqueueEntry(current, {
    kind: 'session-end',
    sessionId: current.sessionId,
    endedAtMs: readClockMs(),
    metadata: current.metadata,
    logicalPath: current.logicalPath
  });
}

export function describeGameplayValidationDebugLogLocation(): string {
  if (!state) {
    return `Documents/${LOG_ROOT_DIRECTORY}/pending.jsonl`;
  }
  return state.fileUri ?? `Documents/${state.logicalPath}`;
}

export function buildGameplayValidationDebugLogFileName(startedAtMs: number): string {
  return `playscene-debug-overlay-${formatTimestampForFile(startedAtMs)}.jsonl`;
}

export function buildGameplayValidationDebugLogPath(startedAtMs: number): string {
  return `${LOG_ROOT_DIRECTORY}/${buildGameplayValidationDebugLogFileName(startedAtMs)}`;
}

function ensureState(metadata: GameplayValidationDebugLogMetadata, atMs: number): GameplayValidationDebugLogState {
  if (!state || state.closed) {
    const nextState = createInitialState(metadata, atMs);
    state = nextState;
    enqueueEntry(nextState, {
      kind: 'session-start',
      sessionId: nextState.sessionId,
      startedAtMs: nextState.startedAtMs,
      metadata: nextState.metadata,
      logicalPath: nextState.logicalPath
    });
  }
  return state;
}

function createInitialState(
  metadata: GameplayValidationDebugLogMetadata,
  startedAtMs: number = readClockMs()
): GameplayValidationDebugLogState {
  const sessionId = formatTimestampForFile(startedAtMs);
  return {
    sessionId,
    startedAtMs,
    logicalPath: buildGameplayValidationDebugLogPath(startedAtMs),
    fileUri: null,
    lastWrittenAtMs: Number.NEGATIVE_INFINITY,
    lastSignature: '',
    lastError: null,
    writeChain: Promise.resolve(),
    closed: false,
    metadata: {
      songId: metadata.songId?.trim() || undefined,
      midiUrl: metadata.midiUrl?.trim() || undefined
    }
  };
}

function shouldEmitSnapshot(
  current: GameplayValidationDebugLogState,
  signature: string,
  capturedAtMs: number
): boolean {
  if (current.lastSignature === '') return true;
  if (current.lastSignature !== signature) return true;
  return capturedAtMs - current.lastWrittenAtMs >= LOG_THROTTLE_MS;
}

function buildSnapshotSignature(snapshot: GameplayValidationDebugSnapshot): string {
  return [
    snapshot.window.phase,
    snapshot.window.targetKey ?? '-',
    snapshot.window.deadTime ? 'dead' : 'live',
    snapshot.runtime.acceptedPreGate ? 'pre1' : 'pre0',
    snapshot.runtime.acceptedPostGate ? 'post1' : 'post0',
    snapshot.runtime.rejectStage,
    snapshot.runtime.gateRejectReason ?? '-',
    snapshot.spectral.expectedNotePresent ? 'expected1' : 'expected0',
    snapshot.runtime.noteValidationRatio.toFixed(2),
    snapshot.target.targetMode ?? '-'
  ].join('|');
}

function enqueueEntry(state: GameplayValidationDebugLogState, entry: GameplayValidationDebugLogEntry): void {
  state.writeChain = state.writeChain
    .then(async () => {
      if (!Capacitor.isNativePlatform()) return;

      await ensureLogDirectory();
      const payload = `${JSON.stringify(entry)}\n`;
      await Filesystem.appendFile({
        directory: Directory.Documents,
        path: state.logicalPath,
        data: payload,
        encoding: Encoding.UTF8
      });
      try {
        const fileInfo = await Filesystem.getUri({
          directory: Directory.Documents,
          path: state.logicalPath
        });
        state.fileUri = fileInfo.uri;
      } catch {
        state.fileUri = null;
      }
      state.lastError = null;
    })
    .catch(async (error: unknown) => {
      state.lastError = formatError(error);
      try {
        await ensureLogDirectory();
        const errorEntry: GameplayValidationDebugLogEntry = {
          kind: 'error',
          sessionId: state.sessionId,
          atMs: readClockMs(),
          metadata: state.metadata,
          logicalPath: state.logicalPath,
          message: state.lastError
        };
        await Filesystem.appendFile({
          directory: Directory.Documents,
          path: state.logicalPath,
          data: `${JSON.stringify(errorEntry)}\n`,
          encoding: Encoding.UTF8
        });
      } catch {
        // Best effort only. The log should never interrupt gameplay.
      }
    });
}

async function ensureLogDirectory(): Promise<void> {
  await Filesystem.mkdir({
    directory: Directory.Documents,
    path: LOG_ROOT_DIRECTORY,
    recursive: true
  });
}

function formatTimestampForFile(value: number): string {
  return new Date(value).toISOString().replace(/:/g, '-').replace(/\./g, '-');
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
