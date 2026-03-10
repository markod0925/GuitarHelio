import { Midi } from '@tonejs/midi';
import type { MidiSong, MidiTrack, TempoEvent, TimeSignatureEvent } from "./types";

function safeTicksToSeconds(midi: InstanceType<typeof Midi>, ticks: number): number {
  const seconds = midi.header.ticksToSeconds(ticks);
  return Number.isFinite(seconds) ? seconds : 0;
}

export function midiFromArrayBuffer(arrayBuffer: ArrayBuffer): MidiSong {
  const midi = new Midi(arrayBuffer);

  const tracks: MidiTrack[] = midi.tracks.map((track) => {
    const channel = Number.isInteger(track.channel) ? track.channel : 0;
    const program = Number.isInteger(track.instrument.number) ? track.instrument.number : 0;
    return {
      name: track.name || undefined,
      channel,
      program,
      isDrum: track.instrument.percussion || channel === 9,
      notes: track.notes.map((note) => ({
        pitch: note.midi,
        velocity: Math.round(note.velocity * 127),
        startTicks: note.ticks,
        endTicks: note.ticks + note.durationTicks,
        startTime: note.time,
        endTime: note.time + note.duration,
      })),
    };
  });

  const tempos: TempoEvent[] = midi.header.tempos
    .map((tempo) => {
      const bpm = Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : 120;
      return {
        ticks: tempo.ticks,
        time: safeTicksToSeconds(midi, tempo.ticks),
        bpm,
        microsecondsPerQuarter: Math.round(60_000_000 / bpm),
      };
    })
    .sort((a, b) => a.ticks - b.ticks);

  const timeSignatures: TimeSignatureEvent[] = midi.header.timeSignatures
    .map((sig) => ({
      numerator: sig.timeSignature[0],
      denominator: sig.timeSignature[1],
      ticks: sig.ticks,
      time: safeTicksToSeconds(midi, sig.ticks),
    }))
    .sort((a, b) => a.ticks - b.ticks);

  const endTicks = Math.max(
    midi.durationTicks,
    ...tracks.flatMap((track) => track.notes.map((note) => note.endTicks)),
    0,
  );

  return {
    ppq: midi.header.ppq,
    tracks,
    tempos,
    timeSignatures,
    endTicks,
    ticksToSeconds: (ticks: number) => safeTicksToSeconds(midi, ticks),
  };
}
