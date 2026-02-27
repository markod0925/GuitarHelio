import { describe, expect, test } from 'vitest';
import { Midi } from '@tonejs/midi';
// @ts-expect-error - JS helper module vendored in tools has no local .d.ts
import { applyTempoMetadataToMidi } from '../tools/audio-midi-converter/src/midi-tempo-map.mjs';

describe('applyTempoMetadataToMidi', () => {
  test('applies constant tempo and appends endpoint anchor', () => {
    const midi = new Midi();
    applyTempoMetadataToMidi(midi, {
      tempoBpm: 128,
      audioDurationSeconds: 2
    });

    expect(midi.header.tempos.length).toBeGreaterThanOrEqual(1);
    expect(midi.header.tempos[0].bpm).toBeCloseTo(128, 6);
    expect(midi.header.tempos[0].ticks).toBe(0);

    const expectedEndTick = Math.round(midi.header.secondsToTicks(2));
    const maxTick = Math.max(...midi.header.tempos.map((entry) => Math.round(entry.ticks)));
    expect(maxTick).toBe(expectedEndTick);
  });

  test('applies local tempo map with monotonic tick events', () => {
    const midi = new Midi();
    applyTempoMetadataToMidi(midi, {
      tempoBpm: 120,
      tempoMap: [
        { timeSeconds: 0, bpm: 100 },
        { timeSeconds: 1, bpm: 120 },
        { timeSeconds: 2, bpm: 90 }
      ],
      audioDurationSeconds: 3
    });

    expect(midi.header.tempos.length).toBeGreaterThanOrEqual(3);
    const ticks = midi.header.tempos.map((entry) => Math.round(entry.ticks));

    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
    }

    const expectedEndTick = Math.round(midi.header.secondsToTicks(3));
    expect(ticks[ticks.length - 1]).toBe(expectedEndTick);
  });
});
