import * as JZZModule from 'jzz';
import TinyInstaller from 'jzz-synth-tiny';
import type { SourceNote } from '../types/models';
import type { MidiVoiceOutput } from './midiScrubPlayer';

type JzzOutPort = {
  noteOn: (channel: number, midi: number, velocity: number) => unknown;
  noteOff: (channel: number, midi: number, velocity?: number) => unknown;
  plug?: (destination: AudioNode) => unknown;
  allSoundOff?: (channel: number) => unknown;
  resetAllControllers?: (channel: number) => unknown;
  close?: () => unknown;
};

type JzzWithTiny = {
  synth?: {
    Tiny?: () => JzzOutPort;
  };
  lib?: {
    getAudioContext?: () => {
      state?: string;
      resume?: () => Promise<unknown> | unknown;
    } | null;
  };
};

let tinyInstalled = false;

export class JzzTinySynth implements MidiVoiceOutput {
  private readonly jzz: JzzWithTiny;
  private readonly out: JzzOutPort;
  private readonly timers = new Set<number>();
  private readonly activeNotes = new Map<string, { channel: number; midi: number }>();
  private disposed = false;

  constructor(private readonly clock: Pick<AudioContext, 'currentTime' | 'destination'>) {
    this.jzz = resolveJzz(JZZModule);
    this.out = this.createOutput();
    this.out.plug?.(this.clock.destination);
    this.resumeTinyAudioContext();
  }

  noteOn(note: SourceNote, when: number): void {
    if (this.disposed) return;
    this.schedule(when, () => {
      if (this.disposed) return;
      this.resumeTinyAudioContext();
      const channel = clampChannel(note.channel);
      this.out.noteOn(channel, note.midi_note, toMidiVelocity(note.velocity));
      this.activeNotes.set(noteKey(note), { channel, midi: note.midi_note });
    });
  }

  noteOff(note: SourceNote, when: number): void {
    if (this.disposed) return;
    this.schedule(when, () => {
      if (this.disposed) return;
      const key = noteKey(note);
      const active = this.activeNotes.get(key);
      if (!active) return;
      this.out.noteOff(active.channel, active.midi, 0);
      this.activeNotes.delete(key);
    });
  }

  stopAll(_when = this.clock.currentTime): void {
    if (this.disposed) return;
    this.clearTimers();
    for (const { channel, midi } of this.activeNotes.values()) {
      this.out.noteOff(channel, midi, 0);
    }
    this.activeNotes.clear();
    for (let channel = 0; channel < 16; channel += 1) {
      this.out.allSoundOff?.(channel);
      this.out.resetAllControllers?.(channel);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.out.close?.();
    this.disposed = true;
  }

  private schedule(when: number, callback: () => void): void {
    const delayMs = Math.max(0, Math.round((when - this.clock.currentTime) * 1000));
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
  }

  private createOutput(): JzzOutPort {
    installTiny(this.jzz);
    const out = this.jzz.synth?.Tiny?.();
    if (!out) {
      throw new Error('JZZ Tiny synth is not available');
    }
    return out;
  }

  private resumeTinyAudioContext(): void {
    const audioCtx = this.jzz.lib?.getAudioContext?.();
    if (!audioCtx || audioCtx.state !== 'suspended') return;
    void audioCtx.resume?.();
  }
}

function resolveJzz(moduleLike: unknown): JzzWithTiny {
  const moduleObj = moduleLike as Record<string, unknown>;
  const candidates = [moduleObj.default, moduleObj.JZZ, moduleLike];
  for (const candidate of candidates) {
    if (typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)) {
      return candidate as JzzWithTiny;
    }
  }
  throw new Error('Cannot resolve JZZ module export');
}

function installTiny(jzz: JzzWithTiny): void {
  if (tinyInstalled) return;
  const installer = (TinyInstaller as unknown as { Tiny?: (jzzArg: unknown) => void } & ((jzzArg: unknown) => void))
    .Tiny ??
    (TinyInstaller as unknown as (jzzArg: unknown) => void);
  if (typeof installer === 'function') {
    installer(jzz as unknown);
    tinyInstalled = true;
  }
}

function toMidiVelocity(velocity: number): number {
  const scaled = Math.round(Math.max(0.02, Math.min(1, velocity)) * 127);
  return Math.max(1, Math.min(127, scaled));
}

function clampChannel(channel: number): number {
  if (!Number.isFinite(channel)) return 0;
  return Math.max(0, Math.min(15, Math.floor(channel)));
}

function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}
