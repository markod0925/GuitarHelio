import type { SourceNote } from '../types/models';

type Voice = {
  osc: OscillatorNode;
  gain: GainNode;
};

type SynthOptions = {
  strict?: boolean;
};

export class SimpleSynth {
  private active = new Map<string, Voice>();
  private readonly strict: boolean;
  private readonly masterGain: GainNode;
  private readonly lowPass: BiquadFilterNode;
  private readonly highPass: BiquadFilterNode;
  private readonly limiter: DynamicsCompressorNode;

  constructor(private readonly ctx: AudioContext, options: SynthOptions = {}) {
    this.strict = options.strict ?? false;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.strict ? 0.42 : 0.65;

    this.lowPass = this.ctx.createBiquadFilter();
    this.lowPass.type = 'lowpass';
    this.lowPass.frequency.value = this.strict ? 5600 : 9000;
    this.lowPass.Q.value = 0.7;

    this.highPass = this.ctx.createBiquadFilter();
    this.highPass.type = 'highpass';
    this.highPass.frequency.value = this.strict ? 35 : 28;
    this.highPass.Q.value = 0.7;

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = this.strict ? -26 : -20;
    this.limiter.knee.value = this.strict ? 30 : 24;
    this.limiter.ratio.value = this.strict ? 14 : 10;
    this.limiter.attack.value = this.strict ? 0.008 : 0.003;
    this.limiter.release.value = this.strict ? 0.32 : 0.24;

    this.masterGain.connect(this.lowPass).connect(this.highPass).connect(this.limiter).connect(this.ctx.destination);
  }

  noteOn(note: SourceNote, when: number): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const startAt = this.resolveTime(when);

    osc.type = this.strict ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(midiToHz(note.midi_note), startAt);
    const attackSeconds = this.strict ? 0.016 : 0.008;
    const peakGain = Math.max(0.01, note.velocity * (this.strict ? 0.036 : 0.05));
    gain.gain.cancelScheduledValues(startAt);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(peakGain, startAt + attackSeconds);

    osc.connect(gain).connect(this.masterGain);
    osc.start(startAt);

    const key = noteKey(note);
    this.active.set(key, { osc, gain });
  }

  noteOff(note: SourceNote, when: number): void {
    const key = noteKey(note);
    const voice = this.active.get(key);
    if (!voice) return;
    const stopAt = this.resolveTime(when);
    const releaseSeconds = this.strict ? 0.07 : 0.02;
    releaseVoice(voice, stopAt, releaseSeconds);
    this.active.delete(key);
  }

  stopAll(when = this.ctx.currentTime): void {
    const stopAt = this.resolveTime(when);
    const releaseSeconds = this.strict ? 0.06 : 0.01;
    for (const [key, voice] of this.active.entries()) {
      releaseVoice(voice, stopAt, releaseSeconds);
      this.active.delete(key);
    }
  }

  private resolveTime(when: number): number {
    const leadSeconds = this.strict ? 0.004 : 0.0015;
    return Math.max(this.ctx.currentTime + leadSeconds, when);
  }
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}

function releaseVoice(voice: Voice, when: number, releaseSeconds: number): void {
  holdAudioParam(voice.gain.gain, when);
  voice.gain.gain.linearRampToValueAtTime(0, when + releaseSeconds);
  voice.osc.stop(when + releaseSeconds + 0.02);
  voice.osc.onended = () => {
    voice.osc.disconnect();
    voice.gain.disconnect();
  };
}

function holdAudioParam(param: AudioParam, when: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(when);
    return;
  }
  param.cancelScheduledValues(when);
  param.setValueAtTime(Math.max(0, param.value), when);
}
