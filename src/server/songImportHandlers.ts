import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  resolveRequestedConverterMode as resolveRequestedConverterModeShared,
  toExecutableConverterMode
} from '../platform/converterMode';
import {
  estimateTempoFromAudioBuffer,
  getCoverFileExtension,
  loadAudioToMidiConverter,
  loadCoverExtractor
} from './converterLoader';
import {
  detectImportSource,
  safeDecodeURIComponent,
  sanitizeSongFolderName,
  sanitizeUploadFileName,
  toDisplaySongName
} from './fileDetection';
import { buildUniqueSongFolder, buildUniqueSongId, readSongManifest, writeSongManifest } from './songManifest';
import type {
  RequestedConverterMode,
  SongImportJob,
  SongImportPayload,
  SongImportRuntime,
  SongManifestEntry
} from './songImportTypes';

export const IMPORT_START_PATH = '/api/song-import/start';
export const IMPORT_STATUS_PATH_PREFIX = '/api/song-import/status/';
export const SONG_REMOVE_PATH = '/api/song-remove';

const SONG_CONVERTER_MODE_HEADER = 'x-song-converter-mode';
const MAX_IMPORT_AUDIO_BYTES = 80 * 1024 * 1024;
const JOB_RETENTION_MS = 30 * 60 * 1000;
const CONVERTER_DEBUG_ENV_FLAG = 'GH_ENABLE_DEBUG_CONVERTER';

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function createInitialJob(id: string, fileName: string): SongImportJob {
  const timestamp = nowIso();
  return {
    id,
    status: 'queued',
    stage: 'Queued...',
    progress: 0,
    fileName,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function updateImportJob(runtime: SongImportRuntime, jobId: string, patch: Partial<SongImportJob>): void {
  const current = runtime.importJobs.get(jobId);
  if (!current) return;

  Object.assign(current, patch);
  current.progress = clampProgress(current.progress);
  current.updatedAt = nowIso();
}

function pruneOldJobs(runtime: SongImportRuntime): void {
  const expirationTime = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of runtime.importJobs.entries()) {
    if (Date.parse(job.updatedAt) < expirationTime) {
      runtime.importJobs.delete(id);
    }
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req: IncomingMessage, maxBytes = MAX_IMPORT_AUDIO_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += data.length;

      if (totalBytes > maxBytes) {
        reject(new Error(`Uploaded file exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit.`));
        req.destroy();
        return;
      }

      chunks.push(data);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('aborted', () => reject(new Error('Upload aborted by client.')));
    req.on('error', reject);
  });
}

function isDebugConverterModeEnabled(): boolean {
  const envValue = String(process.env[CONVERTER_DEBUG_ENV_FLAG] ?? '')
    .trim()
    .toLowerCase();
  if (envValue === '1' || envValue === 'true' || envValue === 'yes') return true;
  return process.env.NODE_ENV !== 'production';
}

function resolveRequestedConverterMode(rawValue: string): RequestedConverterMode {
  return resolveRequestedConverterModeShared(rawValue, isDebugConverterModeEnabled());
}

function resolveRequestedConverterModeFromRequest(req: IncomingMessage): RequestedConverterMode {
  const header = getHeaderValue(req.headers[SONG_CONVERTER_MODE_HEADER]);
  return resolveRequestedConverterMode(header);
}

async function processSongImport(runtime: SongImportRuntime, jobId: string, payload: SongImportPayload): Promise<void> {
  let songDirectoryPath: string | null = null;
  let manifestUpdated = false;

  try {
    updateImportJob(runtime, jobId, {
      status: 'processing',
      stage: 'Creating song folder...',
      progress: 0.05,
      error: undefined,
      result: undefined
    });

    await fs.mkdir(runtime.runtimeSongsDir, { recursive: true });

    const baseFolderName = sanitizeSongFolderName(payload.fileName);
    const folderName = await buildUniqueSongFolder(runtime.runtimeSongsDir, baseFolderName);
    songDirectoryPath = path.join(runtime.runtimeSongsDir, folderName);
    await fs.mkdir(songDirectoryPath, { recursive: false });

    const midiFileName = 'song.mid';
    let audioFileName: string | undefined;
    let coverFileName: string | undefined;

    if (payload.sourceType === 'audio') {
      if (!payload.audioExtension) {
        throw new Error('Invalid import payload: missing audio extension.');
      }

      updateImportJob(runtime, jobId, {
        stage: 'Saving source audio...',
        progress: 0.1
      });

      audioFileName = `song${payload.audioExtension}`;
      await fs.writeFile(path.join(songDirectoryPath, audioFileName), payload.buffer);

      updateImportJob(runtime, jobId, {
        stage: 'Estimating tempo (Tempo-CNN ONNX)...',
        progress: 0.16
      });

      const tempoEstimate = await estimateTempoFromAudioBuffer(runtime, payload.buffer, payload.audioExtension);

      const runConverter = async (
        mode: 'legacy' | 'neuralnote',
        progressStart: number,
        progressSpan: number,
        fallbackStage: string
      ): Promise<Buffer> => {
        const converter = await loadAudioToMidiConverter(runtime, mode);
        return converter.convertAudioBufferToMidiBuffer(payload.buffer, payload.audioExtension, {
          conversionPreset: 'balanced',
          tempoBpm: tempoEstimate.tempoBpm,
          tempoMap: tempoEstimate.tempoMap,
          onProgress: ({ stage, progress }) => {
            const normalizedProgress = clampProgress(Number(progress ?? 0));
            const stageLabel = String(stage || fallbackStage).trim() || fallbackStage;
            updateImportJob(runtime, jobId, {
              stage: stageLabel,
              progress: progressStart + normalizedProgress * progressSpan
            });
          }
        });
      };

      const converterMode = toExecutableConverterMode(payload.converterMode);
      if (!converterMode) {
        throw new Error('Converter mode "ab" is no longer available. Use "legacy" or "neuralnote" (C++/ONNX aliases).');
      }
      const midiBuffer = await runConverter(converterMode, 0.22, 0.68, 'Converting audio to MIDI (C++/ONNX)...');
      await fs.writeFile(path.join(songDirectoryPath, midiFileName), midiBuffer);

      updateImportJob(runtime, jobId, {
        stage: 'Checking embedded artwork...',
        progress: 0.92
      });

      const coverExtractor = await loadCoverExtractor(runtime);
      const embeddedCover = coverExtractor.extractEmbeddedCover({
        buffer: payload.buffer,
        fileName: payload.fileName,
        mimeType: payload.mimeType
      });

      if (embeddedCover && embeddedCover.data && Number(embeddedCover.data.length) > 0) {
        const coverExt = getCoverFileExtension(embeddedCover);
        coverFileName = `cover${coverExt}`;
        await fs.writeFile(path.join(songDirectoryPath, coverFileName), Buffer.from(embeddedCover.data));
      }
    } else {
      updateImportJob(runtime, jobId, {
        stage: 'Saving source MIDI...',
        progress: 0.2
      });
      await fs.writeFile(path.join(songDirectoryPath, midiFileName), payload.buffer);

      updateImportJob(runtime, jobId, {
        stage: 'Skipping artwork extraction for MIDI source...',
        progress: 0.92
      });
    }

    updateImportJob(runtime, jobId, {
      stage: 'Updating song manifest...',
      progress: 0.97
    });

    const manifest = await readSongManifest(runtime.runtimeSongManifestPath);
    const songName = toDisplaySongName(folderName);
    const songId = buildUniqueSongId(songName, manifest.songs);

    const newSongEntry: SongManifestEntry = {
      id: songId,
      name: songName,
      folder: folderName,
      midi: midiFileName
    };

    if (audioFileName) {
      newSongEntry.audio = audioFileName;
    }
    if (coverFileName) {
      newSongEntry.cover = coverFileName;
    }

    manifest.songs.push(newSongEntry);
    await writeSongManifest(runtime.runtimeSongsDir, runtime.runtimeSongManifestPath, manifest);
    manifestUpdated = true;

    updateImportJob(runtime, jobId, {
      status: 'completed',
      stage: 'Import completed.',
      progress: 1,
      result: {
        song: newSongEntry,
        coverExtracted: Boolean(coverFileName),
        sourceType: payload.sourceType,
        sourceExtension: payload.sourceExtension,
        ...(payload.audioExtension ? { audioExtension: payload.audioExtension } : {}),
        converterMode: payload.converterMode
      }
    });
  } catch (error) {
    if (!manifestUpdated && songDirectoryPath) {
      await fs.rm(songDirectoryPath, { recursive: true, force: true }).catch(() => undefined);
    }

    const message = error instanceof Error && error.message ? error.message : 'Song import failed.';
    updateImportJob(runtime, jobId, {
      status: 'failed',
      stage: 'Import failed.',
      progress: 1,
      error: message
    });
  }
}

export async function handleImportStart(runtime: SongImportRuntime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  pruneOldJobs(runtime);

  try {
    const encodedFileName = getHeaderValue(req.headers['x-song-file-name']).trim();
    const fileName = sanitizeUploadFileName(safeDecodeURIComponent(encodedFileName));
    const mimeType = getHeaderValue(req.headers['content-type']).split(';')[0].trim().toLowerCase();
    const converterMode = resolveRequestedConverterModeFromRequest(req);
    if (converterMode === 'ab') {
      sendJson(res, 400, {
        error: 'Converter mode "ab" is no longer available. Use "legacy" or "neuralnote" (C++/ONNX aliases).'
      });
      return;
    }

    const importSource = detectImportSource(fileName, mimeType);
    if (!importSource) {
      sendJson(res, 400, {
        error: 'Unsupported format. Please upload MIDI, MP3, or OGG.'
      });
      return;
    }

    const inputBuffer = await readRequestBody(req);
    if (inputBuffer.length === 0) {
      sendJson(res, 400, { error: 'Uploaded file is empty.' });
      return;
    }

    const jobId = randomUUID();
    runtime.importJobs.set(jobId, createInitialJob(jobId, fileName));
    void processSongImport(runtime, jobId, {
      fileName,
      mimeType,
      sourceType: importSource.sourceType,
      sourceExtension: importSource.sourceExtension,
      ...(importSource.sourceType === 'audio' ? { audioExtension: importSource.sourceExtension } : {}),
      converterMode,
      buffer: inputBuffer
    });

    sendJson(res, 202, { jobId, converterMode });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Could not start audio import.';
    sendJson(res, 500, { error: message });
  }
}

export async function handleImportStatus(runtime: SongImportRuntime, res: ServerResponse, jobId: string): Promise<void> {
  pruneOldJobs(runtime);

  if (!jobId) {
    sendJson(res, 400, { error: 'Missing job id.' });
    return;
  }

  const job = runtime.importJobs.get(jobId);
  if (!job) {
    sendJson(res, 404, { error: 'Import job not found.' });
    return;
  }

  sendJson(res, 200, {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    fileName: job.fileName,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
}

export async function handleSongRemove(runtime: SongImportRuntime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    if (body.length <= 0) {
      sendJson(res, 400, { error: 'Missing request body.' });
      return;
    }

    const payload = JSON.parse(body.toString('utf8')) as { songId?: unknown; folder?: unknown };
    const songId = typeof payload.songId === 'string' ? payload.songId.trim() : '';
    const folder = typeof payload.folder === 'string' ? payload.folder.trim() : '';
    if (!songId && !folder) {
      sendJson(res, 400, { error: 'Missing song id or folder.' });
      return;
    }

    const manifest = await readSongManifest(runtime.runtimeSongManifestPath);
    const index = manifest.songs.findIndex((song) => {
      if (songId && song.id === songId) return true;
      if (folder && song.folder === folder) return true;
      return false;
    });
    if (index < 0) {
      sendJson(res, 404, { error: 'Song not found.' });
      return;
    }

    const [removedSong] = manifest.songs.splice(index, 1);
    await writeSongManifest(runtime.runtimeSongsDir, runtime.runtimeSongManifestPath, manifest);

    const folderToDelete = removedSong?.folder?.trim();
    if (folderToDelete) {
      const songDirectoryPath = path.resolve(runtime.runtimeSongsDir, folderToDelete);
      const rootPath = path.resolve(runtime.runtimeSongsDir);
      if (songDirectoryPath === rootPath || !songDirectoryPath.startsWith(`${rootPath}${path.sep}`)) {
        sendJson(res, 500, { error: 'Resolved song path is outside songs root.' });
        return;
      }
      await fs.rm(songDirectoryPath, { recursive: true, force: true });
    }

    sendJson(res, 200, { ok: true, songId: removedSong?.id ?? songId });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Could not remove song.';
    sendJson(res, 500, { error: message });
  }
}
