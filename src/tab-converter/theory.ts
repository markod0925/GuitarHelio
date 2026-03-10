import type { TimeSignatureEvent, TimelineEventData } from "./types";

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

function noteNumberToName(pitch: number): string {
  const degree = NOTE_NAMES[((pitch % 12) + 12) % 12];
  const octave = Math.floor(pitch / 12) - 1;
  return `${degree}${octave}`;
}

function noteNameToNumber(name: string): number {
  const match = name.match(/^([A-G](?:#)?)(-?\d+)$/);
  if (!match) {
    throw new Error(`Invalid note name: ${name}`);
  }

  const [, degree, octaveText] = match;
  const semitone = NOTE_NAMES.indexOf(degree);
  if (semitone < 0) {
    throw new Error(`Invalid note degree: ${degree}`);
  }

  const octave = Number.parseInt(octaveText, 10);
  return (octave + 1) * 12 + semitone;
}

let nextNodeId = 0;

export class Note {
  readonly id: number;
  readonly pitch: number;
  readonly name: string;
  readonly degree: string;
  readonly octave: string;

  constructor(pitch: number) {
    this.id = nextNodeId++;
    this.pitch = pitch;
    this.name = noteNumberToName(pitch);
    this.degree = this.name.slice(0, -1);
    this.octave = this.name.slice(-1);
  }

  samePitchAs(other: Note): boolean {
    return this.pitch === other.pitch;
  }

  toString(): string {
    return this.name;
  }
}

export class Tuning {
  static readonly standardTuning = ["E4", "B3", "G3", "D3", "A2", "E2"];
  static readonly standardUkuleleTuning = ["A4", "E4", "C4", "G4"];

  readonly strings: Note[];
  readonly nstrings: number;
  nfrets: number;

  constructor(strings: string[] = Tuning.standardTuning) {
    this.strings = strings.map((noteName) => new Note(noteNameToNumber(noteName)));
    this.nstrings = strings.length;
    this.nfrets = 20;
  }

  getAllPossibleNotes(): Note[][] {
    return this.strings.map((string) => {
      const stringNotes: Note[] = [];
      for (let fret = 0; fret <= this.nfrets; fret++) {
        stringNotes.push(new Note(string.pitch + fret));
      }
      return stringNotes;
    });
  }

  getPitchBounds(): [number, number] {
    const pitches = this.strings.map((string) => string.pitch);
    return [Math.min(...pitches), Math.max(...pitches) + this.nfrets];
  }
}

export class Measure {
  readonly imeasure: number;
  readonly timeSignature: TimeSignatureEvent;
  readonly measureStart: number;
  readonly measureEnd: number;
  readonly timeline: Map<number, TimelineEventData>;

  constructor(
    imeasure: number,
    timeSignature: TimeSignatureEvent,
    measureStart: number,
    measureEnd: number,
    timeline: Map<number, TimelineEventData>,
  ) {
    this.imeasure = imeasure;
    this.timeSignature = timeSignature;
    this.measureStart = measureStart;
    this.measureEnd = measureEnd;
    this.timeline = timeline;
  }

  get durationTicks(): number {
    return this.measureEnd - this.measureStart;
  }
}
