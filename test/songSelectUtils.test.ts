import { describe, expect, it } from 'vitest';
import {
  detectSongImportKind,
  inferUploadMimeType,
  resolveSongAssetPath,
  sanitizeSettingValues,
  toSongManifestEntry
} from '../src/ui/song-select/utils/songSelectUtils';

describe('songSelectUtils', () => {
  it('parses a valid manifest song entry', () => {
    const parsed = toSongManifestEntry({
      id: 'my-song',
      name: 'My Song',
      folder: 'custom/folder',
      midi: 'song.mid',
      audio: 'song.mp3',
      highScore: 123.4
    });

    expect(parsed).toEqual({
      id: 'my-song',
      name: 'My Song',
      folder: 'custom/folder',
      midi: 'song.mid',
      audio: 'song.mp3',
      cover: undefined,
      file: undefined,
      highScore: 123
    });
  });

  it('falls back to id as folder when folder is missing', () => {
    const parsed = toSongManifestEntry({ id: 'fallback-song', name: 'Fallback' });
    expect(parsed?.folder).toBe('fallback-song');
  });

  it('rejects invalid manifest objects', () => {
    expect(toSongManifestEntry(null)).toBeNull();
    expect(toSongManifestEntry({ id: 42, name: 'Bad' })).toBeNull();
    expect(toSongManifestEntry({ id: 'ok', name: 42 })).toBeNull();
  });

  it('detects import kind by extension and mime type', () => {
    expect(detectSongImportKind('track.mid', '')).toBe('midi');
    expect(detectSongImportKind('track.ogg', '')).toBe('audio');
    expect(detectSongImportKind('track.unknown', 'audio/midi')).toBe('midi');
    expect(detectSongImportKind('track.unknown', 'audio/ogg')).toBe('audio');
    expect(detectSongImportKind('track.unknown', 'application/octet-stream')).toBeNull();
  });

  it('infers upload mime type from common extensions', () => {
    expect(inferUploadMimeType('song.mid')).toBe('audio/midi');
    expect(inferUploadMimeType('song.ogg')).toBe('audio/ogg');
    expect(inferUploadMimeType('song.mp3')).toBe('audio/mpeg');
  });

  it('sanitizes settings with bounds and uniqueness', () => {
    const values = sanitizeSettingValues([1, 2, 2, 3, -1, 99, 4.5], 1, 4);
    expect(values).toEqual([1, 2, 3]);
  });
});

describe('song asset path resolution', () => {
  it('keeps absolute URLs and encodes relative assets', () => {
    expect(resolveSongAssetPath('my song/folder', 'cover art.png')).toBe('/songs/my%20song/folder/cover%20art.png');
    expect(resolveSongAssetPath('abc', 'https://cdn.example.com/cover.png')).toBe('https://cdn.example.com/cover.png');
    expect(resolveSongAssetPath('abc', '/songs/custom/cover.png')).toBe('/songs/custom/cover.png');
  });
});
