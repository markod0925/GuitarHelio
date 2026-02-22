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

  test('keeps direct pitch mapping before octave fallback', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 52, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const strictProfile: DifficultyProfile = {
      allowed_strings: [6],
      allowed_frets: { min: 0, max: 12 },
      allowed_fingers: [1],
      avg_seconds_per_note: 0.5,
      pitch_tolerance_semitones: 0,
      max_simultaneous_notes: 1
    };

    const [target] = generateTargetNotes(source, strictProfile, tempoMap);
    expect(target.expected_midi).toBe(52);
    expect(target.fret).toBe(12);
  });

  test('supports configurable representative policy for clustered notes', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 45, velocity: 0.7, channel: 0, track: 0 },
      { tick_on: 20, tick_off: 120, midi_note: 52, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);

    const highest = generateTargetNotes(source, profile, tempoMap, { representativePolicy: 'highest' });
    const lowest = generateTargetNotes(source, profile, tempoMap, { representativePolicy: 'lowest' });

    expect(highest[0].source_midi).toBe(52);
    expect(lowest[0].source_midi).toBe(45);
  });

  test('respects non-contiguous allowed fret list', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 42, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const customProfile: DifficultyProfile = {
      allowed_strings: [6],
      allowed_frets: { min: 0, max: 21 },
      allowed_fret_list: [0, 2, 5],
      allowed_fingers: [1, 2],
      avg_seconds_per_note: 0.5,
      pitch_tolerance_semitones: 0,
      max_simultaneous_notes: 1
    };

    const [target] = generateTargetNotes(source, customProfile, tempoMap);
    expect(target.fret).toBe(2);
  });

  test('uses finger 0 for open string notes', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 40, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const customProfile: DifficultyProfile = {
      allowed_strings: [6],
      allowed_frets: { min: 0, max: 5 },
      allowed_fingers: [1, 2, 3, 4],
      avg_seconds_per_note: 0.1,
      pitch_tolerance_semitones: 0,
      max_simultaneous_notes: 1
    };

    const [target] = generateTargetNotes(source, customProfile, tempoMap);
    expect(target.fret).toBe(0);
    expect(target.finger).toBe(0);
  });

  test('avoids same finger on consecutive different frets when alternatives exist', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 42, velocity: 0.7, channel: 0, track: 0 },
      { tick_on: 300, tick_off: 420, midi_note: 44, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const customProfile: DifficultyProfile = {
      allowed_strings: [6],
      allowed_frets: { min: 0, max: 8 },
      allowed_fingers: [1, 2, 3, 4],
      avg_seconds_per_note: 0.1,
      pitch_tolerance_semitones: 0,
      max_simultaneous_notes: 1
    };

    const targets = generateTargetNotes(source, customProfile, tempoMap);
    expect(targets.length).toBe(2);
    expect(targets[0].fret).not.toBe(targets[1].fret);
    expect(targets[0].finger).not.toBe(targets[1].finger);
  });

  test('respects selected allowed fingers', () => {
    const source: SourceNote[] = [
      { tick_on: 0, tick_off: 120, midi_note: 43, velocity: 0.7, channel: 0, track: 0 }
    ];
    const tempoMap = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const customProfile: DifficultyProfile = {
      allowed_strings: [6],
      allowed_frets: { min: 0, max: 5 },
      allowed_fingers: [2],
      avg_seconds_per_note: 0.1,
      pitch_tolerance_semitones: 0,
      max_simultaneous_notes: 1
    };

    const [target] = generateTargetNotes(source, customProfile, tempoMap);
    expect(target.fret).toBe(3);
    expect(target.finger).toBe(2);
  });
});
