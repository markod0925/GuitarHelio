import { describe, expect, test } from 'vitest';
import { analyzeHeldHitForTarget, isPitchFrameTargetValid } from '../src/ui/playSceneDebug';
import type { PitchFrame } from '../src/types/models';

function makeFrame(tSeconds: number, midiEstimate: number, detectedString: number | null): PitchFrame {
  return {
    t_seconds: tSeconds,
    midi_estimate: midiEstimate,
    confidence: 0.9,
    detected_string: detectedString
  };
}

describe('string-aware gameplay hit validation', () => {
  test('Easy accepts pitch match even when detected string is different', () => {
    const valid = isPitchFrameTargetValid(makeFrame(0, 52, 2), 52, 4, 0.5, 0.7, false);
    expect(valid).toBe(true);
  });

  test('Medium rejects when detected string is present and wrong', () => {
    const valid = isPitchFrameTargetValid(makeFrame(0, 52, 2), 52, 4, 0.5, 0.7, true);
    expect(valid).toBe(false);
  });

  test('Medium accepts pitch when detected string is missing (fallback)', () => {
    const valid = isPitchFrameTargetValid(makeFrame(0, 52, null), 52, 4, 0.5, 0.7, true);
    expect(valid).toBe(true);
  });

  test('Hard held-hit succeeds with pitch-only fallback when string stays unavailable', () => {
    const frames: PitchFrame[] = [makeFrame(1.0, 52, null), makeFrame(1.08, 52, null), makeFrame(1.16, 52, null)];
    const analysis = analyzeHeldHitForTarget(frames, 52, 4, 0.5, 120, 0.7, true);
    expect(analysis.valid).toBe(true);
    expect(analysis.streakMs).toBeGreaterThanOrEqual(120);
  });
});
