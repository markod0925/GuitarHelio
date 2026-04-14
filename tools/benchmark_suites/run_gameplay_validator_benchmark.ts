#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { FeatureExtractionService } from '../../src/audio/FeatureExtractionService';
import { midiToHz } from '../../src/ui/song-select/utils/songSelectUtils';
import { midiForStringFret } from '../../src/guitar/tuning';
import { PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { MASP_TUNED_PARAMS, scoreMaspMidiFrame, type MaspHarmonicMap } from '../../src/audio/maspCore';
import {
  DATASET_ROOT,
  WINDOWS_DATASET_ROOT,
  FRAME_SIZE,
  DspCoreDetector,
  average,
  bandScale,
  buildAllStringFretPositions,
  buildDatasetRows,
  buildEvenlySpacedFrameStarts,
  buildFeatureContextWithTarget,
  buildLegend,
  buildSingleNoteRuntimeModel,
  colorForAlgorithm,
  createMaspDetector,
  csvEscape,
  decodeMonoAudio,
  escapeXml,
  finiteNumber,
  findClosestPositionForMidi,
  formatCsvValue,
  formatNullable,
  formatPct,
  linearScale,
  readFrame,
  roundNumber,
  stringGroup,
  svgHeader
} from './shared';
import {
  ALGORITHMS,
  DEFAULT_VALIDATOR_DECISION_CONFIG,
  LEGACY_VALIDATOR_DECISION_CONFIG,
  aggregateValidatorRows,
  evaluateRowsForConfig,
  parseDecisionConfigFromEnv,
  type AlgorithmName,
  type MismatchType,
  type SpectralProbeCandidateScore,
  type SpectralProbeCompetitorClass,
  type SpectralProbeFrameTelemetry,
  type SpectralProbePairwiseTelemetry,
  type ValidatorAggregate,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig,
  type ValidatorRow
} from './gameplay_validator_core';
import { MONO_ACTIVATION_GATE_POLICY, MONO_NOTE_SET_POLICY } from './gameplay_validator_polyphonic';

type TargetNote = {
  stringId: number;
  fret: number;
  midi: number;
};

type ValidationCase = {
  caseId: string;
  sourceFileId: string;
  sourceRelativeFilePath: string;
  sourceStringId: number;
  sourceFret: number;
  sourceTake: number;
  expectedNote: TargetNote;
  expectedAccept: boolean;
  mismatchType: MismatchType;
  targetKind: 'single_note';
  samePitchAltCandidateExists: boolean;
};

type FramePreparedContext = {
  frameIndex: number;
  timestampMs: number;
  frame: Float32Array;
  optionalFeatures: ReturnType<typeof buildFeatureContextWithTarget>;
  expectedScore: number;
  bestCompetitorScore: number;
  bestCompetitorMidi: number | null;
  bestOctaveScore: number;
  neighborScore: number;
  expectedRank: number | null;
  expectedTop1: boolean;
  expectedTop3: boolean;
  expectedPairwiseWinRate: number | null;
  octaveCompetitorOutranked: boolean;
  expectedVsSourceWon: boolean | null;
  candidateScoreCount: number | null;
  samePitchAltScore: number | null;
  sharedEvidenceAvailability: string[];
  sharedEvidenceLimitations: string[];
};

type BaselineComparison = {
  baselineConfig: ValidatorDecisionConfig;
  baselineAggregates: Record<AlgorithmName, ValidatorAggregate>;
};

type SpectralProbeCandidate = {
  noteId: string;
  stringId: number;
  fret: number;
  midi: number;
  competitorClass: SpectralProbeCompetitorClass;
};

type SpectralProbePair = {
  candidate: SpectralProbeCandidate;
  modelJson: string;
};

type SpectralProbePlan = {
  expected: SpectralProbeCandidate;
  candidates: SpectralProbeCandidate[];
  aggregateModelJson: string;
  pairwiseModels: SpectralProbePair[];
};

type FrameEvidence = {
  expectedScore: number;
  bestCompetitorScore: number;
  bestCompetitorMidi: number | null;
  bestOctaveScore: number;
  neighborScore: number;
  samePitchAltScore: number | null;
  expectedRank: number | null;
  expectedTop1: boolean;
  expectedTop3: boolean;
  expectedPairwiseWinRate: number | null;
  octaveCompetitorOutranked: boolean;
  expectedVsSourceWon: boolean | null;
  positionAmbiguous: boolean;
  candidateScoreCount: number | null;
  sharedEvidenceAvailability: string[];
  sharedEvidenceLimitations: string[];
  evidenceSource: 'masp_proxy' | 'spectral_probe';
  spectralProbe: SpectralProbeFrameTelemetry | null;
};

const OUTPUT_ROOT = 'analysis/gameplay_validator_benchmark';
const TARGET_FRAME_COUNT = 18;
const MASP_HARMONIC_LOCAL_BANDWIDTH_BINS = 2;
const MASP_MIDI_MAX = 88;

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const datasetDir = path.resolve(repoRoot, DATASET_ROOT);
  const outputDir = path.resolve(repoRoot, OUTPUT_ROOT);
  const plotsDir = path.join(outputDir, 'plots');
  await fs.mkdir(plotsDir, { recursive: true });

  const datasetRows = await buildDatasetRows(datasetDir);
  if (datasetRows.length <= 0) {
    throw new Error(`No WAV files found under ${datasetDir}`);
  }

  const rowsByMidi = new Map<number, typeof datasetRows>();
  for (const row of datasetRows) {
    const midi = midiFor(row.stringId, row.fret);
    const list = rowsByMidi.get(midi) ?? [];
    list.push(row);
    rowsByMidi.set(midi, list);
  }
  const allPositions = buildAllStringFretPositions(12);

  const maspEvidenceMaps = buildMaspHarmonicMaps(
    MASP_TUNED_PARAMS.strictSampleRate,
    FRAME_SIZE,
    MASP_TUNED_PARAMS.midiMin,
    MASP_MIDI_MAX,
    MASP_TUNED_PARAMS.maxHarmonics,
    MASP_HARMONIC_LOCAL_BANDWIDTH_BINS
  );

  const masp = createMaspDetector();
  const spectral = new DspCoreDetector(
    'spectral_game_runtime_unified_v3',
    PitchDetectorPreset.SpectralGameRuntimeUnifiedV3,
    JSON.stringify(buildSingleNoteRuntimeModel({ stringId: 1, fret: 0, midi: midiFor(1, 0) }))
  );
  const spectralProbe = new DspCoreDetector(
    'spectral_game_runtime_unified_v3_probe',
    PitchDetectorPreset.SpectralGameRuntimeUnifiedV3,
    null
  );

  await masp.init();
  await spectral.init();
  await spectralProbe.init();

  const telemetryRows: ValidatorCaseTelemetry[] = [];

  try {
    for (let index = 0; index < datasetRows.length; index += 1) {
      const source = datasetRows[index];
      console.log(`[gameplay-validator] ${index + 1}/${datasetRows.length} ${source.relativeFilePath}`);

      const decoded = await decodeMonoAudio(source.filePath);
      const starts = buildEvenlySpacedFrameStarts(decoded.samples.length, TARGET_FRAME_COUNT, FRAME_SIZE);

      const cases = buildValidationCases(source, rowsByMidi, allPositions);
      for (const validationCase of cases) {
        const runtimeModel = buildSingleNoteRuntimeModel(validationCase.expectedNote);
        const runtimeModelJson = JSON.stringify(runtimeModel);
        spectral.updateSpectralModel(runtimeModelJson);
        const spectralProbePlan = buildSpectralProbePlan(validationCase, allPositions);

        const frameContexts = buildPreparedFrames({
          starts,
          sampleRate: decoded.sampleRate,
          samples: decoded.samples,
          runtimeModel,
          target: validationCase.expectedNote,
          sourceMidi: midiFor(validationCase.sourceStringId, validationCase.sourceFret),
          maspEvidenceMaps
        });

        for (const algorithm of ALGORITHMS) {
          const detector = algorithm === 'MASP' ? masp : spectral;
          detector.reset();

          const frames: ValidatorCaseTelemetry['frames'] = [];
          for (const prepared of frameContexts) {
            const startedAt = performance.now();
            const result = detector.processFrame({
              timestampMs: prepared.timestampMs,
              frameIndex: prepared.frameIndex,
              sampleRate: decoded.sampleRate,
              rawFrame: prepared.frame,
              processedFrame: prepared.frame,
              analysisWindowId: prepared.frameIndex,
              optionalFeatures: prepared.optionalFeatures
            });
            const runtimeMs = performance.now() - startedAt;

            const evidence = algorithm === 'MASP'
              ? buildMaspFrameEvidence(prepared)
              : analyzeSpectralProbeFrame({
                detector: spectralProbe,
                frameInput: {
                  timestampMs: prepared.timestampMs,
                  frameIndex: prepared.frameIndex,
                  sampleRate: decoded.sampleRate,
                  rawFrame: prepared.frame,
                  processedFrame: prepared.frame,
                  analysisWindowId: prepared.frameIndex,
                  optionalFeatures: prepared.optionalFeatures
                },
                plan: spectralProbePlan
              });

            const detectedMidi = finiteNumber(result.midi);
            const confidence = finiteNumber(result.confidence) ?? 0;
            const detectedString = asFiniteInt(result.stringId);
            const detectedFret = asFiniteInt(result.fret);
            const expectedCentsError = detectedMidi !== null ? (detectedMidi - validationCase.expectedNote.midi) * 100 : null;
            const expectedMidiHit = expectedCentsError !== null && Math.abs(expectedCentsError) <= 50;
            const expectedPositionMatch = expectedMidiHit &&
              detectedString === validationCase.expectedNote.stringId &&
              detectedFret === validationCase.expectedNote.fret;
            const samePitchAltDetected = expectedMidiHit &&
              detectedString !== null &&
              detectedFret !== null &&
              !expectedPositionMatch;

            frames.push({
              frameIndex: prepared.frameIndex,
              timestampMs: prepared.timestampMs,
              runtimeMs,
              detectorAccepted: result.accepted,
              detectorConfidence: confidence,
              detectedMidi,
              detectedString,
              detectedFret,
              expectedCentsError,
              expectedScore: evidence.expectedScore,
              bestCompetitorScore: evidence.bestCompetitorScore,
              bestCompetitorMidi: evidence.bestCompetitorMidi,
              bestOctaveScore: evidence.bestOctaveScore,
              neighborScore: evidence.neighborScore,
              samePitchAltScore: evidence.samePitchAltScore,
              expectedRank: evidence.expectedRank,
              expectedTop1: evidence.expectedTop1,
              expectedTop3: evidence.expectedTop3,
              expectedPairwiseWinRate: evidence.expectedPairwiseWinRate,
              octaveCompetitorOutranked: evidence.octaveCompetitorOutranked,
              expectedVsSourceWon: evidence.expectedVsSourceWon,
              positionAmbiguous: evidence.positionAmbiguous,
              candidateScoreCount: evidence.candidateScoreCount,
              sharedEvidenceAvailability: evidence.sharedEvidenceAvailability,
              sharedEvidenceLimitations: evidence.sharedEvidenceLimitations,
              evidenceSource: evidence.evidenceSource,
              spectralProbe: evidence.spectralProbe,
              samePitchAltDetected,
              expectedPositionMatch
            });
          }

          telemetryRows.push({
            algorithm,
            caseId: validationCase.caseId,
            sourceFileId: validationCase.sourceFileId,
            sourceRelativeFilePath: validationCase.sourceRelativeFilePath,
            sourceStringId: validationCase.sourceStringId,
            sourceFret: validationCase.sourceFret,
            sourceTake: validationCase.sourceTake,
            sourceStringBand: stringGroup(validationCase.sourceStringId),
            targetKind: validationCase.targetKind,
            mismatchType: validationCase.mismatchType,
            expectedAccept: validationCase.expectedAccept,
            expectedString: validationCase.expectedNote.stringId,
            expectedFret: validationCase.expectedNote.fret,
            expectedMidi: validationCase.expectedNote.midi,
            samePitchAltCandidateExists: validationCase.samePitchAltCandidateExists,
            frames
          });
        }
      }
    }
  } finally {
    spectral.dispose?.();
    spectralProbe.dispose?.();
  }

  const baselineConfig = LEGACY_VALIDATOR_DECISION_CONFIG;
  const candidateConfig = parseDecisionConfigFromEnv(DEFAULT_VALIDATOR_DECISION_CONFIG);

  const baselineEval = evaluateRowsForConfig(telemetryRows, baselineConfig, ALGORITHMS);
  const candidateEval = evaluateRowsForConfig(telemetryRows, candidateConfig, ALGORITHMS);

  await writeResults(outputDir, {
    rows: candidateEval.rows,
    telemetryRows,
    aggregates: candidateEval.aggregates,
    config: candidateConfig,
    baselineComparison: {
      baselineConfig,
      baselineAggregates: baselineEval.aggregates
    }
  });
  await writeEvidenceAudit(outputDir, telemetryRows);
  await writeSpectralProbeReport(outputDir, telemetryRows);
  await writePlots(plotsDir, candidateEval.aggregates);
  await writeSummary(outputDir, datasetRows.length, candidateEval.aggregates, baselineEval.aggregates, candidateConfig, baselineConfig);

  console.log(`Outputs: ${OUTPUT_ROOT}`);
}

function buildPreparedFrames(input: {
  starts: number[];
  sampleRate: number;
  samples: Float32Array;
  runtimeModel: ReturnType<typeof buildSingleNoteRuntimeModel>;
  target: TargetNote;
  sourceMidi: number;
  maspEvidenceMaps: MaspHarmonicMap[];
}): FramePreparedContext[] {
  const featureService = new FeatureExtractionService(FRAME_SIZE);
  const out: FramePreparedContext[] = [];
  for (let frameIndex = 0; frameIndex < input.starts.length; frameIndex += 1) {
    const start = input.starts[frameIndex];
    const frame = readFrame(input.samples, start, FRAME_SIZE);
    const baseFeatures = featureService.extractFeatures(frame, input.sampleRate, null, input.runtimeModel);
    const optionalFeatures = buildFeatureContextWithTarget(baseFeatures, input.target, input.runtimeModel);
    const evidence = computeMaspEvidence(
      baseFeatures.magnitudeSpectrum,
      input.target.midi,
      input.sourceMidi,
      input.maspEvidenceMaps
    );

    out.push({
      frameIndex,
      timestampMs: (start / input.sampleRate) * 1000,
      frame,
      optionalFeatures,
      expectedScore: evidence.expectedScore,
      bestCompetitorScore: evidence.bestCompetitorScore,
      bestCompetitorMidi: evidence.bestCompetitorMidi,
      bestOctaveScore: evidence.bestOctaveScore,
      neighborScore: evidence.neighborScore,
      expectedRank: evidence.expectedRank,
      expectedTop1: evidence.expectedTop1,
      expectedTop3: evidence.expectedTop3,
      expectedPairwiseWinRate: evidence.expectedPairwiseWinRate,
      octaveCompetitorOutranked: evidence.octaveCompetitorOutranked,
      expectedVsSourceWon: evidence.expectedVsSourceWon,
      candidateScoreCount: evidence.candidateScoreCount,
      samePitchAltScore: evidence.samePitchAltScore,
      sharedEvidenceAvailability: evidence.sharedEvidenceAvailability,
      sharedEvidenceLimitations: evidence.sharedEvidenceLimitations
    });
  }
  return out;
}

function buildMaspFrameEvidence(prepared: FramePreparedContext): FrameEvidence {
  return {
    expectedScore: prepared.expectedScore,
    bestCompetitorScore: prepared.bestCompetitorScore,
    bestCompetitorMidi: prepared.bestCompetitorMidi,
    bestOctaveScore: prepared.bestOctaveScore,
    neighborScore: prepared.neighborScore,
    samePitchAltScore: prepared.samePitchAltScore,
    expectedRank: prepared.expectedRank,
    expectedTop1: prepared.expectedTop1,
    expectedTop3: prepared.expectedTop3,
    expectedPairwiseWinRate: prepared.expectedPairwiseWinRate,
    octaveCompetitorOutranked: prepared.octaveCompetitorOutranked,
    expectedVsSourceWon: prepared.expectedVsSourceWon,
    positionAmbiguous: false,
    candidateScoreCount: prepared.candidateScoreCount,
    sharedEvidenceAvailability: prepared.sharedEvidenceAvailability,
    sharedEvidenceLimitations: prepared.sharedEvidenceLimitations,
    evidenceSource: 'masp_proxy',
    spectralProbe: null
  };
}

function analyzeSpectralProbeFrame(input: {
  detector: DspCoreDetector;
  frameInput: {
    timestampMs: number;
    frameIndex: number;
    sampleRate: number;
    rawFrame: Float32Array;
    processedFrame: Float32Array;
    analysisWindowId: number;
    optionalFeatures: ReturnType<typeof buildFeatureContextWithTarget>;
  };
  plan: SpectralProbePlan;
}): FrameEvidence {
  const classById = new Map<string, SpectralProbeCompetitorClass>(
    input.plan.candidates.map((candidate) => [candidate.noteId, candidate.competitorClass])
  );
  const missingEvidence: string[] = [];

  const aggregateDebug = runSpectralProbeModel(input.detector, input.frameInput, input.plan.aggregateModelJson);
  const aggregateScores = extractCandidateScores(aggregateDebug, classById);
  const expectedEntry = aggregateScores.find((entry) => entry.noteId === input.plan.expected.noteId) ?? null;
  const bestCompetitor = aggregateScores.find((entry) => entry.noteId !== input.plan.expected.noteId) ?? null;
  const octaveCandidates = aggregateScores.filter((entry) => entry.competitorClass === 'octave');
  const neighborCandidates = aggregateScores.filter((entry) =>
    entry.competitorClass === 'neighbor' || entry.competitorClass === 'nearby_note'
  );

  if (!Array.isArray(aggregateDebug.candidate_scores)) {
    missingEvidence.push('raw_candidate_scores_not_exposed_by_runtime');
  }

  const pairwise: SpectralProbePairwiseTelemetry[] = [];
  for (const pair of input.plan.pairwiseModels) {
    const pairDebug = runSpectralProbeModel(input.detector, input.frameInput, pair.modelJson);
    const pairScores = extractCandidateScores(pairDebug, classById);
    const expectedPair = pairScores.find((entry) => entry.noteId === input.plan.expected.noteId) ?? null;
    const competitorPair = pairScores.find((entry) => entry.noteId === pair.candidate.noteId) ?? null;
    const expectedScore = expectedPair?.rawScore ?? null;
    const competitorScore = competitorPair?.rawScore ?? null;
    const expectedWon = expectedScore === null || competitorScore === null
      ? (expectedScore !== null ? true : (competitorScore !== null ? false : null))
      : expectedScore >= competitorScore;
    const detectedString = asFiniteInt(pairDebug.detected_string);
    const detectedFret = asFiniteInt(pairDebug.detected_fret);
    pairwise.push({
      noteId: pair.candidate.noteId,
      midi: pair.candidate.midi,
      stringId: pair.candidate.stringId,
      fret: pair.candidate.fret,
      competitorClass: pair.candidate.competitorClass,
      expectedScore,
      competitorScore,
      expectedWon,
      detectedString,
      detectedFret,
      positionAmbiguous: detectedString === null || detectedFret === null
    });
  }

  const comparedPairs = pairwise.filter((entry) => entry.expectedWon !== null);
  const expectedWins = comparedPairs.filter((entry) => entry.expectedWon === true).length;
  const expectedPairwiseWinRate = comparedPairs.length > 0 ? expectedWins / comparedPairs.length : null;
  const octaveCompetitorOutranked = (
    pairwise.some((entry) => entry.competitorClass === 'octave' && entry.expectedWon === false) ||
    (expectedEntry !== null && octaveCandidates.some((entry) => entry.rawScore > expectedEntry.rawScore))
  );
  const expectedVsSourceWon = pairwise.find((entry) => entry.competitorClass === 'source_actual')?.expectedWon ?? null;
  const positionAmbiguous = pairwise
    .filter((entry) => entry.competitorClass === 'same_pitch_alt')
    .some((entry) => entry.positionAmbiguous);
  const bestSamePitchAlt = aggregateScores
    .filter((entry) => entry.competitorClass === 'same_pitch_alt')
    .map((entry) => entry.rawScore);

  if (!pairwise.some((entry) => entry.competitorClass === 'octave')) {
    missingEvidence.push('octave_probe_candidates_absent');
  }
  if (!pairwise.some((entry) => entry.competitorClass === 'same_pitch_alt')) {
    missingEvidence.push('same_pitch_alt_probe_candidates_absent');
  }
  if (!pairwise.some((entry) => entry.competitorClass === 'source_actual')) {
    missingEvidence.push('source_actual_probe_candidate_absent');
  }

  const spectralProbe: SpectralProbeFrameTelemetry = {
    probeVersion: 'spectral_probe_v1',
    expectedNoteId: input.plan.expected.noteId,
    candidateCount: input.plan.candidates.length,
    availableCandidateScoreCount: aggregateScores.length,
    topCandidates: aggregateScores.slice(0, 8),
    pairwise,
    expectedRank: expectedEntry?.rank ?? null,
    expectedTop1: (expectedEntry?.rank ?? null) === 1,
    expectedTop3: expectedEntry !== null && expectedEntry.rank <= 3,
    expectedPairwiseWinRate,
    octaveCompetitorOutranked,
    expectedVsSourceWon,
    positionAmbiguous,
    missingEvidence
  };

  return {
    expectedScore: expectedEntry?.rawScore ?? 0,
    bestCompetitorScore: bestCompetitor?.rawScore ?? 0,
    bestCompetitorMidi: bestCompetitor?.midi ?? null,
    bestOctaveScore: maxOrZero(octaveCandidates.map((entry) => entry.rawScore)),
    neighborScore: maxOrZero(neighborCandidates.map((entry) => entry.rawScore)),
    samePitchAltScore: bestSamePitchAlt.length > 0 ? Math.max(...bestSamePitchAlt) : null,
    expectedRank: expectedEntry?.rank ?? null,
    expectedTop1: (expectedEntry?.rank ?? null) === 1,
    expectedTop3: expectedEntry !== null && expectedEntry.rank <= 3,
    expectedPairwiseWinRate,
    octaveCompetitorOutranked,
    expectedVsSourceWon,
    positionAmbiguous,
    candidateScoreCount: aggregateScores.length,
    sharedEvidenceAvailability: [
      'expected_target_score',
      'best_competitor_score',
      'best_octave_score',
      'nearby_competitor_score',
      'same_pitch_alt_score',
      'expected_rank',
      'expected_topk_ratio_inputs',
      'pairwise_competitor_outcomes',
      'expected_vs_source_outcome',
      'independent_position_probe'
    ],
    sharedEvidenceLimitations: missingEvidence,
    evidenceSource: 'spectral_probe',
    spectralProbe
  };
}

function buildSpectralProbePlan(
  validationCase: ValidationCase,
  allPositions: Array<{ stringId: number; fret: number; midi: number }>
): SpectralProbePlan {
  // Spectral path audit (benchmark-specific):
  // 1) Independent evidence available: probe-model candidate ranking and pairwise expected-vs-competitor outcomes.
  // 2) Target-conditioned evidence: the production validation path injects a single expected note model, so
  //    detected note/position can collapse to the forced target context.
  // 3) Missing exact-position evidence: spectral scoring is frequency-centric; same-midi alternate positions are
  //    generally ambiguous rather than independently separable.
  const expected = buildProbeCandidate(
    validationCase.expectedNote.stringId,
    validationCase.expectedNote.fret,
    validationCase.expectedNote.midi,
    'other'
  );

  const byKey = new Map<string, SpectralProbeCandidate>();
  byKey.set(`${expected.stringId}:${expected.fret}:${expected.midi}`, expected);

  const addCandidate = (candidate: SpectralProbeCandidate) => {
    const key = `${candidate.stringId}:${candidate.fret}:${candidate.midi}`;
    if (byKey.has(key)) return;
    byKey.set(key, candidate);
  };

  const sourceMidi = midiFor(validationCase.sourceStringId, validationCase.sourceFret);
  addCandidate(buildProbeCandidate(validationCase.sourceStringId, validationCase.sourceFret, sourceMidi, 'source_actual'));

  for (const delta of [-2, -1, 1, 2]) {
    const neighbor = findClosestPositionForMidi(
      allPositions,
      validationCase.expectedNote.midi + delta,
      validationCase.expectedNote.stringId
    );
    if (!neighbor) continue;
    addCandidate(buildProbeCandidate(neighbor.stringId, neighbor.fret, neighbor.midi, 'neighbor'));
  }

  for (const octaveShift of [-12, 12]) {
    const octave = findClosestPositionForMidi(
      allPositions,
      validationCase.expectedNote.midi + octaveShift,
      validationCase.expectedNote.stringId
    );
    if (!octave) continue;
    addCandidate(buildProbeCandidate(octave.stringId, octave.fret, octave.midi, 'octave'));
  }

  const samePitchAlternatives = allPositions
    .filter((position) =>
      position.midi === validationCase.expectedNote.midi &&
      (position.stringId !== validationCase.expectedNote.stringId || position.fret !== validationCase.expectedNote.fret)
    )
    .sort((left, right) =>
      Math.abs(left.stringId - validationCase.expectedNote.stringId) - Math.abs(right.stringId - validationCase.expectedNote.stringId) ||
      left.fret - right.fret ||
      left.stringId - right.stringId
    )
    .slice(0, 3);
  for (const alternative of samePitchAlternatives) {
    addCandidate(buildProbeCandidate(alternative.stringId, alternative.fret, alternative.midi, 'same_pitch_alt'));
  }

  const candidates = [...byKey.values()];
  const aggregateModelJson = JSON.stringify(buildRuntimeModelForProbe(candidates));
  const pairwiseModels = candidates
    .filter((candidate) => candidate.noteId !== expected.noteId)
    .map((candidate) => ({
      candidate,
      modelJson: JSON.stringify(buildRuntimeModelForProbe([expected, candidate]))
    }));

  return {
    expected,
    candidates,
    aggregateModelJson,
    pairwiseModels
  };
}

function buildProbeCandidate(
  stringId: number,
  fret: number,
  midi: number,
  competitorClass: SpectralProbeCompetitorClass
): SpectralProbeCandidate {
  return {
    noteId: `n_s${stringId}_f${fret}_m${midi}`,
    stringId,
    fret,
    midi,
    competitorClass
  };
}

function buildRuntimeModelForProbe(candidates: SpectralProbeCandidate[]) {
  return {
    notes: candidates.map((candidate) => ({
      id: candidate.noteId,
      string: candidate.stringId,
      fret: candidate.fret,
      midi: candidate.midi,
      frequency_hz: midiToHz(candidate.midi)
    })),
    chords: []
  };
}

function runSpectralProbeModel(
  detector: DspCoreDetector,
  frameInput: {
    timestampMs: number;
    frameIndex: number;
    sampleRate: number;
    rawFrame: Float32Array;
    processedFrame: Float32Array;
    analysisWindowId: number;
    optionalFeatures: ReturnType<typeof buildFeatureContextWithTarget>;
  },
  modelJson: string
): Record<string, unknown> {
  detector.updateSpectralModel(modelJson);
  detector.reset();
  const output = detector.processFrame(frameInput);
  return asRecord(output.debug);
}

function extractCandidateScores(
  debug: Record<string, unknown>,
  classById: Map<string, SpectralProbeCompetitorClass>
): SpectralProbeCandidateScore[] {
  const candidateScoresRaw = Array.isArray(debug.candidate_scores) ? debug.candidate_scores : [];
  if (candidateScoresRaw.length > 0) {
    const parsed = candidateScoresRaw
      .map((entry) => {
        const row = asRecord(entry);
        const noteId = asString(row.note_id);
        const midi = finiteNumber(row.midi);
        const stringId = asFiniteInt(row.string);
        const fret = asFiniteInt(row.fret);
        const rawScore = finiteNumber(row.raw_score);
        const relativeScore = finiteNumber(row.relative_score);
        if (!noteId || midi === null || stringId === null || fret === null || rawScore === null) return null;
        return {
          noteId,
          midi,
          stringId,
          fret,
          rawScore,
          relativeScore,
          rank: 0,
          competitorClass: classById.get(noteId) ?? 'other'
        } satisfies SpectralProbeCandidateScore;
      })
      .filter(notNull);
    parsed.sort((left, right) => right.rawScore - left.rawScore || left.midi - right.midi);
    for (let index = 0; index < parsed.length; index += 1) {
      parsed[index].rank = index + 1;
    }
    return parsed;
  }

  const selected = Array.isArray(debug.selected_notes) ? debug.selected_notes : [];
  const parsedSelected = selected
    .map((entry) => {
      const row = asRecord(entry);
      const noteId = asString(row.note_id);
      const midi = finiteNumber(row.midi);
      const stringId = asFiniteInt(row.string);
      const fret = asFiniteInt(row.fret);
      const score = finiteNumber(row.score);
      if (!noteId || midi === null || stringId === null || fret === null || score === null) return null;
      return {
        noteId,
        midi,
        stringId,
        fret,
        rawScore: score,
        relativeScore: null,
        rank: 0,
        competitorClass: classById.get(noteId) ?? 'other'
      } satisfies SpectralProbeCandidateScore;
    })
    .filter(notNull);
  parsedSelected.sort((left, right) => right.rawScore - left.rawScore || left.midi - right.midi);
  for (let index = 0; index < parsedSelected.length; index += 1) {
    parsedSelected[index].rank = index + 1;
  }
  return parsedSelected;
}

function maxOrZero(values: number[]): number {
  if (values.length <= 0) return 0;
  return Math.max(...values);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function computeMaspEvidence(
  magnitudeSpectrum: ArrayLike<number>,
  expectedMidi: number,
  sourceMidi: number,
  maps: MaspHarmonicMap[]
): {
  expectedScore: number;
  bestCompetitorScore: number;
  bestCompetitorMidi: number | null;
  bestOctaveScore: number;
  neighborScore: number;
  samePitchAltScore: number | null;
  expectedRank: number | null;
  expectedTop1: boolean;
  expectedTop3: boolean;
  expectedPairwiseWinRate: number | null;
  octaveCompetitorOutranked: boolean;
  expectedVsSourceWon: boolean | null;
  candidateScoreCount: number | null;
  sharedEvidenceAvailability: string[];
  sharedEvidenceLimitations: string[];
} {
  const scores = scoreMaspMidiFrame(magnitudeSpectrum, maps, MASP_TUNED_PARAMS);
  const midiMin = MASP_TUNED_PARAMS.midiMin;

  const expectedIdx = expectedMidi - midiMin;
  const expectedScore = expectedIdx >= 0 && expectedIdx < scores.length ? scores[expectedIdx] : 0;

  let bestCompetitorScore = 0;
  let bestCompetitorMidi: number | null = null;
  for (let index = 0; index < scores.length; index += 1) {
    const midi = midiMin + index;
    if (midi === expectedMidi) continue;
    const score = scores[index];
    if (score > bestCompetitorScore) {
      bestCompetitorScore = score;
      bestCompetitorMidi = midi;
    }
  }

  const octaveUpIdx = expectedMidi + 12 - midiMin;
  const octaveDownIdx = expectedMidi - 12 - midiMin;
  const octaveUpScore = octaveUpIdx >= 0 && octaveUpIdx < scores.length ? scores[octaveUpIdx] : 0;
  const octaveDownScore = octaveDownIdx >= 0 && octaveDownIdx < scores.length ? scores[octaveDownIdx] : 0;

  const neighborUpIdx = expectedMidi + 1 - midiMin;
  const neighborDownIdx = expectedMidi - 1 - midiMin;
  const neighborUpScore = neighborUpIdx >= 0 && neighborUpIdx < scores.length ? scores[neighborUpIdx] : 0;
  const neighborDownScore = neighborDownIdx >= 0 && neighborDownIdx < scores.length ? scores[neighborDownIdx] : 0;
  const sourceIdx = sourceMidi - midiMin;
  const sourceScore = sourceIdx >= 0 && sourceIdx < scores.length ? scores[sourceIdx] : null;
  const expectedVsSourceWon = sourceScore === null ? null : expectedScore >= sourceScore;

  const ordered = scores
    .map((score, index) => ({ score, midi: midiMin + index }))
    .sort((left, right) => right.score - left.score || left.midi - right.midi);
  const expectedRank = ordered.findIndex((entry) => entry.midi === expectedMidi);
  const pairwiseComparators = [bestCompetitorScore, Math.max(octaveUpScore, octaveDownScore), Math.max(neighborUpScore, neighborDownScore)]
    .filter((value) => Number.isFinite(value) && value > 0);
  const expectedPairwiseWins = pairwiseComparators.filter((value) => expectedScore >= value).length;
  const expectedPairwiseWinRate = pairwiseComparators.length > 0 ? expectedPairwiseWins / pairwiseComparators.length : null;

  return {
    expectedScore,
    bestCompetitorScore,
    bestCompetitorMidi,
    bestOctaveScore: Math.max(octaveUpScore, octaveDownScore),
    neighborScore: Math.max(neighborUpScore, neighborDownScore),
    samePitchAltScore: null,
    expectedRank: expectedRank >= 0 ? expectedRank + 1 : null,
    expectedTop1: expectedRank === 0,
    expectedTop3: expectedRank >= 0 && expectedRank <= 2,
    expectedPairwiseWinRate,
    octaveCompetitorOutranked: Math.max(octaveUpScore, octaveDownScore) > expectedScore,
    expectedVsSourceWon,
    candidateScoreCount: scores.length,
    sharedEvidenceAvailability: [
      'expected_target_score',
      'best_competitor_score',
      'best_octave_score',
      'nearby_competitor_score',
      'expected_rank',
      'expected_topk_ratio_inputs',
      'source_competitor_proxy'
    ],
    sharedEvidenceLimitations: [
      'same_pitch_alt_score_not_independent_for_masp_midi_only',
      'pairwise_competitor_outcomes_are_proxy_not_explicit_probe',
      'position_evidence_not_independent'
    ]
  };
}

function buildMaspHarmonicMaps(
  sampleRate: number,
  nfft: number,
  midiMin: number,
  midiMax: number,
  maxHarmonics: number,
  localBandwidthBins: number
): MaspHarmonicMap[] {
  const nyquist = sampleRate * 0.5;
  const hzPerBin = sampleRate / nfft;
  const maxBin = Math.floor(nfft / 2);
  const maps: MaspHarmonicMap[] = [];
  for (let midi = midiMin; midi <= midiMax; midi += 1) {
    const f0 = midiToHz(midi);
    const ranges = [];
    for (let harmonic = 1; harmonic <= maxHarmonics; harmonic += 1) {
      const harmonicHz = f0 * harmonic;
      if (harmonicHz >= nyquist) break;
      const center = Math.round(harmonicHz / hzPerBin);
      ranges.push({
        start: Math.max(0, center - localBandwidthBins),
        end: Math.min(maxBin, center + localBandwidthBins)
      });
    }
    maps.push({ midi, f0_hz: f0, ranges });
  }
  return maps;
}

function buildValidationCases(
  source: { fileId: string; relativeFilePath: string; stringId: number; fret: number; take: number },
  rowsByMidi: Map<number, Array<{ stringId: number; fret: number }>>,
  allPositions: Array<{ stringId: number; fret: number; midi: number }>
): ValidationCase[] {
  const sourceMidi = midiFor(source.stringId, source.fret);
  const positive: ValidationCase = {
    caseId: `${source.fileId}__correct_target`,
    sourceFileId: source.fileId,
    sourceRelativeFilePath: source.relativeFilePath,
    sourceStringId: source.stringId,
    sourceFret: source.fret,
    sourceTake: source.take,
    expectedNote: { stringId: source.stringId, fret: source.fret, midi: sourceMidi },
    expectedAccept: true,
    mismatchType: 'correct_target',
    targetKind: 'single_note',
    samePitchAltCandidateExists: false
  };

  const negatives: ValidationCase[] = [];

  const neighborFret = source.fret < 12 ? source.fret + 1 : (source.fret > 0 ? source.fret - 1 : null);
  if (neighborFret !== null && neighborFret !== source.fret) {
    negatives.push({
      ...positive,
      caseId: `${source.fileId}__neighbor_fret`,
      expectedNote: { stringId: source.stringId, fret: neighborFret, midi: midiFor(source.stringId, neighborFret) },
      expectedAccept: false,
      mismatchType: 'neighbor_fret'
    });
  }

  const octavePosition = findClosestPositionForMidi(allPositions, sourceMidi + 12, source.stringId) ??
    findClosestPositionForMidi(allPositions, sourceMidi - 12, source.stringId);
  if (octavePosition && (octavePosition.stringId !== source.stringId || octavePosition.fret !== source.fret)) {
    negatives.push({
      ...positive,
      caseId: `${source.fileId}__octave_distractor`,
      expectedNote: { stringId: octavePosition.stringId, fret: octavePosition.fret, midi: octavePosition.midi },
      expectedAccept: false,
      mismatchType: 'octave_distractor'
    });
  }

  const sameMidiAlternatives = (rowsByMidi.get(sourceMidi) ?? [])
    .filter((row) => row.stringId !== source.stringId || row.fret !== source.fret);
  if (sameMidiAlternatives.length > 0) {
    const candidate = sameMidiAlternatives[0];
    negatives.push({
      ...positive,
      caseId: `${source.fileId}__same_pitch_alt_string`,
      expectedNote: { stringId: candidate.stringId, fret: candidate.fret, midi: sourceMidi },
      expectedAccept: false,
      mismatchType: 'same_pitch_alt_string',
      samePitchAltCandidateExists: true
    });
  }

  const nearby = findClosestPositionForMidi(allPositions, sourceMidi + 1, source.stringId) ??
    findClosestPositionForMidi(allPositions, sourceMidi - 1, source.stringId);
  if (nearby && (nearby.stringId !== source.stringId || nearby.fret !== source.fret)) {
    negatives.push({
      ...positive,
      caseId: `${source.fileId}__nearby_note_distractor`,
      expectedNote: { stringId: nearby.stringId, fret: nearby.fret, midi: nearby.midi },
      expectedAccept: false,
      mismatchType: 'nearby_note_distractor'
    });
  }

  const seen = new Set<string>();
  const uniqueNegatives: ValidationCase[] = [];
  for (const candidate of negatives) {
    const key = `${candidate.expectedNote.stringId}:${candidate.expectedNote.fret}:${candidate.expectedNote.midi}:${candidate.mismatchType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNegatives.push(candidate);
  }

  return [positive, ...uniqueNegatives];
}

async function writeResults(
  outputDir: string,
  input: {
    rows: ValidatorRow[];
    telemetryRows: ValidatorCaseTelemetry[];
    aggregates: Record<AlgorithmName, ValidatorAggregate>;
    config: ValidatorDecisionConfig;
    baselineComparison: BaselineComparison;
  }
): Promise<void> {
  const doc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'gameplay_validator',
    datasetPath: DATASET_ROOT,
    datasetPathWindows: WINDOWS_DATASET_ROOT,
    rawOnly: true,
    targetAware: true,
    algorithms: ALGORITHMS,
    decisionConfig: input.config,
    noteDecisionConfigId: input.config.id,
    aggregationPolicyId: MONO_NOTE_SET_POLICY.id,
    activationGatePolicyId: MONO_ACTIVATION_GATE_POLICY.id,
    baselineComparison: input.baselineComparison,
    notes: [
      'This suite evaluates target-aware validation behavior, not generic detector ranking.',
      'Each case is a note-set of cardinality 1; mono aggregation and gate-off policy are explicit and separate from note decision tuning.',
      'Decision logic is shared note-level competitor-aware evidence first, then optional expected-position evidence.'
    ],
    aggregates: input.aggregates,
    rows: input.rows
  };

  const diagnosticsDoc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'gameplay_validator',
    algorithms: ALGORITHMS,
    noteDecisionConfigId: input.config.id,
    aggregationPolicyId: MONO_NOTE_SET_POLICY.id,
    activationGatePolicyId: MONO_ACTIVATION_GATE_POLICY.id,
    caseTelemetry: input.telemetryRows
  };

  await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'diagnostics.json'), `${JSON.stringify(diagnosticsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'results.csv'), `${buildCsv(input.rows)}\n`, 'utf8');
}

async function writeSpectralProbeReport(
  outputDir: string,
  telemetryRows: ValidatorCaseTelemetry[]
): Promise<void> {
  const spectralCases = telemetryRows.filter((row) => row.algorithm === 'spectral_game_runtime_unified_v3');
  const allFrames = spectralCases.flatMap((row) => row.frames);
  const probeFrames = allFrames.filter((frame) => frame.spectralProbe !== null);

  const expectedRanks = probeFrames
    .map((frame) => frame.expectedRank)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const expectedTop1Rate = ratio(probeFrames.map((frame) => frame.expectedRank === 1));
  const expectedTop3Rate = ratio(probeFrames.map((frame) => frame.expectedTop3));
  const expectedPairwiseWinRates = probeFrames
    .map((frame) => frame.expectedPairwiseWinRate)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const expectedVsBestMargins = probeFrames.map((frame) => frame.expectedScore - frame.bestCompetitorScore);
  const octaveConfusionRate = ratio(probeFrames.map((frame) => frame.octaveCompetitorOutranked));
  const sourceComparable = probeFrames.filter((frame) => frame.expectedVsSourceWon !== null);
  const expectedVsSourceRate = sourceComparable.length > 0
    ? sourceComparable.filter((frame) => frame.expectedVsSourceWon === true).length / sourceComparable.length
    : 1;
  const samePitchFrames = spectralCases
    .filter((row) => row.mismatchType === 'same_pitch_alt_string')
    .flatMap((row) => row.frames);
  const samePitchAmbiguityRate = ratio(samePitchFrames.map((frame) => frame.positionAmbiguous));
  const rawScoresUnavailableCount = probeFrames.filter((frame) =>
    frame.spectralProbe?.missingEvidence.includes('raw_candidate_scores_not_exposed_by_runtime') ?? false
  ).length;
  const rawCandidateScoreAvailability = probeFrames.length > 0
    ? 1 - rawScoresUnavailableCount / probeFrames.length
    : 0;

  const exactPositionVerdict: 'YES' | 'NO' | 'PARTIAL' =
    samePitchFrames.length <= 0
      ? 'NO'
      : samePitchAmbiguityRate >= 0.8
        ? 'NO'
        : samePitchAmbiguityRate >= 0.35
          ? 'PARTIAL'
          : 'YES';

  const reportJson = {
    generatedAtIso: new Date().toISOString(),
    algorithm: 'spectral_game_runtime_unified_v3',
    auditAnswers: {
      independentEvidence:
        'Probe-model candidate ranks and pairwise expected-vs-competitor outcomes are independent of the forced single-target runtime path.',
      targetConditionedEvidence:
        'The production benchmark path injects a single-note spectral model per case; that path is target-conditioned and can mask competitor ambiguity.',
      exactPositionMissingEvidence:
        'Exact-position discrimination is missing independent string/fret evidence for same-midi alternates; ambiguity is exposed via null position on same-pitch pairwise probes.'
    },
    probeMetrics: {
      frameCount: probeFrames.length,
      expectedRankAverage: expectedRanks.length > 0 ? average(expectedRanks) : null,
      expectedTop1Rate,
      expectedTop3Rate,
      expectedPairwiseWinRateMean: expectedPairwiseWinRates.length > 0 ? average(expectedPairwiseWinRates) : null,
      expectedVsBestMarginAverage: expectedVsBestMargins.length > 0 ? average(expectedVsBestMargins) : null,
      octaveConfusionRate,
      expectedVsSourceRate,
      samePitchAltAmbiguityRate: samePitchAmbiguityRate,
      rawCandidateScoreAvailability
    },
    exactPositionVerdict,
    limitationSummary:
      exactPositionVerdict === 'NO'
        ? 'Spectral evidence remains note-centric for same-midi alternatives; exact-position FAR cannot materially improve without new position-aware features.'
        : exactPositionVerdict === 'PARTIAL'
          ? 'Weak position proxies exist, but they are insufficiently stable for robust exact-position gating.'
          : 'Independent position-discriminative evidence exists in current telemetry.'
  };

  const reportMd = [
    '# Spectral Evidence Audit',
    '',
    '## Direct Answers',
    '',
    '1. What evidence exists independently of the expected target?',
    '- Probe-model candidate ranks and pairwise expected-vs-competitor outcomes (source, neighbor, octave, same-pitch alt).',
    '',
    '2. What evidence is target-conditioned?',
    '- The production spectral benchmark path uses a single-note injected runtime model per case (`buildSingleNoteRuntimeModel`), so baseline detection is conditioned by the expected target context.',
    '',
    '3. What evidence is missing for exact-position discrimination?',
    '- Independent same-midi string/fret discrimination remains missing; same-pitch pair probes frequently report ambiguous position instead of robust string/fret separation.',
    '',
    '## Probe Metrics',
    '',
    `- Frames with probe telemetry: ${probeFrames.length}.`,
    `- Expected target avg rank: ${formatNullable(expectedRanks.length > 0 ? average(expectedRanks) : null, 3)}.`,
    `- Expected target top-1/top-3 rate: ${formatPct(expectedTop1Rate)} / ${formatPct(expectedTop3Rate)}.`,
    `- Mean expected pairwise win rate: ${formatNullable(expectedPairwiseWinRates.length > 0 ? average(expectedPairwiseWinRates) : null, 3)}.`,
    `- Mean expected-vs-best margin: ${formatNullable(expectedVsBestMargins.length > 0 ? average(expectedVsBestMargins) : null, 3)}.`,
    `- Octave confusion rate: ${formatPct(octaveConfusionRate)}.`,
    `- Expected-vs-source win rate: ${formatPct(expectedVsSourceRate)}.`,
    `- Same-pitch-alt ambiguity rate: ${formatPct(samePitchAmbiguityRate)}.`,
    `- Raw candidate-score availability: ${formatPct(rawCandidateScoreAvailability)}.`,
    '',
    '## Exact-Position Verdict',
    '',
    `- Verdict: **${exactPositionVerdict}**.`,
    `- ${reportJson.limitationSummary}`,
    ''
  ].join('\n');

  await fs.writeFile(path.join(outputDir, 'spectral_probe_report.json'), `${JSON.stringify(reportJson, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'spectral_probe_report.md'), reportMd, 'utf8');
}

async function writeEvidenceAudit(
  outputDir: string,
  telemetryRows: ValidatorCaseTelemetry[]
): Promise<void> {
  const rowsByAlgorithm = new Map<AlgorithmName, ValidatorCaseTelemetry[]>();
  for (const algorithm of ALGORITHMS) rowsByAlgorithm.set(algorithm, []);
  for (const row of telemetryRows) {
    rowsByAlgorithm.get(row.algorithm)?.push(row);
  }

  const summaryRows = ALGORITHMS.map((algorithm) => {
    const cases = rowsByAlgorithm.get(algorithm) ?? [];
    const frames = cases.flatMap((item) => item.frames);
    const nonNullSamePitchAlt = frames.filter((frame) => frame.samePitchAltScore !== null).length;
    const independentPositionEvidence = frames.filter((frame) =>
      frame.spectralProbe?.pairwise.some((pair) =>
        pair.competitorClass === 'same_pitch_alt' &&
        pair.detectedString !== null &&
        pair.detectedFret !== null
      ) ?? false
    ).length;
    const limitations = [...new Set(frames.flatMap((frame) => frame.sharedEvidenceLimitations))];

    return {
      algorithm,
      expectedNoteEvidence:
        frames.some((frame) => frame.expectedRank !== null)
          ? 'Expected score + expected rank/top-K frame evidence.'
          : 'Expected score only; rank/top-K unavailable.',
      nearbyCompetitorEvidence:
        frames.some((frame) => Number.isFinite(frame.neighborScore))
          ? 'Nearby-note competitor score available (shared field: neighborScore).'
          : 'Nearby-note competitor evidence unavailable.',
      octaveCompetitorEvidence:
        frames.some((frame) => Number.isFinite(frame.bestOctaveScore))
          ? 'Octave competitor score available (shared field: bestOctaveScore).'
          : 'Octave competitor evidence unavailable.',
      samePitchAltEvidence:
        nonNullSamePitchAlt > 0
          ? 'Direct same-pitch-alt competitor score available.'
          : 'No independent same-pitch-alt score; only proxy/implicit evidence.',
      independentPositionEvidence:
        independentPositionEvidence > 0
          ? 'Present in probe telemetry on a subset of frames.'
          : 'Unavailable or ambiguous (no stable independent string/fret evidence).',
      limitations: limitations.length > 0 ? limitations.join('; ') : 'None recorded.'
    };
  });

  const directlyComparable = [
    'expected_target_score',
    'best_competitor_score',
    'best_octave_score',
    'nearby_competitor_score',
    'expected_rank/top-K (now present for both, but MASP rank is midi-only)',
    'expected_vs_source outcome (spectral probe direct, MASP proxy)'
  ];

  const md = [
    '# MASP vs Spectral Evidence Audit',
    '',
    'This audit documents evidence asymmetry before threshold tuning. Shared decision logic consumes the same conceptual fields, with `null` where evidence is unavailable.',
    '',
    '| Algorithm | Expected-note evidence | Nearby-note competitor evidence | Octave competitor evidence | Same-pitch-alt-string evidence | Independent position evidence | Limitations |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summaryRows.map((row) =>
      `| ${row.algorithm} | ${row.expectedNoteEvidence} | ${row.nearbyCompetitorEvidence} | ${row.octaveCompetitorEvidence} | ${row.samePitchAltEvidence} | ${row.independentPositionEvidence} | ${row.limitations} |`
    ),
    '',
    '## Evidence Asymmetry',
    '',
    '- Spectral probe exposes explicit pairwise competitor outcomes and direct same-pitch-alt competitor classes.',
    '- MASP path remains midi-score centric; same-pitch alternate string evidence is not independently observable and is explicitly marked unavailable.',
    '- Both algorithms now expose shared comparator fields used by the same decision semantics; unavailable fields remain `null` and are not fabricated.',
    '',
    '## Directly Comparable Shared Fields',
    '',
    ...directlyComparable.map((item) => `- ${item}`),
    ''
  ].join('\n');

  await fs.writeFile(path.join(outputDir, 'evidence_audit.md'), md, 'utf8');
  await fs.writeFile(path.join(outputDir, 'evidence_audit.json'), `${JSON.stringify(summaryRows, null, 2)}\n`, 'utf8');
}

function buildCsv(rows: ValidatorRow[]): string {
  const header = [
    'algorithm',
    'case_id',
    'source_file_id',
    'source_relative_file_path',
    'source_string',
    'source_fret',
    'source_take',
    'source_string_band',
    'source_fret_band',
    'target_kind',
    'mismatch_type',
    'expected_accept',
    'expected_string',
    'expected_fret',
    'expected_midi',
    'note_decision_config_id',
    'aggregation_policy_id',
    'activation_gate_policy_id',
    'decision_mode',
    'decision_accept',
    'decision_reason',
    'confidence_score',
    'hit_frame_count',
    'hit_frame_count_expected',
    'hit_frame_count_any',
    'hit_frame_count_position',
    'wrong_accept_frame_count',
    'total_frame_count',
    'expected_frame_ratio',
    'position_frame_ratio',
    'min_consecutive_expected_frames',
    'min_consecutive_position_frames',
    'first_expected_hit_latency_ms',
    'first_any_hit_latency_ms',
    'expected_cents_error_median',
    'expected_score_median',
    'best_competitor_score_median',
    'best_competitor_midi_mode',
    'best_octave_competitor_score_median',
    'expected_vs_best_margin_median',
    'expected_vs_best_ratio_median',
    'expected_vs_octave_margin_median',
    'expected_rank_median',
    'expected_top1_frame_ratio',
    'expected_top3_frame_ratio',
    'expected_pairwise_win_rate_mean',
    'octave_confusion_frame_ratio',
    'expected_vs_source_frame_ratio',
    'position_ambiguous_frame_ratio',
    'same_pitch_alt_detected_frame_count',
    'same_pitch_alt_candidate_exists',
    'decision_latency_ms',
    'runtime_avg_ms',
    'runtime_p95_ms'
  ];
  const out = [header.join(',')];
  for (const row of rows) {
    out.push([
      row.algorithm,
      row.caseId,
      row.sourceFileId,
      row.sourceRelativeFilePath,
      row.sourceStringId,
      row.sourceFret,
      row.sourceTake,
      row.sourceStringBand,
      row.sourceFretBand,
      row.targetKind,
      row.mismatchType,
      row.expectedAccept,
      row.expectedString,
      row.expectedFret,
      row.expectedMidi,
      row.noteDecisionConfigId,
      MONO_NOTE_SET_POLICY.id,
      MONO_ACTIVATION_GATE_POLICY.id,
      row.decisionMode,
      row.decisionAccept,
      row.decisionReason,
      row.confidenceScore,
      row.hitFrameCount,
      row.hitFrameCountExpected,
      row.hitFrameCountAny,
      row.hitFrameCountPosition,
      row.wrongAcceptFrameCount,
      row.totalFrameCount,
      row.expectedFrameRatio,
      row.positionFrameRatio,
      row.minConsecutiveExpectedFrames,
      row.minConsecutivePositionFrames,
      row.firstExpectedHitLatencyMs,
      row.firstAnyHitLatencyMs,
      row.expectedCentsErrorMedian,
      row.expectedScoreMedian,
      row.bestCompetitorScoreMedian,
      row.bestCompetitorMidiMode,
      row.bestOctaveCompetitorScoreMedian,
      row.expectedVsBestMarginMedian,
      row.expectedVsBestRatioMedian,
      row.expectedVsOctaveMarginMedian,
      row.expectedRankMedian,
      row.expectedTop1FrameRatio,
      row.expectedTop3FrameRatio,
      row.expectedPairwiseWinRateMean,
      row.octaveConfusionFrameRatio,
      row.expectedVsSourceFrameRatio,
      row.positionAmbiguousFrameRatio,
      row.samePitchAltDetectedFrameCount,
      row.samePitchAltCandidateExists,
      row.decisionLatencyMs,
      row.runtimeAvgMs,
      row.runtimeP95Ms
    ].map((value) => csvEscape(formatCsvValue(value))).join(','));
  }
  return out.join('\n');
}

async function writePlots(plotsDir: string, aggregates: Record<AlgorithmName, ValidatorAggregate>): Promise<void> {
  await fs.writeFile(path.join(plotsDir, 'tar_far_by_algorithm.svg'), buildTarFarPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'precision_recall_f1.svg'), buildPrfPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'latency_by_algorithm.svg'), buildLatencyPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'low_string_tar_far.svg'), buildLowStringPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'mismatch_far_by_type.svg'), buildMismatchFarPlot(aggregates), 'utf8');
}

function buildTarFarPlot(aggregates: Record<AlgorithmName, ValidatorAggregate>): string {
  return buildGroupedRatePlot(
    'TAR vs FAR (Gameplay Validator)',
    [
      { key: 'tar', label: 'TAR', color: '#22c55e' },
      { key: 'far', label: 'FAR', color: '#f97316' }
    ],
    aggregates
  );
}

function buildPrfPlot(aggregates: Record<AlgorithmName, ValidatorAggregate>): string {
  return buildGroupedRatePlot(
    'Precision / Recall / F1',
    [
      { key: 'precision', label: 'Precision', color: '#38bdf8' },
      { key: 'recall', label: 'Recall', color: '#22c55e' },
      { key: 'f1', label: 'F1', color: '#a78bfa' }
    ],
    aggregates
  );
}

function buildLowStringPlot(aggregates: Record<AlgorithmName, ValidatorAggregate>): string {
  return buildGroupedRatePlot(
    'Low-String Validator Metrics',
    [
      { key: 'lowStringTar', label: 'Low TAR', color: '#22c55e' },
      { key: 'lowStringFar', label: 'Low FAR', color: '#f97316' }
    ],
    aggregates
  );
}

function buildGroupedRatePlot(
  title: string,
  metrics: Array<{ key: keyof ValidatorAggregate; label: string; color: string }>,
  aggregates: Record<AlgorithmName, ValidatorAggregate>
): string {
  const width = 980;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 90 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(ALGORITHMS, margin.left, margin.left + innerWidth, 0.26);
  const subScale = bandScale(metrics.map((metric) => metric.label), 0, groupScale.bandWidth, 0.18);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const x0 = groupScale.positionForValue(algorithm) ?? margin.left;
    for (const metric of metrics) {
      const sx = subScale.positionForValue(metric.label) ?? 0;
      const value = Number(aggregates[algorithm][metric.key] ?? 0);
      const top = y(value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${metric.color}" fill-opacity="0.88" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(value)}</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 24}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
  }

  elements.push(...buildLegend(metrics.map((metric) => ({ label: metric.label, color: metric.color })), width - 210, 90));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildLatencyPlot(aggregates: Record<AlgorithmName, ValidatorAggregate>): string {
  const width = 920;
  const height = 460;
  const margin = { left: 80, right: 28, top: 58, bottom: 72 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const values = ALGORITHMS.map((algorithm) => ({
    label: algorithm,
    value: aggregates[algorithm].medianDecisionLatencyMs ?? 0,
    color: colorForAlgorithm(algorithm),
    text: formatNullable(aggregates[algorithm].medianDecisionLatencyMs, 1, ' ms')
  }));

  const x = bandScale(values.map((value) => value.label), margin.left, margin.left + innerWidth, 0.28);
  const maxValue = Math.max(1, ...values.map((value) => value.value));
  const y = linearScale(0, maxValue * 1.15, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Median Decision Latency (ms)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const value of values) {
    const x0 = x.positionForValue(value.label) ?? margin.left;
    const top = y(value.value);
    const h = margin.top + innerHeight - top;
    elements.push(`<rect x="${x0.toFixed(2)}" y="${top.toFixed(2)}" width="${(x.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${value.color}" fill-opacity="0.86" />`);
    elements.push(`<text x="${(x0 + x.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(value.text)}</text>`);
    elements.push(`<text x="${(x0 + x.bandWidth / 2).toFixed(2)}" y="${height - 18}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(value.label)}</text>`);
  }

  elements.push('</svg>');
  return elements.join('\n');
}

function buildMismatchFarPlot(aggregates: Record<AlgorithmName, ValidatorAggregate>): string {
  const mismatchTypes = [...new Set(ALGORITHMS.flatMap((algorithm) => Object.keys(aggregates[algorithm].mismatchFarByType)))];
  const width = 1100;
  const height = 560;
  const margin = { left: 90, right: 28, top: 58, bottom: 100 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(mismatchTypes, margin.left, margin.left + innerWidth, 0.22);
  const subScale = bandScale(ALGORITHMS, 0, groupScale.bandWidth, 0.2);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">FAR by Mismatch Type</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const mismatchType of mismatchTypes) {
    const x0 = groupScale.positionForValue(mismatchType) ?? margin.left;
    for (const algorithm of ALGORITHMS) {
      const sx = subScale.positionForValue(algorithm) ?? 0;
      const value = aggregates[algorithm].mismatchFarByType[mismatchType] ?? 0;
      const top = y(value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.86" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="10" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(value)}</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 22}" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(mismatchType)}</text>`);
  }

  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 220, 90));
  elements.push('</svg>');
  return elements.join('\n');
}

async function writeSummary(
  outputDir: string,
  datasetFileCount: number,
  aggregates: Record<AlgorithmName, ValidatorAggregate>,
  baselineAggregates: Record<AlgorithmName, ValidatorAggregate>,
  config: ValidatorDecisionConfig,
  baselineConfig: ValidatorDecisionConfig
): Promise<void> {
  const summary = [
    '# Gameplay Validator Benchmark Suite',
    '',
    '## Scope',
    '',
    '- Task: target-aware gameplay validation (single-note cases; chord-ready structure).',
    '- Canonical mono stack: note decision config + mono note-set cardinality-1 aggregation + gate-off policy.',
    '- Algorithms: `MASP`, `spectral_game_runtime_unified_v3`.',
    '- Input policy: RAW only.',
    '- This suite evaluates validator correctness, not generic detector ranking.',
    '- Dataset path: `' + WINDOWS_DATASET_ROOT + '`.',
    `- WAV files analyzed: ${datasetFileCount}.`,
    '',
    '## Decision Configuration',
    '',
    '- Baseline config: ' + baselineConfig.id + ' (' + baselineConfig.mode + ').',
    '- Candidate config: ' + config.id + ' (' + config.mode + ').',
    '- Note decision config id: ' + config.id + '.',
    '- Aggregation policy id: ' + MONO_NOTE_SET_POLICY.id + ' (mono cardinality-1).',
    '- Activation gate policy id: ' + MONO_ACTIVATION_GATE_POLICY.id + ' (gate disabled).',
    `- Candidate note thresholds: min score ${config.note.minExpectedScore}, min frame ratio ${formatPct(config.note.minExpectedFrameRatio)}, min consecutive ${config.note.minConsecutiveExpectedFrames}, max cents ${config.note.maxExpectedCentsError}, min confidence ${roundNumber(config.note.minExpectedConfidence, 3)}, margin(best) ${roundNumber(config.note.minExpectedVsBestMargin, 3)}, ratio(best) ${roundNumber(config.note.minExpectedVsBestRatio, 3)}, margin(octave) ${roundNumber(config.note.minExpectedVsOctaveMargin, 3)}, ignore attack ${roundNumber(config.note.ignoreAttackMs, 1)} ms, top-1 ratio ${formatPct(config.note.minExpectedTop1FrameRatio)}, top-3 ratio ${formatPct(config.note.minExpectedTop3FrameRatio)}, pairwise win-rate ${formatPct(config.note.minExpectedPairwiseWinRate)}, max octave confusion ${formatPct(config.note.maxOctaveConfusionFrameRatio)}, expected-vs-source ratio ${formatPct(config.note.minExpectedVsSourceFrameRatio)}.`,
    '',
    '## Metrics (Candidate)',
    '',
    '| Algorithm | TAR | Strict FAR | Note-mismatch FAR | Position-only FAR | Precision | Recall | F1 | Median Decision Latency | Runtime avg / p95 (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const agg = aggregates[algorithm];
      return `| ${algorithm} | ${formatPct(agg.tar)} | ${formatPct(agg.strictFar)} | ${formatPct(agg.noteMismatchFar)} | ${formatPct(agg.positionOnlyFar)} | ${formatPct(agg.precision)} | ${formatPct(agg.recall)} | ${formatPct(agg.f1)} | ${formatNullable(agg.medianDecisionLatencyMs, 1, ' ms')} | ${agg.runtimeAvgMs.toFixed(3)} / ${agg.runtimeP95Ms.toFixed(3)} |`;
    }),
    '',
    '## Baseline vs Candidate (TAR/FAR)',
    '',
    '| Algorithm | Baseline TAR | Candidate TAR | Baseline Strict FAR | Candidate Strict FAR |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const base = baselineAggregates[algorithm];
      const cand = aggregates[algorithm];
      return `| ${algorithm} | ${formatPct(base.tar)} | ${formatPct(cand.tar)} | ${formatPct(base.strictFar)} | ${formatPct(cand.strictFar)} |`;
    }),
    '',
    '## FAR by Mismatch Type (Candidate)',
    '',
    '| Algorithm | neighbor_fret | octave_distractor | nearby_note_distractor | same_pitch_alt_string |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const mismatch = aggregates[algorithm].mismatchFarByType;
      return `| ${algorithm} | ${formatPct(mismatch.neighbor_fret ?? 0)} | ${formatPct(mismatch.octave_distractor ?? 0)} | ${formatPct(mismatch.nearby_note_distractor ?? 0)} | ${formatPct(mismatch.same_pitch_alt_string ?? 0)} |`;
    }),
    '',
    '## String-Band TAR/FAR (Candidate)',
    '',
    '| Algorithm | Low TAR / FAR | Mid TAR / FAR | High TAR / FAR |',
    '| --- | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const bands = aggregates[algorithm].tarFarByStringBand;
      return `| ${algorithm} | ${formatPct(bands.low.tar)} / ${formatPct(bands.low.far)} | ${formatPct(bands.mid.tar)} / ${formatPct(bands.mid.far)} | ${formatPct(bands.high.tar)} / ${formatPct(bands.high.far)} |`;
    }),
    '',
    '## Fret-Band TAR/FAR (Candidate)',
    '',
    '| Algorithm | Low TAR / FAR | Mid TAR / FAR | High TAR / FAR |',
    '| --- | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const bands = aggregates[algorithm].tarFarByFretBand;
      return `| ${algorithm} | ${formatPct(bands.low.tar)} / ${formatPct(bands.low.far)} | ${formatPct(bands.mid.tar)} / ${formatPct(bands.mid.far)} | ${formatPct(bands.high.tar)} / ${formatPct(bands.high.far)} |`;
    }),
    '',
    '## Output Files',
    '',
    '- `results.json`',
    '- `results.csv`',
    '- `diagnostics.json`',
    '- `evidence_audit.json`',
    '- `evidence_audit.md`',
    '- `spectral_probe_report.json`',
    '- `spectral_probe_report.md`',
    '- `summary.md`',
    '- `plots/`',
    ''
  ].join('\n');

  await fs.writeFile(path.join(outputDir, 'summary.md'), summary, 'utf8');
}

function asFiniteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function ratio(values: boolean[]): number {
  if (values.length <= 0) return 0;
  return values.filter(Boolean).length / values.length;
}

function midiFor(stringId: number, fret: number): number {
  return midiForStringFret(stringId, fret);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
