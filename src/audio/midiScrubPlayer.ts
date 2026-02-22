import type { SourceNote } from '../types/models';

export type MidiVoiceOutput = {
  noteOn: (note: SourceNote, when: number) => void;
  noteOff: (note: SourceNote, when: number) => void;
  stopAll: (when?: number) => void;
};

export class MidiScrubPlayer {
  private readonly notesByStart: SourceNote[];
  private readonly notesByEnd: SourceNote[];
  private readonly activeNoteKeys = new Set<string>();
  private previousTick = 0;
  private paused = true;
  private initialized = false;

  constructor(
    private readonly output: MidiVoiceOutput,
    notes: SourceNote[],
    private readonly scrubThresholdTick: number
  ) {
    this.notesByStart = [...notes].sort((a, b) => a.tick_on - b.tick_on || a.tick_off - b.tick_off || a.midi_note - b.midi_note);
    this.notesByEnd = [...notes].sort((a, b) => a.tick_off - b.tick_off || a.tick_on - b.tick_on || a.midi_note - b.midi_note);
  }

  pause(atTick: number): void {
    this.paused = true;
    this.previousTick = Math.max(0, atTick);
    this.output.stopAll();
    this.activeNoteKeys.clear();
  }

  resume(atTick: number): void {
    const safeTick = Math.max(0, atTick);
    this.paused = false;
    this.rebuildVoicesAtTick(safeTick);
    this.previousTick = safeTick;
    this.initialized = true;
  }

  stop(): void {
    this.paused = true;
    this.initialized = false;
    this.previousTick = 0;
    this.output.stopAll();
    this.activeNoteKeys.clear();
  }

  updateToTick(tick: number, nowSeconds: number): void {
    if (this.paused) return;

    const safeTick = Math.max(0, tick);
    if (!this.initialized) {
      this.rebuildVoicesAtTick(safeTick, nowSeconds);
      this.previousTick = safeTick;
      this.initialized = true;
      return;
    }

    const deltaTick = safeTick - this.previousTick;
    if (Math.abs(deltaTick) < 0.001) return;

    if (Math.abs(deltaTick) > this.scrubThresholdTick) {
      this.rebuildVoicesAtTick(safeTick, nowSeconds);
      this.previousTick = safeTick;
      return;
    }

    if (deltaTick > 0) {
      this.applyIncrementalForward(this.previousTick, safeTick, nowSeconds);
    } else {
      this.applyIncrementalReverse(this.previousTick, safeTick, nowSeconds);
    }

    this.previousTick = safeTick;
  }

  private rebuildVoicesAtTick(tickNow: number, nowSeconds = 0): void {
    this.output.stopAll(nowSeconds);
    this.activeNoteKeys.clear();

    const activeEnd = upperBoundByStartTick(this.notesByStart, tickNow);
    for (let i = 0; i < activeEnd; i += 1) {
      const note = this.notesByStart[i];
      if (note.tick_off <= tickNow) continue;
      this.applyNoteOn(note, nowSeconds);
    }
  }

  private applyIncrementalForward(prevTick: number, nowTick: number, nowSeconds: number): void {
    const startFrom = upperBoundByStartTick(this.notesByStart, prevTick);
    const startTo = upperBoundByStartTick(this.notesByStart, nowTick);
    const endFrom = upperBoundByEndTick(this.notesByEnd, prevTick);
    const endTo = upperBoundByEndTick(this.notesByEnd, nowTick);

    for (let i = startFrom; i < startTo; i += 1) {
      this.applyNoteOn(this.notesByStart[i], nowSeconds);
    }
    for (let i = endFrom; i < endTo; i += 1) {
      this.applyNoteOff(this.notesByEnd[i], nowSeconds);
    }
  }

  private applyIncrementalReverse(prevTick: number, nowTick: number, nowSeconds: number): void {
    const endFrom = upperBoundByEndTick(this.notesByEnd, nowTick);
    const endTo = upperBoundByEndTick(this.notesByEnd, prevTick);
    const startFrom = upperBoundByStartTick(this.notesByStart, nowTick);
    const startTo = upperBoundByStartTick(this.notesByStart, prevTick);

    for (let i = endFrom; i < endTo; i += 1) {
      this.applyNoteOn(this.notesByEnd[i], nowSeconds);
    }
    for (let i = startFrom; i < startTo; i += 1) {
      this.applyNoteOff(this.notesByStart[i], nowSeconds);
    }
  }

  private applyNoteOn(note: SourceNote, whenSeconds: number): void {
    const key = noteKey(note);
    if (this.activeNoteKeys.has(key)) return;
    this.activeNoteKeys.add(key);
    this.output.noteOn(note, whenSeconds);
  }

  private applyNoteOff(note: SourceNote, whenSeconds: number): void {
    const key = noteKey(note);
    if (!this.activeNoteKeys.has(key)) return;
    this.activeNoteKeys.delete(key);
    this.output.noteOff(note, whenSeconds);
  }
}

function upperBoundByStartTick(notesByStart: SourceNote[], tick: number): number {
  let lo = 0;
  let hi = notesByStart.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (notesByStart[mid].tick_on <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundByEndTick(notesByEnd: SourceNote[], tick: number): number {
  let lo = 0;
  let hi = notesByEnd.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (notesByEnd[mid].tick_off <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}
