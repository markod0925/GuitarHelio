import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ACTIVATION_GATE_POLICY,
  MONO_ACTIVATION_GATE_POLICY,
  MONO_NOTE_SET_POLICY,
  RealtimeGameplayValidator,
  buildValidatorFrameEvidenceFromPitchFrame,
  buildValidatorFrameEvidenceFromPitchResult,
  type RuntimeValidatorInput,
  type ValidatorFrameCandidateEvidence,
  type ValidatorFrameEvidence,
  type ValidationTarget
} from '../src/gameplay/validation';
import type { PitchFrame } from '../src/types/models';

function noteFrame(midi: number, timestampMs: number, overrides: Partial<ValidatorFrameCandidateEvidence> = {}): ValidatorFrameCandidateEvidence {
  return {
    timestampMs,
    midi,
    targetSemitoneTolerance: overrides.targetSemitoneTolerance ?? 1,
    matchedMidi: overrides.matchedMidi ?? midi,
    matchedSemitoneDistance: overrides.matchedSemitoneDistance ?? 0,
    detectorAccepted: overrides.detectorAccepted ?? true,
    detectorConfidence: overrides.detectorConfidence ?? 0.95,
    detectedMidi: overrides.detectedMidi ?? midi,
    detectedString: overrides.detectedString ?? 1,
    detectedFret: overrides.detectedFret ?? 0,
    expectedCentsError: overrides.expectedCentsError ?? 0,
    expectedScore: overrides.expectedScore ?? 100,
    bestCompetitorScore: overrides.bestCompetitorScore ?? 10,
    bestCompetitorMidi: overrides.bestCompetitorMidi ?? midi + 1,
    bestOctaveScore: overrides.bestOctaveScore ?? 5,
    neighborScore: overrides.neighborScore ?? 8,
    samePitchAltScore: overrides.samePitchAltScore ?? null,
    expectedRank: overrides.expectedRank ?? 1,
    expectedTop1: overrides.expectedTop1 ?? true,
    expectedTop3: overrides.expectedTop3 ?? true,
    expectedPairwiseWinRate: overrides.expectedPairwiseWinRate ?? 1,
    octaveCompetitorOutranked: overrides.octaveCompetitorOutranked ?? false,
    expectedVsSourceWon: overrides.expectedVsSourceWon ?? true,
    positionAmbiguous: overrides.positionAmbiguous ?? false,
    candidateScoreCount: overrides.candidateScoreCount ?? 3,
    sharedEvidenceAvailability: overrides.sharedEvidenceAvailability ?? [],
    sharedEvidenceLimitations: overrides.sharedEvidenceLimitations ?? [],
    evidenceSource: overrides.evidenceSource ?? 'spectral_probe',
    spectralProbe: overrides.spectralProbe ?? null,
    samePitchAltDetected: overrides.samePitchAltDetected ?? false,
    expectedPositionMatch: overrides.expectedPositionMatch ?? true
  };
}

function frameEvidence(timestampMs: number, notes: Array<ValidatorFrameCandidateEvidence>, rawDetectedMidis?: number[]): ValidatorFrameEvidence {
  const realizedNotes = notes.map((note) => ({
    ...note,
    timestampMs
  }));
  return {
    timestampMs,
    notes: realizedNotes,
    rawDetectedMidis: rawDetectedMidis ?? realizedNotes.map((note) => note.midi).filter((value): value is number => value !== null),
    rawDetectionMaxConfidence: realizedNotes.length > 0 ? Math.max(...realizedNotes.map((note) => note.detectorConfidence)) : null,
    rawDetectionFrameRatio: realizedNotes.length > 0 ? 1 : 0,
    metadata: {}
  };
}

function monoTarget(midi: number): ValidationTarget {
  return {
    mode: 'mono',
    midiNotes: [midi],
    semitoneTolerance: 1
  };
}

function polyTarget(midis: number[], overrides: Partial<ValidationTarget> = {}): ValidationTarget {
  return {
    mode: 'poly',
    midiNotes: midis,
    semitoneTolerance: overrides.semitoneTolerance ?? 1,
    ...overrides
  };
}

function runFrames(validator: RealtimeGameplayValidator, target: ValidationTarget, frames: RuntimeValidatorInput[]): ReturnType<RealtimeGameplayValidator['update']> {
  validator.setTarget(target);
  let output = validator.update(frames[0]);
  for (let index = 1; index < frames.length; index += 1) {
    output = validator.update(frames[index]);
  }
  return output;
}

describe('RealtimeGameplayValidator', () => {
  test('accepts a mono target after several good frames', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0)]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16)]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32)]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(true);
    expect(output.acceptedPreGate).toBe(true);
    expect(output.acceptedPostGate).toBe(true);
    expect(output.targetMode).toBe('mono');
    expect(output.validatedNotes).toEqual([60]);
    expect(output.matchedNotes).toEqual([60]);
    expect(output.missingNotes).toEqual([]);
    expect(output.rejectStage).toBe('none');
  });

  test('accepts a mono target when the matched note stays within easy tolerance', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    target.semitoneTolerance = 3;
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0, { detectedMidi: 63, matchedMidi: 63, expectedCentsError: 300, matchedSemitoneDistance: 3 })]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16, { detectedMidi: 63, matchedMidi: 63, expectedCentsError: 300, matchedSemitoneDistance: 3 })]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32, { detectedMidi: 63, matchedMidi: 63, expectedCentsError: 300, matchedSemitoneDistance: 3 })]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(true);
    expect(output.validatedNotes).toEqual([60]);
    expect(output.matchedNotes).toEqual([63]);
    expect(validator.getState().noteDecisions[0]?.evidence.matchedMidi).toBe(63);
  });

  test('rejects a mono target when the matched note falls outside medium tolerance', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    target.semitoneTolerance = 1;
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0, { detectedMidi: 62, matchedMidi: 62, expectedCentsError: 200, matchedSemitoneDistance: 2, expectedScore: 100, bestCompetitorScore: 20 })]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16, { detectedMidi: 62, matchedMidi: 62, expectedCentsError: 200, matchedSemitoneDistance: 2, expectedScore: 100, bestCompetitorScore: 20 })]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32, { detectedMidi: 62, matchedMidi: 62, expectedCentsError: 200, matchedSemitoneDistance: 2, expectedScore: 100, bestCompetitorScore: 20 })]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(false);
    expect(output.rejectStage).toBe('note_level');
    expect(output.missingNotes).toEqual([60]);
  });

  test('accepts a mono target with hard tolerance at half a semitone', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    target.semitoneTolerance = 0.5;
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0, { detectedMidi: 60.4, matchedMidi: 60.4, expectedCentsError: 40, matchedSemitoneDistance: 0.4 })]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16, { detectedMidi: 60.4, matchedMidi: 60.4, expectedCentsError: 40, matchedSemitoneDistance: 0.4 })]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32, { detectedMidi: 60.4, matchedMidi: 60.4, expectedCentsError: 40, matchedSemitoneDistance: 0.4 })]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(true);
    expect(output.matchedNotes).toEqual([60]);
  });

  test('rejects a mono target with hard tolerance when pitch exceeds half a semitone', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    target.semitoneTolerance = 0.5;
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0, { detectedMidi: 60.6, matchedMidi: 60.6, expectedCentsError: 60, matchedSemitoneDistance: 0.6, expectedScore: 100, bestCompetitorScore: 20 })]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16, { detectedMidi: 60.6, matchedMidi: 60.6, expectedCentsError: 60, matchedSemitoneDistance: 0.6, expectedScore: 100, bestCompetitorScore: 20 })]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32, { detectedMidi: 60.6, matchedMidi: 60.6, expectedCentsError: 60, matchedSemitoneDistance: 0.6, expectedScore: 100, bestCompetitorScore: 20 })]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(false);
    expect(output.rejectStage).toBe('note_level');
  });

  test('rejects a mono target when the competitor wins', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0, { expectedScore: 10, bestCompetitorScore: 40, expectedTop1: false })]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16, { expectedScore: 8, bestCompetitorScore: 55, expectedTop1: false })]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32, { expectedScore: 9, bestCompetitorScore: 50, expectedTop1: false })]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(false);
    expect(output.rejectStage).toBe('note_level');
    expect(output.rejectReasons.some((reason) => reason.startsWith('note:60:'))).toBe(true);
    expect(output.validatedNotes).toEqual([]);
  });

  test('accepts a poly target when enough notes validate', () => {
    const validator = new RealtimeGameplayValidator();
    const target = polyTarget([60, 64], { minNoteRatio: 1 });
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0), noteFrame(64, 0)]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16), noteFrame(64, 16)]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32), noteFrame(64, 32)]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(true);
    expect(output.targetMode).toBe('poly');
    expect(output.validatedNotes).toEqual([60, 64]);
    expect(output.noteValidationRatio).toBe(1);
  });

  test('accepts a poly target when one note shifts within easy tolerance', () => {
    const validator = new RealtimeGameplayValidator();
    const target = polyTarget([60, 64], { minNoteRatio: 1, semitoneTolerance: 3 });
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0, { detectedMidi: 62, matchedMidi: 62, expectedCentsError: 200, matchedSemitoneDistance: 2 }), noteFrame(64, 0)]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16, { detectedMidi: 62, matchedMidi: 62, expectedCentsError: 200, matchedSemitoneDistance: 2 }), noteFrame(64, 16)]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32, { detectedMidi: 62, matchedMidi: 62, expectedCentsError: 200, matchedSemitoneDistance: 2 }), noteFrame(64, 32)]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(true);
    expect(output.validatedNotes).toEqual([60, 64]);
    expect(output.matchedNotes).toEqual([62, 64]);
  });

  test('does not let one detected note satisfy two expected notes', () => {
    const validator = new RealtimeGameplayValidator();
    const target = polyTarget([60, 61], { minNoteRatio: 1, semitoneTolerance: 3 });
    const frame: PitchFrame = {
      t_seconds: 0.096,
      midi_estimate: 60.5,
      confidence: 1,
      selected_notes: [
        { midi: 60.5, score: 100, note_id: 'candidate-60_5' }
      ],
      chord_scores: []
    };
    const targetEvidence = buildValidatorFrameEvidenceFromPitchFrame(frame, 0, target);

    validator.setTarget(target);
    validator.update({ timestampMs: 0, frameEvidence: targetEvidence, target });
    const output = validator.update({ timestampMs: 16, frameEvidence: targetEvidence, target });

    expect(output.accepted).toBe(false);
    expect(output.validatedNotes.length).toBe(1);
    expect(output.missingNotes.length).toBe(1);
  });

  test('rejects a poly target when one note stays below threshold', () => {
    const validator = new RealtimeGameplayValidator();
    const target = polyTarget([60, 64], { minNoteRatio: 1 });
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0), noteFrame(64, 0, { expectedScore: 8, bestCompetitorScore: 50 })]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16), noteFrame(64, 16, { expectedScore: 7, bestCompetitorScore: 60 })]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32), noteFrame(64, 32, { expectedScore: 6, bestCompetitorScore: 70 })]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(false);
    expect(output.rejectStage).toBe('note_level');
    expect(output.missingNotes).toEqual([64]);
  });

  test('clears mono history when switching to poly', () => {
    const validator = new RealtimeGameplayValidator();
    const mono = monoTarget(60);
    validator.setTarget(mono);
    validator.update({ timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0)]), target: mono });
    validator.update({ timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16)]), target: mono });
    expect(validator.getState().lastOutput?.accepted).toBe(true);

    const poly = polyTarget([64, 67], { minNoteRatio: 1 });
    validator.setTarget(poly);
    expect(validator.getState().noteDecisions).toHaveLength(0);

    const output = validator.update({
      timestampMs: 32,
      frameEvidence: frameEvidence(32, [noteFrame(64, 32)]),
      target: poly
    });

    expect(output.accepted).toBe(false);
    expect(output.validatedNotes).toEqual([64]);
    expect(validator.getState().targetRevision).toBe(2);
  });

  test('clears poly history when switching to mono', () => {
    const validator = new RealtimeGameplayValidator();
    const poly = polyTarget([60, 64], { minNoteRatio: 1 });
    validator.setTarget(poly);
    validator.update({ timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0), noteFrame(64, 0)]), target: poly });
    validator.update({ timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16), noteFrame(64, 16)]), target: poly });
    expect(validator.getState().lastOutput?.accepted).toBe(true);

    const mono = monoTarget(67);
    validator.setTarget(mono);
    expect(validator.getState().noteDecisions).toHaveLength(0);

    const output = validator.update({
      timestampMs: 32,
      frameEvidence: frameEvidence(32, [noteFrame(60, 32)]),
      target: mono
    });

    expect(output.accepted).toBe(false);
    expect(output.targetMode).toBe('mono');
    expect(validator.getState().targetRevision).toBe(2);
  });

  test('suppresses activation through the runtime gate', () => {
    const validator = new RealtimeGameplayValidator({
      polyGatePolicy: {
        ...DEFAULT_ACTIVATION_GATE_POLICY,
        stableAllowSupersetIfExpectedCovered: false
      }
    });
    const target = polyTarget([60, 64], { minNoteRatio: 1, allowSuperset: true });
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0), noteFrame(64, 0)], [60, 64, 67]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16), noteFrame(64, 16)], [60, 64, 67]), target },
      { timestampMs: 32, frameEvidence: frameEvidence(32, [noteFrame(60, 32), noteFrame(64, 32)], [60, 64, 67]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.acceptedPreGate).toBe(true);
    expect(output.acceptedPostGate).toBe(false);
    expect(output.rejectStage).toBe('gate');
    expect(output.gateRejectReason).toBe('stable_superset_not_allowed');
  });

  test('keeps mono gate off by default', () => {
    const validator = new RealtimeGameplayValidator();
    const target = monoTarget(60);
    const frames: RuntimeValidatorInput[] = [
      { timestampMs: 0, frameEvidence: frameEvidence(0, [noteFrame(60, 0)]), target },
      { timestampMs: 16, frameEvidence: frameEvidence(16, [noteFrame(60, 16)]), target }
    ];

    const output = runFrames(validator, target, frames);
    expect(output.accepted).toBe(true);
    expect(output.acceptedPreGate).toBe(output.acceptedPostGate);
    expect(MONO_ACTIVATION_GATE_POLICY.gateEnabled).toBe(false);
    expect(MONO_NOTE_SET_POLICY.mode).toBe('all_notes_required');
  });

  test('builds frame evidence from spectral detector results', () => {
    const result = buildValidatorFrameEvidenceFromPitchResult(
      {
        detectorName: 'spectral_game_runtime_unified_v3',
        accepted: true,
        midi: 60,
        noteName: 'C4',
        confidence: 0.92,
        candidates: [
          { pitchHz: 261.63, midi: 60, noteName: 'C4', confidence: 0.92, label: 'c4' },
          { pitchHz: 293.66, midi: 62, noteName: 'D4', confidence: 0.34, label: 'd4' }
        ],
        debug: {}
      },
      48,
      monoTarget(60)
    );

    expect(result.timestampMs).toBe(48);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].midi).toBe(60);
    expect(result.rawDetectedMidis).toEqual([60, 62]);
  });

  test('builds frame evidence from live pitch frames', () => {
    const frame: PitchFrame = {
      t_seconds: 0.096,
      midi_estimate: 60,
      confidence: 0.81,
      detected_string: 1,
      detected_fret: 0,
      selected_notes: [
        { midi: 60, string: 1, fret: 0, score: 0.81, note_id: 'c4' },
        { midi: 62, string: 1, fret: 2, score: 0.24, note_id: 'd4' }
      ],
      chord_scores: []
    };

    const result = buildValidatorFrameEvidenceFromPitchFrame(frame, 96, monoTarget(60));

    expect(result.timestampMs).toBe(96);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].midi).toBe(60);
    expect(result.notes[0].detectorConfidence).toBe(0.81);
    expect(result.rawDetectedMidis).toEqual([60, 62]);
  });
});
