import type { SourceNote } from '../types/models';

export class SimpleSynth {
  private active = new Map<string, OscillatorNode>();

  constructor(private readonly ctx: AudioContext) {}

  noteOn(note: SourceNote, when: number): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToHz(note.midi_note), when);
    gain.gain.setValueAtTime(Math.max(0.05, note.velocity * 0.2), when);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(when);

    const key = noteKey(note);
    this.active.set(key, osc);
  }

  noteOff(note: SourceNote, when: number): void {
    const key = noteKey(note);
    const osc = this.active.get(key);
    if (!osc) return;
    osc.stop(when);
    this.active.delete(key);
  }
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}
