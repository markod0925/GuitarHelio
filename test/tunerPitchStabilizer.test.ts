import { describe, expect, test } from 'vitest';
import { TunerPitchStabilizer } from '../src/audio/tunerPitchStabilizer';
import type { PitchFrame } from '../src/types/models';

function frame(midi: number | null, confidence = 0.9): PitchFrame {
  return {
    t_seconds: 0,
    midi_estimate: midi,
    confidence
  };
}

describe('TunerPitchStabilizer', () => {
  test('stabilizes cents jitter around the same note', () => {
    const stabilizer = new TunerPitchStabilizer();
    const targetMidi = 40;
    const rawMidi = [40.08, 39.95, 40.06, 39.94, 40.04, 39.97];
    const readings = rawMidi
      .map((midi) => stabilizer.update(frame(midi), targetMidi))
      .filter((reading): reading is NonNullable<typeof reading> => reading !== null);

    expect(readings).toHaveLength(rawMidi.length);
    expect(readings.every((reading) => reading.detectedMidi === 40)).toBe(true);

    const centsValues = readings.map((reading) => reading.cents);
    const centsRange = Math.max(...centsValues) - Math.min(...centsValues);
    expect(centsRange).toBeLessThan(10);
  });

  test('does not flip note around semitone boundary without stable evidence', () => {
    const stabilizer = new TunerPitchStabilizer();
    const targetMidi = 40;
    const boundaryMidi = [40.49, 40.51, 40.49, 40.51, 40.49, 40.51, 40.49, 40.51];
    const detected = boundaryMidi
      .map((midi) => stabilizer.update(frame(midi), targetMidi))
      .filter((reading): reading is NonNullable<typeof reading> => reading !== null)
      .map((reading) => reading.detectedMidi);

    expect(detected.length).toBeGreaterThan(0);
    expect(detected.every((value) => value === 40)).toBe(true);
  });

  test('switches detected note after consistent new pitch frames', () => {
    const stabilizer = new TunerPitchStabilizer();
    const targetMidi = 40;
    const sequence = [40, 40, 40, 41.2, 41.2, 41.2, 41.2, 41.2, 41.2, 41.2];
    const detected = sequence
      .map((midi) => stabilizer.update(frame(midi), targetMidi))
      .filter((reading): reading is NonNullable<typeof reading> => reading !== null)
      .map((reading) => reading.detectedMidi);

    expect(detected.at(-1)).toBe(41);
  });

  test('holds last stable reading briefly across dropouts then clears', () => {
    const stabilizer = new TunerPitchStabilizer();
    const targetMidi = 40;

    const first = stabilizer.update(frame(40), targetMidi);
    expect(first).not.toBeNull();

    const held1 = stabilizer.update(frame(null, 0), targetMidi);
    const held2 = stabilizer.update(frame(null, 0), targetMidi);
    const held3 = stabilizer.update(frame(null, 0), targetMidi);
    const held4 = stabilizer.update(frame(null, 0), targetMidi);
    const cleared = stabilizer.update(frame(null, 0), targetMidi);

    expect(held1).not.toBeNull();
    expect(held2).not.toBeNull();
    expect(held3).not.toBeNull();
    expect(held4).not.toBeNull();
    expect(cleared).toBeNull();
  });
});
