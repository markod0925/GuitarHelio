import { describe, expect, test } from 'vitest';
import { buildSpectralRuntimeModelFromTargets } from '../src/audio/spectralRuntimeModel';
import type { TargetNote } from '../src/types/models';

function makeTarget(
  id: string,
  tick: number,
  chordId: string,
  expectedMidi: number,
  string: number,
  fret: number
): TargetNote {
  return {
    id,
    tick,
    chord_id: chordId,
    chord_size: 1,
    chord_index: 0,
    duration_ticks: 120,
    expected_midi: expectedMidi,
    string,
    fret,
    finger: 1
  };
}

describe('buildSpectralRuntimeModelFromTargets', () => {
  test('returns null when no targets are available', () => {
    expect(buildSpectralRuntimeModelFromTargets([])).toBeNull();
  });

  test('deduplicates patterns globally by unordered MIDI set and includes mononote patterns', () => {
    const targets: TargetNote[] = [
      makeTarget('a1', 0, 'a', 43, 6, 3),
      makeTarget('a2', 0, 'a', 47, 5, 2),
      makeTarget('b1', 240, 'b', 47, 2, 0),
      makeTarget('b2', 240, 'b', 43, 3, 2),
      makeTarget('c1', 480, 'c', 67, 1, 3),
      makeTarget('d1', 720, 'd', 67, 2, 8),
      makeTarget('e1', 960, 'e', 67, 1, 3),
      makeTarget('e2', 960, 'e', 43, 6, 3)
    ];

    const model = buildSpectralRuntimeModelFromTargets(targets);
    expect(model).not.toBeNull();
    if (!model) return;

    const chordIds = model.chords.map((chord) => chord.id).sort();
    expect(chordIds).toEqual(['pattern_43_47', 'pattern_43_67', 'pattern_67']);
    expect(model.chords).toHaveLength(3);

    const mononotePattern = model.chords.find((chord) => chord.id === 'pattern_67');
    expect(mononotePattern?.member_note_ids).toHaveLength(1);
  });
});
