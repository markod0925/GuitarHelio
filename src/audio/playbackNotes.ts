import type { SourceNote } from '../types/models';

type PlaybackNotesOptions = {
  mutedChannels?: number[];
  minMidi?: number;
  maxMidi?: number;
  minDurationTicks?: number;
  maxNotesPerTick?: number;
  velocityCap?: number;
};

const DEFAULT_MUTED_CHANNELS = [9];
const DEFAULT_MIN_MIDI = 28;
const DEFAULT_MAX_MIDI = 96;
const DEFAULT_MAX_NOTES_PER_TICK = 8;
const DEFAULT_VELOCITY_CAP = 0.82;

export function buildPlaybackNotes(
  notes: SourceNote[],
  ticksPerQuarter: number,
  options: PlaybackNotesOptions = {}
): SourceNote[] {
  const mutedChannels = new Set(options.mutedChannels ?? DEFAULT_MUTED_CHANNELS);
  const minMidi = options.minMidi ?? DEFAULT_MIN_MIDI;
  const maxMidi = options.maxMidi ?? DEFAULT_MAX_MIDI;
  const minDurationTicks = options.minDurationTicks ?? Math.max(2, Math.floor(ticksPerQuarter / 48));
  const maxNotesPerTick = Math.max(1, options.maxNotesPerTick ?? DEFAULT_MAX_NOTES_PER_TICK);
  const velocityCap = Math.max(0.05, Math.min(1, options.velocityCap ?? DEFAULT_VELOCITY_CAP));

  const filtered = notes
    .filter((note) => !mutedChannels.has(note.channel))
    .filter((note) => note.midi_note >= minMidi && note.midi_note <= maxMidi)
    .filter((note) => note.tick_off - note.tick_on >= minDurationTicks)
    .map((note) => ({ ...note, velocity: Math.min(velocityCap, Math.max(0.02, note.velocity)) }))
    .sort((a, b) => a.tick_on - b.tick_on || a.midi_note - b.midi_note || a.channel - b.channel);

  const kept: SourceNote[] = [];
  let idx = 0;
  while (idx < filtered.length) {
    const tick = filtered[idx].tick_on;
    const group: SourceNote[] = [];
    while (idx < filtered.length && filtered[idx].tick_on === tick) {
      group.push(filtered[idx]);
      idx += 1;
    }
    for (const note of reduceTickGroup(group, maxNotesPerTick)) {
      kept.push(note);
    }
  }

  return kept;
}

function reduceTickGroup(group: SourceNote[], limit: number): SourceNote[] {
  if (group.length <= limit) return group;

  const selected = new Map<string, SourceNote>();
  const byPitch = [...group].sort((a, b) => a.midi_note - b.midi_note || b.velocity - a.velocity);

  selected.set(noteKey(byPitch[0]), byPitch[0]);
  selected.set(noteKey(byPitch[byPitch.length - 1]), byPitch[byPitch.length - 1]);

  const byVelocity = [...group].sort((a, b) => b.velocity - a.velocity || a.midi_note - b.midi_note);
  for (const note of byVelocity) {
    if (selected.size >= limit) break;
    selected.set(noteKey(note), note);
  }

  return [...selected.values()].sort((a, b) => a.midi_note - b.midi_note || a.channel - b.channel);
}

function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}:${note.tick_off}`;
}
