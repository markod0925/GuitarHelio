import { findValidPaths } from "./graph-utils";
import { removeDuplicateNotes, transposeNote } from "./midi-utils";
import { Note, Tuning } from "./theory";
import type { FretboardConstraints } from "./types";

const DEFAULT_SCALE_LENGTH = 650;
const FRET_SCALE_DIVISOR = 17.817;
const DEFAULT_MAX_FRET_SPAN = 5;

export interface FretboardOptions extends Partial<FretboardConstraints> {}

function permutations<T>(input: T[]): T[][] {
  if (input.length <= 1) {
    return [input.slice()];
  }

  const result: T[][] = [];

  const recurse = (remaining: T[], built: T[]): void => {
    if (remaining.length === 0) {
      result.push(built.slice());
      return;
    }

    for (let i = 0; i < remaining.length; i++) {
      const next = remaining[i];
      const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
      built.push(next);
      recurse(rest, built);
      built.pop();
    }
  };

  recurse(input.slice(), []);
  return result;
}

function positionOf(positions: Map<Note, [number, number]>, note: Note): [number, number] {
  const position = positions.get(note);
  if (!position) {
    throw new Error("Missing note position");
  }
  return position;
}

export class Fretboard {
  readonly tuning: Tuning;
  readonly nstrings: number;
  readonly scaleLength: number;
  readonly positions: Map<Note, [number, number]>;
  readonly maxFretSpan: number;
  readonly maxReachFret: number;
  readonly hasExplicitPositionFilter: boolean;
  private readonly pitchIndex: Map<number, Note[]>;
  private readonly fingeringCache: Map<string, Note[][]>;
  private readonly allowedStringSet: Set<number> | null;
  private readonly allowedFretSet: Set<number> | null;

  constructor(tuning: Tuning, options: FretboardOptions = {}) {
    this.tuning = tuning;
    this.nstrings = tuning.nstrings;
    this.scaleLength = DEFAULT_SCALE_LENGTH;
    this.maxFretSpan = options.maxFretSpan ?? DEFAULT_MAX_FRET_SPAN;
    this.maxReachFret = options.maxReachFret ?? tuning.nfrets;
    this.allowedStringSet = this.normalizeAllowedStrings(options.allowedStrings);
    this.allowedFretSet = this.normalizeAllowedFrets(options.allowedFrets);
    this.hasExplicitPositionFilter =
      Array.isArray(options.allowedStrings) || Array.isArray(options.allowedFrets);
    this.positions = this.buildPositions();
    this.pitchIndex = this.buildPitchIndex();
    this.fingeringCache = new Map();
  }

  private normalizeAllowedStrings(values: number[] | undefined): Set<number> | null {
    if (!Array.isArray(values)) {
      return null;
    }

    const normalized = new Set<number>();
    for (const value of values) {
      const stringNumber = Math.trunc(value);
      if (!Number.isFinite(stringNumber) || stringNumber < 1 || stringNumber > this.nstrings) {
        throw new Error(
          `Invalid allowed string '${value}'. Expected integers in range 1..${this.nstrings}.`,
        );
      }
      normalized.add(stringNumber - 1);
    }

    return normalized;
  }

  private normalizeAllowedFrets(values: number[] | undefined): Set<number> | null {
    if (!Array.isArray(values)) {
      return null;
    }

    const normalized = new Set<number>();
    for (const value of values) {
      const fret = Math.trunc(value);
      if (!Number.isFinite(fret) || fret < 0 || fret > this.tuning.nfrets) {
        throw new Error(
          `Invalid allowed fret '${value}'. Expected integers in range 0..${this.tuning.nfrets}.`,
        );
      }
      normalized.add(fret);
    }

    return normalized;
  }

  private isPositionAllowed(position: [number, number]): boolean {
    const [string, fret] = position;
    if (fret > this.maxReachFret) {
      return false;
    }
    if (this.allowedStringSet && !this.allowedStringSet.has(string)) {
      return false;
    }
    if (this.allowedFretSet && !this.allowedFretSet.has(fret)) {
      return false;
    }
    return true;
  }

  hasPlayablePositionForPitch(pitch: number): boolean {
    const options = this.pitchIndex.get(pitch) ?? [];
    return options.some((option) => this.isPositionAllowed(positionOf(this.positions, option)));
  }

  private buildPositions(): Map<Note, [number, number]> {
    const noteMap = this.tuning.getAllPossibleNotes();
    const positions = new Map<Note, [number, number]>();

    for (let string = 0; string < noteMap.length; string++) {
      for (let fret = 0; fret < noteMap[string].length; fret++) {
        positions.set(noteMap[string][fret], [string, fret]);
      }
    }

    return positions;
  }

  private buildPitchIndex(): Map<number, Note[]> {
    const index = new Map<number, Note[]>();

    for (const note of this.positions.keys()) {
      const current = index.get(note.pitch) ?? [];
      current.push(note);
      index.set(note.pitch, current);
    }

    return index;
  }

  getNoteOptions(notes: Note[]): Note[][] {
    return notes
      .map((note) => this.getSpecificNoteOptions(note))
      .filter((options) => options.length > 0);
  }

  getSpecificNoteOptions(note: Note): Note[] {
    const options = this.pitchIndex.get(note.pitch) ?? [];
    return options.filter((option) => this.isPositionAllowed(positionOf(this.positions, option)));
  }

  getPossibleFingerings(noteOptions: Note[][]): Note[][] {
    if (noteOptions.length === 0) {
      return [];
    }

    const cacheKey = [...new Set(noteOptions.map((opts) => opts[0].pitch))]
      .sort((a, b) => a - b)
      .join(",");

    const cached = this.fingeringCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let fingerings: Note[][] = [];

    if (noteOptions.length === 1) {
      fingerings = noteOptions[0].map((note) => [note]);
    } else {
      const seen = new Set<string>();
      for (const noteOptionsPermutation of permutations(noteOptions)) {
        for (const path of findValidPaths(this.positions, noteOptionsPermutation, this.nstrings)) {
          const key = path
            .map((note) => note.id)
            .sort((a, b) => a - b)
            .join(",");

          if (!seen.has(key) && this.isFingeringPossible(path, noteOptionsPermutation)) {
            seen.add(key);
            fingerings.push(path);
          }
        }
      }
    }

    this.fingeringCache.set(cacheKey, fingerings);
    return fingerings;
  }

  fixOobNotes(notes: Note[], preserveHighestNote = false): Note[] {
    const stringPitches = this.tuning.strings.map((string) => string.pitch);
    let minPossiblePitch = Math.min(...stringPitches);
    let maxPossiblePitch = Math.max(...stringPitches) + this.maxReachFret;

    if (preserveHighestNote && notes.length > 0) {
      const highestPitchBefore = Math.max(...notes.map((note) => note.pitch));

      let highestPitchAfter: number;
      if (highestPitchBefore > maxPossiblePitch) {
        const above = Math.max(highestPitchBefore - maxPossiblePitch, 0);
        highestPitchAfter = highestPitchBefore - Math.ceil(above / 12) * 12;
      } else {
        const below = Math.max(minPossiblePitch - highestPitchBefore, 0);
        highestPitchAfter = highestPitchBefore + Math.ceil(below / 12) * 12;
      }

      maxPossiblePitch = highestPitchAfter;
    }

    const resNotes: Note[] = [];

    for (const note of notes) {
      let octavesToAdjust = 0;

      if (note.pitch > maxPossiblePitch) {
        const above = Math.max(note.pitch - maxPossiblePitch, 0);
        octavesToAdjust = -Math.ceil(above / 12);
      }

      if (note.pitch < minPossiblePitch) {
        const below = Math.max(minPossiblePitch - note.pitch, 0);
        octavesToAdjust = Math.ceil(below / 12);
      }

      const newNote = transposeNote(note, octavesToAdjust * 12);
      if (newNote.pitch >= minPossiblePitch && newNote.pitch <= maxPossiblePitch) {
        resNotes.push(newNote);
      }
    }

    return removeDuplicateNotes(resNotes);
  }

  distanceBetween(p1: [number, number], p2: [number, number]): number {
    return Math.hypot(p1[0] / this.nstrings - p2[0] / this.nstrings, p1[1] - p2[1]);
  }

  getFretDistance(nfret: number): number {
    let result = 0;
    let remainingScaleLength = this.scaleLength;

    for (let i = 0; i < nfret; i++) {
      const fretHeight = remainingScaleLength / FRET_SCALE_DIVISOR;
      result += fretHeight;
      remainingScaleLength -= fretHeight;
    }

    return result;
  }

  isFingeringPossible(fingering: Note[], noteArrays: Note[][]): boolean {
    const pluckedStrings = fingering.map((note) => positionOf(this.positions, note)[0]);
    const onePerString = pluckedStrings.length === new Set(pluckedStrings).size;

    const usedFrets = fingering
      .map((note) => positionOf(this.positions, note)[1])
      .filter((fret) => fret !== 0);

    const maxFretSpan =
      usedFrets.length > 0 ? Math.max(...usedFrets) - Math.min(...usedFrets) < this.maxFretSpan : true;

    const withinReach = fingering.every((note) =>
      this.isPositionAllowed(positionOf(this.positions, note)),
    );
    const rightLength = fingering.length <= noteArrays.length;
    return onePerString && maxFretSpan && withinReach && rightLength;
  }

  getFingeringCacheSize(): number {
    return this.fingeringCache.size;
  }
}
