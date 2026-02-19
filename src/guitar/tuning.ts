export const STANDARD_TUNING: Record<number, number> = {
  1: 64,
  2: 59,
  3: 55,
  4: 50,
  5: 45,
  6: 40
};

export function midiForStringFret(string: number, fret: number): number {
  return STANDARD_TUNING[string] + fret;
}
