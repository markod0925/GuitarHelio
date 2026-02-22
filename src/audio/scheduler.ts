import { SCHEDULER_LOOKAHEAD_SECONDS, SCHEDULER_UPDATE_MS } from '../app/config';
import type { SourceNote } from '../types/models';
import { TempoMap } from '../midi/tempoMap';
import { SimpleSynth } from './synth';

export class AudioScheduler {
  private timer: number | null = null;
  private cursor = 0;
  private running = false;
  private transportStartAudioSeconds = 0;
  private transportStartSongSeconds = 0;
  private pausedSongSeconds = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly synth: SimpleSynth,
    private readonly notes: SourceNote[],
    private readonly tempoMap: TempoMap
  ) {}

  start(songPositionSeconds = 0): number {
    if (this.running) {
      this.pause();
    }

    const safeSongPosition = Math.max(0, songPositionSeconds);
    this.transportStartSongSeconds = safeSongPosition;
    this.pausedSongSeconds = safeSongPosition;
    this.transportStartAudioSeconds = this.ctx.currentTime + 0.04;
    this.cursor = this.findCursorAtOrAfter(safeSongPosition);

    this.running = true;
    this.ensureTimer();
    return safeSongPosition;
  }

  pause(): number {
    if (!this.running) return this.pausedSongSeconds;

    this.pausedSongSeconds = this.getSongPositionSeconds();
    this.running = false;
    this.clearTimer();
    this.synth.stopAll(this.ctx.currentTime);
    this.cursor = this.findCursorAtOrAfter(this.pausedSongSeconds);
    return this.pausedSongSeconds;
  }

  stop(): void {
    this.pause();
    this.pausedSongSeconds = 0;
    this.transportStartSongSeconds = 0;
    this.transportStartAudioSeconds = this.ctx.currentTime;
    this.cursor = 0;
  }

  getSongPositionSeconds(): number {
    if (!this.running) return this.pausedSongSeconds;
    return this.computeSongPosition(this.ctx.currentTime);
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), SCHEDULER_UPDATE_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.running) return;

    const nowAudio = this.ctx.currentTime;
    const nowSong = this.computeSongPosition(nowAudio);
    const horizonSong = nowSong + SCHEDULER_LOOKAHEAD_SECONDS;
    this.pausedSongSeconds = nowSong;

    while (this.cursor < this.notes.length) {
      const note = this.notes[this.cursor];
      const noteStartSong = this.tempoMap.tickToSeconds(note.tick_on);
      if (noteStartSong > horizonSong) break;

      const noteEndSong = this.tempoMap.tickToSeconds(note.tick_off);
      const noteStartAudio = this.songToAudioTime(noteStartSong);
      const noteEndAudio = this.songToAudioTime(noteEndSong);

      if (noteEndAudio >= nowAudio - 0.02) {
        this.synth.noteOn(note, noteStartAudio);
        this.synth.noteOff(note, noteEndAudio);
      }
      this.cursor += 1;
    }
  }

  private computeSongPosition(audioTime: number): number {
    return this.transportStartSongSeconds + Math.max(0, audioTime - this.transportStartAudioSeconds);
  }

  private songToAudioTime(songTime: number): number {
    return this.transportStartAudioSeconds + (songTime - this.transportStartSongSeconds);
  }

  private findCursorAtOrAfter(songSeconds: number): number {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const noteStart = this.tempoMap.tickToSeconds(this.notes[mid].tick_on);
      if (noteStart < songSeconds) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
