import { describe, expect, test } from 'vitest';
import { TempoMap } from '../src/midi/tempoMap';

describe('TempoMap', () => {
  test('round-trips tick/seconds at constant tempo', () => {
    const map = TempoMap.fromTempoEvents(480, [{ tick: 0, bpm: 120 }]);
    const seconds = map.tickToSeconds(960);
    expect(seconds).toBeCloseTo(1, 6);
    expect(map.secondsToTick(seconds)).toBe(960);
  });

  test('supports tempo change conversion', () => {
    const map = TempoMap.fromTempoEvents(480, [
      { tick: 0, bpm: 120 },
      { tick: 480, bpm: 60 }
    ]);
    expect(map.tickToSeconds(480)).toBeCloseTo(0.5, 6);
    expect(map.tickToSeconds(960)).toBeCloseTo(1.5, 6);
  });
});
