import { Note } from "./theory";
import type { MidiNoteEvent, MidiSong, MidiTrack, TimeSignatureEvent, TimelineEventData } from "./types";

export function measureLengthTicks(midi: MidiSong, timeSignature: TimeSignatureEvent): number {
  const nQuarterNotes = timeSignature.numerator * (4 / timeSignature.denominator);
  return nQuarterNotes * midi.ppq;
}

export function getNotesBetween(
  notes: MidiNoteEvent[],
  beginTicks: number,
  endTicks: number,
): MidiNoteEvent[] {
  return notes.filter((note) => note.startTicks >= beginTicks && note.startTicks < endTicks);
}

export function getNonDrum(instruments: MidiTrack[]): MidiTrack[] {
  return instruments.filter((instrument) => !instrument.isDrum);
}

export function fillMeasureStr(strArray: string[]): string[] {
  const maxLen = Math.max(...strArray.map((line) => line.length));
  return strArray.map((line) => line.padEnd(maxLen, "-"));
}

export function sortNotesByTick<T extends { startTime: number }>(notes: T[]): T[] {
  return [...notes].sort((a, b) => a.startTime - b.startTime);
}

export function roundToMultiple(n: number, base = 10): number {
  return Math.round(n / base) * base;
}

export function transposeNote(note: Note, semitones: number): Note {
  return new Note(note.pitch + semitones);
}

export function removeDuplicateNotes(notes: Note[]): Note[] {
  const seen = new Set<number>();
  const res: Note[] = [];
  for (const note of notes) {
    if (!seen.has(note.pitch)) {
      seen.add(note.pitch);
      res.push(note);
    }
  }
  return res;
}

export function sortNotesByPitch(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.pitch - b.pitch);
}

export function getEventsBetween(
  timeline: Map<number, TimelineEventData>,
  startTicks: number,
  endTicks: number,
): Map<number, TimelineEventData> {
  const entries = [...timeline.entries()]
    .filter(([tick]) => tick >= startTicks && tick < endTicks)
    .sort(([a], [b]) => a - b);
  return new Map(entries);
}
