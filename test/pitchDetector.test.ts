import { describe, expect, test } from 'vitest';
import { isValidHeldHit } from '../src/audio/pitchDetector';
import type { PitchFrame } from '../src/types/models';

function frame(t_seconds: number, midi_estimate: number | null, confidence = 0.8): PitchFrame {
  return { t_seconds, midi_estimate, confidence };
}

describe('isValidHeldHit', () => {
  test('accepts contiguous valid hold that exceeds threshold', () => {
    const frames = [
      frame(0.00, 64),
      frame(0.03, 64),
      frame(0.07, 64),
      frame(0.10, 64)
    ];

    expect(isValidHeldHit(frames, 64, 0, 80)).toBe(true);
  });

  test('rejects non-contiguous valid frames separated by invalid detection', () => {
    const frames = [
      frame(0.00, 64),
      frame(0.02, 63),
      frame(0.10, 64),
      frame(0.14, 64)
    ];

    expect(isValidHeldHit(frames, 64, 0, 80)).toBe(false);
  });
});
