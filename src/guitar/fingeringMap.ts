import type { DifficultyProfile } from '../types/models';
import { midiForStringFret } from './tuning';

export type PlayablePosition = {
  string: number;
  fret: number;
  finger: number;
  midi: number;
  pitchDistance: number;
};

export function generatePlayablePositions(sourceMidi: number, profile: DifficultyProfile): PlayablePosition[] {
  const positions: PlayablePosition[] = [];

  for (const string of profile.allowed_strings) {
    for (let fret = profile.allowed_frets.min; fret <= profile.allowed_frets.max; fret += 1) {
      const midi = midiForStringFret(string, fret);
      const pitchDistance = Math.abs(midi - sourceMidi);
      if (pitchDistance > profile.pitch_tolerance_semitones) continue;

      const fingerCandidates = fret === 0 ? [1] : profile.allowed_fingers;
      for (const finger of fingerCandidates) {
        if (!profile.allowed_fingers.includes(finger)) continue;
        positions.push({ string, fret, finger, midi, pitchDistance });
      }
    }
  }

  return positions;
}
