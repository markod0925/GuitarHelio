import { SCHEDULER_LOOKAHEAD_SECONDS, SCHEDULER_UPDATE_MS } from '../app/config';
import type { SourceNote } from '../types/models';
import { TempoMap } from '../midi/tempoMap';
import { SimpleSynth } from './synth';

export class AudioScheduler {
  private timer: number | null = null;
  private cursor = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly synth: SimpleSynth,
    private readonly notes: SourceNote[],
    private readonly tempoMap: TempoMap
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.cursor = 0;
    this.timer = window.setInterval(() => this.tick(), SCHEDULER_UPDATE_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = this.ctx.currentTime;
    const horizon = now + SCHEDULER_LOOKAHEAD_SECONDS;

    while (this.cursor < this.notes.length) {
      const note = this.notes[this.cursor];
      const startAt = this.tempoMap.tickToSeconds(note.tick_on);
      if (startAt > horizon) break;
      if (startAt >= now - 0.05) {
        this.synth.noteOn(note, startAt);
        this.synth.noteOff(note, this.tempoMap.tickToSeconds(note.tick_off));
      }
      this.cursor += 1;
    }
  }
}
