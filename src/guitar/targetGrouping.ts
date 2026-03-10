import type { TargetNote } from '../types/models';

export type TargetGroupBounds = {
  start: number;
  end: number;
  chordId: string;
};

export function resolveTargetChordId(target: TargetNote): string {
  return target.chord_id ?? `tick-${target.tick}`;
}

export function resolveTargetGroupBounds(
  targets: TargetNote[],
  startIndex: number
): TargetGroupBounds | null {
  const anchor = targets[startIndex];
  if (!anchor) return null;

  const chordId = resolveTargetChordId(anchor);
  let end = startIndex + 1;
  while (end < targets.length && areTargetsInSameGroup(anchor, chordId, targets[end])) {
    end += 1;
  }

  return { start: startIndex, end, chordId };
}

export function resolveTargetGroup(targets: TargetNote[], startIndex: number): TargetNote[] {
  const bounds = resolveTargetGroupBounds(targets, startIndex);
  if (!bounds) return [];
  return targets.slice(bounds.start, bounds.end);
}

export function resolveGroupRepresentativeString(targets: TargetNote[], startIndex: number): number {
  const group = resolveTargetGroup(targets, startIndex);
  if (group.length === 0) return 3;

  const sum = group.reduce((acc, target) => acc + target.string, 0);
  return Math.max(1, Math.min(6, Math.round(sum / group.length)));
}

function areTargetsInSameGroup(anchor: TargetNote, anchorChordId: string, candidate: TargetNote): boolean {
  const candidateChordId = candidate.chord_id;
  if (anchor.chord_id !== undefined || candidateChordId !== undefined) {
    return candidateChordId !== undefined && candidateChordId === anchorChordId;
  }
  return candidate.tick === anchor.tick;
}
