import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import {
  resolveRequestedConverterMode as resolveRequestedConverterModeShared,
  toExecutableConverterMode,
  type ConverterMode,
  type RequestedConverterMode
} from './src/platform/converterMode';

type SupportedAudioExtension = '.mp3' | '.ogg' | '.wav';
type SupportedMidiExtension = '.mid' | '.midi';
type SupportedImportSource = 'audio' | 'midi';
type SongImportStatus = 'queued' | 'processing' | 'completed' | 'failed';

type MidiAnalysisSummary = {
  noteCount: number;
  uniquePitches: number;
  durationSeconds: number;
  meanNoteDurationSeconds: number;
  meanVelocity: number;
  pitchSet: number[];
};

type ConverterComparisonSummary = {
  baselineMode: 'legacy';
  candidateMode: 'neuralnote';
  candidateStatus: 'ok' | 'failed';
  candidateError?: string;
  legacy: MidiAnalysisSummary;
  neuralnote?: MidiAnalysisSummary;
  deltas?: {
    noteCount: number;
    durationSeconds: number;
    meanNoteDurationSeconds: number;
    meanVelocity: number;
    pitchSetJaccard: number;
  };
};

type SongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi: string;
  audio?: string;
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
    sourceType: SupportedImportSource;
    sourceExtension: SupportedAudioExtension | '.mid';
    audioExtension?: SupportedAudioExtension;
    converterMode: RequestedConverterMode;
    converterComparison?: ConverterComparisonSummary;
  };
};

type SongImportPayload = {
  fileName: string;
  mimeType: string;
  sourceType: SupportedImportSource;
  sourceExtension: SupportedAudioExtension | '.mid';
  audioExtension?: SupportedAudioExtension;
  converterMode: RequestedConverterMode;
  buffer: Buffer;
};

type AudioToMidiConverter = {
  convertAudioBufferToMidiBuffer: (
    inputBuffer: Buffer,
    mimeOrExt?: string,
    options?: {
      conversionPreset?: 'accurate' | 'balanced' | 'dense';
      tempoBpm?: number;
      tempoMap?: Array<{ timeSeconds: number; bpm: number }>;
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
let runtimeSongsDir = PUBLIC_SONGS_DIR;
let runtimeSongManifestPath = path.resolve(PUBLIC_SONGS_DIR, 'manifest.json');

const IMPORT_START_PATH = '/api/song-import/start';
const IMPORT_STATUS_PATH_PREFIX = '/api/song-import/status/';
const SONG_REMOVE_PATH = '/api/song-remove';
const SONGS_PATH_PREFIX = '/songs/';
const SONG_CONVERTER_MODE_HEADER = 'x-song-converter-mode';
const MAX_IMPORT_AUDIO_BYTES = 80 * 1024 * 1024;
const JOB_RETENTION_MS = 30 * 60 * 1000;
const CONVERTER_DEBUG_ENV_FLAG = 'GH_ENABLE_DEBUG_CONVERTER';
const SUPPORTED_AUDIO_EXTENSIONS = new Set<SupportedAudioExtension>(['.mp3', '.ogg', '.wav']);
const SUPPORTED_MIDI_EXTENSIONS = new Set<SupportedMidiExtension>(['.mid', '.midi']);
const TEMPO_CLI_BASENAME = process.platform === 'win32' ? 'tempo_cnn_cli.exe' : 'tempo_cnn_cli';
const ONNX_RUNTIME_SUBDIR = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';

const importJobs = new Map<string, SongImportJob>();
const converterPromises = new Map<ConverterMode, Promise<AudioToMidiConverter>>();
let coverExtractorPromise: Promise<CoverExtractorModule> | null = null;

function createSongImportApiPlugin(): Plugin {
  return {
    name: 'song-import-api',
    configureServer(server) {
      runtimeSongsDir = PUBLIC_SONGS_DIR;
      runtimeSongManifestPath = path.resolve(runtimeSongsDir, 'manifest.json');
      registerImportApiMiddleware(server.middlewares.use.bind(server.middlewares));
    },
    configurePreviewServer(server) {
      const outDir = path.resolve(PROJECT_ROOT, server.config.build.outDir || 'dist');
      runtimeSongsDir = path.resolve(outDir, 'songs');
      runtimeSongManifestPath = path.resolve(runtimeSongsDir, 'manifest.json');
      registerImportApiMiddleware(server.middlewares.use.bind(server.middlewares));
    }
  };
}


function registerImportApiMiddleware(
  register: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
): void {
  register((req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = stripQuery(req.url ?? '/');

    if ((method === 'GET' || method === 'HEAD') && pathname.startsWith(SONGS_PATH_PREFIX)) {
      void handleSongsAssetRequest(req, res, pathname, next);
      return;
    }

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

    if (method === 'POST' && pathname === SONG_REMOVE_PATH) {
      void handleSongRemove(req, res);
      return;
    }

    next();
  });
}

async function handleSongsAssetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  next: () => void
): Promise<void> {
  const filePath = resolveSongsFilePath(pathname);
  if (!filePath) {
    next();
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      next();
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const contentType = detectSongsContentType(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(stat.size));

    if (method === 'HEAD') {
      res.end();
      return;
    }

    const readStream = fsSync.createReadStream(filePath);
    readStream.on('error', () => {
      if (res.writableEnded) return;
      res.statusCode = 500;
      res.end('Failed to read song asset.');
    });
    readStream.pipe(res);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      next();
      return;
    }
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('Failed to load song asset.');
    }
  }
}

function stripQuery(urlValue: string): string {
  const marker = urlValue.indexOf('?');
  return marker === -1 ? urlValue : urlValue.slice(0, marker);
}

function resolveSongsFilePath(pathname: string): string | null {
  if (!pathname.startsWith(SONGS_PATH_PREFIX)) return null;
  const encodedRelative = pathname.slice(SONGS_PATH_PREFIX.length);
  const decodedRelative = encodedRelative
    .split('/')
    .map((segment) => safeDecodeURIComponent(segment))
    .join('/');

  const normalized = path.posix.normalize(`/${decodedRelative}`).slice(1);
  if (!normalized || normalized.startsWith('..') || normalized.includes('\0')) return null;

  const root = path.resolve(runtimeSongsDir);
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  return candidate;
}

function detectSongsContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.mid' || ext === '.midi') return 'audio/midi';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
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

function detectMidiExtension(fileName: string, mimeType: string): SupportedMidiExtension | null {
  const ext = path.extname(fileName).toLowerCase() as SupportedMidiExtension;
  if (SUPPORTED_MIDI_EXTENSIONS.has(ext)) return ext;

  const mime = String(mimeType || '').toLowerCase();
  if (
    mime.includes('audio/midi') ||
    mime.includes('audio/mid') ||
    mime.includes('audio/x-midi') ||
    mime.includes('audio/sp-midi') ||
    mime.includes('application/midi') ||
    mime.includes('application/x-midi')
  ) {
    return '.mid';
  }

  return null;
}

function detectImportSource(
  fileName: string,
  mimeType: string
): { sourceType: 'audio'; sourceExtension: SupportedAudioExtension } | { sourceType: 'midi'; sourceExtension: '.mid' } | null {
  const midiExtension = detectMidiExtension(fileName, mimeType);
  if (midiExtension && SUPPORTED_MIDI_EXTENSIONS.has(midiExtension)) {
    return { sourceType: 'midi', sourceExtension: '.mid' };
  }

  const audioExtension = detectAudioExtension(fileName, mimeType);
  if (audioExtension && SUPPORTED_AUDIO_EXTENSIONS.has(audioExtension)) {
    return { sourceType: 'audio', sourceExtension: audioExtension };
  }

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

function getConverterModulePath(mode: ConverterMode): string {
  if (mode === 'legacy' || mode === 'neuralnote') return 'scripts/audio-to-midi-neuralnote.mjs';
  return 'scripts/audio-to-midi-neuralnote.mjs';
}

async function loadAudioToMidiConverter(mode: ConverterMode): Promise<AudioToMidiConverter> {
  const cached = converterPromises.get(mode);
  if (cached) return cached;

  const moduleUrl = pathToFileURL(path.resolve(PROJECT_ROOT, getConverterModulePath(mode))).href;
  const pending = import(moduleUrl).then((moduleValue) => {
    const converter = (moduleValue.default ?? moduleValue) as Partial<AudioToMidiConverter>;
    if (!converter || typeof converter.convertAudioBufferToMidiBuffer !== 'function') {
      throw new Error(`Audio to MIDI converter "${mode}" is not available.`);
    }
    return converter as AudioToMidiConverter;
  });

  converterPromises.set(mode, pending);
  return pending;
}

type TempoEstimate = {
  bpm: number;
  tempoMap?: Array<{ timeSeconds: number; bpm: number }>;
};

async function estimateTempoFromAudioBuffer(
  inputBuffer: Buffer,
  audioExtension: SupportedAudioExtension
): Promise<{ tempoBpm: number; tempoMap: Array<{ timeSeconds: number; bpm: number }> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-tempo-import-'));
  try {
    const audioPath = path.join(tempDir, `tempo-source${audioExtension}`);
    await fs.writeFile(audioPath, inputBuffer);

    const tempoModuleUrl = pathToFileURL(path.resolve(PROJECT_ROOT, 'tools/audio-midi-converter/src/tempo-bpm.mjs')).href;
    const tempoModule = (await import(tempoModuleUrl)) as {
      estimateTempoFromAudioFile?: (inputFilePath: string, options?: Record<string, unknown>) => Promise<TempoEstimate>;
    };
    const estimateTempo = tempoModule.estimateTempoFromAudioFile;
    if (typeof estimateTempo !== 'function') {
      throw new Error('Tempo estimation helper is not available.');
    }

    const estimated = await estimateTempo(audioPath, {
      backend: 'onnx',
      tempoCliBin: path.resolve(PROJECT_ROOT, 'third_party/tempocnn_core/bin', TEMPO_CLI_BASENAME),
      tempoModelOnnxPath: path.resolve(PROJECT_ROOT, 'third_party/tempo_cnn/tempocnn/models/fcn.onnx'),
      onnxLibDir: path.resolve(PROJECT_ROOT, 'third_party/onnxruntime', ONNX_RUNTIME_SUBDIR, 'lib'),
      interpolate: true,
      localTempo: false,
      useFfmpeg: false
    });

    const tempoBpm = Number(estimated?.bpm);
    if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) {
      throw new Error('Tempo estimator returned an invalid BPM value.');
    }

    return { tempoBpm, tempoMap: [] };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type MidiNoteLike = {
  midi?: number;
  time?: number;
  duration?: number;
  velocity?: number;
};

type MidiTrackLike = {
  notes?: MidiNoteLike[];
};

type MidiObjectLike = {
  tracks?: MidiTrackLike[];
};

function toRounded(value: number, decimals = 4): number {
  const safeDecimals = Math.max(0, Math.min(9, Math.floor(decimals)));
  const scale = 10 ** safeDecimals;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * scale) / scale;
}

function buildMidiAnalysisSummary(midiObject: MidiObjectLike): MidiAnalysisSummary {
  const tracks = Array.isArray(midiObject.tracks) ? midiObject.tracks : [];

  let noteCount = 0;
  let maxEndTime = 0;
  let sumDuration = 0;
  let sumVelocity = 0;
  const pitchSet = new Set<number>();

  for (const track of tracks) {
    const notes = Array.isArray(track?.notes) ? track.notes : [];
    for (const note of notes) {
      const pitch = Math.round(Number(note?.midi ?? 0));
      const time = Number(note?.time ?? 0);
      const duration = Math.max(0, Number(note?.duration ?? 0));
      const velocity = Math.max(0, Math.min(1, Number(note?.velocity ?? 0)));
      const endTime = time + duration;

      noteCount += 1;
      if (Number.isFinite(pitch)) {
        pitchSet.add(Math.max(0, Math.min(127, pitch)));
      }
      if (Number.isFinite(endTime) && endTime > maxEndTime) {
        maxEndTime = endTime;
      }
      if (Number.isFinite(duration)) {
        sumDuration += duration;
      }
      if (Number.isFinite(velocity)) {
        sumVelocity += velocity;
      }
    }
  }

  return {
    noteCount,
    uniquePitches: pitchSet.size,
    durationSeconds: toRounded(maxEndTime),
    meanNoteDurationSeconds: toRounded(noteCount > 0 ? sumDuration / noteCount : 0),
    meanVelocity: toRounded(noteCount > 0 ? sumVelocity / noteCount : 0),
    pitchSet: Array.from(pitchSet).sort((a, b) => a - b)
  };
}

function calculateJaccardIndex(leftValues: number[], rightValues: number[]): number {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (left.size === 0 && right.size === 0) return 1;

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) return 0;
  return toRounded(intersection / union);
}

async function analyzeMidiBuffer(midiBuffer: Buffer): Promise<MidiAnalysisSummary> {
  const toneMidiModule = await import('@tonejs/midi');
  const toneMidiExports =
    toneMidiModule?.default && typeof toneMidiModule.default === 'object' ? toneMidiModule.default : toneMidiModule;
  const Midi = toneMidiExports?.Midi as (new (midiData: Buffer | Uint8Array | ArrayBuffer) => MidiObjectLike) | undefined;

  if (typeof Midi !== 'function') {
    throw new Error('MIDI analysis dependency is not available.');
  }

  const midiObject = new Midi(midiBuffer);
  return buildMidiAnalysisSummary(midiObject);
}

function createFailedComparisonSummary(
  legacySummary: MidiAnalysisSummary,
  candidateError: string
): ConverterComparisonSummary {
  return {
    baselineMode: 'legacy',
    candidateMode: 'neuralnote',
    candidateStatus: 'failed',
    candidateError: candidateError.trim() || 'Candidate converter failed.',
    legacy: legacySummary
  };
}

function createSuccessfulComparisonSummary(
  legacySummary: MidiAnalysisSummary,
  neuralnoteSummary: MidiAnalysisSummary
): ConverterComparisonSummary {
  return {
    baselineMode: 'legacy',
    candidateMode: 'neuralnote',
    candidateStatus: 'ok',
    legacy: legacySummary,
    neuralnote: neuralnoteSummary,
    deltas: {
      noteCount: neuralnoteSummary.noteCount - legacySummary.noteCount,
      durationSeconds: toRounded(neuralnoteSummary.durationSeconds - legacySummary.durationSeconds),
      meanNoteDurationSeconds: toRounded(neuralnoteSummary.meanNoteDurationSeconds - legacySummary.meanNoteDurationSeconds),
      meanVelocity: toRounded(neuralnoteSummary.meanVelocity - legacySummary.meanVelocity),
      pitchSetJaccard: calculateJaccardIndex(legacySummary.pitchSet, neuralnoteSummary.pitchSet)
    }
  };
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

  while (await pathExists(path.join(runtimeSongsDir, candidate))) {
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

  if (!id || !name || !folder || !midi) return null;

  return {
    id,
    name,
    folder,
    midi,
    ...(audio ? { audio } : {}),
    cover: cover && cover.length > 0 ? cover : undefined
  };
}

async function readSongManifest(): Promise<SongManifestDocument> {
  let rawDoc: Record<string, unknown> = {};

  try {
    const raw = await fs.readFile(runtimeSongManifestPath, 'utf8');
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
  await fs.mkdir(runtimeSongsDir, { recursive: true });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(runtimeSongManifestPath, serialized, 'utf8');
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

    await fs.mkdir(runtimeSongsDir, { recursive: true });

    const baseFolderName = sanitizeSongFolderName(payload.fileName);
    const folderName = await buildUniqueSongFolder(baseFolderName);
    songDirectoryPath = path.join(runtimeSongsDir, folderName);
    await fs.mkdir(songDirectoryPath, { recursive: false });

    const midiFileName = 'song.mid';
    let audioFileName: string | undefined;
    let coverFileName: string | undefined;

    if (payload.sourceType === 'audio') {
      if (!payload.audioExtension) {
        throw new Error('Invalid import payload: missing audio extension.');
      }

      updateImportJob(jobId, {
        stage: 'Saving source audio...',
        progress: 0.1
      });

      audioFileName = `song${payload.audioExtension}`;
      await fs.writeFile(path.join(songDirectoryPath, audioFileName), payload.buffer);

      updateImportJob(jobId, {
        stage: 'Estimating tempo (Tempo-CNN ONNX)...',
        progress: 0.16
      });

      const tempoEstimate = await estimateTempoFromAudioBuffer(payload.buffer, payload.audioExtension);

      const runConverter = async (
        mode: ConverterMode,
        progressStart: number,
        progressSpan: number,
        fallbackStage: string
      ): Promise<Buffer> => {
        const converter = await loadAudioToMidiConverter(mode);
        return converter.convertAudioBufferToMidiBuffer(payload.buffer, payload.audioExtension, {
          conversionPreset: 'balanced',
          tempoBpm: tempoEstimate.tempoBpm,
          tempoMap: tempoEstimate.tempoMap,
          onProgress: ({ stage, progress }) => {
            const normalizedProgress = clampProgress(Number(progress ?? 0));
            const stageLabel = String(stage || fallbackStage).trim() || fallbackStage;
            updateImportJob(jobId, {
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

      if (embeddedCover && embeddedCover.data && Number(embeddedCover.data.length) > 0) {
        const coverExt = getCoverFileExtension(embeddedCover);
        coverFileName = `cover${coverExt}`;
        await fs.writeFile(path.join(songDirectoryPath, coverFileName), Buffer.from(embeddedCover.data));
      }
    } else {
      updateImportJob(jobId, {
        stage: 'Saving source MIDI...',
        progress: 0.2
      });
      await fs.writeFile(path.join(songDirectoryPath, midiFileName), payload.buffer);

      updateImportJob(jobId, {
        stage: 'Skipping artwork extraction for MIDI source...',
        progress: 0.92
      });
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
      midi: midiFileName
    };

    if (audioFileName) {
      newSongEntry.audio = audioFileName;
    }
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
    importJobs.set(jobId, createInitialJob(jobId, fileName));
    void processSongImport(jobId, {
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

async function handleSongRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const manifest = await readSongManifest();
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
    await writeSongManifest(manifest);

    const folderToDelete = removedSong?.folder?.trim();
    if (folderToDelete) {
      const songDirectoryPath = path.resolve(runtimeSongsDir, folderToDelete);
      const rootPath = path.resolve(runtimeSongsDir);
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

export default defineConfig({
  plugins: [createSongImportApiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173
  }
});
