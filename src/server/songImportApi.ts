import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { safeDecodeURIComponent } from './fileDetection';
import {
  handleImportStart,
  handleImportStatus,
  handleSongRemove,
  IMPORT_START_PATH,
  IMPORT_STATUS_PATH_PREFIX,
  SONG_REMOVE_PATH
} from './songImportHandlers';
import type { SongImportRuntime } from './songImportTypes';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, '../..');
const PUBLIC_SONGS_DIR = path.resolve(PROJECT_ROOT, 'public/songs');
const RUNTIME_SONGS_DIR_ENV = 'GH_RUNTIME_SONGS_DIR';
const SONGS_PATH_PREFIX = '/songs/';

function resolveRuntimeSongsDirFromEnv(): string | null {
  const rawValue = String(process.env[RUNTIME_SONGS_DIR_ENV] ?? '').trim();
  if (!rawValue) return null;
  return path.resolve(rawValue);
}

export function createSongImportApiPlugin(): Plugin {
  const runtime: SongImportRuntime = {
    projectRoot: PROJECT_ROOT,
    runtimeSongsDir: PUBLIC_SONGS_DIR,
    runtimeSongManifestPath: path.resolve(PUBLIC_SONGS_DIR, 'manifest.json'),
    importJobs: new Map(),
    converterPromises: new Map(),
    coverExtractorPromise: null
  };

  return {
    name: 'song-import-api',
    configureServer(server) {
      runtime.runtimeSongsDir = resolveRuntimeSongsDirFromEnv() ?? PUBLIC_SONGS_DIR;
      runtime.runtimeSongManifestPath = path.resolve(runtime.runtimeSongsDir, 'manifest.json');
      registerImportApiMiddleware(runtime, server.middlewares.use.bind(server.middlewares));
    },
    configurePreviewServer(server) {
      const outDir = path.resolve(PROJECT_ROOT, server.config.build.outDir || 'dist');
      runtime.runtimeSongsDir = resolveRuntimeSongsDirFromEnv() ?? path.resolve(outDir, 'songs');
      runtime.runtimeSongManifestPath = path.resolve(runtime.runtimeSongsDir, 'manifest.json');
      registerImportApiMiddleware(runtime, server.middlewares.use.bind(server.middlewares));
    }
  };
}

function registerImportApiMiddleware(
  runtime: SongImportRuntime,
  register: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
): void {
  register((req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = stripQuery(req.url ?? '/');

    if ((method === 'GET' || method === 'HEAD') && pathname.startsWith(SONGS_PATH_PREFIX)) {
      void handleSongsAssetRequest(runtime, req, res, pathname, next);
      return;
    }

    if (method === 'POST' && pathname === IMPORT_START_PATH) {
      void handleImportStart(runtime, req, res);
      return;
    }

    if (method === 'GET' && pathname.startsWith(IMPORT_STATUS_PATH_PREFIX)) {
      const rawJobId = pathname.slice(IMPORT_STATUS_PATH_PREFIX.length).trim();
      const jobId = safeDecodeURIComponent(rawJobId);
      void handleImportStatus(runtime, res, jobId);
      return;
    }

    if (method === 'POST' && pathname === SONG_REMOVE_PATH) {
      void handleSongRemove(runtime, req, res);
      return;
    }

    next();
  });
}

async function handleSongsAssetRequest(
  runtime: SongImportRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  next: () => void
): Promise<void> {
  const filePath = resolveSongsFilePath(runtime, pathname);
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

function resolveSongsFilePath(runtime: SongImportRuntime, pathname: string): string | null {
  if (!pathname.startsWith(SONGS_PATH_PREFIX)) return null;
  const encodedRelative = pathname.slice(SONGS_PATH_PREFIX.length);
  const decodedRelative = encodedRelative
    .split('/')
    .map((segment) => safeDecodeURIComponent(segment))
    .join('/');

  const normalized = path.posix.normalize(`/${decodedRelative}`).slice(1);
  if (!normalized || normalized.startsWith('..') || normalized.includes('\0')) return null;

  const root = path.resolve(runtime.runtimeSongsDir);
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
