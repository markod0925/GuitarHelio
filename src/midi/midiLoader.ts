import { Midi } from '@tonejs/midi';
import type { SourceNote } from '../types/models';
import { TempoMap } from './tempoMap';

export type LoadedMidi = {
  ticksPerQuarter: number;
  sourceNotes: SourceNote[];
  tempoMap: TempoMap;
};

export async function loadMidiFromUrl(url: string): Promise<LoadedMidi> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return loadMidiFromArrayBuffer(buffer);
}

export function loadMidiFromArrayBuffer(buffer: ArrayBuffer): LoadedMidi {
  const midi = new Midi(buffer);
  const ticksPerQuarter = midi.header.ppq;

  const tempoEvents = midi.header.tempos.map((t) => ({ tick: t.ticks, bpm: t.bpm }));
  const tempoMap = TempoMap.fromTempoEvents(ticksPerQuarter, tempoEvents);

  const sourceNotes: SourceNote[] = midi.tracks.flatMap((track, trackIdx) =>
    track.notes.map((note) => ({
      tick_on: note.ticks,
      tick_off: note.ticks + note.durationTicks,
      midi_note: note.midi,
      velocity: note.velocity,
      channel: track.channel ?? 0,
      track: trackIdx
    }))
  );

  sourceNotes.sort((a, b) => a.tick_on - b.tick_on || a.midi_note - b.midi_note);

  return { ticksPerQuarter, sourceNotes, tempoMap };
}
