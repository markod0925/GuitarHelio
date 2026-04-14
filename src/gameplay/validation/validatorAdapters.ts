import type { PitchDetectorResult } from '../../pitch/types';
import type { PitchFrame, TargetNote } from '../../types/models';
import type {
  ValidationTarget,
  ValidatorFrameEvidence
} from './validatorTypes';

type DetectorCandidate = {
  midi: number;
  score: number;
  label: string | null;
  stringId: number | null;
  fret: number | null;
};

type CandidateAssignment = {
  targetIndex: number;
  candidateIndex: number;
  distanceSemitones: number;
};

const DEFAULT_DIFFICULTY: 'Easy' | 'Medium' | 'Hard' = 'Medium';

export function resolveDifficultySemitoneTolerance(difficulty: 'Easy' | 'Medium' | 'Hard' | undefined): number {
  if (difficulty === 'Easy') {
    return 3;
  }
  if (difficulty === 'Hard') {
    return 0.5;
  }
  return 1;
}

export function buildValidationTargetFromTargetGroup(
  targetGroup: TargetNote[] | undefined | null,
  difficulty: 'Easy' | 'Medium' | 'Hard' | undefined = DEFAULT_DIFFICULTY
): ValidationTarget | null {
  if (!targetGroup || targetGroup.length === 0) {
    return null;
  }

  const midiNotes = uniqueSortedNumbers(targetGroup.map((target) => target.expected_midi));
  const mode = midiNotes.length > 1 ? 'poly' : 'mono';
  return {
    mode,
    midiNotes,
    semitoneTolerance: resolveDifficultySemitoneTolerance(difficulty),
    minNoteRatio: 1,
    allowSuperset: mode === 'poly',
    metadata: {
      chordId: targetGroup[0].chord_id ?? null,
      targetIds: targetGroup.map((target) => target.id),
      difficulty: difficulty ?? DEFAULT_DIFFICULTY
    }
  };
}

export function buildValidatorFrameEvidenceFromPitchResult(
  result: PitchDetectorResult,
  timestampMs: number,
  target?: ValidationTarget | null
): ValidatorFrameEvidence {
  const candidates = collectDetectorCandidatesFromPitchResult(result);
  return buildValidatorFrameEvidenceFromCandidates({
    candidates,
    timestampMs,
    target,
    rawDetectedMidis: candidates.map((candidate) => candidate.midi)
  }, {
    detectorAccepted: result.accepted,
    detectorConfidence: result.confidence ?? 0,
    detectedMidi: result.midi ?? null,
    detectedString: finiteNumberOrNull(result.stringId),
    detectedFret: finiteNumberOrNull(result.fret),
    sharedEvidenceAvailability: [],
    sharedEvidenceLimitations: [],
    metadata: {
      detectorName: result.detectorName,
      rejectReason: result.rejectReason ?? null
    },
    evidenceSource: 'spectral_probe'
  });
}

export function buildValidatorFrameEvidenceFromPitchFrame(
  frame: PitchFrame,
  timestampMs: number,
  target?: ValidationTarget | null
): ValidatorFrameEvidence {
  const candidates = collectDetectorCandidatesFromPitchFrame(frame);
  const rawDetectedMidis = uniqueSortedNumbers([
    ...candidates.map((candidate) => candidate.midi),
    ...(Number.isFinite(frame.midi_estimate ?? Number.NaN) ? [frame.midi_estimate as number] : [])
  ]);
  return buildValidatorFrameEvidenceFromCandidates({
    candidates,
    timestampMs,
    target,
    rawDetectedMidis
  }, {
    detectorAccepted: frame.midi_estimate !== null || candidates.length > 0,
    detectorConfidence: frame.confidence ?? 0,
    detectedMidi: frame.midi_estimate ?? candidates[0]?.midi ?? null,
    detectedString: finiteNumberOrNull(frame.detected_string),
    detectedFret: finiteNumberOrNull(frame.detected_fret),
    sharedEvidenceAvailability: [],
    sharedEvidenceLimitations: ['live_pitch_frame'],
    metadata: {
      detectedString: frame.detected_string ?? null,
      detectedFret: frame.detected_fret ?? null,
      bestNoteId: frame.best_note_id ?? null
    },
    evidenceSource: 'masp_proxy'
  });
}

function buildValidatorFrameEvidenceFromCandidates(
  input: {
    candidates: DetectorCandidate[];
    timestampMs: number;
    target?: ValidationTarget | null;
    rawDetectedMidis: number[];
  },
  shared: {
    detectorAccepted: boolean;
    detectorConfidence: number;
    detectedMidi: number | null;
    detectedString: number | null;
    detectedFret: number | null;
    sharedEvidenceAvailability: string[];
    sharedEvidenceLimitations: string[];
    metadata: Record<string, unknown>;
    evidenceSource: 'masp_proxy' | 'spectral_probe';
  }
): ValidatorFrameEvidence {
  const target = input.target;
  if (!target || target.midiNotes.length === 0) {
    return {
      timestampMs: input.timestampMs,
      notes: [],
      rawDetectedMidis: input.rawDetectedMidis,
      rawDetectionMaxConfidence: shared.detectorConfidence,
      rawDetectionFrameRatio: shared.detectorAccepted ? 1 : 0,
      metadata: shared.metadata
    };
  }

  const assignments = matchCandidatesToTargets(target.midiNotes, input.candidates, target.semitoneTolerance);
  const notes = target.midiNotes.map((midi, targetIndex) => {
    const assignment = assignments.byTargetIndex.get(targetIndex) ?? null;
    const assignedCandidate = assignment !== null ? input.candidates[assignment.candidateIndex] : null;
    const bestCandidate = input.candidates[0] ?? null;
    const competitor = resolveBestCompetitorForTarget(input.candidates, assignment?.candidateIndex ?? null);
    const acceptedMidi = assignedCandidate?.midi ?? null;
    const detectedMidi = shared.detectedMidi ?? bestCandidate?.midi ?? null;
    const matchedDistance = acceptedMidi !== null ? acceptedMidi - midi : null;
    const rawDistance = detectedMidi !== null ? detectedMidi - midi : null;
    const acceptedScore = assignedCandidate?.score ?? 0;
    const bestCompetitorScore = competitor?.score ?? 0;
    const bestOctaveCandidate = resolveBestOctaveCompetitorForTarget(input.candidates, midi, assignment?.candidateIndex ?? null);
    const expectedRank = assignment !== null ? assignment.candidateIndex + 1 : null;
    const rawTop1 = bestCandidate?.midi ?? null;
    const top1CandidateAccepted = assignedCandidate !== null && rawTop1 !== null && assignedCandidate.midi === rawTop1;

    return {
      timestampMs: input.timestampMs,
      midi: Math.round(midi),
      detectedMidi,
      detectedString: shared.detectedString,
      detectedFret: shared.detectedFret,
      targetSemitoneTolerance: target.semitoneTolerance,
      matchedMidi: acceptedMidi,
      matchedSemitoneDistance: matchedDistance,
      detectorAccepted: shared.detectorAccepted,
      detectorConfidence: shared.detectorConfidence,
      expectedCentsError: matchedDistance !== null ? matchedDistance * 100 : rawDistance !== null ? rawDistance * 100 : null,
      expectedScore: acceptedScore,
      bestCompetitorScore,
      bestCompetitorMidi: competitor?.midi ?? null,
      bestOctaveScore: bestOctaveCandidate?.score ?? 0,
      neighborScore: bestCompetitorScore,
      samePitchAltScore: null,
      expectedRank,
      expectedTop1: assignment !== null ? top1CandidateAccepted : false,
      expectedTop3: assignment !== null ? assignment.candidateIndex < 3 : false,
      expectedPairwiseWinRate: null,
      octaveCompetitorOutranked: false,
      expectedVsSourceWon: assignment !== null ? true : null,
      positionAmbiguous: false,
      candidateScoreCount: input.candidates.length,
      sharedEvidenceAvailability: shared.sharedEvidenceAvailability,
      sharedEvidenceLimitations: shared.sharedEvidenceLimitations,
      evidenceSource: shared.evidenceSource,
      spectralProbe: null,
      samePitchAltDetected: false,
      expectedPositionMatch: true
    };
  });

  return {
    timestampMs: input.timestampMs,
    notes,
    rawDetectedMidis: input.rawDetectedMidis,
    rawDetectionMaxConfidence: shared.detectorConfidence,
    rawDetectionFrameRatio: shared.detectorAccepted ? 1 : 0,
    metadata: shared.metadata
  };
}

function matchCandidatesToTargets(
  targetMidis: number[],
  candidates: DetectorCandidate[],
  semitoneTolerance: number
): {
  byTargetIndex: Map<number, CandidateAssignment>;
  byCandidateIndex: Map<number, CandidateAssignment>;
} {
  const pairings: CandidateAssignment[] = [];
  const tolerance = Math.max(0, semitoneTolerance);

  for (let targetIndex = 0; targetIndex < targetMidis.length; targetIndex += 1) {
    const targetMidi = targetMidis[targetIndex];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const distanceSemitones = candidate.midi - targetMidi;
      if (Math.abs(distanceSemitones) > tolerance + 1e-9) continue;
      pairings.push({
        targetIndex,
        candidateIndex,
        distanceSemitones
      });
    }
  }

  pairings.sort((left, right) => {
    const leftCandidate = candidates[left.candidateIndex];
    const rightCandidate = candidates[right.candidateIndex];
    return (
      rightCandidate.score - leftCandidate.score ||
      Math.abs(left.distanceSemitones) - Math.abs(right.distanceSemitones) ||
      left.candidateIndex - right.candidateIndex ||
      left.targetIndex - right.targetIndex
    );
  });

  const byTargetIndex = new Map<number, CandidateAssignment>();
  const byCandidateIndex = new Map<number, CandidateAssignment>();

  for (const pairing of pairings) {
    if (byTargetIndex.has(pairing.targetIndex) || byCandidateIndex.has(pairing.candidateIndex)) {
      continue;
    }
    byTargetIndex.set(pairing.targetIndex, {
      ...pairing,
      distanceSemitones: pairing.distanceSemitones
    });
    byCandidateIndex.set(pairing.candidateIndex, {
      ...pairing,
      distanceSemitones: pairing.distanceSemitones
    });
  }

  return {
    byTargetIndex,
    byCandidateIndex
  };
}

function resolveBestCompetitorForTarget(
  candidates: DetectorCandidate[],
  assignedCandidateIndex: number | null
): DetectorCandidate | null {
  const competitorCandidates = candidates.filter((_, index) => index !== assignedCandidateIndex);
  return competitorCandidates[0] ?? null;
}

function resolveBestOctaveCompetitorForTarget(
  candidates: DetectorCandidate[],
  targetMidi: number,
  assignedCandidateIndex: number | null
): DetectorCandidate | null {
  const octaveCandidates = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index, candidate }) => index !== assignedCandidateIndex && Math.abs(Math.abs(candidate.midi - targetMidi) - 12) <= 0.5)
    .sort((left, right) => right.candidate.score - left.candidate.score || left.index - right.index);
  return octaveCandidates[0]?.candidate ?? null;
}

function collectDetectorCandidatesFromPitchResult(result: PitchDetectorResult): DetectorCandidate[] {
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  return candidates
    .map((candidate) => ({
      midi: candidate.midi,
      score: candidate.confidence ?? 0,
      label: candidate.label ?? null,
      stringId: finiteNumberOrNull((candidate as { stringId?: number }).stringId),
      fret: finiteNumberOrNull((candidate as { fret?: number }).fret)
    }))
    .filter((candidate): candidate is DetectorCandidate => Number.isFinite(candidate.midi))
    .sort((left, right) => right.score - left.score || left.midi - right.midi);
}

function collectDetectorCandidatesFromPitchFrame(frame: PitchFrame): DetectorCandidate[] {
  const selectedNotes = Array.isArray(frame.selected_notes) ? frame.selected_notes : [];
  const candidates: DetectorCandidate[] = selectedNotes
    .filter((note): note is NonNullable<typeof selectedNotes>[number] & { midi: number } => Number.isFinite(note.midi))
    .map((note) => ({
      midi: note.midi,
      score: note.score ?? frame.confidence ?? 0,
      label: note.note_id ?? null,
      stringId: finiteNumberOrNull(note.string),
      fret: finiteNumberOrNull(note.fret)
    }))
    .sort((left, right) => right.score - left.score || left.midi - right.midi);

  if (Number.isFinite(frame.midi_estimate ?? Number.NaN)) {
    const midi = frame.midi_estimate as number;
    if (!candidates.some((candidate) => candidate.midi === midi)) {
      candidates.unshift({
        midi,
        score: frame.confidence ?? 0,
        label: frame.best_note_id ?? null,
        stringId: finiteNumberOrNull(frame.detected_string),
        fret: finiteNumberOrNull(frame.detected_fret)
      });
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.midi - right.midi);
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.round(value)))].sort((left, right) => left - right);
}
