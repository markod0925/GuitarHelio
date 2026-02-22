import type { DifficultyProfile } from '../types/models';
import { midiForStringFret } from './tuning';

export type PlayablePosition = {
  string: number;
  fret: number;
  finger: number;
  boxStart: number;
  midi: number;
  pitchDistance: number;
};

export function generatePlayablePositions(sourceMidi: number, profile: DifficultyProfile): PlayablePosition[] {
  const positions: PlayablePosition[] = [];
  const frets = normalizeAllowedFrets(profile);

  for (const string of profile.allowed_strings) {
    for (const fret of frets) {
      const midi = midiForStringFret(string, fret);
      const pitchDistance = Math.abs(midi - sourceMidi);
      if (pitchDistance > profile.pitch_tolerance_semitones) continue;

      if (fret === 0) {
        positions.push({ string, fret, finger: 0, boxStart: 0, midi, pitchDistance });
        continue;
      }

      const minBoxStart = Math.max(1, fret - 3);
      const maxBoxStart = fret;
      for (let boxStart = minBoxStart; boxStart <= maxBoxStart; boxStart += 1) {
        const finger = fret - boxStart + 1;
        if (!profile.allowed_fingers.includes(finger)) continue;
        positions.push({ string, fret, finger, boxStart, midi, pitchDistance });
      }
    }
  }

  return positions;
}

function normalizeAllowedFrets(profile: DifficultyProfile): number[] {
  const fromList = profile.allowed_fret_list?.filter((fret) => Number.isInteger(fret));
  if (fromList && fromList.length > 0) {
    const unique = Array.from(new Set(fromList));
    unique.sort((a, b) => a - b);
    return unique;
  }

  const frets: number[] = [];
  for (let fret = profile.allowed_frets.min; fret <= profile.allowed_frets.max; fret += 1) {
    frets.push(fret);
  }
  return frets;
}
