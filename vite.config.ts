import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

type SupportedAudioExtension = '.mp3' | '.ogg' | '.wav';
type SongImportStatus = 'queued' | 'processing' | 'completed' | 'failed';

type SongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi: string;
  audio: string;
};

type SongManifestDocument = {
  songs: SongManifestEntry[];
  [key: string]: unknown;
};

type SongImportJob = {
  id: string;
  status: SongImportStatus;
  stage: string;
  progress: number;
  fileName: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    song: SongManifestEntry;
    coverExtracted: boolean;
    audioExtension: SupportedAudioExtension;
  };
};

type SongImportPayload = {
  fileName: string;
  mimeType: string;
  audioExtension: SupportedAudioExtension;
  buffer: Buffer;
};

type AudioToMidiConverter = {
  convertAudioBufferToMidiBuffer: (
    inputBuffer: Buffer,
    mimeOrExt?: string,
    options?: {
      conversionPreset?: 'accurate' | 'balanced' | 'dense';
      onProgress?: (update: { stage?: string; progress?: number }) => void;
    }
  ) => Promise<Buffer>;
};

type CoverExtractorModule = {
  extractEmbeddedCover: (input: {
    buffer: Buffer;
    fileName?: string;
    mimeType?: string;
  }) =>
    | {
        mimeType: string;
        extension: string;
        data: Buffer | Uint8Array;
      }
    | null;
};

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_SONGS_DIR = path.resolve(PROJECT_ROOT, 'public/songs');
const SONG_MANIFEST_PATH = path.resolve(PUBLIC_SONGS_DIR, 'manifest.json');
const BASIC_PITCH_MODEL_SOURCE_DIR = path.resolve(PROJECT_ROOT, 'assets/models/basic-pitch');
const BASIC_PITCH_MODEL_PUBLIC_PREFIX = '/models/basic-pitch/';

const IMPORT_START_PATH = '/api/song-import/start';
const IMPORT_STATUS_PATH_PREFIX = '/api/song-import/status/';
const MAX_IMPORT_AUDIO_BYTES = 80 * 1024 * 1024;
const JOB_RETENTION_MS = 30 * 60 * 1000;
const SUPPORTED_AUDIO_EXTENSIONS = new Set<SupportedAudioExtension>(['.mp3', '.ogg', '.wav']);

const importJobs = new Map<string, SongImportJob>();
let converterPromise: Promise<AudioToMidiConverter> | null = null;
let coverExtractorPromise: Promise<CoverExtractorModule> | null = null;

function createBasicPitchModelAssetsPlugin(): Plugin {
  let buildOutDir = path.resolve(PROJECT_ROOT, 'dist');

  return {
    name: 'basic-pitch-model-assets',
    configResolved(config) {
      buildOutDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      registerBasicPitchModelMiddleware(server.middlewares.use.bind(server.middlewares), BASIC_PITCH_MODEL_SOURCE_DIR);
    },
    configurePreviewServer(server) {
      registerBasicPitchModelMiddleware(server.middlewares.use.bind(server.middlewares), BASIC_PITCH_MODEL_SOURCE_DIR);
    },
    async writeBundle() {
      const outputDir = path.join(buildOutDir, 'models/basic-pitch');
      await copyDirectoryRecursive(BASIC_PITCH_MODEL_SOURCE_DIR, outputDir);
    }
  };
}

function createSongImportApiPlugin(): Plugin {
  return {
    name: 'song-import-api',
    configureServer(server) {
      registerImportApiMiddleware(server.middlewares.use.bind(server.middlewares));
    },
    configurePreviewServer(server) {
      registerImportApiMiddleware(server.middlewares.use.bind(server.middlewares));
    }
  };
}

function registerBasicPitchModelMiddleware(
  register: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void,
  sourceDir: string
): void {
  register((req, res, next) => {
    const pathname = stripQuery(req.url ?? '/');
    if (!pathname.startsWith(BASIC_PITCH_MODEL_PUBLIC_PREFIX)) {
      next();
      return;
    }

    const relativePath = safeDecodeURIComponent(pathname.slice(BASIC_PITCH_MODEL_PUBLIC_PREFIX.length)).trim();
    if (!relativePath || relativePath.includes('..')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const sourcePath = path.resolve(sourceDir, relativePath);
    const safePrefix = `${sourceDir}${path.sep}`;
    if (sourcePath !== sourceDir && !sourcePath.startsWith(safePrefix)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    void fs
      .readFile(sourcePath)
      .then((fileBytes) => {
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', contentTypeForPath(sourcePath));
        res.end(fileBytes);
      })
      .catch(() => {
        res.statusCode = 404;
        res.end('Not found');
      });
  });
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.bin') return 'application/octet-stream';
  return 'application/octet-stream';
}

function registerImportApiMiddleware(
  register: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
): void {
  register((req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = stripQuery(req.url ?? '/');

    if (method === 'POST' && pathname === IMPORT_START_PATH) {
      void handleImportStart(req, res);
      return;
    }

    if (method === 'GET' && pathname.startsWith(IMPORT_STATUS_PATH_PREFIX)) {
      const rawJobId = pathname.slice(IMPORT_STATUS_PATH_PREFIX.length).trim();
      const jobId = safeDecodeURIComponent(rawJobId);
      void handleImportStatus(res, jobId);
      return;
    }

    next();
  });
}

function stripQuery(urlValue: string): string {
  const marker = urlValue.indexOf('?');
  return marker === -1 ? urlValue : urlValue.slice(0, marker);
}

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

function safeDecodeURIComponent(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeUploadFileName(fileName: string): string {
  const baseName = path.basename(String(fileName || '').trim());
  const cleaned = baseName.replace(/[\u0000-\u001f]/g, '').replace(/[\\/]+/g, '').trim();
  return cleaned || 'uploaded-song.mp3';
}

function sanitizeSongFolderName(fileName: string): string {
  const withoutExtension = path.basename(fileName, path.extname(fileName));
  const cleaned = withoutExtension
    .replace(/[<>:"|?*]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') return 'New Song';
  return cleaned;
}

function toDisplaySongName(folderName: string): string {
  const clean = String(folderName || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'New Song';
}

function slugifySongId(value: string): string {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'song';
}

function buildUniqueSongId(baseName: string, songs: SongManifestEntry[]): string {
  const existing = new Set(songs.map((song) => song.id.toLowerCase()));
  const base = slugifySongId(baseName);

  if (!existing.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function detectAudioExtension(fileName: string, mimeType: string): SupportedAudioExtension | null {
  const ext = path.extname(fileName).toLowerCase() as SupportedAudioExtension;
  if (SUPPORTED_AUDIO_EXTENSIONS.has(ext)) return ext;

  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return '.mp3';
  if (mime.includes('audio/ogg') || mime.includes('audio/x-ogg') || mime.includes('audio/opus')) return '.ogg';
  if (mime.includes('audio/wav') || mime.includes('audio/wave') || mime.includes('audio/x-wav')) return '.wav';

  return null;
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

function updateImportJob(jobId: string, patch: Partial<SongImportJob>): void {
  const current = importJobs.get(jobId);
  if (!current) return;

  Object.assign(current, patch);
  current.progress = clampProgress(current.progress);
  current.updatedAt = nowIso();
}

function pruneOldJobs(): void {
  const expirationTime = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of importJobs.entries()) {
    if (Date.parse(job.updatedAt) < expirationTime) {
      importJobs.delete(id);
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
        reject(new Error(`Uploaded audio exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit.`));
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

async function loadAudioToMidiConverter(): Promise<AudioToMidiConverter> {
  if (!converterPromise) {
    const moduleUrl = pathToFileURL(path.resolve(PROJECT_ROOT, 'scripts/audio-to-midi.mjs')).href;
    converterPromise = import(moduleUrl).then((moduleValue) => {
      const converter = (moduleValue.default ?? moduleValue) as Partial<AudioToMidiConverter>;
      if (!converter || typeof converter.convertAudioBufferToMidiBuffer !== 'function') {
        throw new Error('Audio to MIDI converter is not available.');
      }
      return converter as AudioToMidiConverter;
    });
  }

  return converterPromise;
}

async function loadCoverExtractor(): Promise<CoverExtractorModule> {
  if (!coverExtractorPromise) {
    const moduleUrl = pathToFileURL(path.resolve(PROJECT_ROOT, 'scripts/audio-cover-extractor.mjs')).href;
    coverExtractorPromise = import(moduleUrl).then((moduleValue) => {
      const extractor = moduleValue as Partial<CoverExtractorModule>;
      if (!extractor || typeof extractor.extractEmbeddedCover !== 'function') {
        throw new Error('Embedded cover extractor is not available.');
      }
      return extractor as CoverExtractorModule;
    });
  }

  return coverExtractorPromise;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildUniqueSongFolder(baseFolderName: string): Promise<string> {
  let candidate = baseFolderName;
  let suffix = 2;

  while (await pathExists(path.join(PUBLIC_SONGS_DIR, candidate))) {
    candidate = `${baseFolderName} (${suffix})`;
    suffix += 1;
  }

  return candidate;
}

function normalizeManifestEntry(value: unknown): SongManifestEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;

  const id = typeof data.id === 'string' ? data.id.trim() : '';
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const folder = typeof data.folder === 'string' ? data.folder.trim() : '';
  const midi = typeof data.midi === 'string' ? data.midi.trim() : typeof data.file === 'string' ? data.file.trim() : '';
  const audio = typeof data.audio === 'string' ? data.audio.trim() : '';
  const cover = typeof data.cover === 'string' ? data.cover.trim() : undefined;

  if (!id || !name || !folder || !midi || !audio) return null;

  return {
    id,
    name,
    folder,
    midi,
    audio,
    cover: cover && cover.length > 0 ? cover : undefined
  };
}

async function readSongManifest(): Promise<SongManifestDocument> {
  let rawDoc: Record<string, unknown> = {};

  try {
    const raw = await fs.readFile(SONG_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      rawDoc = { ...(parsed as Record<string, unknown>) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }

  const normalizedSongs = Array.isArray(rawDoc.songs)
    ? rawDoc.songs.map((entry) => normalizeManifestEntry(entry)).filter((entry): entry is SongManifestEntry => entry !== null)
    : [];

  return {
    ...rawDoc,
    songs: normalizedSongs
  };
}

async function writeSongManifest(manifest: SongManifestDocument): Promise<void> {
  await fs.mkdir(PUBLIC_SONGS_DIR, { recursive: true });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(SONG_MANIFEST_PATH, serialized, 'utf8');
}

function getCoverFileExtension(rawCover: { extension?: string; mimeType?: string }): string {
  const extension = String(rawCover.extension || '').trim().toLowerCase();
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.gif' || extension === '.webp' || extension === '.bmp') {
    return extension === '.jpeg' ? '.jpg' : extension;
  }

  const mimeType = String(rawCover.mimeType || '').toLowerCase();
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/bmp') return '.bmp';
  return '.jpg';
}

async function processSongImport(jobId: string, payload: SongImportPayload): Promise<void> {
  let songDirectoryPath: string | null = null;
  let manifestUpdated = false;

  try {
    updateImportJob(jobId, {
      status: 'processing',
      stage: 'Creating song folder...',
      progress: 0.05,
      error: undefined,
      result: undefined
    });

    await fs.mkdir(PUBLIC_SONGS_DIR, { recursive: true });

    const baseFolderName = sanitizeSongFolderName(payload.fileName);
    const folderName = await buildUniqueSongFolder(baseFolderName);
    songDirectoryPath = path.join(PUBLIC_SONGS_DIR, folderName);
    await fs.mkdir(songDirectoryPath, { recursive: false });

    updateImportJob(jobId, {
      stage: 'Saving source audio...',
      progress: 0.1
    });

    const audioFileName = `song${payload.audioExtension}`;
    await fs.writeFile(path.join(songDirectoryPath, audioFileName), payload.buffer);

    updateImportJob(jobId, {
      stage: 'Converting audio to MIDI...',
      progress: 0.16
    });

    const converter = await loadAudioToMidiConverter();
    const midiBuffer = await converter.convertAudioBufferToMidiBuffer(payload.buffer, payload.audioExtension, {
      conversionPreset: 'balanced',
      onProgress: ({ stage, progress }) => {
        const normalizedProgress = clampProgress(Number(progress ?? 0));
        updateImportJob(jobId, {
          stage: String(stage || 'Converting audio to MIDI...').trim(),
          progress: 0.16 + normalizedProgress * 0.74
        });
      }
    });

    const midiFileName = 'song.mid';
    await fs.writeFile(path.join(songDirectoryPath, midiFileName), midiBuffer);

    updateImportJob(jobId, {
      stage: 'Checking embedded artwork...',
      progress: 0.92
    });

    const coverExtractor = await loadCoverExtractor();
    const embeddedCover = coverExtractor.extractEmbeddedCover({
      buffer: payload.buffer,
      fileName: payload.fileName,
      mimeType: payload.mimeType
    });

    let coverFileName: string | undefined;
    if (embeddedCover && embeddedCover.data && Number(embeddedCover.data.length) > 0) {
      const coverExt = getCoverFileExtension(embeddedCover);
      coverFileName = `cover${coverExt}`;
      await fs.writeFile(path.join(songDirectoryPath, coverFileName), Buffer.from(embeddedCover.data));
    }

    updateImportJob(jobId, {
      stage: 'Updating song manifest...',
      progress: 0.97
    });

    const manifest = await readSongManifest();
    const songName = toDisplaySongName(folderName);
    const songId = buildUniqueSongId(songName, manifest.songs);

    const newSongEntry: SongManifestEntry = {
      id: songId,
      name: songName,
      folder: folderName,
      midi: midiFileName,
      audio: audioFileName
    };

    if (coverFileName) {
      newSongEntry.cover = coverFileName;
    }

    manifest.songs.push(newSongEntry);
    await writeSongManifest(manifest);
    manifestUpdated = true;

    updateImportJob(jobId, {
      status: 'completed',
      stage: 'Import completed.',
      progress: 1,
      result: {
        song: newSongEntry,
        coverExtracted: Boolean(coverFileName),
        audioExtension: payload.audioExtension
      }
    });
  } catch (error) {
    if (!manifestUpdated && songDirectoryPath) {
      await fs.rm(songDirectoryPath, { recursive: true, force: true }).catch(() => undefined);
    }

    const message = error instanceof Error && error.message ? error.message : 'Audio import failed.';
    updateImportJob(jobId, {
      status: 'failed',
      stage: 'Import failed.',
      progress: 1,
      error: message
    });
  }
}

async function handleImportStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  pruneOldJobs();

  try {
    const encodedFileName = getHeaderValue(req.headers['x-song-file-name']).trim();
    const fileName = sanitizeUploadFileName(safeDecodeURIComponent(encodedFileName));
    const mimeType = getHeaderValue(req.headers['content-type']).split(';')[0].trim().toLowerCase();

    const audioExtension = detectAudioExtension(fileName, mimeType);
    if (!audioExtension || !SUPPORTED_AUDIO_EXTENSIONS.has(audioExtension)) {
      sendJson(res, 400, {
        error: 'Unsupported audio format. Please upload MP3, OGG, or WAV.'
      });
      return;
    }

    const inputBuffer = await readRequestBody(req);
    if (inputBuffer.length === 0) {
      sendJson(res, 400, { error: 'Uploaded file is empty.' });
      return;
    }

    const jobId = randomUUID();
    importJobs.set(jobId, createInitialJob(jobId, fileName));
    void processSongImport(jobId, {
      fileName,
      mimeType,
      audioExtension,
      buffer: inputBuffer
    });

    sendJson(res, 202, { jobId });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Could not start audio import.';
    sendJson(res, 500, { error: message });
  }
}

async function handleImportStatus(res: ServerResponse, jobId: string): Promise<void> {
  pruneOldJobs();

  if (!jobId) {
    sendJson(res, 400, { error: 'Missing job id.' });
    return;
  }

  const job = importJobs.get(jobId);
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

async function copyDirectoryRecursive(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }
    await fs.copyFile(sourcePath, targetPath);
  }
}

export default defineConfig({
  plugins: [createBasicPitchModelAssetsPlugin(), createSongImportApiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173
  }
});
