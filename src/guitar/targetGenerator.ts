import type { DifficultyProfile, SourceNote, TargetNote } from '../types/models';
import { TempoMap } from '../midi/tempoMap';
import { generatePlayablePositions, type PlayablePosition } from './fingeringMap';

type WeightedCandidate = PlayablePosition & { sourceMidi: number; tick: number; durationTicks: number };
type SelectionPolicy = 'highest' | 'lowest';

export type TargetGeneratorOptions = {
  clusterMs?: number;
  representativePolicy?: SelectionPolicy;
};

export function generateTargetNotes(
  sourceNotes: SourceNote[],
  profile: DifficultyProfile,
  tempoMap: TempoMap,
  options: TargetGeneratorOptions = {}
): TargetNote[] {
  const candidates = extractCandidates(
    sourceNotes,
    tempoMap,
    options.clusterMs ?? 45,
    options.representativePolicy ?? 'highest'
  );
  const densityFiltered = filterDensity(candidates, profile, tempoMap);
  const targets: TargetNote[] = [];
  let previousFret: number | null = null;
  let previousFinger: number | null = null;
  let previousBoxStart: number | null = null;
  for (const [i, candidate] of densityFiltered.entries()) {
    const projected = projectToGuitar(
      candidate.midi_note,
      candidate.tick_on,
      candidate.tick_off - candidate.tick_on,
      profile,
      previousFret,
      previousFinger,
      previousBoxStart
    );
    if (!projected) continue;
    targets.push({
      id: `target-${i}-${candidate.tick_on}`,
      tick: projected.tick,
      duration_ticks: projected.durationTicks,
      string: projected.string,
      fret: projected.fret,
      finger: projected.finger,
      expected_midi: projected.midi,
      source_midi: projected.sourceMidi
    });
    previousFret = projected.fret;
    previousFinger = projected.finger;
    previousBoxStart = projected.boxStart;
  }

  return targets;
}

function extractCandidates(
  sourceNotes: SourceNote[],
  tempoMap: TempoMap,
  clusterMs: number,
  representativePolicy: SelectionPolicy
): SourceNote[] {
  const sorted = [...sourceNotes].sort((a, b) => a.tick_on - b.tick_on || b.midi_note - a.midi_note);
  const clusters: SourceNote[][] = [];

  for (const note of sorted) {
    const noteS = tempoMap.tickToSeconds(note.tick_on);
    const current = clusters.at(-1);
    if (!current) {
      clusters.push([note]);
      continue;
    }
    const last = current[current.length - 1];
    const lastS = tempoMap.tickToSeconds(last.tick_on);
    if ((noteS - lastS) * 1000 <= clusterMs) {
      current.push(note);
    } else {
      clusters.push([note]);
    }
  }

  return clusters.map((cluster) =>
    representativePolicy === 'lowest'
      ? cluster.reduce((best, n) => (n.midi_note < best.midi_note ? n : best))
      : cluster.reduce((best, n) => (n.midi_note > best.midi_note ? n : best))
  );
}

function filterDensity(candidates: SourceNote[], profile: DifficultyProfile, tempoMap: TempoMap): SourceNote[] {
  const minGapSeconds = profile.avg_seconds_per_note ?? (profile.target_notes_per_minute ? 60 / profile.target_notes_per_minute : 0);
  if (minGapSeconds <= 0) return candidates;

  const out: SourceNote[] = [];
  let lastSecond = -Infinity;
  for (const c of candidates) {
    const sec = tempoMap.tickToSeconds(c.tick_on);
    if (sec - lastSecond >= minGapSeconds) {
      out.push(c);
      lastSecond = sec;
    }
  }
  return out;
}

function projectToGuitar(
  sourceMidi: number,
  tick: number,
  durationTicks: number,
  profile: DifficultyProfile,
  previousFret: number | null,
  previousFinger: number | null,
  previousBoxStart: number | null
): WeightedCandidate | null {
  const direct = buildCandidates(sourceMidi, sourceMidi, tick, durationTicks, profile);
  if (direct.length > 0) {
    return direct.sort(
      (a, b) =>
        cost(a, previousFret, previousFinger, previousBoxStart, profile) -
        cost(b, previousFret, previousFinger, previousBoxStart, profile)
    )[0];
  }

  const upOctave = buildCandidates(sourceMidi + 12, sourceMidi, tick, durationTicks, profile);
  if (upOctave.length > 0) {
    return upOctave.sort(
      (a, b) =>
        cost(a, previousFret, previousFinger, previousBoxStart, profile) -
        cost(b, previousFret, previousFinger, previousBoxStart, profile)
    )[0];
  }

  const downOctave = buildCandidates(sourceMidi - 12, sourceMidi, tick, durationTicks, profile);
  if (downOctave.length > 0) {
    return downOctave.sort(
      (a, b) =>
        cost(a, previousFret, previousFinger, previousBoxStart, profile) -
        cost(b, previousFret, previousFinger, previousBoxStart, profile)
    )[0];
  }

  return null;
}

function buildCandidates(
  playableMidi: number,
  sourceMidi: number,
  tick: number,
  durationTicks: number,
  profile: DifficultyProfile
): WeightedCandidate[] {
  return generatePlayablePositions(playableMidi, profile).map((position) => ({
    ...position,
    sourceMidi,
    tick,
    durationTicks
  }));
}

function cost(
  pos: WeightedCandidate,
  previousFret: number | null,
  previousFinger: number | null,
  previousBoxStart: number | null,
  profile: DifficultyProfile
): number {
  const fretJump = previousFret === null ? 0 : Math.abs(pos.fret - previousFret);
  const largeJumpPenalty = fretJump > 4 ? (fretJump - 4) * 1.5 : 0;
  const openStringBonus = profile.prefer_open_strings && pos.fret === 0 ? -0.6 : 0;

  const boxShift = previousBoxStart === null || pos.boxStart === 0 ? 0 : Math.abs(pos.boxStart - previousBoxStart);
  const boxShiftPenalty = boxShift * 0.9;

  const sameFingerDifferentFretPenalty =
    previousFinger !== null && previousFinger === pos.finger && previousFret !== null && previousFret !== pos.fret && pos.finger !== 0
      ? 3.5
      : 0;

  const pinkyPreparedBonus = pos.finger === 4 ? -0.25 : 0;

  return (
    pos.pitchDistance * 3 +
    pos.fret * 0.7 +
    largeJumpPenalty +
    boxShiftPenalty +
    sameFingerDifferentFretPenalty +
    openStringBonus +
    pinkyPreparedBonus
  );
}
