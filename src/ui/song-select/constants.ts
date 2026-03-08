import type { SongCatalogLoadPolicy } from './types';

export const DEFAULT_SONG_COVER_TEXTURE_KEY = 'defaultSongCover';
export const DEFAULT_SONG_COVER_URL = '/ui/song-cover-placeholder-neon.png';
export const IMPORT_STATUS_POLL_MS = 700;
export const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
export const IMPORT_SOURCE_STORAGE_KEY = 'gh_import_source_mode';
export const DEBUG_CONVERTER_MODE_STORAGE_KEY = 'gh_debug_converter_mode';
export const ASSET_NEGATIVE_CACHE_TTL_MS = 30_000;
export const DEFAULT_COVER_LOAD_CONCURRENCY = 3;
export const SONG_REMOVE_LONG_PRESS_MS = 560;
export const SONG_REMOVE_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
export const TUNER_IN_TUNE_CENTS = 5;
export const TUNER_AUTO_ADVANCE_HOLD_SECONDS = 2;
export const TUNER_SEQUENCE: ReadonlyArray<number> = [6, 5, 4, 3, 2, 1];

export const WEB_STARTUP_CATALOG_POLICY: SongCatalogLoadPolicy = {
  validateAssetsOnStartup: false,
  lazyCoverLoading: 'visible-first',
  coverLoadConcurrency: DEFAULT_COVER_LOAD_CONCURRENCY
};
