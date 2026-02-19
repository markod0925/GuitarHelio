import type { DifficultyProfile, SourceNote, TargetNote } from '../types/models';
import { TempoMap } from '../midi/tempoMap';
import { generatePlayablePositions, type PlayablePosition } from './fingeringMap';

type WeightedCandidate = PlayablePosition & { sourceMidi: number; tick: number; durationTicks: number };

export function generateTargetNotes(
  sourceNotes: SourceNote[],
  profile: DifficultyProfile,
  tempoMap: TempoMap
): TargetNote[] {
  const candidates = extractCandidates(sourceNotes, tempoMap);
  const densityFiltered = filterDensity(candidates, profile, tempoMap);

  return densityFiltered
    .map((candidate, i) => {
      const projected = projectToGuitar(candidate.midi_note, candidate.tick_on, candidate.tick_off - candidate.tick_on, profile);
      if (!projected) return null;
      return {
        id: `target-${i}-${candidate.tick_on}`,
        tick: projected.tick,
        duration_ticks: projected.durationTicks,
        string: projected.string,
        fret: projected.fret,
        finger: projected.finger,
        expected_midi: projected.midi,
        source_midi: projected.sourceMidi
      } satisfies TargetNote;
    })
    .filter((n): n is TargetNote => n !== null);
}

function extractCandidates(sourceNotes: SourceNote[], tempoMap: TempoMap, clusterMs = 45): SourceNote[] {
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

  return clusters.map((cluster) => cluster.reduce((best, n) => (n.midi_note > best.midi_note ? n : best)));
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
  profile: DifficultyProfile
): WeightedCandidate | null {
  const attempt = [sourceMidi, sourceMidi + 12, sourceMidi - 12]
    .flatMap((candidate) =>
      generatePlayablePositions(candidate, profile).map((position) => ({
        ...position,
        sourceMidi,
        tick,
        durationTicks
      }))
    )
    .sort((a, b) => cost(a) - cost(b));

  return attempt[0] ?? null;
}

function cost(pos: WeightedCandidate): number {
  const largeJumpPenalty = pos.fret > 7 ? 3 : 0;
  return pos.pitchDistance * 3 + pos.fret * 0.7 + largeJumpPenalty;
}
