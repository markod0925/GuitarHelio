import fs from 'node:fs/promises';
import path from 'node:path';
import type { SongManifestDocument, SongManifestEntry } from './songImportTypes';

export function slugifySongId(value: string): string {
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

export function buildUniqueSongId(baseName: string, songs: SongManifestEntry[]): string {
  const existing = new Set(songs.map((song) => song.id.toLowerCase()));
  const base = slugifySongId(baseName);

  if (!existing.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function buildUniqueSongFolder(runtimeSongsDir: string, baseFolderName: string): Promise<string> {
  let candidate = baseFolderName;
  let suffix = 2;

  while (await pathExists(path.join(runtimeSongsDir, candidate))) {
    candidate = `${baseFolderName} (${suffix})`;
    suffix += 1;
  }

  return candidate;
}

export function normalizeManifestEntry(value: unknown): SongManifestEntry | null {
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

export async function readSongManifest(runtimeSongManifestPath: string): Promise<SongManifestDocument> {
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

export async function writeSongManifest(
  runtimeSongsDir: string,
  runtimeSongManifestPath: string,
  manifest: SongManifestDocument
): Promise<void> {
  await fs.mkdir(runtimeSongsDir, { recursive: true });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(runtimeSongManifestPath, serialized, 'utf8');
}
