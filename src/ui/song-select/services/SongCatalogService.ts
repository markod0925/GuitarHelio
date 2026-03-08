import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { resolveSongHighScore } from '../../../app/sessionPersistence';
import {
  ASSET_NEGATIVE_CACHE_TTL_MS,
  DEFAULT_SONG_COVER_TEXTURE_KEY,
  DEFAULT_SONG_COVER_URL
} from '../constants';
import type {
  AssetExistenceCacheEntry,
  SongCatalogLoadPolicy,
  SongEntry,
  SongManifestEntry,
  SongOption
} from '../types';
import {
  firstNonEmpty,
  isCapacitorFileUrl,
  isValidAssetResponse,
  normalizeFolder,
  resolveSongAssetPath,
  sanitizeKey,
  toSongManifestEntry,
  waitMs
} from '../utils/songSelectUtils';

const FALLBACK_MANIFEST_SONGS: SongManifestEntry[] = [
  {
    id: 'example',
    name: 'Example Song',
    folder: 'example',
    cover: 'cover.svg',
    midi: 'song.mid',
    audio: 'song.mp3',
    highScore: 0
  }
];

export type CoverLoadingOptions = {
  songs: SongEntry[];
  songOptions: SongOption[];
  viewportRect: Phaser.Geom.Rectangle | undefined;
  concurrency: number;
  generation: number;
  isSceneActive: () => boolean;
  isGenerationValid: () => boolean;
  onBatchLoaded: () => void;
  applyThumbnailViewportCrop: (option: SongOption, viewportTop: number, viewportBottom: number) => void;
};

export class SongCatalogService {
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly assetExistenceCache = new Map<string, AssetExistenceCacheEntry>()
  ) {}

  clearAssetExistenceCache(): void {
    this.assetExistenceCache.clear();
  }

  async fetchManifestText(): Promise<string | null> {
    try {
      const response = await fetch(`/songs/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
      if (response.ok) {
        const manifestRaw = await response.text();
        if (this.scene.cache.text.exists('songManifest')) {
          this.scene.cache.text.remove('songManifest');
        }
        this.scene.cache.text.add('songManifest', manifestRaw);
        return manifestRaw;
      }
    } catch {
      // Ignore network issues and fallback to cached manifest.
    }

    const cached = this.scene.cache.text.get('songManifest');
    return typeof cached === 'string' ? cached : null;
  }

  async readManifestSongs(policy: SongCatalogLoadPolicy): Promise<SongEntry[]> {
    const manifestRaw = await this.fetchManifestText();
    let sourceSongs: SongManifestEntry[] = FALLBACK_MANIFEST_SONGS;
    if (typeof manifestRaw === 'string') {
      try {
        const parsed = JSON.parse(manifestRaw) as { songs?: unknown };
        if (Array.isArray(parsed.songs)) {
          const parsedSongs = parsed.songs
            .map((item) => toSongManifestEntry(item))
            .filter((item): item is SongManifestEntry => item !== null);
          if (parsedSongs.length > 0) {
            sourceSongs = parsedSongs;
          }
        }
      } catch {
        sourceSongs = FALLBACK_MANIFEST_SONGS;
      }
    }

    const nativeSongs = await this.readNativeManifestSongs();
    const mergedSongs = [...sourceSongs, ...nativeSongs];

    const songs = (
      await Promise.all(mergedSongs.map((rawSong, index) => this.resolveSongEntry(rawSong, index, policy)))
    ).filter((song): song is SongEntry => song !== null);

    if (songs.length > 0) return songs;

    const fallbackSongs = (
      await Promise.all(
        FALLBACK_MANIFEST_SONGS.map((rawSong, index) =>
          this.resolveSongEntry(rawSong, mergedSongs.length + index, policy)
        )
      )
    ).filter((song): song is SongEntry => song !== null);
    return fallbackSongs;
  }

  async readNativeManifestSongs(): Promise<SongManifestEntry[]> {
    if (!Capacitor.isNativePlatform()) return [];

    try {
      const { readNativeSongCatalogEntries } = await import('../../../platform/nativeSongCatalog');
      const nativeEntries = await readNativeSongCatalogEntries();
      return nativeEntries.map((entry: {
        id: string;
        name: string;
        folder: string;
        cover?: string;
        midi?: string;
        audio?: string;
        highScore?: number;
      }) => ({
        id: entry.id,
        name: entry.name,
        folder: entry.folder,
        cover: entry.cover,
        midi: entry.midi,
        audio: entry.audio,
        highScore: entry.highScore
      }));
    } catch (error) {
      console.warn('Failed to load native song catalog', error);
      return [];
    }
  }

  async resolveSongEntry(
    rawSong: SongManifestEntry,
    index: number,
    policy: SongCatalogLoadPolicy
  ): Promise<SongEntry | null> {
    const folder = normalizeFolder(rawSong.folder);
    if (!folder) return null;

    const midiField = firstNonEmpty(rawSong.midi, rawSong.file);
    if (!midiField) return null;
    const midiUrl = this.resolveSongAssetPath(folder, midiField);
    if (policy.validateAssetsOnStartup && !(await this.assetExists(midiUrl))) return null;

    let coverUrl = DEFAULT_SONG_COVER_URL;
    if (rawSong.cover && rawSong.cover.trim().length > 0) {
      const requestedCover = this.resolveSongAssetPath(folder, rawSong.cover);
      if (!policy.validateAssetsOnStartup || (await this.assetExists(requestedCover))) {
        coverUrl = requestedCover;
      }
    }

    let audioUrl = midiUrl;
    let usesMidiFallback = !rawSong.audio;
    if (rawSong.audio && rawSong.audio.trim().length > 0) {
      const requestedAudio = this.resolveSongAssetPath(folder, rawSong.audio);
      if (!policy.validateAssetsOnStartup || (await this.assetExists(requestedAudio))) {
        audioUrl = requestedAudio;
        usesMidiFallback = false;
      } else {
        usesMidiFallback = true;
      }
    }

    const coverTextureKey =
      coverUrl === DEFAULT_SONG_COVER_URL ? DEFAULT_SONG_COVER_TEXTURE_KEY : `song-cover-${sanitizeKey(rawSong.id)}-${index}`;
    const highScore = resolveSongHighScore(rawSong.id, rawSong.highScore);

    return {
      id: rawSong.id,
      name: rawSong.name,
      folder,
      cover: coverUrl,
      midi: midiUrl,
      audio: audioUrl,
      highScore,
      usesMidiFallback,
      coverTextureKey
    };
  }

  resolveSongAssetPath(folder: string, value: string): string {
    return resolveSongAssetPath(folder, value);
  }

  async assetExists(url: string): Promise<boolean> {
    const cached = this.assetExistenceCache.get(url);
    const now = Date.now();
    if (cached) {
      if (cached.exists) return true;
      if ((cached.expiresAtMs ?? 0) > now) return false;
      this.assetExistenceCache.delete(url);
    }

    const capacitorFileUrl = isCapacitorFileUrl(url);
    const requestUrl = url;

    if (!capacitorFileUrl) {
      try {
        const headResponse = await fetch(requestUrl, { method: 'HEAD', cache: 'no-store' });
        if (headResponse.ok) {
          const exists = isValidAssetResponse(url, headResponse);
          this.assetExistenceCache.set(
            url,
            exists ? { exists: true } : { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS }
          );
          return exists;
        }
        if (headResponse.status !== 405 && headResponse.status !== 501) {
          this.assetExistenceCache.set(url, { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS });
          return false;
        }
      } catch {
        // Ignore and fallback to GET.
      }
    }

    try {
      const getResponse = await fetch(requestUrl, { method: 'GET', cache: 'no-store' });
      const exists = getResponse.ok && (capacitorFileUrl || isValidAssetResponse(url, getResponse));
      this.assetExistenceCache.set(
        url,
        exists ? { exists: true } : { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS }
      );
      return exists;
    } catch {
      this.assetExistenceCache.set(url, { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS });
      return false;
    }
  }

  async validateSongBeforeStart(song: SongEntry): Promise<SongEntry | null> {
    const midiExists = await this.assetExists(song.midi);
    if (!midiExists) return null;

    let audioUrl = song.midi;
    let usesMidiFallback = true;
    if (song.audio && song.audio !== song.midi) {
      if (await this.assetExists(song.audio)) {
        audioUrl = song.audio;
        usesMidiFallback = false;
      }
    }

    let coverUrl = DEFAULT_SONG_COVER_URL;
    let coverTextureKey = DEFAULT_SONG_COVER_TEXTURE_KEY;
    if (song.cover && song.cover !== DEFAULT_SONG_COVER_URL) {
      if (await this.assetExists(song.cover)) {
        coverUrl = song.cover;
        coverTextureKey = song.coverTextureKey;
      }
    }

    return {
      ...song,
      cover: coverUrl,
      coverTextureKey,
      audio: audioUrl,
      usesMidiFallback
    };
  }

  async preloadSongCoverTexturesLazy(options: CoverLoadingOptions): Promise<void> {
    const coversToLoad = options.songs.filter(
      (song) =>
        song.coverTextureKey !== DEFAULT_SONG_COVER_TEXTURE_KEY &&
        !this.scene.textures.exists(song.coverTextureKey) &&
        song.cover.trim().length > 0
    );
    if (coversToLoad.length === 0) return;

    const visibleSongIds = new Set(
      options.songOptions
        .filter((songOption) => options.viewportRect?.contains(songOption.background.x, songOption.background.y) ?? false)
        .map((songOption) => songOption.song.id)
    );
    const prioritized = [
      ...coversToLoad.filter((song) => visibleSongIds.has(song.id)),
      ...coversToLoad.filter((song) => !visibleSongIds.has(song.id))
    ];

    const safeConcurrency = Math.max(1, Math.floor(options.concurrency));
    for (let index = 0; index < prioritized.length; index += safeConcurrency) {
      if (!options.isSceneActive() || !options.isGenerationValid()) return;
      const batch = prioritized.slice(index, index + safeConcurrency);
      await this.loadSongCoverBatch(batch);
      if (!options.isSceneActive() || !options.isGenerationValid()) return;
      this.refreshLoadedSongCoverTextures(options.songOptions, options.viewportRect, options.applyThumbnailViewportCrop);
      options.onBatchLoaded();
      await waitMs(0);
    }
  }

  refreshLoadedSongCoverTextures(
    songOptions: SongOption[],
    viewportRect: Phaser.Geom.Rectangle | undefined,
    applyThumbnailViewportCrop: (option: SongOption, viewportTop: number, viewportBottom: number) => void
  ): void {
    songOptions.forEach((option) => {
      const image = option.thumbnailImage;
      if (!image) return;
      const hasSongCoverTexture = this.scene.textures.exists(option.song.coverTextureKey);
      const hasDefaultCoverTexture = this.scene.textures.exists(DEFAULT_SONG_COVER_TEXTURE_KEY);
      const key =
        option.song.usesMidiFallback || !hasSongCoverTexture
          ? hasDefaultCoverTexture
            ? DEFAULT_SONG_COVER_TEXTURE_KEY
            : option.song.coverTextureKey
          : option.song.coverTextureKey;
      const needsResize =
        Math.abs(image.displayWidth - option.thumbnailImageSize) > 0.5 ||
        Math.abs(image.displayHeight - option.thumbnailImageSize) > 0.5;
      if (image.texture.key === key && !needsResize) return;
      if (image.texture.key !== key) image.setTexture(key);
      image.setDisplaySize(option.thumbnailImageSize, option.thumbnailImageSize);
      image.setCrop();
      if (viewportRect) {
        applyThumbnailViewportCrop(option, viewportRect.top, viewportRect.bottom);
      }
    });
  }

  private async loadSongCoverBatch(batch: SongEntry[]): Promise<void> {
    if (batch.length === 0) return;

    await new Promise<void>((resolve) => {
      const failedKeys = new Set<string>();
      const onFileError = (file: Phaser.Loader.File): void => {
        failedKeys.add(file.key);
      };
      const onComplete = (): void => {
        this.scene.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileError);
        if (failedKeys.size > 0) {
          batch.forEach((song) => {
            if (failedKeys.has(song.coverTextureKey)) {
              song.cover = DEFAULT_SONG_COVER_URL;
              song.coverTextureKey = DEFAULT_SONG_COVER_TEXTURE_KEY;
            }
          });
        }
        resolve();
      };

      this.scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileError);
      this.scene.load.once(Phaser.Loader.Events.COMPLETE, onComplete);
      batch.forEach((song) => {
        if (this.scene.textures.exists(song.coverTextureKey)) return;
        if (song.cover.toLowerCase().endsWith('.svg')) {
          this.scene.load.svg(song.coverTextureKey, song.cover);
        } else {
          this.scene.load.image(song.coverTextureKey, song.cover);
        }
      });
      this.scene.load.start();
    });
  }
}
