import { midiForStringFret } from '../guitar/tuning.js';
import { resolveTargetGroupBounds } from '../guitar/targetGrouping.js';
const DEFAULT_MAX_FRET = 12;
export function buildSpectralRuntimeModelFromTargets(targets) {
    if (targets.length === 0)
        return null;
    const noteByKey = new Map();
    for (const target of targets) {
        const key = noteKey(target.string, target.fret, target.expected_midi);
        if (noteByKey.has(key))
            continue;
        noteByKey.set(key, {
            id: `n_s${target.string}_f${target.fret}_m${target.expected_midi}`,
            string: target.string,
            fret: target.fret,
            midi: target.expected_midi,
            frequency_hz: midiToHz(target.expected_midi)
        });
    }
    const notes = [...noteByKey.values()].sort((a, b) => a.midi - b.midi || a.string - b.string || a.fret - b.fret || a.id.localeCompare(b.id));
    if (notes.length === 0)
        return null;
    const noteIdsByMidi = new Map();
    for (const note of notes) {
        const ids = noteIdsByMidi.get(note.midi);
        if (ids) {
            ids.push(note.id);
        }
        else {
            noteIdsByMidi.set(note.midi, [note.id]);
        }
    }
    const chords = dedupePatternChords(targets, noteIdsByMidi);
    return { notes, chords };
}
export function buildPracticeSpectralRuntimeModel(maxFret = DEFAULT_MAX_FRET) {
    const notes = [];
    const safeMaxFret = Math.max(0, Math.floor(maxFret));
    for (let string = 1; string <= 6; string += 1) {
        for (let fret = 0; fret <= safeMaxFret; fret += 1) {
            const midi = midiForStringFret(string, fret);
            notes.push({
                id: `n_s${string}_f${fret}_m${midi}`,
                string,
                fret,
                midi,
                frequency_hz: midiToHz(midi)
            });
        }
    }
    notes.sort((a, b) => a.midi - b.midi || a.string - b.string || a.fret - b.fret);
    return { notes, chords: [] };
}
function dedupePatternChords(targets, noteIdsByMidi) {
    const chords = [];
    const seenPatternKeys = new Set();
    for (let index = 0; index < targets.length;) {
        const bounds = resolveTargetGroupBounds(targets, index);
        if (!bounds) {
            break;
        }
        const group = targets.slice(bounds.start, bounds.end);
        const midiValues = uniqueSortedMidi(group.map((target) => target.expected_midi));
        if (midiValues.length === 0) {
            index = bounds.end;
            continue;
        }
        const patternKey = midiValues.join(',');
        if (seenPatternKeys.has(patternKey)) {
            index = bounds.end;
            continue;
        }
        seenPatternKeys.add(patternKey);
        const member_note_ids = [];
        for (const midi of midiValues) {
            const ids = noteIdsByMidi.get(midi);
            if (!ids || ids.length === 0)
                continue;
            member_note_ids.push(ids[0]);
        }
        if (member_note_ids.length > 0) {
            chords.push({
                id: `pattern_${patternKey.replaceAll(',', '_')}`,
                member_note_ids
            });
        }
        index = bounds.end;
    }
    return chords;
}
function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}
function noteKey(string, fret, midi) {
    return `${string}:${fret}:${midi}`;
}
function uniqueSortedMidi(values) {
    const deduped = new Set();
    for (const value of values) {
        if (!Number.isFinite(value))
            continue;
        deduped.add(Math.round(value));
    }
    return [...deduped].sort((a, b) => a - b);
}
