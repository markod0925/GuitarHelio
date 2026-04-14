import type { PitchDetectorResult } from '../../pitch/types';
import type { PitchFrame, TargetNote } from '../../types/models';
import type {
  ValidationTarget,
  ValidatorFrameCandidateEvidence,
  ValidatorFrameEvidence
} from './validatorTypes';

export function buildValidationTargetFromTargetGroup(
  targetGroup: TargetNote[] | undefined | null
): ValidationTarget | null {
  if (!targetGroup || targetGroup.length === 0) {
    return null;
  }

  const midiNotes = uniqueSortedNumbers(targetGroup.map((target) => target.expected_midi));
  const mode = midiNotes.length > 1 ? 'poly' : 'mono';
  return {
    mode,
    midiNotes,
    minNoteRatio: 1,
    allowSuperset: mode === 'poly',
    metadata: {
      chordId: targetGroup[0].chord_id ?? null,
      targetIds: targetGroup.map((target) => target.id)
    }
  };
}

export function buildValidatorFrameEvidenceFromPitchResult(
  result: PitchDetectorResult,
  timestampMs: number,
  target?: ValidationTarget | null
): ValidatorFrameEvidence {
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const candidateByMidi = new Map<number, { confidence: number; label?: string }>();
  for (const candidate of candidates) {
    if (typeof candidate.midi !== 'number' || !Number.isFinite(candidate.midi)) continue;
    candidateByMidi.set(Math.round(candidate.midi), {
      confidence: candidate.confidence ?? 0,
      label: candidate.label
      });
  }

  const rawDetectedMidis = candidates
    .map((candidate) => candidate.midi)
    .filter((midi): midi is number => typeof midi === 'number' && Number.isFinite(midi))
    .map((midi) => Math.round(midi));

  if (!target || target.midiNotes.length === 0) {
    return {
      timestampMs,
      notes: [],
      rawDetectedMidis,
      rawDetectionMaxConfidence: result.confidence ?? null,
      rawDetectionFrameRatio: result.accepted ? 1 : 0,
      metadata: {
        detectorName: result.detectorName,
        rejectReason: result.rejectReason ?? null
      }
    };
  }

  const noteEvidences: ValidatorFrameCandidateEvidence[] = target.midiNotes.map((midi) => {
    const roundedMidi = Math.round(midi);
    const matched = candidateByMidi.get(roundedMidi);
    const bestCandidate = candidates[0];
    const competitor = candidates.find((candidate) => midiOf(candidate) !== roundedMidi) ?? null;
    const candidateIndex = candidates.findIndex((candidate) => midiOf(candidate) === roundedMidi);
    const debug = (result.debug ?? {}) as Record<string, unknown>;
    return {
      timestampMs,
      midi: roundedMidi,
      detectorAccepted: result.accepted,
      detectorConfidence: result.confidence ?? 0,
      detectedMidi: result.midi ?? null,
      detectedString: result.stringId ?? null,
      detectedFret: result.fret ?? null,
      expectedCentsError: result.cents ?? null,
      expectedScore: matched?.confidence ?? (bestCandidate?.confidence ?? result.confidence ?? 0),
      bestCompetitorScore: competitor?.confidence ?? 0,
      bestCompetitorMidi: competitor?.midi ?? null,
      bestOctaveScore: bestCandidate?.confidence ?? 0,
      neighborScore: competitor?.confidence ?? 0,
      samePitchAltScore: null,
      expectedRank: candidateIndex >= 0
        ? candidateIndex + 1
        : null,
      expectedTop1: midiOf(candidates[0]) === roundedMidi,
      expectedTop3: candidates.slice(0, 3).some((candidate) => midiOf(candidate) === roundedMidi),
      expectedPairwiseWinRate: null,
      octaveCompetitorOutranked: false,
      expectedVsSourceWon: matched ? true : null,
      positionAmbiguous: false,
      candidateScoreCount: candidates.length,
      sharedEvidenceAvailability: Array.isArray(debug.sharedEvidenceAvailability) ? debug.sharedEvidenceAvailability.filter((value): value is string => typeof value === 'string') : [],
      sharedEvidenceLimitations: Array.isArray(debug.sharedEvidenceLimitations) ? debug.sharedEvidenceLimitations.filter((value): value is string => typeof value === 'string') : [],
      evidenceSource: 'spectral_probe',
      spectralProbe: {
        probeVersion: 'spectral_probe_v1',
        expectedNoteId: matched?.label ?? `midi_${roundedMidi}`,
        candidateCount: candidates.length,
        availableCandidateScoreCount: candidates.length,
        topCandidates: candidates.slice(0, 5).map((candidate, candidateIndex) => ({
          noteId: candidate.label ?? `candidate_${candidateIndex}`,
          midi: midiOf(candidate),
          stringId: Number.isFinite((candidate as unknown as { stringId?: number }).stringId)
            ? ((candidate as unknown as { stringId?: number }).stringId as number)
            : 0,
          fret: Number.isFinite((candidate as unknown as { fret?: number }).fret)
            ? ((candidate as unknown as { fret?: number }).fret as number)
            : 0,
          rawScore: candidate.confidence ?? 0,
          relativeScore: null,
          rank: candidateIndex + 1,
          competitorClass: 'other'
        })),
        pairwise: [],
        expectedRank: null,
        expectedTop1: midiOf(candidates[0]) === roundedMidi,
        expectedTop3: candidates.slice(0, 3).some((candidate) => midiOf(candidate) === roundedMidi),
        expectedPairwiseWinRate: null,
        octaveCompetitorOutranked: false,
        expectedVsSourceWon: matched ? true : null,
        positionAmbiguous: false,
        missingEvidence: []
      },
      samePitchAltDetected: false,
      expectedPositionMatch: true
    };
  });

  return {
    timestampMs,
    notes: noteEvidences,
    rawDetectedMidis,
    rawDetectionMaxConfidence: result.confidence ?? null,
    rawDetectionFrameRatio: result.accepted ? 1 : 0,
    metadata: {
      detectorName: result.detectorName,
      rejectReason: result.rejectReason ?? null
    }
  };
}

export function buildValidatorFrameEvidenceFromPitchFrame(
  frame: PitchFrame,
  timestampMs: number,
  target?: ValidationTarget | null
): ValidatorFrameEvidence {
  const selectedNotes = Array.isArray(frame.selected_notes) ? frame.selected_notes : [];
  const candidateNotes = selectedNotes.filter((note): note is NonNullable<typeof selectedNotes>[number] & { midi: number } => Number.isFinite(note.midi));
  const rawDetectedMidis = uniqueSortedNumbers([
    ...(candidateNotes.map((note) => Math.round(note.midi))),
    ...(Number.isFinite(frame.midi_estimate ?? Number.NaN) ? [Math.round(frame.midi_estimate as number)] : [])
  ]);

  if (!target || target.midiNotes.length === 0) {
    return {
      timestampMs,
      notes: [],
      rawDetectedMidis,
      rawDetectionMaxConfidence: frame.confidence ?? null,
      rawDetectionFrameRatio: candidateNotes.length > 0 || frame.midi_estimate !== null ? 1 : 0,
      metadata: {
        detectedString: frame.detected_string ?? null,
        detectedFret: frame.detected_fret ?? null
      }
    };
  }

  const candidateByMidi = new Map<number, { score: number; label?: string }>();
  for (const note of candidateNotes) {
    candidateByMidi.set(Math.round(note.midi), {
      score: note.score ?? frame.confidence ?? 0,
      label: note.note_id ?? undefined
    });
  }

  const noteEvidences: ValidatorFrameCandidateEvidence[] = target.midiNotes.map((midi) => {
    const roundedMidi = Math.round(midi);
    const matched = candidateByMidi.get(roundedMidi);
    const bestCandidate = candidateNotes[0];
    const competitor = candidateNotes.find((candidate) => Math.round(candidate.midi) !== roundedMidi) ?? null;
    const candidateIndex = candidateNotes.findIndex((candidate) => Math.round(candidate.midi) === roundedMidi);
    const detectedMidi = frame.midi_estimate !== null && Number.isFinite(frame.midi_estimate) ? frame.midi_estimate : null;
    return {
      timestampMs,
      midi: roundedMidi,
      detectorAccepted: detectedMidi !== null || candidateNotes.length > 0,
      detectorConfidence: frame.confidence ?? 0,
      detectedMidi,
      detectedString: frame.detected_string ?? null,
      detectedFret: frame.detected_fret ?? null,
      expectedCentsError: detectedMidi !== null ? (detectedMidi - roundedMidi) * 100 : null,
      expectedScore: matched?.score ?? (bestCandidate?.score ?? frame.confidence ?? 0),
      bestCompetitorScore: competitor?.score ?? 0,
      bestCompetitorMidi: competitor?.midi ?? null,
      bestOctaveScore: bestCandidate?.score ?? 0,
      neighborScore: competitor?.score ?? 0,
      samePitchAltScore: null,
      expectedRank: candidateIndex >= 0 ? candidateIndex + 1 : null,
      expectedTop1: Math.round(candidateNotes[0]?.midi ?? Number.NaN) === roundedMidi,
      expectedTop3: candidateNotes.slice(0, 3).some((candidate) => Math.round(candidate.midi) === roundedMidi),
      expectedPairwiseWinRate: null,
      octaveCompetitorOutranked: false,
      expectedVsSourceWon: matched ? true : null,
      positionAmbiguous: false,
      candidateScoreCount: candidateNotes.length,
      sharedEvidenceAvailability: [],
      sharedEvidenceLimitations: ['live_pitch_frame'],
      evidenceSource: 'masp_proxy',
      spectralProbe: null,
      samePitchAltDetected: false,
      expectedPositionMatch: true
    };
  });

  return {
    timestampMs,
    notes: noteEvidences,
    rawDetectedMidis,
    rawDetectionMaxConfidence: frame.confidence ?? null,
    rawDetectionFrameRatio: candidateNotes.length > 0 || frame.midi_estimate !== null ? 1 : 0,
    metadata: {
      detectedString: frame.detected_string ?? null,
      detectedFret: frame.detected_fret ?? null,
      bestNoteId: frame.best_note_id ?? null
    }
  };
}

function midiOf(candidate: { midi?: number | null }): number {
  return typeof candidate.midi === 'number' && Number.isFinite(candidate.midi) ? Math.round(candidate.midi) : 0;
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.round(value)))].sort((left, right) => left - right);
}
