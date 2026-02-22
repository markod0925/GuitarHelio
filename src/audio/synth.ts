import type { SourceNote } from '../types/models';

type Voice = {
  osc: OscillatorNode;
  gain: GainNode;
};

export class SimpleSynth {
  private active = new Map<string, Voice>();
  private readonly masterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;

  constructor(private readonly ctx: AudioContext) {
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.65;

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -20;
    this.limiter.knee.value = 24;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.24;

    this.masterGain.connect(this.limiter).connect(this.ctx.destination);
  }

  noteOn(note: SourceNote, when: number): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToHz(note.midi_note), when);
    const peakGain = Math.max(0.015, note.velocity * 0.05);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peakGain, when + 0.008);

    osc.connect(gain).connect(this.masterGain);
    osc.start(when);

    const key = noteKey(note);
    this.active.set(key, { osc, gain });
  }

  noteOff(note: SourceNote, when: number): void {
    const key = noteKey(note);
    const voice = this.active.get(key);
    if (!voice) return;
    const stopAt = Math.max(this.ctx.currentTime, when);
    voice.gain.gain.cancelScheduledValues(stopAt);
    voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), stopAt);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, stopAt + 0.02);
    voice.osc.stop(stopAt + 0.025);
    this.active.delete(key);
  }

  stopAll(when = this.ctx.currentTime): void {
    const stopAt = Math.max(this.ctx.currentTime, when);
    for (const [key, voice] of this.active.entries()) {
      voice.gain.gain.cancelScheduledValues(stopAt);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), stopAt);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, stopAt + 0.01);
      voice.osc.stop(stopAt + 0.015);
      this.active.delete(key);
    }
  }
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}
