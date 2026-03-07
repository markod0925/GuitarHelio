import { describe, expect, test } from 'vitest';
import {
  applyPitchCalibration,
  buildPitchCalibrationProfile,
  estimatePitchCalibrationMeasurement,
  getPitchCalibrationOffsetCents
} from '../src/audio/pitchCalibration';

describe('pitch calibration', () => {
  test('estimates offset robustly with outliers', () => {
    const targetMidi = 40;
    const samples = [40.09, 40.08, 40.1, 40.07, 40.09, 40.08, 42.4];
    const measurement = estimatePitchCalibrationMeasurement(samples, targetMidi);
    expect(measurement).not.toBeNull();
    expect(measurement?.offsetCents).toBeGreaterThan(6);
    expect(measurement?.offsetCents).toBeLessThan(12);
  });

  test('interpolates correction curve between calibration points', () => {
    const profile = buildPitchCalibrationProfile([
      { midi: 40, offsetCents: 10, sampleCount: 10, scatterCents: 1.5 },
      { midi: 52, offsetCents: -10, sampleCount: 10, scatterCents: 1.3 },
      { midi: 64, offsetCents: 20, sampleCount: 10, scatterCents: 1.7 }
    ]);
    expect(profile).not.toBeNull();
    if (!profile) return;

    expect(getPitchCalibrationOffsetCents(40, profile)).toBeCloseTo(10, 5);
    expect(getPitchCalibrationOffsetCents(46, profile)).toBeCloseTo(0, 5);
    expect(getPitchCalibrationOffsetCents(64, profile)).toBeCloseTo(20, 5);
  });

  test('applies correction by subtracting interpolated cents', () => {
    const profile = buildPitchCalibrationProfile([
      { midi: 40, offsetCents: 20, sampleCount: 10, scatterCents: 1.5 },
      { midi: 64, offsetCents: 20, sampleCount: 10, scatterCents: 1.3 }
    ]);
    expect(profile).not.toBeNull();
    if (!profile) return;

    const corrected = applyPitchCalibration(52, profile);
    expect(corrected).toBeCloseTo(51.8, 5);
  });
});
