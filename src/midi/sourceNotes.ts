import type { SourceNote } from '../types/models';

export function sanitizeSourceNotes(notes: SourceNote[]): SourceNote[] {
  return notes
    .filter((n) => n.tick_off > n.tick_on)
    .map((n) => ({ ...n, velocity: Math.min(1, Math.max(0, n.velocity)) }))
    .sort((a, b) => a.tick_on - b.tick_on || a.midi_note - b.midi_note);
}
