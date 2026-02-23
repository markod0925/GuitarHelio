import { convertAudioBufferToMidiBrowser } from '../audio/audioToMidiBrowser';
import { extractEmbeddedCoverFromAudio } from '../audio/embeddedCover';
import {
  buildNativeSongAssetPath,
  createUniqueNativeSongFolder,
  ensureNativeSongFolder,
  isNativeSongLibraryAvailable,
  readNativeSongsManifest,
  type NativeSongManifestEntry,
  writeNativeSongBinaryFile,
  writeNativeSongsManifest
} from './nativeSongLibrary';

export type NativeSongImportProgress = {
  stage: string;
  progress: number;
};

export type NativeSongImportResult = {
  song: NativeSongManifestEntry;
  coverExtracted: boolean;
  audioExtension: '.mp3' | '.ogg' | '.wav';
};

const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav']);

export async function importAudioSongNative(
  file: File,
  onProgress?: (update: NativeSongImportProgress) => void
): Promise<NativeSongImportResult> {
  if (!isNativeSongLibraryAvailable()) {
    throw new Error('Native song import is available only on Capacitor runtime.');
  }

  const fileName = sanitizeUploadFileName(file.name);
  const audioExtension = detectAudioExtension(fileName, file.type);
  if (!audioExtension || !SUPPORTED_AUDIO_EXTENSIONS.has(audioExtension)) {
    throw new Error('Unsupported audio format. Please upload MP3, OGG, or WAV.');
  }

  const audioBuffer = await file.arrayBuffer();
  if (audioBuffer.byteLength <= 0) {
    throw new Error('Uploaded file is empty.');
  }

  const audioBytes = new Uint8Array(audioBuffer);
  reportProgress(onProgress, 'Creating song folder...', 0.05);

  const baseFolder = sanitizeSongFolderName(fileName);
  const folder = await createUniqueNativeSongFolder(baseFolder);
  await ensureNativeSongFolder(folder);

  const audioFileName = `song${audioExtension}` as const;
  const audioPath = buildNativeSongAssetPath(folder, audioFileName);

  reportProgress(onProgress, 'Saving source audio...', 0.1);
  await writeNativeSongBinaryFile(audioPath, audioBytes);

  reportProgress(onProgress, 'Converting audio to MIDI...', 0.18);
  const midiBytes = await convertAudioBufferToMidiBrowser(audioBuffer, audioExtension, (progress) => {
    reportProgress(onProgress, progress.stage, 0.18 + progress.progress * 0.72);
  });

  const midiFileName = 'song.mid';
  const midiPath = buildNativeSongAssetPath(folder, midiFileName);
  await writeNativeSongBinaryFile(midiPath, midiBytes);

  reportProgress(onProgress, 'Checking embedded artwork...', 0.92);
  const cover = extractEmbeddedCoverFromAudio(audioBytes, fileName, file.type);

  let coverFileName: string | undefined;
  if (cover) {
    coverFileName = `cover${cover.extension}`;
    await writeNativeSongBinaryFile(buildNativeSongAssetPath(folder, coverFileName), cover.data);
  }

  reportProgress(onProgress, 'Updating song manifest...', 0.97);
  const manifestSongs = await readNativeSongsManifest();
  const songName = toDisplaySongName(folder);
  const songId = buildUniqueSongId(songName, manifestSongs);

  const newSong: NativeSongManifestEntry = {
    id: songId,
    name: songName,
    folder,
    midi: midiFileName,
    audio: audioFileName,
    ...(coverFileName ? { cover: coverFileName } : {})
  };

  await writeNativeSongsManifest([...manifestSongs, newSong]);
  reportProgress(onProgress, 'Import completed.', 1);

  return {
    song: newSong,
    coverExtracted: Boolean(coverFileName),
    audioExtension
  };
}

function reportProgress(
  onProgress: ((update: NativeSongImportProgress) => void) | undefined,
  stage: string,
  progress: number
): void {
  if (!onProgress) return;

  onProgress({
    stage,
    progress: clamp01(progress)
  });
}

function detectAudioExtension(fileName: string, mimeType: string): '.mp3' | '.ogg' | '.wav' | null {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.mp3')) return '.mp3';
  if (lowered.endsWith('.ogg') || lowered.endsWith('.oga') || lowered.endsWith('.opus')) return '.ogg';
  if (lowered.endsWith('.wav')) return '.wav';

  const loweredMime = String(mimeType || '').toLowerCase();
  if (loweredMime.includes('audio/mpeg') || loweredMime.includes('audio/mp3')) return '.mp3';
  if (loweredMime.includes('audio/ogg') || loweredMime.includes('audio/x-ogg') || loweredMime.includes('audio/opus')) {
    return '.ogg';
  }
  if (loweredMime.includes('audio/wav') || loweredMime.includes('audio/wave') || loweredMime.includes('audio/x-wav')) {
    return '.wav';
  }

  return null;
}

function sanitizeUploadFileName(fileName: string): string {
  const trimmed = String(fileName || '').trim();
  return trimmed.length > 0 ? trimmed : 'uploaded-song.mp3';
}

function sanitizeSongFolderName(fileName: string): string {
  const nameWithoutExtension = fileName.replace(/\.[^/.]+$/g, '');
  const cleaned = nameWithoutExtension
    .replace(/[<>:"|?*]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') return 'New Song';
  return cleaned;
}

function toDisplaySongName(folderName: string): string {
  const cleaned = folderName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned : 'New Song';
}

function buildUniqueSongId(baseName: string, songs: NativeSongManifestEntry[]): string {
  const existing = new Set(songs.map((song) => song.id.toLowerCase()));
  const base = slugify(baseName);
  if (!existing.has(base)) return base;

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
}

function slugify(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || 'song';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
