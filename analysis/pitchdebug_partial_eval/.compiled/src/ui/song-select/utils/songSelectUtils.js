import { Capacitor } from '@capacitor/core';
import { toPublicAssetUrl } from '../../../app/publicAssetUrl.js';
import { DEBUG_CONVERTER_MODE_STORAGE_KEY, IMPORT_SOURCE_STORAGE_KEY } from '../constants.js';
export function toSongManifestEntry(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const data = value;
    if (typeof data.id !== 'string' || typeof data.name !== 'string')
        return null;
    const folder = typeof data.folder === 'string' && data.folder.trim().length > 0 ? data.folder : data.id;
    const cover = typeof data.cover === 'string' ? data.cover : undefined;
    const midi = typeof data.midi === 'string' ? data.midi : undefined;
    const audio = typeof data.audio === 'string' ? data.audio : undefined;
    const file = typeof data.file === 'string' ? data.file : undefined;
    const highScore = typeof data.highScore === 'number' && Number.isFinite(data.highScore) && data.highScore >= 0
        ? Math.round(data.highScore)
        : undefined;
    return {
        id: data.id,
        name: data.name,
        folder,
        cover,
        midi,
        audio,
        file,
        highScore
    };
}
export function firstNonEmpty(...values) {
    return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}
export async function parseJsonSafe(response) {
    try {
        return (await response.json());
    }
    catch {
        return null;
    }
}
export function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
export function encodePathSegments(value) {
    return value
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}
export function resolveSongAssetPath(folder, value) {
    const trimmed = value.trim();
    if (/^[a-z][a-z\d+\-.]*:/i.test(trimmed) || trimmed.startsWith('//')) {
        return trimmed;
    }
    if (trimmed.startsWith('/')) {
        return toPublicAssetUrl(trimmed);
    }
    const relativeValue = trimmed.replace(/^\.?\//, '');
    return toPublicAssetUrl(`songs/${encodePathSegments(folder)}/${encodePathSegments(relativeValue)}`);
}
export function waitMs(ms) {
    return new Promise((resolve) => {
        window.setTimeout(() => resolve(), Math.max(0, ms));
    });
}
export async function requestQuitApplication() {
    if (Capacitor.isNativePlatform()) {
        try {
            const { App } = await import('@capacitor/app');
            App.exitApp();
            return true;
        }
        catch (error) {
            console.warn('Failed to quit native app', error);
            return false;
        }
    }
    if (isElectronRuntime() && typeof window !== 'undefined') {
        window.close();
        return true;
    }
    return false;
}
function isElectronRuntime() {
    if (typeof navigator === 'undefined')
        return false;
    return /electron/i.test(navigator.userAgent);
}
export function truncateLabel(value, maxLength) {
    if (!value)
        return '';
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}
export function inferUploadMimeType(fileName) {
    const lowered = fileName.toLowerCase();
    if (lowered.endsWith('.mid') || lowered.endsWith('.midi')) {
        return 'audio/midi';
    }
    if (lowered.endsWith('.ogg') || lowered.endsWith('.oga') || lowered.endsWith('.opus')) {
        return 'audio/ogg';
    }
    return 'audio/mpeg';
}
export function detectSongImportKind(fileName, mimeType) {
    const lowered = fileName.toLowerCase();
    if (/\.(mid|midi)$/i.test(lowered))
        return 'midi';
    if (/\.(mp3|ogg)$/i.test(lowered))
        return 'audio';
    const loweredMime = String(mimeType || '').toLowerCase();
    if (/^(audio\/midi|audio\/mid|audio\/x-midi|audio\/sp-midi|application\/midi|application\/x-midi)/i.test(loweredMime)) {
        return 'midi';
    }
    if (/^audio\/(mpeg|mp3|ogg|x-ogg|opus)/i.test(loweredMime)) {
        return 'audio';
    }
    return null;
}
export function stripFileExtension(fileName) {
    const sanitized = fileName.trim();
    if (!sanitized)
        return 'song';
    return sanitized.replace(/\.[^/.]+$/g, '') || sanitized;
}
export function toErrorMessage(error) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message.trim();
    }
    if (typeof error === 'string' && error.trim().length > 0) {
        return error.trim();
    }
    return 'Import failed.';
}
export function describeMicFailure(error) {
    const name = extractErrorName(error);
    switch (name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
            return 'permission denied';
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return 'no microphone found';
        case 'NotReadableError':
        case 'TrackStartError':
            return 'microphone busy in another app';
        case 'OverconstrainedError':
        case 'ConstraintNotSatisfiedError':
            return 'unsupported audio constraints';
        case 'SecurityError':
            return 'runtime security policy blocked mic';
        case 'AbortError':
            return 'microphone start aborted by system';
        default: {
            const message = extractErrorMessage(error);
            if (message)
                return message;
            return name ? name : null;
        }
    }
}
function extractErrorName(error) {
    if (!error || typeof error !== 'object')
        return null;
    if (!('name' in error))
        return null;
    const rawName = error.name;
    if (typeof rawName !== 'string')
        return null;
    const normalized = rawName.trim();
    return normalized.length > 0 ? normalized : null;
}
function extractErrorMessage(error) {
    if (!error || typeof error !== 'object')
        return null;
    if (!('message' in error))
        return null;
    const rawMessage = error.message;
    if (typeof rawMessage !== 'string')
        return null;
    const normalized = rawMessage.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}
export function isImportSourceDebugEnabled() {
    if (typeof window === 'undefined')
        return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('debugImportSource') === '1';
}
export function loadImportSourceModePreference() {
    if (typeof window === 'undefined')
        return 'auto';
    const value = window.localStorage.getItem(IMPORT_SOURCE_STORAGE_KEY);
    if (value === 'server' || value === 'native' || value === 'auto') {
        return value;
    }
    return 'auto';
}
export function saveImportSourceModePreference(mode) {
    if (typeof window === 'undefined')
        return;
    window.localStorage.setItem(IMPORT_SOURCE_STORAGE_KEY, mode);
}
export function parseDebugConverterMode(value) {
    if (value === 'legacy' || value === 'neuralnote' || value === 'ab') {
        return value;
    }
    return null;
}
export function loadDebugConverterModePreference() {
    if (typeof window === 'undefined')
        return 'legacy';
    const params = new URLSearchParams(window.location.search);
    const fromQuery = parseDebugConverterMode(params.get('debugConverterMode'));
    if (fromQuery) {
        window.localStorage.setItem(DEBUG_CONVERTER_MODE_STORAGE_KEY, fromQuery);
        return fromQuery;
    }
    const fromStorage = parseDebugConverterMode(window.localStorage.getItem(DEBUG_CONVERTER_MODE_STORAGE_KEY));
    return fromStorage ?? 'legacy';
}
export function sanitizeKey(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
}
export function normalizeFolder(value) {
    return value
        .replace(/\\/g, '/')
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .join('/');
}
export function isValidAssetResponse(url, response) {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType)
        return true;
    if (contentType.includes('text/html'))
        return false;
    const loweredUrl = url.toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(loweredUrl)) {
        return contentType.startsWith('image/');
    }
    if (/\.(mp3|wav|ogg|m4a)$/.test(loweredUrl)) {
        return contentType.startsWith('audio/');
    }
    if (/\.(mid|midi)$/.test(loweredUrl)) {
        return contentType.startsWith('audio/') || contentType.includes('midi') || contentType.includes('octet-stream');
    }
    return true;
}
export function isCapacitorFileUrl(url) {
    const lowered = url.toLowerCase();
    return lowered.includes('/_capacitor_file_/') || lowered.startsWith('capacitor://localhost/_capacitor_file_/');
}
export function midiToNoteName(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const note = names[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
}
export function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}
export function nextDifficulty(difficulty) {
    if (difficulty === 'Easy')
        return 'Medium';
    if (difficulty === 'Medium')
        return 'Hard';
    return 'Easy';
}
export function previousDifficulty(difficulty) {
    if (difficulty === 'Hard')
        return 'Medium';
    if (difficulty === 'Medium')
        return 'Easy';
    return 'Hard';
}
export function sortedValues(values) {
    return Array.from(values).sort((a, b) => a - b);
}
export function rangeInclusive(start, end) {
    const values = [];
    for (let value = start; value <= end; value += 1) {
        values.push(value);
    }
    return values;
}
export function sanitizeSettingValues(values, min, max) {
    const unique = new Set();
    values.forEach((value) => {
        if (!Number.isInteger(value))
            return;
        if (value < min || value > max)
            return;
        unique.add(value);
    });
    return Array.from(unique).sort((a, b) => a - b);
}
