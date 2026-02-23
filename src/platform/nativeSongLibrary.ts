import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

export type NativeSongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  midi: string;
  audio: string;
  cover?: string;
};

const NATIVE_SONGS_ROOT_PATH = 'songs';
const NATIVE_MANIFEST_PATH = `${NATIVE_SONGS_ROOT_PATH}/manifest.json`;

export function isNativeSongLibraryAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export function getNativeSongsRootPath(): string {
  return NATIVE_SONGS_ROOT_PATH;
}

export function buildNativeSongAssetPath(folder: string, fileName: string): string {
  return `${NATIVE_SONGS_ROOT_PATH}/${folder}/${fileName}`;
}

export async function ensureNativeSongsRoot(): Promise<void> {
  await Filesystem.mkdir({
    path: NATIVE_SONGS_ROOT_PATH,
    directory: Directory.Data,
    recursive: true
  });
}

export async function readNativeSongsManifest(): Promise<NativeSongManifestEntry[]> {
  if (!isNativeSongLibraryAvailable()) return [];

  try {
    const raw = await Filesystem.readFile({
      path: NATIVE_MANIFEST_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8
    });

    const data = typeof raw.data === 'string' ? raw.data : '';
    const parsed = JSON.parse(data) as { songs?: unknown };
    if (!Array.isArray(parsed.songs)) return [];

    return parsed.songs
      .map((entry) => normalizeNativeManifestEntry(entry))
      .filter((entry): entry is NativeSongManifestEntry => entry !== null);
  } catch {
    return [];
  }
}

export async function writeNativeSongsManifest(entries: NativeSongManifestEntry[]): Promise<void> {
  await ensureNativeSongsRoot();

  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const payload = `${JSON.stringify({ songs: sorted }, null, 2)}\n`;
  await Filesystem.writeFile({
    path: NATIVE_MANIFEST_PATH,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
    data: payload
  });
}

export async function nativeSongAssetExists(pathValue: string): Promise<boolean> {
  try {
    await Filesystem.stat({
      path: pathValue,
      directory: Directory.Data
    });
    return true;
  } catch {
    return false;
  }
}

export async function createUniqueNativeSongFolder(baseName: string): Promise<string> {
  await ensureNativeSongsRoot();
  const existing = new Set<string>();

  try {
    const listed = await Filesystem.readdir({
      path: NATIVE_SONGS_ROOT_PATH,
      directory: Directory.Data
    });

    for (const entry of listed.files) {
      const entryName = normalizeReaddirEntryName(entry);
      if (entryName) {
        existing.add(entryName.toLowerCase());
      }
    }
  } catch {
    // If listing fails we still return the base folder; mkdir will fail later if duplicate.
  }

  let candidate = baseName;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${baseName} (${suffix})`;
    suffix += 1;
  }

  return candidate;
}

export async function ensureNativeSongFolder(folder: string): Promise<void> {
  await Filesystem.mkdir({
    path: `${NATIVE_SONGS_ROOT_PATH}/${folder}`,
    directory: Directory.Data,
    recursive: true
  });
}

export async function writeNativeSongBinaryFile(pathValue: string, bytes: Uint8Array): Promise<void> {
  await Filesystem.writeFile({
    path: pathValue,
    directory: Directory.Data,
    recursive: true,
    data: bytesToBase64(bytes)
  });
}

export async function writeNativeSongTextFile(pathValue: string, text: string): Promise<void> {
  await Filesystem.writeFile({
    path: pathValue,
    directory: Directory.Data,
    recursive: true,
    encoding: Encoding.UTF8,
    data: text
  });
}

export async function getNativeSongAssetUrl(pathValue: string): Promise<string> {
  const uri = await Filesystem.getUri({
    path: pathValue,
    directory: Directory.Data
  });

  return Capacitor.convertFileSrc(uri.uri);
}

function normalizeNativeManifestEntry(value: unknown): NativeSongManifestEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;

  const id = asNonEmptyString(data.id);
  const name = asNonEmptyString(data.name);
  const folder = asNonEmptyString(data.folder);
  const midi = asNonEmptyString(data.midi);
  const audio = asNonEmptyString(data.audio);
  const cover = asOptionalString(data.cover);

  if (!id || !name || !folder || !midi || !audio) return null;

  return {
    id,
    name,
    folder,
    midi,
    audio,
    cover
  };
}

function normalizeReaddirEntryName(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry !== 'object' || entry === null) return '';

  const data = entry as { name?: unknown };
  if (typeof data.name !== 'string') return '';
  return data.name.trim();
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
