import { describe, expect, test } from 'vitest';
import { MidiScrubPlayer } from '../src/audio/midiScrubPlayer';
import type { SourceNote } from '../src/types/models';

function note(tickOn: number, tickOff: number, midi = 52): SourceNote {
  return {
    tick_on: tickOn,
    tick_off: tickOff,
    midi_note: midi,
    velocity: 0.8,
    channel: 0,
    track: 0
  };
}

describe('MidiScrubPlayer', () => {
  test('plays note-on and note-off while moving forward across boundaries', () => {
    const notes = [note(10, 20)];
    const on: string[] = [];
    const off: string[] = [];

    const player = new MidiScrubPlayer(
      {
        noteOn: (n) => on.push(`${n.tick_on}-${n.tick_off}`),
        noteOff: (n) => off.push(`${n.tick_on}-${n.tick_off}`),
        stopAll: () => undefined
      },
      notes,
      240
    );

    player.resume(0);
    player.updateToTick(9, 0);
    expect(on).toEqual([]);

    player.updateToTick(10, 0);
    expect(on).toEqual(['10-20']);

    player.updateToTick(20, 0);
    expect(off).toEqual(['10-20']);
  });

  test('pauses all voices and rebuilds active notes on resume', () => {
    const notes = [note(10, 30)];
    const on: string[] = [];
    let stopAllCount = 0;

    const player = new MidiScrubPlayer(
      {
        noteOn: (n) => on.push(`${n.tick_on}-${n.tick_off}`),
        noteOff: () => undefined,
        stopAll: () => {
          stopAllCount += 1;
        }
      },
      notes,
      240
    );

    player.resume(0);
    player.updateToTick(15, 0);
    expect(on).toEqual(['10-30']);

    player.pause(15);
    expect(stopAllCount).toBe(2); // one from initial resume rebuild, one from pause

    player.resume(15);
    expect(on).toEqual(['10-30', '10-30']);
  });
});
