export function resolveTargetChordId(target) {
    return target.chord_id ?? `tick-${target.tick}`;
}
export function resolveTargetGroupBounds(targets, startIndex) {
    const anchor = targets[startIndex];
    if (!anchor)
        return null;
    const chordId = resolveTargetChordId(anchor);
    let end = startIndex + 1;
    while (end < targets.length && areTargetsInSameGroup(anchor, chordId, targets[end])) {
        end += 1;
    }
    return { start: startIndex, end, chordId };
}
export function resolveTargetGroup(targets, startIndex) {
    const bounds = resolveTargetGroupBounds(targets, startIndex);
    if (!bounds)
        return [];
    return targets.slice(bounds.start, bounds.end);
}
export function resolveGroupRepresentativeString(targets, startIndex) {
    const group = resolveTargetGroup(targets, startIndex);
    if (group.length === 0)
        return 3;
    const sum = group.reduce((acc, target) => acc + target.string, 0);
    return Math.max(1, Math.min(6, Math.round(sum / group.length)));
}
function areTargetsInSameGroup(anchor, anchorChordId, candidate) {
    const candidateChordId = candidate.chord_id;
    if (anchor.chord_id !== undefined || candidateChordId !== undefined) {
        return candidateChordId !== undefined && candidateChordId === anchorChordId;
    }
    return candidate.tick === anchor.tick;
}
