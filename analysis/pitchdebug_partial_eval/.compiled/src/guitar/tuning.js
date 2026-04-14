export const STANDARD_TUNING = {
    1: 64,
    2: 59,
    3: 55,
    4: 50,
    5: 45,
    6: 40
};
export function midiForStringFret(string, fret) {
    return STANDARD_TUNING[string] + fret;
}
