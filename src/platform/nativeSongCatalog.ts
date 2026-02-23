import {
  buildNativeSongAssetPath,
  getNativeSongAssetUrl,
  isNativeSongLibraryAvailable,
  nativeSongAssetExists,
  readNativeSongsManifest
} from './nativeSongLibrary';

export type NativeSongCatalogEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi: string;
  audio: string;
};

export async function readNativeSongCatalogEntries(): Promise<NativeSongCatalogEntry[]> {
  if (!isNativeSongLibraryAvailable()) return [];

  const manifest = await readNativeSongsManifest();
  if (manifest.length === 0) return [];

  const resolved = await Promise.all(manifest.map((song, index) => resolveCatalogEntry(song, index)));
  return resolved.filter((entry): entry is NativeSongCatalogEntry => entry !== null);
}

async function resolveCatalogEntry(
  song: {
    id: string;
    name: string;
    folder: string;
    cover?: string;
    midi: string;
    audio: string;
  },
  index: number
): Promise<NativeSongCatalogEntry | null> {
  const midiPath = buildNativeSongAssetPath(song.folder, song.midi);
  if (!(await nativeSongAssetExists(midiPath))) {
    return null;
  }

  const midiUrl = await getNativeSongAssetUrl(midiPath);

  let audioUrl = midiUrl;
  const audioPath = buildNativeSongAssetPath(song.folder, song.audio);
  if (await nativeSongAssetExists(audioPath)) {
    audioUrl = await getNativeSongAssetUrl(audioPath);
  }

  let coverUrl: string | undefined;
  if (song.cover) {
    const coverPath = buildNativeSongAssetPath(song.folder, song.cover);
    if (await nativeSongAssetExists(coverPath)) {
      coverUrl = await getNativeSongAssetUrl(coverPath);
    }
  }

  return {
    id: `native-${song.id}-${index}`,
    name: song.name,
    folder: song.folder,
    cover: coverUrl,
    midi: midiUrl,
    audio: audioUrl
  };
}
