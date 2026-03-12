import path from 'node:path';
import type { SupportedAudioExtension, SupportedMidiExtension } from './songImportTypes';

const SUPPORTED_AUDIO_EXTENSIONS = new Set<SupportedAudioExtension>(['.mp3', '.ogg', '.wav']);
const SUPPORTED_MIDI_EXTENSIONS = new Set<SupportedMidiExtension>(['.mid', '.midi']);

export function safeDecodeURIComponent(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeUploadFileName(fileName: string): string {
  const baseName = path.basename(String(fileName || '').trim());
  const cleaned = baseName.replace(/[\u0000-\u001f]/g, '').replace(/[\\/]+/g, '').trim();
  return cleaned || 'uploaded-song.mp3';
}

export function sanitizeSongFolderName(fileName: string): string {
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

export function toDisplaySongName(folderName: string): string {
  const clean = String(folderName || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'New Song';
}

export function detectAudioExtension(fileName: string, mimeType: string): SupportedAudioExtension | null {
  const ext = path.extname(fileName).toLowerCase() as SupportedAudioExtension;
  if (SUPPORTED_AUDIO_EXTENSIONS.has(ext)) return ext;

  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return '.mp3';
  if (mime.includes('audio/ogg') || mime.includes('audio/x-ogg') || mime.includes('audio/opus')) return '.ogg';
  if (mime.includes('audio/wav') || mime.includes('audio/wave') || mime.includes('audio/x-wav')) return '.wav';

  return null;
}

export function detectMidiExtension(fileName: string, mimeType: string): SupportedMidiExtension | null {
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

export function detectImportSource(
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
