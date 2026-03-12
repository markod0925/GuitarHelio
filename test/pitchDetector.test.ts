import { describe, expect, test } from 'vitest';
import { applyReferenceContaminationPolicy, isValidHeldHit } from '../src/audio/pitchDetector';
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

describe('applyReferenceContaminationPolicy', () => {
  test('rejects speaker frame only when contamination matches hard reject conditions', () => {
    const result = applyReferenceContaminationPolicy(
      {
        t_seconds: 1,
        midi_estimate: 64,
        confidence: 0.9,
        reference_midi: 64.1,
        reference_correlation: 0.9,
        energy_ratio_db: -12,
        onset_strength: 0.05,
        contamination_score: 0.9
      },
      'speaker'
    );

    expect(result.midi_estimate).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.rejected_as_reference_bleed).toBe(true);
  });

  test('keeps matching speaker frame when onset is strong and applies soft confidence penalty', () => {
    const result = applyReferenceContaminationPolicy(
      {
        t_seconds: 1,
        midi_estimate: 64,
        confidence: 1,
        reference_midi: 64.05,
        reference_correlation: 0.9,
        energy_ratio_db: -12,
        onset_strength: 0.4,
        contamination_score: 0.6
      },
      'speaker'
    );

    expect(result.midi_estimate).toBe(64);
    expect(result.rejected_as_reference_bleed).toBe(false);
    expect(result.confidence).toBeCloseTo(0.73, 4);
  });

  test('uses stricter reject thresholds for headphones mode', () => {
    const notRejected = applyReferenceContaminationPolicy(
      {
        t_seconds: 1,
        midi_estimate: 64,
        confidence: 0.9,
        reference_midi: 64.05,
        reference_correlation: 0.91,
        energy_ratio_db: -12,
        onset_strength: 0.1,
        contamination_score: 0.8
      },
      'headphones'
    );
    const rejected = applyReferenceContaminationPolicy(
      {
        t_seconds: 1,
        midi_estimate: 64,
        confidence: 0.9,
        reference_midi: 64.05,
        reference_correlation: 0.96,
        energy_ratio_db: -15,
        onset_strength: 0.1,
        contamination_score: 0.8
      },
      'headphones'
    );

    expect(notRejected.midi_estimate).toBe(64);
    expect(notRejected.rejected_as_reference_bleed).toBe(false);
    expect(rejected.midi_estimate).toBeNull();
    expect(rejected.rejected_as_reference_bleed).toBe(true);
  });
});
