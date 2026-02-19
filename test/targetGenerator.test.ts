import { describe, expect, test } from 'vitest';
import { generateTargetNotes } from '../src/guitar/targetGenerator';
import { TempoMap } from '../src/midi/tempoMap';
import type { DifficultyProfile, SourceNote } from '../src/types/models';

const profile: DifficultyProfile = {
  allowed_strings: [6, 5, 4],
  allowed_frets: { min: 0, max: 5 },
  allowed_fingers: [1, 2],
  avg_seconds_per_note: 0.5,
  pitch_tolerance_semitones: 2,
  max_simultaneous_notes: 1
};

describe('generateTargetNotes', () => {
  test('returns simplified playable subset', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 45, velocity: 0.7, channel: 0, track: 0 },
      { tick_on: 30, tick_off: 150, midi_note: 52, velocity: 0.7, channel: 0, track: 0 },
      { tick_on: 480, tick_off: 600, midi_note: 47, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const targets = generateTargetNotes(source, profile, tempoMap);

    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0].string).toBeGreaterThanOrEqual(4);
    expect(targets[0].fret).toBeGreaterThanOrEqual(0);
  });
});
