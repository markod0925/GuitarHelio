import { describe, expect, test } from 'vitest';
import { buildPlaybackNotes } from '../src/audio/playbackNotes';
import type { SourceNote } from '../src/types/models';

function n(
  tickOn: number,
  tickOff: number,
  midi: number,
  velocity: number,
  channel = 0,
  track = 0
): SourceNote {
  return {
    tick_on: tickOn,
    tick_off: tickOff,
    midi_note: midi,
    velocity,
    channel,
    track
  };
}

describe('buildPlaybackNotes', () => {
  test('filters drums, out-of-range notes, and too-short notes', () => {
    const source: SourceNote[] = [
      n(0, 120, 52, 0.7, 0), // keep
      n(0, 120, 40, 0.9, 9), // drop drum channel
      n(0, 120, 20, 0.8, 0), // drop too low
      n(0, 120, 110, 0.8, 0), // drop too high
      n(0, 5, 55, 0.8, 0) // drop too short for 480ppq (min 10 ticks)
    ];

    const out = buildPlaybackNotes(source, 480);
    expect(out).toHaveLength(1);
    expect(out[0].midi_note).toBe(52);
  });

  test('limits notes per tick while preserving low/high anchors', () => {
    const source: SourceNote[] = [
      n(100, 220, 40, 0.4),
      n(100, 220, 45, 0.7),
      n(100, 220, 50, 0.8),
      n(100, 220, 55, 0.3),
      n(100, 220, 60, 0.95),
      n(100, 220, 65, 0.9),
      n(100, 220, 70, 0.85),
      n(100, 220, 75, 0.5)
    ];

    const out = buildPlaybackNotes(source, 480, { maxNotesPerTick: 4 });
    const midi = out.map((x) => x.midi_note).sort((a, b) => a - b);

    expect(out).toHaveLength(4);
    expect(midi[0]).toBe(40); // preserved lowest
    expect(midi[midi.length - 1]).toBe(75); // preserved highest
    expect(midi).toContain(60); // strongest notes retained
    expect(midi).toContain(65);
  });
});
