import { describe, expect, test } from 'vitest';
import { resolvePracticeCellVisual, resolvePracticeStringBandAlpha } from '../src/ui/practiceHighlighting';

describe('practice highlighting helpers', () => {
  test('highlights only matching string when detector provides both MIDI and string', () => {
    const matching = resolvePracticeCellVisual(64, 2, 64, 2);
    const differentString = resolvePracticeCellVisual(64, 3, 64, 2);

    expect(matching.fillColor).toBe(0x22c55e);
    expect(matching.fillAlpha).toBeGreaterThan(0.9);
    expect(differentString.fillColor).toBe(0x64748b);
  });

  test('highlights all equivalent MIDI positions when string is unavailable', () => {
    const positionA = resolvePracticeCellVisual(64, 2, 64, null);
    const positionB = resolvePracticeCellVisual(64, 3, 64, null);

    expect(positionA.fillColor).toBe(0x22c55e);
    expect(positionB.fillColor).toBe(0x22c55e);
  });

  test('enables yellow band only on detected string', () => {
    expect(resolvePracticeStringBandAlpha(4, 4)).toBeGreaterThan(0);
    expect(resolvePracticeStringBandAlpha(5, 4)).toBe(0);
    expect(resolvePracticeStringBandAlpha(4, null)).toBe(0);
  });
});
