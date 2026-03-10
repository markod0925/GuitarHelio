import { midiForStringFret } from './tuning';
import { getDifficultyPreset } from '../tab-converter/difficulty-presets';
import { midiFromArrayBuffer } from '../tab-converter/midi';
import { Tab } from '../tab-converter/tab';
import { Tuning } from '../tab-converter/theory';
import type { DifficultyProfile, SourceNote, TargetNote } from '../types/models';

type SceneDifficulty = 'Easy' | 'Medium' | 'Hard';

type TabTargetGeneratorOptions = {
  profile: DifficultyProfile;
  difficulty: SceneDifficulty;
  sourceNotes: SourceNote[];
  songName?: string;
};

type TabSourceMatch = {
  note: SourceNote;
  distanceTicks: number;
};

const FALLBACK_DURATION_QUARTER_DIVISOR = 2;

export function generateTargetNotesFromMidiTab(
  midiArrayBuffer: ArrayBuffer,
  options: TabTargetGeneratorOptions
): TargetNote[] {
  const midi = midiFromArrayBuffer(midiArrayBuffer);
  const allowedFrets = resolveAllowedFrets(options.profile);
  const mappedDifficulty = mapDifficulty(options.difficulty);
  const maxReachFret = Math.max(0, ...allowedFrets);
  const adaptiveSoftOptions = resolveAdaptiveSoftOptions(
    mappedDifficulty,
    options.profile.allowed_strings,
    allowedFrets,
    midi.ppq
  );

  const tab = new Tab(options.songName ?? 'song', new Tuning(), midi, {
    difficulty: mappedDifficulty,
    // Preserve original converter presets; only apply GH-selected fretboard constraints.
    ...adaptiveSoftOptions,
    fretboardConstraints: {
      allowedStrings: options.profile.allowed_strings,
      allowedFrets,
      maxReachFret
    }
  });

  const sourceByPitch = buildSourcePitchLookup(options.sourceNotes);
  const tabEvents = resolveFlatEvents(tab);
  const targets: TargetNote[] = [];

  for (let eventIndex = 0; eventIndex < tabEvents.length; eventIndex += 1) {
    const event = tabEvents[eventIndex];
    const chordId = `tab-chord-${eventIndex}-${event.time_ticks}`;
    const eventNotes = [...event.notes].sort((a, b) => a.string - b.string || a.fret - b.fret);
    const chordSize = eventNotes.length;

    for (let noteIndex = 0; noteIndex < eventNotes.length; noteIndex += 1) {
      const tabNote = eventNotes[noteIndex];
      const string = tabNote.string + 1;
      if (string < 1 || string > 6) continue;

      const fret = Math.max(0, Math.trunc(tabNote.fret));
      const expectedMidi = midiForStringFret(string, fret);
      const sourceMatch = findBestSourceMatch(
        sourceByPitch,
        expectedMidi,
        event.time_ticks,
        tab.softOptions.onsetMergeWindowTicks
      );
      const nextTick = tabEvents[eventIndex + 1]?.time_ticks;

      targets.push({
        id: `tab-target-${eventIndex}-${noteIndex}-${event.time_ticks}`,
        tick: event.time_ticks,
        duration_ticks: resolveDurationTicks(sourceMatch, nextTick, event.time_ticks, midi.ppq),
        string,
        fret,
        finger: resolveFingerForFret(fret, options.profile.allowed_fingers),
        expected_midi: expectedMidi,
        source_midi: sourceMatch?.note.midi_note,
        chord_id: chordId,
        chord_size: chordSize,
        chord_index: noteIndex
      });
    }
  }

  targets.sort(
    (a, b) =>
      a.tick - b.tick ||
      (a.chord_id ?? '').localeCompare(b.chord_id ?? '') ||
      (a.chord_index ?? 0) - (b.chord_index ?? 0) ||
      a.string - b.string ||
      a.fret - b.fret
  );
  return applyDensityReduction(targets, midi, mappedDifficulty, options.profile.allowed_strings, allowedFrets);
}

function mapDifficulty(difficulty: SceneDifficulty): 'easy' | 'medium' | 'hard' {
  if (difficulty === 'Easy') return 'easy';
  if (difficulty === 'Hard') return 'hard';
  return 'medium';
}

function applyDensityReduction(
  targets: TargetNote[],
  midi: ReturnType<typeof midiFromArrayBuffer>,
  difficulty: 'easy' | 'medium' | 'hard',
  allowedStrings: number[],
  allowedFrets: number[]
): TargetNote[] {
  if (targets.length <= 1) {
    return targets;
  }

  const restriction = computeConstraintRestriction(allowedStrings, allowedFrets);
  const minGapSeconds = resolveMinGapSeconds(difficulty, restriction);
  if (minGapSeconds <= 0) {
    return targets;
  }

  const groups = groupTargetsByChord(targets);
  if (groups.length <= 1) {
    return targets;
  }

  const kept: TargetNote[][] = [];
  let lastKeptTimeSeconds = Number.NEGATIVE_INFINITY;
  for (const group of groups) {
    const groupTimeSeconds = midi.ticksToSeconds(group[0].tick);
    if (kept.length === 0 || groupTimeSeconds - lastKeptTimeSeconds >= minGapSeconds) {
      kept.push(group);
      lastKeptTimeSeconds = groupTimeSeconds;
      continue;
    }

    // In dense clusters, keep the easier event (lower fret / fewer simultaneous notes).
    const previous = kept[kept.length - 1];
    if (computeGroupComplexity(group) + 0.2 < computeGroupComplexity(previous)) {
      kept[kept.length - 1] = group;
      lastKeptTimeSeconds = groupTimeSeconds;
    }
  }

  return kept.flat();
}

function groupTargetsByChord(targets: TargetNote[]): TargetNote[][] {
  const groups: TargetNote[][] = [];
  let current: TargetNote[] = [];
  let currentKey: string | null = null;

  for (const target of targets) {
    const key = target.chord_id ?? target.id;
    if (current.length === 0 || key === currentKey) {
      current.push(target);
      currentKey = key;
      continue;
    }
    groups.push(current);
    current = [target];
    currentKey = key;
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function computeConstraintRestriction(allowedStrings: number[], allowedFrets: number[]): number {
  const normalizedStringCount = normalizeAllowedCount(allowedStrings, 1, 6);
  const normalizedFretCount = normalizeAllowedCount(allowedFrets, 0, 24);
  const stringRestriction = clamp01((6 - normalizedStringCount) / 5);
  const fretRestriction = clamp01((12 - Math.min(12, normalizedFretCount)) / 12);
  return clamp01(stringRestriction * 0.7 + fretRestriction * 0.3);
}

function resolveMinGapSeconds(
  difficulty: 'easy' | 'medium' | 'hard',
  restriction: number
): number {
  if (difficulty === 'easy') {
    return 1.5 + 0.5 * restriction;
  }
  if (difficulty === 'medium') {
    return 0.5 + 0.2 * restriction;
  }
  return 0.2 + 0.1 * restriction;
}

function computeGroupComplexity(group: TargetNote[]): number {
  if (group.length === 0) return 0;
  let fretSum = 0;
  let minString = Number.POSITIVE_INFINITY;
  let maxString = Number.NEGATIVE_INFINITY;
  for (const note of group) {
    fretSum += note.fret;
    if (note.string < minString) minString = note.string;
    if (note.string > maxString) maxString = note.string;
  }

  const avgFret = fretSum / group.length;
  const stringSpread = Math.max(0, maxString - minString);
  return avgFret + group.length * 0.8 + stringSpread * 0.25;
}

function resolveAdaptiveSoftOptions(
  difficulty: 'easy' | 'medium' | 'hard',
  allowedStrings: number[],
  allowedFrets: number[],
  ppq: number
): { onsetMergeWindowTicks: number; maxNotesPerEvent: number } {
  const preset = getDifficultyPreset(difficulty);
  const normalizedStringCount = normalizeAllowedCount(allowedStrings, 1, 6);
  const restriction = computeConstraintRestriction(allowedStrings, allowedFrets);

  const onsetBaseTicks =
    difficulty === 'easy'
      ? Math.round(ppq / 4)
      : difficulty === 'medium'
        ? Math.round(ppq / 6)
        : Math.round(ppq / 10);
  const onsetBonusTicks =
    difficulty === 'easy'
      ? Math.round((ppq / 8) * restriction)
      : difficulty === 'medium'
        ? Math.round((ppq / 10) * restriction)
        : Math.round((ppq / 12) * restriction);

  return {
    onsetMergeWindowTicks: Math.max(
      preset.soft.onsetMergeWindowTicks,
      onsetBaseTicks + onsetBonusTicks
    ),
    // Never ask for more simultaneous notes than the selected playable strings.
    maxNotesPerEvent: Math.max(1, Math.min(preset.soft.maxNotesPerEvent, normalizedStringCount))
  };
}

function normalizeAllowedCount(values: number[], minValue: number, maxValue: number): number {
  const unique = new Set<number>();
  for (const value of values) {
    const normalized = Math.trunc(value);
    if (!Number.isFinite(normalized) || normalized < minValue || normalized > maxValue) {
      continue;
    }
    unique.add(normalized);
  }
  return Math.max(1, unique.size);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function resolveAllowedFrets(profile: DifficultyProfile): number[] {
  const fromList = profile.allowed_fret_list?.filter((fret) => Number.isInteger(fret));
  if (fromList && fromList.length > 0) {
    return [...new Set(fromList)].sort((a, b) => a - b);
  }

  const frets: number[] = [];
  for (let fret = profile.allowed_frets.min; fret <= profile.allowed_frets.max; fret += 1) {
    frets.push(fret);
  }
  return frets;
}

function buildSourcePitchLookup(sourceNotes: SourceNote[]): Map<number, SourceNote[]> {
  const byPitch = new Map<number, SourceNote[]>();
  for (const note of sourceNotes) {
    const bucket = byPitch.get(note.midi_note);
    if (bucket) {
      bucket.push(note);
    } else {
      byPitch.set(note.midi_note, [note]);
    }
  }

  for (const bucket of byPitch.values()) {
    bucket.sort((a, b) => a.tick_on - b.tick_on || a.track - b.track || a.channel - b.channel);
  }

  return byPitch;
}

function resolveFlatEvents(tab: Tab): Array<{ time_ticks: number; notes: Array<{ string: number; fret: number }> }> {
  const events: Array<{ time_ticks: number; notes: Array<{ string: number; fret: number }> }> = [];

  for (const measure of tab.tab.measures) {
    for (const event of measure.events) {
      if (!event.notes || event.notes.length === 0) continue;
      events.push({
        time_ticks: event.time_ticks,
        notes: event.notes.map((note) => ({ string: note.string, fret: note.fret }))
      });
    }
  }

  events.sort((a, b) => a.time_ticks - b.time_ticks);
  return events;
}

function findBestSourceMatch(
  sourceByPitch: Map<number, SourceNote[]>,
  expectedMidi: number,
  eventTick: number,
  onsetWindowTicks: number
): TabSourceMatch | null {
  const candidates = sourceByPitch.get(expectedMidi);
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const minTick = eventTick - Math.max(0, Math.floor(onsetWindowTicks));
  const maxTick = eventTick + Math.max(0, Math.floor(onsetWindowTicks));

  const startIndex = lowerBoundTickOn(candidates, minTick);
  let best: TabSourceMatch | null = null;
  for (let i = startIndex; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate.tick_on > maxTick) {
      break;
    }

    const candidateMatch: TabSourceMatch = {
      note: candidate,
      distanceTicks: Math.abs(candidate.tick_on - eventTick)
    };
    if (isBetterSourceMatch(candidateMatch, best)) {
      best = candidateMatch;
    }
  }

  return best;
}

function lowerBoundTickOn(notes: SourceNote[], tick: number): number {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (notes[mid].tick_on < tick) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function isBetterSourceMatch(candidate: TabSourceMatch, current: TabSourceMatch | null): boolean {
  if (!current) return true;
  if (candidate.distanceTicks !== current.distanceTicks) {
    return candidate.distanceTicks < current.distanceTicks;
  }

  const candidateIsDrum = candidate.note.channel === 9;
  const currentIsDrum = current.note.channel === 9;
  if (candidateIsDrum !== currentIsDrum) {
    return !candidateIsDrum;
  }

  if (candidate.note.track !== current.note.track) {
    return candidate.note.track < current.note.track;
  }

  return candidate.note.tick_off > current.note.tick_off;
}

function resolveDurationTicks(
  sourceMatch: TabSourceMatch | null,
  nextTick: number | undefined,
  eventTick: number,
  ppq: number
): number {
  if (sourceMatch) {
    return Math.max(1, sourceMatch.note.tick_off - sourceMatch.note.tick_on);
  }

  if (nextTick !== undefined && Number.isFinite(nextTick)) {
    return Math.max(1, Math.trunc(nextTick - eventTick));
  }

  return Math.max(1, Math.floor(ppq / FALLBACK_DURATION_QUARTER_DIVISOR));
}

function resolveFingerForFret(fret: number, allowedFingers: number[]): number {
  if (fret <= 0) return 0;

  const normalized = [...new Set(allowedFingers.filter((finger) => Number.isInteger(finger) && finger >= 1 && finger <= 4))]
    .sort((a, b) => a - b);
  const preferred = ((fret - 1) % 4) + 1;

  if (normalized.length === 0) {
    return preferred;
  }

  let best = normalized[0];
  let bestDistance = Math.abs(best - preferred);
  for (let i = 1; i < normalized.length; i += 1) {
    const candidate = normalized[i];
    const distance = Math.abs(candidate - preferred);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
