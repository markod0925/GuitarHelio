import type { SourceNote } from '../types/models';

/**
 * Produces a unique string key for a SourceNote based on its
 * track, channel, MIDI pitch, and onset tick.
 *
 * Used by synth voice tracking and scrub-player active-note sets
 * where only onset identity matters.
 */
export function noteKey(note: SourceNote): string {
    return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}

/**
 * Extended key that also includes tick_off.
 *
 * Used by playback-note de-duplication where two notes sharing onset
 * but differing in duration are distinct entries.
 */
export function noteKeyFull(note: SourceNote): string {
    return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}:${note.tick_off}`;
}
