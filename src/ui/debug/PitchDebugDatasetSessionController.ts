import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

export type PitchDebugDatasetTakeStatus = 'pending' | 'recorded' | 'skipped';

export type PitchDebugDatasetTakeRecord = {
  id: string;
  order: number;
  stringId: number;
  fret: number;
  take: number;
  status: PitchDebugDatasetTakeStatus;
  relativePath: string;
  durationSec: number | null;
  sampleRate: number | null;
  sampleCount: number | null;
  bytes: number | null;
  recordedAtIso: string | null;
  validationError: string | null;
};

export type PitchDebugDatasetManifest = {
  version: 1;
  sessionId: string;
  createdAtIso: string;
  updatedAtIso: string;
  completedAtIso: string | null;
  storage: {
    rootRelativePath: string;
    audioRelativePath: string;
  };
  traversal: {
    stringOrder: number[];
    fretStart: number;
    fretEnd: number;
    takesPerTarget: number;
    totalTakes: number;
  };
  audioFormat: {
    sampleRate: number | null;
    channels: 1;
    encoding: 'float32le';
    wavAudioFormatCode: 3;
    bitsPerSample: 32;
    blockSize: number | null;
    callbackFrames: number | null;
    notes: string;
  };
  takes: PitchDebugDatasetTakeRecord[];
  summary: {
    pending: number;
    recorded: number;
    skipped: number;
    completed: number;
    total: number;
    isComplete: boolean;
  };
};

export type PitchDebugDatasetProgress = {
  sessionId: string;
  updatedAtIso: string;
  nextTakeId: string | null;
  completed: number;
  total: number;
  recorded: number;
  skipped: number;
};

export type NativeDatasetTakeFinalizeResult = {
  recorded: boolean;
  discarded: boolean;
  outputPath: string | null;
  sampleRate: number | null;
  channelCount: number | null;
  encoding: string | null;
  bitsPerSample: number | null;
  sampleCount: number | null;
  durationSec: number | null;
  bytesWritten: number | null;
  fileExists: boolean;
  headerValid: boolean;
  wavAudioFormat: number | null;
  wavChannels: number | null;
  wavSampleRate: number | null;
  wavBitsPerSample: number | null;
  wavDataBytes: number | null;
  validationError: string | null;
};

const SESSION_ROOT = 'pitch_debug_recordings';
const MANIFEST_FILE = 'manifest.json';
const PROGRESS_FILE = 'progress.json';

type CreateSessionOptions = {
  stringOrder?: number[];
  fretStart?: number;
  fretEnd?: number;
  takesPerTarget?: number;
  blockSize?: number | null;
  callbackFrames?: number | null;
};

export class PitchDebugDatasetSessionController {
  async loadLatestIncompleteSession(): Promise<PitchDebugDatasetManifest | null> {
    const entries = await listDirectorySafe(SESSION_ROOT);
    if (entries.length <= 0) {
      return null;
    }
    const manifests: PitchDebugDatasetManifest[] = [];
    for (const entryName of entries) {
      const sessionPath = `${SESSION_ROOT}/${entryName}`;
      const manifest = await this.readManifest(sessionPath);
      if (manifest) {
        manifests.push(manifest);
      }
    }
    manifests.sort((left, right) => right.createdAtIso.localeCompare(left.createdAtIso));
    for (const manifest of manifests) {
      if (!manifest.summary.isComplete) {
        return manifest;
      }
    }
    return null;
  }

  async createNewSession(options: CreateSessionOptions = {}): Promise<PitchDebugDatasetManifest> {
    const stringOrder = options.stringOrder ?? [6, 5, 4, 3, 2, 1];
    const fretStart = options.fretStart ?? 0;
    const fretEnd = options.fretEnd ?? 12;
    const takesPerTarget = options.takesPerTarget ?? 3;
    const now = new Date();
    const sessionId = `session_${formatSessionTimestamp(now)}`;
    const rootRelativePath = `${SESSION_ROOT}/${sessionId}`;
    const audioRelativePath = `${rootRelativePath}/audio`;
    const takes = buildTakePlan(stringOrder, fretStart, fretEnd, takesPerTarget, audioRelativePath);
    const manifest: PitchDebugDatasetManifest = {
      version: 1,
      sessionId,
      createdAtIso: now.toISOString(),
      updatedAtIso: now.toISOString(),
      completedAtIso: null,
      storage: {
        rootRelativePath,
        audioRelativePath
      },
      traversal: {
        stringOrder,
        fretStart,
        fretEnd,
        takesPerTarget,
        totalTakes: takes.length
      },
      audioFormat: {
        sampleRate: null,
        channels: 1,
        encoding: 'float32le',
        wavAudioFormatCode: 3,
        bitsPerSample: 32,
        blockSize: options.blockSize ?? null,
        callbackFrames: options.callbackFrames ?? null,
        notes: 'Saved WAV files contain mono IEEE float32 samples from the same native block stream sent to the pitch runtime.'
      },
      takes,
      summary: {
        pending: takes.length,
        recorded: 0,
        skipped: 0,
        completed: 0,
        total: takes.length,
        isComplete: false
      }
    };
    await Filesystem.mkdir({
      path: audioRelativePath,
      directory: Directory.Data,
      recursive: true
    }).catch(() => undefined);
    await this.persist(manifest);
    return manifest;
  }

  getNextPendingTake(manifest: PitchDebugDatasetManifest): PitchDebugDatasetTakeRecord | null {
    for (const take of manifest.takes) {
      if (take.status === 'pending') {
        return take;
      }
    }
    return null;
  }

  async persist(manifest: PitchDebugDatasetManifest): Promise<void> {
    const nowIso = new Date().toISOString();
    const recomputed = recomputeSummary({
      ...manifest,
      updatedAtIso: nowIso
    });
    await Filesystem.mkdir({
      path: recomputed.storage.rootRelativePath,
      directory: Directory.Data,
      recursive: true
    }).catch(() => undefined);
    await Filesystem.writeFile({
      path: `${recomputed.storage.rootRelativePath}/${MANIFEST_FILE}`,
      directory: Directory.Data,
      data: JSON.stringify(recomputed, null, 2),
      encoding: Encoding.UTF8
    });
    const nextTake = this.getNextPendingTake(recomputed);
    const progress: PitchDebugDatasetProgress = {
      sessionId: recomputed.sessionId,
      updatedAtIso: recomputed.updatedAtIso,
      nextTakeId: nextTake?.id ?? null,
      completed: recomputed.summary.completed,
      total: recomputed.summary.total,
      recorded: recomputed.summary.recorded,
      skipped: recomputed.summary.skipped
    };
    await Filesystem.writeFile({
      path: `${recomputed.storage.rootRelativePath}/${PROGRESS_FILE}`,
      directory: Directory.Data,
      data: JSON.stringify(progress, null, 2),
      encoding: Encoding.UTF8
    });
    manifest.updatedAtIso = recomputed.updatedAtIso;
    manifest.completedAtIso = recomputed.completedAtIso;
    manifest.summary = recomputed.summary;
  }

  async markCurrentTakeRecorded(
    manifest: PitchDebugDatasetManifest,
    takeId: string,
    result: NativeDatasetTakeFinalizeResult
  ): Promise<{ ok: boolean; error: string | null }> {
    const take = manifest.takes.find((entry) => entry.id === takeId);
    if (!take) {
      return { ok: false, error: `Dataset take not found: ${takeId}` };
    }
    if (!result.recorded || result.discarded) {
      return { ok: false, error: 'Native recorder did not return a completed take.' };
    }
    if (!result.fileExists || !result.headerValid) {
      return {
        ok: false,
        error: result.validationError ?? 'Native recorder output failed file/header validation.'
      };
    }
    if (
      !Number.isFinite(result.durationSec) ||
      (result.durationSec ?? 0) <= 0 ||
      !Number.isFinite(result.sampleCount) ||
      (result.sampleCount ?? 0) <= 0
    ) {
      return { ok: false, error: 'Native recorder returned an empty or invalid take duration.' };
    }
    if ((result.durationSec ?? 0) > 12) {
      return { ok: false, error: 'Native recorder returned an implausible take duration.' };
    }
    if (!Number.isFinite(result.bytesWritten) || (result.bytesWritten ?? 0) <= 44) {
      return { ok: false, error: 'Saved take file is too small to contain valid WAV audio.' };
    }
    if ((result.wavAudioFormat ?? 0) !== 3 || (result.wavChannels ?? 0) !== 1 || (result.wavBitsPerSample ?? 0) !== 32) {
      return { ok: false, error: 'Saved WAV header does not match expected mono float32 format.' };
    }
    const stats = await Filesystem.stat({
      path: take.relativePath,
      directory: Directory.Data
    }).catch(() => null);
    if (!stats) {
      return { ok: false, error: 'Saved file is missing on app-local storage.' };
    }
    take.status = 'recorded';
    take.durationSec = result.durationSec ?? null;
    take.sampleRate = result.sampleRate ?? result.wavSampleRate ?? null;
    take.sampleCount = result.sampleCount ?? null;
    take.bytes = result.bytesWritten ?? null;
    take.recordedAtIso = new Date().toISOString();
    take.validationError = null;
    if (manifest.audioFormat.sampleRate === null && take.sampleRate && Number.isFinite(take.sampleRate)) {
      manifest.audioFormat.sampleRate = take.sampleRate;
    }
    await this.persist(manifest);
    return { ok: true, error: null };
  }

  async skipCurrentTarget(manifest: PitchDebugDatasetManifest, takeId: string): Promise<number> {
    const current = manifest.takes.find((entry) => entry.id === takeId);
    if (!current) {
      return 0;
    }
    let skipped = 0;
    for (const take of manifest.takes) {
      if (take.stringId !== current.stringId || take.fret !== current.fret) {
        continue;
      }
      if (take.status !== 'pending') {
        continue;
      }
      take.status = 'skipped';
      take.durationSec = null;
      take.sampleRate = null;
      take.sampleCount = null;
      take.bytes = null;
      take.recordedAtIso = new Date().toISOString();
      take.validationError = null;
      skipped += 1;
    }
    if (skipped > 0) {
      await this.persist(manifest);
    }
    return skipped;
  }

  async resetTakeToPending(manifest: PitchDebugDatasetManifest, takeId: string): Promise<boolean> {
    const take = manifest.takes.find((entry) => entry.id === takeId);
    if (!take) {
      return false;
    }
    take.status = 'pending';
    take.durationSec = null;
    take.sampleRate = null;
    take.sampleCount = null;
    take.bytes = null;
    take.recordedAtIso = null;
    take.validationError = null;
    await Filesystem.deleteFile({
      path: take.relativePath,
      directory: Directory.Data
    }).catch(() => undefined);
    await this.persist(manifest);
    return true;
  }

  private async readManifest(sessionPath: string): Promise<PitchDebugDatasetManifest | null> {
    const raw = await Filesystem.readFile({
      path: `${sessionPath}/${MANIFEST_FILE}`,
      directory: Directory.Data,
      encoding: Encoding.UTF8
    }).catch(() => null);
    if (!raw || typeof raw.data !== 'string') {
      return null;
    }
    try {
      const parsed = JSON.parse(raw.data) as PitchDebugDatasetManifest;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      if (!Array.isArray(parsed.takes)) {
        return null;
      }
      return recomputeSummary(parsed);
    } catch {
      return null;
    }
  }
}

function recomputeSummary(manifest: PitchDebugDatasetManifest): PitchDebugDatasetManifest {
  const recorded = manifest.takes.filter((take) => take.status === 'recorded').length;
  const skipped = manifest.takes.filter((take) => take.status === 'skipped').length;
  const pending = manifest.takes.length - recorded - skipped;
  const completed = recorded + skipped;
  const isComplete = pending <= 0;
  return {
    ...manifest,
    completedAtIso: isComplete ? (manifest.completedAtIso ?? new Date().toISOString()) : null,
    summary: {
      pending: Math.max(0, pending),
      recorded,
      skipped,
      completed,
      total: manifest.takes.length,
      isComplete
    }
  };
}

function buildTakePlan(
  stringOrder: number[],
  fretStart: number,
  fretEnd: number,
  takesPerTarget: number,
  audioRelativePath: string
): PitchDebugDatasetTakeRecord[] {
  const out: PitchDebugDatasetTakeRecord[] = [];
  let order = 0;
  for (const stringId of stringOrder) {
    for (let fret = fretStart; fret <= fretEnd; fret += 1) {
      for (let take = 1; take <= takesPerTarget; take += 1) {
        order += 1;
        out.push({
          id: `s${pad2(stringId)}_f${pad2(fret)}_t${pad2(take)}`,
          order,
          stringId,
          fret,
          take,
          status: 'pending',
          relativePath: `${audioRelativePath}/string_${pad2(stringId)}_fret_${pad2(fret)}_take_${pad2(take)}.wav`,
          durationSec: null,
          sampleRate: null,
          sampleCount: null,
          bytes: null,
          recordedAtIso: null,
          validationError: null
        });
      }
    }
  }
  return out;
}

async function listDirectorySafe(path: string): Promise<string[]> {
  const result = await Filesystem.readdir({
    path,
    directory: Directory.Data
  }).catch(() => null);
  if (!result || !Array.isArray(result.files)) {
    return [];
  }
  const out: string[] = [];
  const entries = result.files as unknown[];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.trim().length > 0) {
        out.push(entry);
      }
      continue;
    }
    if (entry && typeof entry === 'object') {
      const maybeName = (entry as { name?: unknown }).name;
      if (typeof maybeName === 'string' && maybeName.trim().length > 0) {
        out.push(maybeName);
      }
    }
  }
  return out;
}

function formatSessionTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = pad2(value.getMonth() + 1);
  const day = pad2(value.getDate());
  const hour = pad2(value.getHours());
  const minute = pad2(value.getMinutes());
  const second = pad2(value.getSeconds());
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function pad2(value: number): string {
  return `${Math.max(0, Math.round(value))}`.padStart(2, '0');
}
