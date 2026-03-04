import type { PitchFrame, SourceNote } from '../types/models';
import type { PitchFrameWindow } from '../audio/PitchFrameRingBuffer';
import { TempoMap } from '../midi/tempoMap';
import type { HeldHitAnalysis } from './playSceneTypes';

export function sanitizeSelection(
  values: number[] | undefined,
  min: number,
  max: number,
  fallback: number[] | undefined
): number[] {
  const candidate = values ?? fallback ?? [];
  const deduped = Array.from(
    new Set(candidate.filter((value) => Number.isInteger(value) && value >= min && value <= max))
  );
  deduped.sort((a, b) => a - b);
  return deduped;
}

export function isBackingTrackAudioUrl(url: string): boolean {
  return /\.(mp3|wav|ogg|m4a)(?:[?#].*)?$/i.test(url);
}

export function filterSourceNotesByOnsetSeconds(
  sourceNotes: SourceNote[],
  tempoMap: TempoMap,
  cutoffSeconds: number
): SourceNote[] {
  const safeCutoffSeconds = Math.max(0, cutoffSeconds);
  if (safeCutoffSeconds <= 0) return sourceNotes;

  return sourceNotes.filter((note) => tempoMap.tickToSeconds(note.tick_on) >= safeCutoffSeconds);
}

export function analyzeHeldHit(
  frames: PitchFrameWindow | readonly PitchFrame[],
  expectedMidi: number,
  tolerance: number,
  holdMs: number,
  minConfidence: number,
  out?: HeldHitAnalysis
): HeldHitAnalysis {
  const frameCount = frames.length;
  if (frameCount === 0) {
    return writeHeldHitAnalysis(out, false, 0, 0, 0, undefined);
  }

  let streakStartSeconds: number | null = null;
  let streakMs = 0;
  let validFrameCount = 0;
  const latestFrame = resolveLatestPitchFrame(frames);

  for (let index = 0; index < frameCount; index += 1) {
    const frame = resolvePitchFrameAt(frames, index);
    if (!frame) continue;
    const validFrame = isPitchFrameValid(frame, expectedMidi, tolerance, minConfidence);
    if (!validFrame) {
      streakStartSeconds = null;
      streakMs = 0;
      continue;
    }

    validFrameCount += 1;
    if (streakStartSeconds === null) {
      streakStartSeconds = frame.t_seconds;
      streakMs = 0;
      continue;
    }

    streakMs = Math.max(0, (frame.t_seconds - streakStartSeconds) * 1000);
    if (streakMs >= holdMs) {
      return writeHeldHitAnalysis(out, true, streakMs, validFrameCount, frameCount, latestFrame);
    }
  }

  return writeHeldHitAnalysis(out, false, streakMs, validFrameCount, frameCount, latestFrame);
}

function writeHeldHitAnalysis(
  out: HeldHitAnalysis | undefined,
  valid: boolean,
  streakMs: number,
  validFrameCount: number,
  sampleCount: number,
  latestFrame: PitchFrame | undefined
): HeldHitAnalysis {
  if (!out) {
    return {
      valid,
      streakMs,
      validFrameCount,
      sampleCount,
      latestFrame
    };
  }

  out.valid = valid;
  out.streakMs = streakMs;
  out.validFrameCount = validFrameCount;
  out.sampleCount = sampleCount;
  out.latestFrame = latestFrame;
  return out;
}

function resolvePitchFrameAt(frames: PitchFrameWindow | readonly PitchFrame[], index: number): PitchFrame | undefined {
  if (isPitchFrameArray(frames)) {
    return frames[index];
  }
  return frames.at(index);
}

function resolveLatestPitchFrame(frames: PitchFrameWindow | readonly PitchFrame[]): PitchFrame | undefined {
  if (isPitchFrameArray(frames)) {
    return frames.length > 0 ? frames[frames.length - 1] : undefined;
  }
  return frames.latest();
}

function isPitchFrameArray(value: PitchFrameWindow | readonly PitchFrame[]): value is readonly PitchFrame[] {
  return Array.isArray(value);
}

export function isPitchFrameValid(
  frame: PitchFrame,
  expectedMidi: number,
  tolerance: number,
  minConfidence: number
): boolean {
  return (
    frame.midi_estimate !== null &&
    frame.confidence >= minConfidence &&
    Math.abs(frame.midi_estimate - expectedMidi) <= tolerance
  );
}

export function formatDebugBool(value: boolean): string {
  return value ? 'Y' : 'N';
}

export function formatDebugNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toFixed(digits);
}

export function formatSignedMs(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '-';
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}ms`;
}

export function formatDebugPath(value: string | undefined): string {
  if (!value) return '-';
  const trimmed = value.trim();
  if (!trimmed) return '-';
  if (trimmed.startsWith('data:')) return '[data-url]';
  const withoutQuery = trimmed.split('?')[0].split('#')[0];
  const parts = withoutQuery.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return withoutQuery;
  const tail = parts.slice(-3).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return `.../${tail.join('/')}`;
}

export function normalizeTopFeedback(rawFeedbackText: string): string {
  const normalized = rawFeedbackText.trim().toLowerCase();
  if (normalized.length === 0) return '';

  if (normalized.startsWith('perfect')) return 'Perfect';
  if (normalized.startsWith('great')) return 'Great';
  if (normalized.startsWith('ok')) return 'OK';
  if (normalized.startsWith('too soon')) return 'Too Soon';
  if (normalized.startsWith('too late') || normalized.startsWith('miss')) return 'Too Late';
  return '';
}

export function isGameplayDebugOverlayEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  return params.get('debugGameplayOverlay') === '1';
}
