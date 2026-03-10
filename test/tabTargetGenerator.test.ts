import { describe, expect, test } from 'vitest';
import { Midi } from '@tonejs/midi';
import type { DifficultyProfile } from '../src/types/models';
import { generateTargetNotesFromMidiTab } from '../src/guitar/tabTargetGenerator';
import { loadMidiFromArrayBuffer } from '../src/midi/midiLoader';

function midiToArrayBuffer(midi: Midi): ArrayBuffer {
  const bytes = midi.toArray();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function makeProfile(
  allowedStrings: number[],
  allowedFrets: number[],
  allowedFingers: number[]
): DifficultyProfile {
  return {
    allowed_strings: allowedStrings,
    allowed_frets: { min: Math.min(...allowedFrets), max: Math.max(...allowedFrets) },
    allowed_fret_list: allowedFrets,
    allowed_fingers: allowedFingers,
    avg_seconds_per_note: 0.5,
    pitch_tolerance_semitones: 0,
    max_simultaneous_notes: 1
  };
}

describe('generateTargetNotesFromMidiTab', () => {
  test('respects selected strings and frets from session settings', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 40, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 42, ticks: 480, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 43, ticks: 960, durationTicks: 240, velocity: 0.8 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);

    const targets = generateTargetNotesFromMidiTab(buffer, {
      profile: makeProfile([6], [0, 2, 3], [1, 2, 3, 4]),
      difficulty: 'Hard',
      sourceNotes: loaded.sourceNotes
    });

    expect(targets.length).toBe(3);
    expect(targets.map((target) => target.string)).toEqual([6, 6, 6]);
    expect(targets.map((target) => target.fret)).toEqual([0, 2, 3]);
  });

  test('maps tick and duration directly from matched source notes', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 47, ticks: 480, durationTicks: 300, velocity: 0.82 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);

    const targets = generateTargetNotesFromMidiTab(buffer, {
      profile: makeProfile([6], [7], [3]),
      difficulty: 'Hard',
      sourceNotes: loaded.sourceNotes
    });

    expect(targets.length).toBe(1);
    expect(targets[0].tick).toBe(480);
    expect(targets[0].duration_ticks).toBe(300);
    expect(targets[0].string).toBe(6);
    expect(targets[0].fret).toBe(7);
    expect(targets[0].expected_midi).toBe(47);
    expect(targets[0].finger).toBe(3);
  });

  test('assigns fretted fingers from selected allowed fingers', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 47, ticks: 0, durationTicks: 240, velocity: 0.8 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);

    const targets = generateTargetNotesFromMidiTab(buffer, {
      profile: makeProfile([6], [7], [4]),
      difficulty: 'Hard',
      sourceNotes: loaded.sourceNotes
    });

    expect(targets.length).toBe(1);
    expect(targets[0].finger).toBe(4);
  });

  test('keeps multi-note chord events from TAB extraction', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 40, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 45, ticks: 0, durationTicks: 240, velocity: 0.8 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);

    const targets = generateTargetNotesFromMidiTab(buffer, {
      profile: makeProfile([5, 6], [0], [1, 2, 3, 4]),
      difficulty: 'Easy',
      sourceNotes: loaded.sourceNotes
    });

    expect(targets.length).toBe(2);
    expect(targets[0].tick).toBe(0);
    expect(targets[1].tick).toBe(0);
    expect(targets[0].chord_id).toBe(targets[1].chord_id);
    expect(targets[0].chord_size).toBe(2);
    expect(targets[1].chord_size).toBe(2);
  });

  test('applies original MIDI-to-TAB difficulty presets during extraction', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 40, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 45, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 50, ticks: 0, durationTicks: 240, velocity: 0.8 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);
    const profile = makeProfile([4, 5, 6], [0], [1, 2, 3, 4]);

    const easyTargets = generateTargetNotesFromMidiTab(buffer, {
      profile,
      difficulty: 'Easy',
      sourceNotes: loaded.sourceNotes
    });
    const hardTargets = generateTargetNotesFromMidiTab(buffer, {
      profile,
      difficulty: 'Hard',
      sourceNotes: loaded.sourceNotes
    });

    expect(easyTargets.length).toBe(2);
    expect(hardTargets.length).toBe(3);
  });

  test('caps chord size to selected playable string count', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 40, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 45, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 47, ticks: 0, durationTicks: 240, velocity: 0.8 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);

    const targets = generateTargetNotesFromMidiTab(buffer, {
      profile: makeProfile([5, 6], [0, 2, 7], [1, 2, 3, 4]),
      difficulty: 'Hard',
      sourceNotes: loaded.sourceNotes
    });

    expect(targets.length).toBe(2);
    expect(targets.every((target) => target.tick === 0)).toBe(true);
  });

  test('merges near onsets more aggressively when string/fret constraints are tight', () => {
    const midi = new Midi();
    const track = midi.addTrack();
    track.addNote({ midi: 40, ticks: 0, durationTicks: 240, velocity: 0.8 });
    track.addNote({ midi: 42, ticks: 60, durationTicks: 240, velocity: 0.8 });
    const buffer = midiToArrayBuffer(midi);
    const loaded = loadMidiFromArrayBuffer(buffer);

    const targets = generateTargetNotesFromMidiTab(buffer, {
      profile: makeProfile([6], [0, 2], [1, 2, 3, 4]),
      difficulty: 'Hard',
      sourceNotes: loaded.sourceNotes
    });

    expect(targets.length).toBe(1);
    expect(targets[0].tick).toBe(0);
  });
});
