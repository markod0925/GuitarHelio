#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FeatureExtractionService } from '../../src/audio/FeatureExtractionService';
import { midiForStringFret } from '../../src/guitar/tuning';
import { PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { midiToHz } from '../../src/ui/song-select/utils/songSelectUtils';
import { MASP_TUNED_PARAMS, scoreMaspMidiFrame, type MaspHarmonicMap } from '../../src/audio/maspCore';
import type { PrecomputedFeatures } from '../../src/pitch/types';
import {
  ALGORITHMS,
  DEFAULT_VALIDATOR_DECISION_CONFIG,
  LEGACY_VALIDATOR_DECISION_CONFIG,
  parseDecisionConfigFromEnv,
  type AlgorithmName,
  type SpectralProbeCandidateScore,
  type SpectralProbeCompetitorClass,
  type SpectralProbeFrameTelemetry,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig
} from './gameplay_validator_core';
import {
  FRAME_SIZE,
  HOP_SIZE,
  DspCoreDetector,
  buildAllStringFretPositions,
  buildFeatureContextWithTarget,
  buildFrameStartsFullCoverage,
  buildSingleNoteRuntimeModel,
  createMaspDetector,
  csvEscape,
  decodeMonoAudio,
  finiteNumber,
  findClosestPositionForMidi,
  formatCsvValue,
  formatNullable,
  formatPct,
  readFrame,
  roundNumber
} from './shared';
import {
  DEFAULT_ACTIVATION_GATE_POLICY,
  DEFAULT_NOTE_SET_POLICY,
  DEFAULT_WINDOW_STABILITY_CONFIG,
  buildExpectedNoteWindows,
  discoverWavJamsPairs,
  evaluatePolyphonicTelemetryForConfig,
  parseActivationGatePolicyFromEnv,
  parseJamsNoteEventsFromFile,
  parseNoteSetAggregationPolicyFromEnv,
  parseWindowStabilityConfigFromEnv,
  type ActivationGatePolicy,
  type DatasetBucket,
  type NoteSetMetrics,
  type PolyphonicWindowTelemetry,
  type WavJamsPair
} from './gameplay_validator_polyphonic';

type SpectralProbeCandidate = {
  noteId: string;
  stringId: number;
  fret: number;
  midi: number;
  competitorClass: SpectralProbeCompetitorClass;
};

type SpectralProbePlanLite = {
  expected: SpectralProbeCandidate;
  candidates: SpectralProbeCandidate[];
  aggregateModelJson: string;
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

type WindowPreparedFrame = {
  frameIndex: number;
  timestampMs: number;
  frame: Float32Array;
  baseFeatures: PrecomputedFeatures;
  maspScores: number[];
};

type JamsAuditRow = {
  fileId: string;
  wavRelativePath: string;
  jamsRelativePath: string;
  subset: string;
  noteEventCount: number;
  sourceTrackCount: number;
  droppedObservationCount: number;
  fileDurationSec: number | null;
  namespaceCounts: Record<string, number>;
};

type RawDetectionSummary = {
  midis: number[];
  maxConfidence: number | null;
  activeFrameRatio: number | null;
};

const OUTPUT_ROOT = 'analysis/gameplay_validator_benchmark_poly';
const DATASET_ROOT = 'tools/pitch-offline-bench/input/wav';
const MASP_MIDI_MAX = 88;
const MASP_HARMONIC_LOCAL_BANDWIDTH_BINS = 2;
const SPECTRAL_RAW_MIN_CONFIDENCE = 0.2;
const EPS = 1e-9;

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const datasetDir = path.resolve(repoRoot, DATASET_ROOT);
  const outputDir = path.resolve(repoRoot, OUTPUT_ROOT);
  await fs.mkdir(outputDir, { recursive: true });

  const windowDurationSec = parseEnvFloat('GAMEPLAY_VALIDATOR_POLY_WINDOW_SEC', 0.45, 0.08);
  const windowHopSec = parseEnvFloat('GAMEPLAY_VALIDATOR_POLY_HOP_SEC', 0.225, 0.04);
  const minEventOverlapSec = parseEnvFloat('GAMEPLAY_VALIDATOR_POLY_MIN_OVERLAP_SEC', 0.03, 0);
  const maxWindowsPerFile = parseEnvIntNullable('GAMEPLAY_VALIDATOR_POLY_MAX_WINDOWS_PER_FILE', 24, 1);
  const maxFramesPerWindow = parseEnvInt('GAMEPLAY_VALIDATOR_POLY_MAX_FRAMES_PER_WINDOW', 10, 2);
  const includeSilentWindows = parseEnvBool('GAMEPLAY_VALIDATOR_POLY_INCLUDE_SILENT_WINDOWS', true);
  const maxFiles = parseEnvIntNullable('GAMEPLAY_VALIDATOR_POLY_MAX_FILES', null, 1);
  const windowStabilityConfig = parseWindowStabilityConfigFromEnv(DEFAULT_WINDOW_STABILITY_CONFIG);

  const pairs = await discoverWavJamsPairs(datasetDir);
  if (pairs.length <= 0) {
    throw new Error(`No WAV/JAMS pairs found under ${datasetDir}`);
  }

  const filteredPairs = filterPairsBySubset(pairs, process.env.GAMEPLAY_VALIDATOR_POLY_SUBSET);
  const selectedPairs = maxFiles !== null ? filteredPairs.slice(0, maxFiles) : filteredPairs;
  if (selectedPairs.length <= 0) {
    throw new Error('No WAV/JAMS pairs selected after subset/max-file filtering.');
  }

  const allPositions = buildAllStringFretPositions(12);
  const fullBoardModel = buildRuntimeModelForProbe(
    allPositions.map((position) =>
      buildProbeCandidate(position.stringId, position.fret, position.midi, 'other')
    )
  );

  const maspEvidenceMaps = buildMaspHarmonicMaps(
    MASP_TUNED_PARAMS.strictSampleRate,
    FRAME_SIZE,
    MASP_TUNED_PARAMS.midiMin,
    MASP_MIDI_MAX,
    MASP_TUNED_PARAMS.maxHarmonics,
    MASP_HARMONIC_LOCAL_BANDWIDTH_BINS
  );

  const masp = createMaspDetector();
  const maspRaw = createMaspDetector();
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
  const spectralRaw = new DspCoreDetector(
    'spectral_game_runtime_unified_v3_raw',
    PitchDetectorPreset.SpectralGameRuntimeUnifiedV3,
    JSON.stringify(fullBoardModel)
  );

  await masp.init();
  await maspRaw.init();
  await spectral.init();
  await spectralProbe.init();
  await spectralRaw.init();

  const windowTelemetry: PolyphonicWindowTelemetry[] = [];
  const jamsAudits: JamsAuditRow[] = [];

  try {
    for (let fileIndex = 0; fileIndex < selectedPairs.length; fileIndex += 1) {
      const pair = selectedPairs[fileIndex];
      if (fileIndex % 10 === 0 || fileIndex + 1 === selectedPairs.length) {
        console.log(`[gameplay-validator-poly] ${fileIndex + 1}/${selectedPairs.length} ${pair.wavRelativePath}`);
      }

      const [decoded, jamsParsed] = await Promise.all([
        decodeMonoAudio(pair.wavPath),
        parseJamsNoteEventsFromFile(pair.jamsPath)
      ]);

      jamsAudits.push({
        fileId: pair.fileId,
        wavRelativePath: pair.wavRelativePath,
        jamsRelativePath: pair.jamsRelativePath,
        subset: pair.subset,
        noteEventCount: jamsParsed.audit.noteEventCount,
        sourceTrackCount: jamsParsed.audit.sourceTrackCount,
        droppedObservationCount: jamsParsed.audit.droppedObservationCount,
        fileDurationSec: jamsParsed.audit.fileDurationSec,
        namespaceCounts: jamsParsed.audit.namespaceCounts
      });

      const windows = buildExpectedNoteWindows({
        events: jamsParsed.events,
        fileId: pair.fileId,
        wavRelativePath: pair.wavRelativePath,
        subset: pair.subset,
        durationSec: decoded.samples.length / decoded.sampleRate,
        windowDurationSec,
        windowHopSec,
        minEventOverlapSec,
        includeSilentWindows,
        maxWindowsPerFile,
        stableWindowMinRatio: windowStabilityConfig.stableWindowMinRatio,
        transitionOverlapThreshold: windowStabilityConfig.transitionOverlapThreshold
      });

      if (windows.length <= 0) {
        continue;
      }

      const featureService = new FeatureExtractionService(FRAME_SIZE);

      for (const window of windows) {
        const preparedFrames = buildPreparedWindowFrames({
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
          startSec: window.startSec,
          endSec: window.endSec,
          maxFrames: maxFramesPerWindow,
          featureService,
          maspEvidenceMaps
        });

        if (preparedFrames.length <= 0) {
          continue;
        }

        const expectedMidis = window.expectedMidis;

        for (const algorithm of ALGORITHMS) {
          const rawDetection = collectRawDetectedMidis({
            algorithm,
            frames: preparedFrames,
            sampleRate: decoded.sampleRate,
            fullBoardModel,
            maspRawDetector: maspRaw,
            spectralRawDetector: spectralRaw,
            minConfidence: SPECTRAL_RAW_MIN_CONFIDENCE
          });

          const perNoteTelemetry: ValidatorCaseTelemetry[] = [];

          for (const expectedMidi of expectedMidis) {
            const target = pickTargetPosition(allPositions, expectedMidi);
            const runtimeModel = buildSingleNoteRuntimeModel(target);
            const runtimeModelJson = JSON.stringify(runtimeModel);
            const spectralPlan = buildSpectralProbePlanLite(target, allPositions);

            const detector = algorithm === 'MASP' ? masp : spectral;
            if (algorithm === 'spectral_game_runtime_unified_v3') {
              spectral.updateSpectralModel(runtimeModelJson);
            }
            detector.reset();

            const frames: ValidatorCaseTelemetry['frames'] = [];
            for (const prepared of preparedFrames) {
              const optionalFeatures = buildFeatureContextWithTarget(prepared.baseFeatures, target, runtimeModel);

              const startedAt = performance.now();
              const result = detector.processFrame({
                timestampMs: prepared.timestampMs,
                frameIndex: prepared.frameIndex,
                sampleRate: decoded.sampleRate,
                rawFrame: prepared.frame,
                processedFrame: prepared.frame,
                analysisWindowId: prepared.frameIndex,
                optionalFeatures
              });
              const runtimeMs = performance.now() - startedAt;

              const evidence = algorithm === 'MASP'
                ? buildMaspFrameEvidenceFromScores(prepared.maspScores, expectedMidi)
                : analyzeSpectralProbeFrameLite({
                  detector: spectralProbe,
                  frameInput: {
                    timestampMs: prepared.timestampMs,
                    frameIndex: prepared.frameIndex,
                    sampleRate: decoded.sampleRate,
                    rawFrame: prepared.frame,
                    processedFrame: prepared.frame,
                    analysisWindowId: prepared.frameIndex,
                    optionalFeatures
                  },
                  plan: spectralPlan
                });

              const rawDetectedMidi = finiteNumber(result.midi);
              const rawConfidence = finiteNumber(result.confidence) ?? 0;
              let detectedMidi = rawDetectedMidi;
              let confidence = rawConfidence;
              let detectorAccepted = result.accepted;
              const detectedString = asFiniteInt(result.stringId);
              const detectedFret = asFiniteInt(result.fret);

              // MASP target-aware acceptance is frequently false on polyphonic material; derive
              // note-hit support from per-note competitor-aware evidence for poly benchmarking.
              if (algorithm === 'MASP') {
                const noteDominance = evidence.expectedScore / Math.max(EPS, evidence.expectedScore + evidence.bestCompetitorScore);
                const maspNoteHit = evidence.expectedScore > 0 && evidence.expectedScore >= evidence.bestCompetitorScore;
                confidence = clamp(noteDominance, 0, 1);
                detectorAccepted = maspNoteHit;
                detectedMidi = maspNoteHit ? expectedMidi : (evidence.bestCompetitorMidi ?? rawDetectedMidi);
              }

              const expectedCentsError = detectedMidi !== null ? (detectedMidi - expectedMidi) * 100 : null;
              const expectedMidiHit = expectedCentsError !== null && Math.abs(expectedCentsError) <= 50;
              const expectedPositionMatch = expectedMidiHit &&
                detectedString === target.stringId &&
                detectedFret === target.fret;
              const samePitchAltDetected = expectedMidiHit &&
                detectedString !== null &&
                detectedFret !== null &&
                !expectedPositionMatch;

              frames.push({
                frameIndex: prepared.frameIndex,
                timestampMs: prepared.timestampMs,
                runtimeMs,
                detectorAccepted,
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

            perNoteTelemetry.push({
              algorithm,
              caseId: `${window.windowId}__m${expectedMidi}`,
              sourceFileId: pair.fileId,
              sourceRelativeFilePath: pair.wavRelativePath,
              sourceStringId: target.stringId,
              sourceFret: target.fret,
              sourceTake: parseTakeFromFileId(pair.fileId),
              sourceStringBand: stringBandFor(target.stringId),
              targetKind: 'single_note',
              mismatchType: 'correct_target',
              expectedAccept: true,
              expectedString: target.stringId,
              expectedFret: target.fret,
              expectedMidi,
              samePitchAltCandidateExists: false,
              frames
            });
          }

          windowTelemetry.push({
            algorithm,
            windowId: window.windowId,
            fileId: pair.fileId,
            wavRelativePath: pair.wavRelativePath,
            subset: pair.subset,
            startSec: window.startSec,
            endSec: window.endSec,
            expectedMidis,
            expectedDominantMidis: window.expectedDominantMidis,
            expectedSegmentCount: window.expectedSegmentCount,
            expectedActiveRatio: window.expectedActiveRatio,
            stableSetRatio: window.stableSetRatio,
            transitionOverlapRatio: window.transitionOverlapRatio,
            noteSetChangeCount: window.noteSetChangeCount,
            baseWindowCategory: window.baseWindowCategory,
            windowCategory: window.windowCategory,
            isStableWindow: window.isStableWindow,
            rawDetectedMidis: rawDetection.midis,
            rawDetectionMaxConfidence: rawDetection.maxConfidence,
            rawDetectionFrameRatio: rawDetection.activeFrameRatio,
            perNoteTelemetry
          });
        }
      }
    }
  } finally {
    spectral.dispose?.();
    spectralProbe.dispose?.();
    spectralRaw.dispose?.();
  }

  const decisionConfig = parseDecisionConfigFromEnv(DEFAULT_VALIDATOR_DECISION_CONFIG);
  const noteSetPolicy = parseNoteSetAggregationPolicyFromEnv(DEFAULT_NOTE_SET_POLICY);
  const activationGatePolicy = parseActivationGatePolicyFromEnv(DEFAULT_ACTIVATION_GATE_POLICY);
  const baselineConfig = LEGACY_VALIDATOR_DECISION_CONFIG;

  const candidateEval = evaluatePolyphonicTelemetryForConfig({
    windowTelemetry,
    decisionConfig,
    noteSetPolicy,
    activationGatePolicy,
    algorithms: ALGORITHMS
  });
  const baselineEval = evaluatePolyphonicTelemetryForConfig({
    windowTelemetry,
    decisionConfig: baselineConfig,
    noteSetPolicy,
    activationGatePolicy,
    algorithms: ALGORITHMS
  });

  await writeOutputs(outputDir, {
    selectedPairCount: selectedPairs.length,
    totalPairCount: pairs.length,
    datasetPath: DATASET_ROOT,
    decisionConfig,
    baselineConfig,
    noteSetPolicy,
    activationGatePolicy,
    candidateEval,
    baselineEval,
    windowTelemetry,
    jamsAudits,
    windowConfig: {
      windowDurationSec,
      windowHopSec,
      minEventOverlapSec,
      stableWindowMinRatio: windowStabilityConfig.stableWindowMinRatio,
      transitionOverlapThreshold: windowStabilityConfig.transitionOverlapThreshold,
      includeSilentWindows,
      maxWindowsPerFile,
      maxFramesPerWindow
    }
  });

  console.log(`[gameplay-validator-poly] windows: ${candidateEval.windowResults.length}`);
  console.log(`[gameplay-validator-poly] outputs: ${OUTPUT_ROOT}`);
}

function filterPairsBySubset(pairs: WavJamsPair[], rawSubset: string | undefined): WavJamsPair[] {
  if (!rawSubset) return pairs;
  const normalized = rawSubset.trim().toLowerCase();
  if (normalized === 'all' || normalized.length <= 0) return pairs;
  if (normalized !== 'solo' && normalized !== 'comp') return pairs;
  return pairs.filter((pair) => pair.subset === normalized);
}

function buildPreparedWindowFrames(input: {
  samples: Float32Array;
  sampleRate: number;
  startSec: number;
  endSec: number;
  maxFrames: number;
  featureService: FeatureExtractionService;
  maspEvidenceMaps: MaspHarmonicMap[];
}): WindowPreparedFrame[] {
  const startSample = Math.max(0, Math.floor(input.startSec * input.sampleRate));
  const endSample = Math.max(startSample + 1, Math.floor(input.endSec * input.sampleRate));
  const sampleCount = Math.max(1, endSample - startSample);

  const starts = buildFrameStartsFullCoverage(sampleCount, FRAME_SIZE, HOP_SIZE)
    .map((offset) => startSample + offset);
  const selectedStarts = sampleEvenly(starts, input.maxFrames);

  const out: WindowPreparedFrame[] = [];
  for (let index = 0; index < selectedStarts.length; index += 1) {
    const start = selectedStarts[index];
    const frame = readFrame(input.samples, start, FRAME_SIZE);
    const baseFeatures = input.featureService.extractFeatures(frame, input.sampleRate, null, null);
    const maspScores = scoreMaspMidiFrame(baseFeatures.magnitudeSpectrum, input.maspEvidenceMaps, MASP_TUNED_PARAMS);
    out.push({
      frameIndex: index,
      timestampMs: (start / input.sampleRate) * 1000,
      frame,
      baseFeatures,
      maspScores
    });
  }
  return out;
}

function collectRawDetectedMidis(input: {
  algorithm: AlgorithmName;
  frames: WindowPreparedFrame[];
  sampleRate: number;
  fullBoardModel: ReturnType<typeof buildRuntimeModelForProbe>;
  maspRawDetector: ReturnType<typeof createMaspDetector>;
  spectralRawDetector: DspCoreDetector;
  minConfidence: number;
}): RawDetectionSummary {
  const detected = new Set<number>();
  const runtimeModelJson = JSON.stringify(input.fullBoardModel);

  let maxConfidence: number | null = null;
  let activeFrameCount = 0;

  const detector = input.algorithm === 'MASP' ? input.maspRawDetector : input.spectralRawDetector;
  if (input.algorithm === 'spectral_game_runtime_unified_v3') {
    input.spectralRawDetector.updateSpectralModel(runtimeModelJson);
  }
  detector.reset();

  for (const frame of input.frames) {
    if (input.algorithm === 'MASP') {
      let topIndex = -1;
      let topScore = Number.NEGATIVE_INFINITY;
      let secondScore = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < frame.maspScores.length; index += 1) {
        const score = frame.maspScores[index] ?? Number.NEGATIVE_INFINITY;
        if (score > topScore) {
          secondScore = topScore;
          topScore = score;
          topIndex = index;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }

      if (topIndex >= 0 && topScore > 0) {
        const confidence = topScore / Math.max(EPS, topScore + Math.max(0, secondScore));
        if (maxConfidence === null || confidence > maxConfidence) {
          maxConfidence = confidence;
        }
        if (confidence >= input.minConfidence) {
          activeFrameCount += 1;
          detected.add(MASP_TUNED_PARAMS.midiMin + topIndex);
        }
      }
      continue;
    }

    const optionalFeatures = {
      ...frame.baseFeatures,
      referenceNote: null,
      spectralModel: input.fullBoardModel,
      candidateNotes: input.fullBoardModel.notes
    };

    const result = detector.processFrame({
      timestampMs: frame.timestampMs,
      frameIndex: frame.frameIndex,
      sampleRate: input.sampleRate,
      rawFrame: frame.frame,
      processedFrame: frame.frame,
      analysisWindowId: frame.frameIndex,
      optionalFeatures
    });

    const midi = finiteNumber(result.midi);
    const confidence = finiteNumber(result.confidence) ?? 0;
    if (maxConfidence === null || confidence > maxConfidence) {
      maxConfidence = confidence;
    }
    if (!result.accepted || midi === null || confidence < input.minConfidence) continue;
    activeFrameCount += 1;
    detected.add(Math.round(midi));
  }

  return {
    midis: [...detected].sort((left, right) => left - right),
    maxConfidence,
    activeFrameRatio: input.frames.length > 0 ? activeFrameCount / input.frames.length : null
  };
}

function pickTargetPosition(
  allPositions: Array<{ stringId: number; fret: number; midi: number }>,
  expectedMidi: number
): { stringId: number; fret: number; midi: number } {
  const exact = findClosestPositionForMidi(allPositions, expectedMidi, 3);
  if (exact) return exact;
  const fallback = allPositions
    .slice()
    .sort((left, right) =>
      Math.abs(left.midi - expectedMidi) - Math.abs(right.midi - expectedMidi) ||
      left.stringId - right.stringId ||
      left.fret - right.fret
    )[0];
  return fallback ?? { stringId: 1, fret: 0, midi: expectedMidi };
}

function buildMaspFrameEvidenceFromScores(scores: number[], expectedMidi: number): FrameEvidence {
  const midiMin = MASP_TUNED_PARAMS.midiMin;
  const expectedIdx = expectedMidi - midiMin;
  const expectedScore = expectedIdx >= 0 && expectedIdx < scores.length ? scores[expectedIdx] : 0;

  let bestCompetitorScore = 0;
  let bestCompetitorMidi: number | null = null;
  for (let index = 0; index < scores.length; index += 1) {
    const midi = midiMin + index;
    if (midi === expectedMidi) continue;
    const score = scores[index] ?? 0;
    if (score > bestCompetitorScore) {
      bestCompetitorScore = score;
      bestCompetitorMidi = midi;
    }
  }

  const octaveScore = Math.max(
    safeScore(scores, expectedMidi + 12, midiMin),
    safeScore(scores, expectedMidi - 12, midiMin)
  );
  const neighborScore = Math.max(
    safeScore(scores, expectedMidi + 1, midiMin),
    safeScore(scores, expectedMidi - 1, midiMin)
  );

  const ordered = scores
    .map((score, index) => ({ score, midi: midiMin + index }))
    .sort((left, right) => right.score - left.score || left.midi - right.midi);
  const expectedRankIndex = ordered.findIndex((entry) => entry.midi === expectedMidi);
  const expectedRank = expectedRankIndex >= 0 ? expectedRankIndex + 1 : null;

  return {
    expectedScore,
    bestCompetitorScore,
    bestCompetitorMidi,
    bestOctaveScore: octaveScore,
    neighborScore,
    samePitchAltScore: null,
    expectedRank,
    expectedTop1: expectedRank === 1,
    expectedTop3: expectedRank !== null && expectedRank <= 3,
    expectedPairwiseWinRate: null,
    octaveCompetitorOutranked: octaveScore > expectedScore,
    expectedVsSourceWon: null,
    positionAmbiguous: false,
    candidateScoreCount: scores.length,
    sharedEvidenceAvailability: [
      'expected_target_score',
      'best_competitor_score',
      'best_octave_score',
      'nearby_competitor_score',
      'expected_rank',
      'expected_topk_ratio_inputs'
    ],
    sharedEvidenceLimitations: [
      'same_pitch_alt_score_not_independent_for_masp_midi_only',
      'pairwise_competitor_outcomes_unavailable_in_poly_lite_probe'
    ],
    evidenceSource: 'masp_proxy',
    spectralProbe: null
  };
}

function buildSpectralProbePlanLite(
  target: { stringId: number; fret: number; midi: number },
  allPositions: Array<{ stringId: number; fret: number; midi: number }>
): SpectralProbePlanLite {
  const expected = buildProbeCandidate(target.stringId, target.fret, target.midi, 'other');
  const byKey = new Map<string, SpectralProbeCandidate>();
  const addCandidate = (candidate: SpectralProbeCandidate) => {
    const key = `${candidate.stringId}:${candidate.fret}:${candidate.midi}`;
    if (byKey.has(key)) return;
    byKey.set(key, candidate);
  };

  addCandidate(expected);

  for (const delta of [-2, -1, 1, 2]) {
    const nearby = findClosestPositionForMidi(allPositions, target.midi + delta, target.stringId);
    if (!nearby) continue;
    addCandidate(buildProbeCandidate(nearby.stringId, nearby.fret, nearby.midi, 'neighbor'));
  }

  for (const shift of [-12, 12]) {
    const octave = findClosestPositionForMidi(allPositions, target.midi + shift, target.stringId);
    if (!octave) continue;
    addCandidate(buildProbeCandidate(octave.stringId, octave.fret, octave.midi, 'octave'));
  }

  const samePitch = allPositions
    .filter((position) =>
      position.midi === target.midi &&
      (position.stringId !== target.stringId || position.fret !== target.fret)
    )
    .sort((left, right) =>
      Math.abs(left.stringId - target.stringId) - Math.abs(right.stringId - target.stringId) ||
      left.fret - right.fret ||
      left.stringId - right.stringId
    )
    .slice(0, 3);
  for (const candidate of samePitch) {
    addCandidate(buildProbeCandidate(candidate.stringId, candidate.fret, candidate.midi, 'same_pitch_alt'));
  }

  const candidates = [...byKey.values()];
  return {
    expected,
    candidates,
    aggregateModelJson: JSON.stringify(buildRuntimeModelForProbe(candidates))
  };
}

function analyzeSpectralProbeFrameLite(input: {
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
  plan: SpectralProbePlanLite;
}): FrameEvidence {
  const classById = new Map<string, SpectralProbeCompetitorClass>(
    input.plan.candidates.map((candidate) => [candidate.noteId, candidate.competitorClass])
  );
  const aggregateDebug = runSpectralProbeModel(input.detector, input.frameInput, input.plan.aggregateModelJson);
  const aggregateScores = extractCandidateScores(aggregateDebug, classById);

  const expectedEntry = aggregateScores.find((entry) => entry.noteId === input.plan.expected.noteId) ?? null;
  const bestCompetitor = aggregateScores.find((entry) => entry.noteId !== input.plan.expected.noteId) ?? null;
  const octaveCandidates = aggregateScores.filter((entry) => entry.competitorClass === 'octave');
  const neighborCandidates = aggregateScores.filter((entry) =>
    entry.competitorClass === 'neighbor' || entry.competitorClass === 'nearby_note'
  );
  const samePitchAlt = aggregateScores.filter((entry) => entry.competitorClass === 'same_pitch_alt');

  const missingEvidence: string[] = [];
  if (!Array.isArray(aggregateDebug.candidate_scores)) {
    missingEvidence.push('raw_candidate_scores_not_exposed_by_runtime');
  }
  missingEvidence.push('pairwise_probe_disabled_for_polyphonic_benchmark');

  const spectralProbe: SpectralProbeFrameTelemetry = {
    probeVersion: 'spectral_probe_v1',
    expectedNoteId: input.plan.expected.noteId,
    candidateCount: input.plan.candidates.length,
    availableCandidateScoreCount: aggregateScores.length,
    topCandidates: aggregateScores.slice(0, 8),
    pairwise: [],
    expectedRank: expectedEntry?.rank ?? null,
    expectedTop1: (expectedEntry?.rank ?? null) === 1,
    expectedTop3: expectedEntry !== null && expectedEntry.rank <= 3,
    expectedPairwiseWinRate: null,
    octaveCompetitorOutranked: expectedEntry !== null && octaveCandidates.some((entry) => entry.rawScore > expectedEntry.rawScore),
    expectedVsSourceWon: null,
    positionAmbiguous: samePitchAlt.length > 0,
    missingEvidence
  };

  return {
    expectedScore: expectedEntry?.rawScore ?? 0,
    bestCompetitorScore: bestCompetitor?.rawScore ?? 0,
    bestCompetitorMidi: bestCompetitor?.midi ?? null,
    bestOctaveScore: maxOrZero(octaveCandidates.map((entry) => entry.rawScore)),
    neighborScore: maxOrZero(neighborCandidates.map((entry) => entry.rawScore)),
    samePitchAltScore: maxOrZero(samePitchAlt.map((entry) => entry.rawScore)) || null,
    expectedRank: expectedEntry?.rank ?? null,
    expectedTop1: (expectedEntry?.rank ?? null) === 1,
    expectedTop3: expectedEntry !== null && expectedEntry.rank <= 3,
    expectedPairwiseWinRate: null,
    octaveCompetitorOutranked: expectedEntry !== null && octaveCandidates.some((entry) => entry.rawScore > expectedEntry.rawScore),
    expectedVsSourceWon: null,
    positionAmbiguous: samePitchAlt.length > 0,
    candidateScoreCount: aggregateScores.length,
    sharedEvidenceAvailability: [
      'expected_target_score',
      'best_competitor_score',
      'best_octave_score',
      'nearby_competitor_score',
      'same_pitch_alt_score',
      'expected_rank',
      'expected_topk_ratio_inputs'
    ],
    sharedEvidenceLimitations: missingEvidence,
    evidenceSource: 'spectral_probe',
    spectralProbe
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

function safeScore(scores: number[], midi: number, midiMin: number): number {
  const index = midi - midiMin;
  if (index < 0 || index >= scores.length) return 0;
  return scores[index] ?? 0;
}

function maxOrZero(values: number[]): number {
  if (values.length <= 0) return 0;
  return Math.max(...values);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function midiFor(stringId: number, fret: number): number {
  return midiForStringFret(stringId, fret);
}

function parseTakeFromFileId(fileId: string): number {
  const prefix = fileId.split('_', 1)[0] ?? '';
  const asNumber = Number.parseInt(prefix, 10);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

function stringBandFor(stringId: number): 'low' | 'mid' | 'high' {
  if (stringId >= 5) return 'low';
  if (stringId >= 3) return 'mid';
  return 'high';
}

async function writeOutputs(outputDir: string, input: {
  selectedPairCount: number;
  totalPairCount: number;
  datasetPath: string;
  decisionConfig: ValidatorDecisionConfig;
  baselineConfig: ValidatorDecisionConfig;
  noteSetPolicy: ReturnType<typeof parseNoteSetAggregationPolicyFromEnv>;
  activationGatePolicy: ActivationGatePolicy;
  candidateEval: ReturnType<typeof evaluatePolyphonicTelemetryForConfig>;
  baselineEval: ReturnType<typeof evaluatePolyphonicTelemetryForConfig>;
  windowTelemetry: PolyphonicWindowTelemetry[];
  jamsAudits: JamsAuditRow[];
  windowConfig: {
    windowDurationSec: number;
    windowHopSec: number;
    minEventOverlapSec: number;
    stableWindowMinRatio: number;
    transitionOverlapThreshold: number;
    includeSilentWindows: boolean;
    maxWindowsPerFile: number | null;
    maxFramesPerWindow: number;
  };
}): Promise<void> {
  const windowsCompact = input.candidateEval.windowResults.map((window) => ({
    algorithm: window.algorithm,
    noteDecisionConfigId: window.noteDecisionConfigId,
    aggregationPolicyId: window.aggregationPolicyId,
    activationGatePolicyId: window.activationGatePolicyId,
    aggregationMode: window.aggregationMode,
    noteSetCardinality: window.noteSetCardinality,
    windowId: window.windowId,
    fileId: window.fileId,
    wavRelativePath: window.wavRelativePath,
    subset: window.subset,
    startSec: roundNumber(window.startSec, 6),
    endSec: roundNumber(window.endSec, 6),
    expectedMidis: window.expectedMidis,
    expectedDominantMidis: window.expectedDominantMidis,
    expectedSegmentCount: window.expectedSegmentCount,
    expectedActiveRatio: roundNumber(window.expectedActiveRatio, 6),
    stableSetRatio: roundNumber(window.stableSetRatio, 6),
    transitionOverlapRatio: roundNumber(window.transitionOverlapRatio, 6),
    noteSetChangeCount: window.noteSetChangeCount,
    baseWindowCategory: window.baseWindowCategory,
    windowCategory: window.windowCategory,
    isStableWindow: window.isStableWindow,
    setRelation: window.setRelation,
    negativeType: window.negativeType,
    rawDetectedMidis: window.rawDetectedMidis,
    validatedExpectedNotes: window.validatedExpectedNotes,
    missingExpectedNotes: window.missingExpectedNotes,
    extraDetectedNotes: window.extraDetectedNotes,
    expectedNoteCount: window.expectedNoteCount,
    validatedNoteCount: window.validatedNoteCount,
    noteValidationRatio: roundNumber(window.noteValidationRatio, 6),
    minValidatedSupportFrames: window.minValidatedSupportFrames,
    rawDetectionMaxConfidence: window.rawDetectionMaxConfidence !== null ? roundNumber(window.rawDetectionMaxConfidence, 6) : null,
    rawDetectionFrameRatio: window.rawDetectionFrameRatio !== null ? roundNumber(window.rawDetectionFrameRatio, 6) : null,
    accept: window.accept,
    policyAccept: window.policyAccept,
    preGateAccept: window.preGateAccept,
    gateCoreAccept: window.gateCoreAccept,
    postGateAccept: window.postGateAccept,
    gateRejectReason: window.gateRejectReason,
    gateSuppressed: window.gateSuppressed,
    gateSuppressedByHysteresis: window.gateSuppressedByHysteresis,
    strictAccept: window.strictAccept,
    activationDetected: window.activationDetected,
    falseReject: window.falseReject,
    falseAccept: window.falseAccept,
    policyFalseReject: window.policyFalseReject,
    policyFalseAccept: window.policyFalseAccept,
    preGateFalseReject: window.preGateFalseReject,
    preGateFalseAccept: window.preGateFalseAccept,
    postGateFalseReject: window.postGateFalseReject,
    postGateFalseAccept: window.postGateFalseAccept,
    supersetMatch: window.supersetMatch,
    subsetMatch: window.subsetMatch,
    disjointSetMatch: window.disjointSetMatch,
    exactSetMatch: window.exactSetMatch,
    partialSetMatch: window.partialSetMatch
  }));
  const monoWindowCount = input.candidateEval.windowResults.filter((window) => window.noteSetCardinality <= 1).length;
  const polyWindowCount = input.candidateEval.windowResults.filter((window) => window.noteSetCardinality > 1).length;

  const resultsDoc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'gameplay_validator_polyphonic',
    datasetPath: input.datasetPath,
    selectedPairCount: input.selectedPairCount,
    totalPairCount: input.totalPairCount,
    algorithms: ALGORITHMS,
    decisionConfig: input.decisionConfig,
    baselineConfig: input.baselineConfig,
    noteSetPolicy: input.noteSetPolicy,
    activationGatePolicy: input.activationGatePolicy,
    noteDecisionConfigId: input.decisionConfig.id,
    aggregationPolicyId: input.noteSetPolicy.id,
    activationGatePolicyId: input.activationGatePolicy.id,
    windowCardinalitySummary: {
      monoWindows: monoWindowCount,
      polyWindows: polyWindowCount
    },
    windowConfig: input.windowConfig,
    aggregates: input.candidateEval.aggregates,
    baselineAggregates: input.baselineEval.aggregates,
    windows: windowsCompact
  };

  const diagnosticsDoc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'gameplay_validator_polyphonic',
    algorithms: ALGORITHMS,
    noteSetPolicy: input.noteSetPolicy,
    activationGatePolicy: input.activationGatePolicy,
    decisionConfig: input.decisionConfig,
    noteDecisionConfigId: input.decisionConfig.id,
    aggregationPolicyId: input.noteSetPolicy.id,
    activationGatePolicyId: input.activationGatePolicy.id,
    windowCardinalitySummary: {
      monoWindows: monoWindowCount,
      polyWindows: polyWindowCount
    },
    windowTelemetry: input.windowTelemetry,
    jamsAudits: input.jamsAudits,
    windowConfig: input.windowConfig
  };

  await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(resultsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'diagnostics.json'), `${JSON.stringify(diagnosticsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'results_windows.csv'), `${buildWindowsCsv(input.candidateEval.windowResults)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'jams_audit.json'), `${JSON.stringify(input.jamsAudits, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'jams_audit.md'), buildJamsAuditMarkdown(input.jamsAudits), 'utf8');
  await fs.writeFile(
    path.join(outputDir, 'summary.md'),
    buildSummaryMarkdown(
      input.candidateEval.aggregates,
      input.baselineEval.aggregates,
      input.decisionConfig,
      input.baselineConfig,
      input.noteSetPolicy,
      input.activationGatePolicy,
      input.windowConfig,
      {
        monoWindows: monoWindowCount,
        polyWindows: polyWindowCount
      }
    ),
    'utf8'
  );
  await fs.writeFile(
    path.join(outputDir, 'interpretation_report.md'),
    buildInterpretationReport(
      input.candidateEval.aggregates,
      input.baselineEval.aggregates,
      input.activationGatePolicy,
      input.decisionConfig,
      input.noteSetPolicy,
      {
        monoWindows: monoWindowCount,
        polyWindows: polyWindowCount
      }
    ),
    'utf8'
  );
  await fs.writeFile(
    path.join(outputDir, 'activation_gate_audit.md'),
    buildActivationGateAuditMarkdown(input.activationGatePolicy, input.candidateEval.aggregates),
    'utf8'
  );
}

function buildWindowsCsv(rows: ReturnType<typeof evaluatePolyphonicTelemetryForConfig>['windowResults']): string {
  const header = [
    'algorithm',
    'note_decision_config_id',
    'aggregation_policy_id',
    'activation_gate_policy_id',
    'aggregation_mode',
    'note_set_cardinality',
    'window_id',
    'file_id',
    'wav_relative_path',
    'subset',
    'start_sec',
    'end_sec',
    'window_category',
    'base_window_category',
    'is_stable_window',
    'stable_set_ratio',
    'transition_overlap_ratio',
    'expected_active_ratio',
    'note_set_change_count',
    'expected_dominant_midis',
    'set_relation',
    'negative_type',
    'expected_note_count',
    'validated_note_count',
    'note_validation_ratio',
    'min_validated_support_frames',
    'raw_detection_max_confidence',
    'raw_detection_frame_ratio',
    'expected_midis',
    'validated_expected_notes',
    'missing_expected_notes',
    'raw_detected_midis',
    'extra_detected_notes',
    'accept_legacy',
    'accept_policy',
    'accept_pre_gate',
    'accept_gate_core',
    'accept_post_gate',
    'gate_reject_reason',
    'gate_suppressed',
    'gate_suppressed_by_hysteresis',
    'accept_strict',
    'activation_detected',
    'false_reject',
    'false_accept',
    'policy_false_reject',
    'policy_false_accept',
    'pre_gate_false_reject',
    'pre_gate_false_accept',
    'post_gate_false_reject',
    'post_gate_false_accept',
    'superset_match',
    'subset_match',
    'disjoint_set_match',
    'exact_set_match',
    'partial_set_match'
  ];
  const out = [header.join(',')];
  for (const row of rows) {
    out.push([
      row.algorithm,
      row.noteDecisionConfigId,
      row.aggregationPolicyId,
      row.activationGatePolicyId,
      row.aggregationMode,
      row.noteSetCardinality,
      row.windowId,
      row.fileId,
      row.wavRelativePath,
      row.subset,
      roundNumber(row.startSec, 6),
      roundNumber(row.endSec, 6),
      row.windowCategory,
      row.baseWindowCategory,
      row.isStableWindow,
      roundNumber(row.stableSetRatio, 6),
      roundNumber(row.transitionOverlapRatio, 6),
      roundNumber(row.expectedActiveRatio, 6),
      row.noteSetChangeCount,
      row.expectedDominantMidis.join('|'),
      row.setRelation,
      row.negativeType,
      row.expectedNoteCount,
      row.validatedNoteCount,
      roundNumber(row.noteValidationRatio, 6),
      row.minValidatedSupportFrames,
      row.rawDetectionMaxConfidence !== null ? roundNumber(row.rawDetectionMaxConfidence, 6) : null,
      row.rawDetectionFrameRatio !== null ? roundNumber(row.rawDetectionFrameRatio, 6) : null,
      row.expectedMidis.join('|'),
      row.validatedExpectedNotes.join('|'),
      row.missingExpectedNotes.join('|'),
      row.rawDetectedMidis.join('|'),
      row.extraDetectedNotes.join('|'),
      row.accept,
      row.policyAccept,
      row.preGateAccept,
      row.gateCoreAccept,
      row.postGateAccept,
      row.gateRejectReason,
      row.gateSuppressed,
      row.gateSuppressedByHysteresis,
      row.strictAccept,
      row.activationDetected,
      row.falseReject,
      row.falseAccept,
      row.policyFalseReject,
      row.policyFalseAccept,
      row.preGateFalseReject,
      row.preGateFalseAccept,
      row.postGateFalseReject,
      row.postGateFalseAccept,
      row.supersetMatch,
      row.subsetMatch,
      row.disjointSetMatch,
      row.exactSetMatch,
      row.partialSetMatch
    ].map((value) => csvEscape(formatCsvValue(value))).join(','));
  }
  return out.join('\n');
}

function buildJamsAuditMarkdown(rows: JamsAuditRow[]): string {
  const namespaceSummary = new Map<string, number>();
  for (const row of rows) {
    for (const [namespace, count] of Object.entries(row.namespaceCounts)) {
      namespaceSummary.set(namespace, (namespaceSummary.get(namespace) ?? 0) + count);
    }
  }

  const lines = [
    '# JAMS Parsing Audit',
    '',
    '- Selected namespace for expected played notes: `note_midi`.',
    '- Parsing strategy: flatten all `note_midi` annotation tracks (`annotation_metadata.data_source`) into note intervals and round midi values to nearest semitone.',
    '',
    '## Namespace Counts (all files)',
    ''
  ];

  for (const [namespace, count] of [...namespaceSummary.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${namespace}: ${count}`);
  }

  lines.push('', '## File Coverage', '', '| File | Subset | Note events | Source tracks | Dropped observations | Duration (s) |', '| --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of rows.slice(0, 200)) {
    lines.push(`| ${row.fileId} | ${row.subset} | ${row.noteEventCount} | ${row.sourceTrackCount} | ${row.droppedObservationCount} | ${formatNullable(row.fileDurationSec, 3)} |`);
  }
  if (rows.length > 200) {
    lines.push('', `- Truncated table: showing first 200 of ${rows.length} files.`);
  }

  lines.push('');
  return lines.join('\n');
}

function buildSummaryMarkdown(
  aggregates: Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>,
  baselineAggregates: Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>,
  config: ValidatorDecisionConfig,
  baselineConfig: ValidatorDecisionConfig,
  policy: ReturnType<typeof parseNoteSetAggregationPolicyFromEnv>,
  activationGatePolicy: ActivationGatePolicy,
  windowConfig: {
    windowDurationSec: number;
    windowHopSec: number;
    minEventOverlapSec: number;
    stableWindowMinRatio: number;
    transitionOverlapThreshold: number;
    includeSilentWindows: boolean;
    maxWindowsPerFile: number | null;
    maxFramesPerWindow: number;
  },
  windowCardinalitySummary: {
    monoWindows: number;
    polyWindows: number;
  },
): string {
  const lines = [
    '# Gameplay Validator Polyphonic Benchmark',
    '',
    '## Scope',
    '',
    '- Dataset: `tools/pitch-offline-bench/input/wav` WAV/JAMS pairs.',
    '- Subsets: `_solo`, `_comp`, and combined.',
    '- Validation strategy: shared per-note competitor-aware validation + note-set aggregation + post-validator activation gate.',
    '- Per-window outputs now include explicit note-decision, aggregation, and activation-gate IDs.',
    '- `note_set_cardinality` makes mono windows cardinality 1 and poly windows cardinality > 1 explicit in reports.',
    '- Product objective: note correctness prioritized over exact string/fret position.',
    '',
    '## Configuration',
    '',
    `- Candidate decision config: ${config.id} (${config.mode}).`,
    `- Baseline decision config: ${baselineConfig.id} (${baselineConfig.mode}).`,
    `- Note decision config id: ${config.id}.`,
    `- Aggregation policy id: ${policy.id}.`,
    `- Activation gate policy id: ${activationGatePolicy.id}.`,
    `- Note-set policy: ${policy.id} (${policy.mode}), min ratio ${roundNumber(policy.minNoteRatio, 3)}, min count ${policy.minNoteCount}, max extra ${policy.maxExtraDetectedNotes ?? 'none'}, allow superset ${policy.allowSupersetIfExpectedCovered}, empty must be quiet ${policy.emptyWindowMustBeQuiet}, extra penalty ${roundNumber(policy.extraNotePenaltyWeight, 3)}.`,
    `- Activation gate: ${activationGatePolicy.id}, enabled ${activationGatePolicy.gateEnabled}, empty quiet ${activationGatePolicy.emptyWindowMustBeQuiet}, empty max validated ${activationGatePolicy.emptyWindowMaxValidatedNotes}, empty max extra ${activationGatePolicy.emptyWindowMaxExtraNotes}, empty max conf ${activationGatePolicy.emptyWindowMaxConfidence ?? 'none'}, transition min stable ${roundNumber(activationGatePolicy.transitionMinStableRatio, 3)}, transition max overlap ${roundNumber(activationGatePolicy.transitionMaxOverlapRatio, 3)}, transition min note ratio ${roundNumber(activationGatePolicy.transitionMinNoteRatio, 3)}, transition allow superset ${activationGatePolicy.transitionAllowSuperset}, stable allow superset ${activationGatePolicy.stableAllowSupersetIfExpectedCovered}, min expected ratio ${roundNumber(activationGatePolicy.minExpectedNoteRatioForActivation, 3)}, require exact transition ${activationGatePolicy.requireExactOnTransition}, min support frames ${activationGatePolicy.minConsecutiveExpectedSupportFrames}, hysteresis ${activationGatePolicy.hysteresisFrames}.`,
    `- Window cardinality summary: mono ${windowCardinalitySummary.monoWindows}, poly ${windowCardinalitySummary.polyWindows}.`,
    `- Windowing: duration ${roundNumber(windowConfig.windowDurationSec, 3)} s, hop ${roundNumber(windowConfig.windowHopSec, 3)} s, min overlap ${roundNumber(windowConfig.minEventOverlapSec, 3)} s, stable-window min ratio ${roundNumber(windowConfig.stableWindowMinRatio, 3)}, transition-overlap threshold ${roundNumber(windowConfig.transitionOverlapThreshold, 3)}, include silent windows ${windowConfig.includeSilentWindows}, max windows/file ${windowConfig.maxWindowsPerFile ?? 'none'}, max frames/window ${windowConfig.maxFramesPerWindow}.`,
    ''
  ];

  for (const bucket of ['solo', 'comp', 'combined'] as const) {
    lines.push(`## Pre vs Post Gate Metrics (${bucket})`, '');
    lines.push('| Algorithm | Recall pre | Recall post | Precision pre | Precision post | Exact pre | Exact post | Superset pre | Superset post | Extra pre | Extra post |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const algorithm of ALGORITHMS) {
      const metric = aggregates[algorithm][bucket];
      lines.push(`| ${algorithm} | ${formatMetricPct(metric.preGateExpectedNoteRecall)} | ${formatMetricPct(metric.postGateExpectedNoteRecall)} | ${formatMetricPct(metric.preGateExpectedNotePrecision)} | ${formatMetricPct(metric.postGateExpectedNotePrecision)} | ${formatMetricPct(metric.preGateExactSetRate)} | ${formatMetricPct(metric.postGateExactSetRate)} | ${formatMetricPct(metric.preGateSupersetRate)} | ${formatMetricPct(metric.postGateSupersetRate)} | ${formatMetricPct(metric.preGateExtraNoteRate)} | ${formatMetricPct(metric.postGateExtraNoteRate)} |`);
    }
    lines.push('');

    lines.push(`### Activation-Suppression View (${bucket})`, '');
    lines.push('| Algorithm | Empty FAR pre | Empty FAR post | Transition accept pre | Transition accept post | Stable recall pre | Stable recall post | Stable accept pre | Stable accept post | Stable coverage pre | Stable coverage post | Gate suppressed |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const algorithm of ALGORITHMS) {
      const metric = aggregates[algorithm][bucket];
      lines.push(`| ${algorithm} | ${formatMetricPct(metric.preGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(metric.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(metric.preGateTransitionWindowAcceptRate)} | ${formatMetricPct(metric.postGateTransitionWindowAcceptRate)} | ${formatMetricPct(metric.preGateStableNonEmptyExpectedNoteRecall)} | ${formatMetricPct(metric.postGateStableNonEmptyExpectedNoteRecall)} | ${formatMetricPct(metric.preGateStableWindowAcceptRate)} | ${formatMetricPct(metric.postGateStableWindowAcceptRate)} | ${formatMetricPct(metric.preGateStableWindowCoverageRate)} | ${formatMetricPct(metric.postGateStableWindowCoverageRate)} | ${formatMetricPct(metric.gateSuppressedRate)} |`);
    }
    lines.push('');
  }

  lines.push('## Baseline vs Candidate (Combined, Post-Gate)', '');
  lines.push('| Algorithm | Baseline post recall | Candidate post recall | Baseline post empty FAR | Candidate post empty FAR | Baseline post transition accept | Candidate post transition accept |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const algorithm of ALGORITHMS) {
    const base = baselineAggregates[algorithm].combined;
    const candidate = aggregates[algorithm].combined;
    lines.push(`| ${algorithm} | ${formatMetricPct(base.postGateExpectedNoteRecall)} | ${formatMetricPct(candidate.postGateExpectedNoteRecall)} | ${formatMetricPct(base.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(candidate.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(base.postGateTransitionWindowAcceptRate)} | ${formatMetricPct(candidate.postGateTransitionWindowAcceptRate)} |`);
  }

  lines.push('', '## Layered View', '');
  lines.push('- Pre-gate = raw validator activation behavior after note-set aggregation (`preGate*`).');
  lines.push('- Post-gate = activation decisions after explicit empty/transition suppression (`postGate*`).');
  lines.push('- `results_windows.csv` and `results.json` preserve both pre-gate and post-gate fields per window.');
  lines.push('- See `activation_gate_audit.md` and `interpretation_report.md` for effect-by-window interpretation.');
  lines.push('');

  return lines.join('\n');
}

function buildInterpretationReport(
  aggregates: Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>,
  baselineAggregates: Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>,
  activationGatePolicy: ActivationGatePolicy,
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: ReturnType<typeof parseNoteSetAggregationPolicyFromEnv>,
  windowCardinalitySummary: {
    monoWindows: number;
    polyWindows: number;
  }
): string {
  const lines: string[] = [
    '# Polyphonic Benchmark Interpretation Report',
    '',
    'This report explicitly distinguishes pre-gate diagnosis from post-gate outcomes.',
    '',
    '## Config Interpreted',
    '',
    `- Decision config: ${decisionConfig.id}`,
    `- Note-set policy: ${noteSetPolicy.id}`,
    `- Activation gate: ${activationGatePolicy.id}`,
    `- Window outputs: note_decision_config_id=${decisionConfig.id}, aggregation_policy_id=${noteSetPolicy.id}, activation_gate_policy_id=${activationGatePolicy.id}.`,
    `- Window cardinality summary: mono ${windowCardinalitySummary.monoWindows}, poly ${windowCardinalitySummary.polyWindows}.`,
    ''
  ];

  const masp = aggregates.MASP.combined;
  const spectral = aggregates.spectral_game_runtime_unified_v3.combined;

  lines.push('## Pre-Gate Diagnosis (Combined)', '');
  lines.push(`- MASP stable non-empty recall (pre-gate): ${formatMetricPct(masp.preGateStableNonEmptyExpectedNoteRecall)}.`);
  lines.push(`- spectral stable non-empty recall (pre-gate): ${formatMetricPct(spectral.preGateStableNonEmptyExpectedNoteRecall)}.`);
  lines.push(`- spectral empty FAR (pre-gate): ${formatMetricPct(spectral.preGateEmptyWindowFalseAcceptRate)}.`);
  lines.push(`- spectral transition accept (pre-gate): ${formatMetricPct(spectral.preGateTransitionWindowAcceptRate)}.`);
  lines.push(`- spectral extra-note rate (pre-gate): ${formatMetricPct(spectral.preGateExtraNoteRate)}.`);
  lines.push('');

  lines.push('## Post-Gate Outcome (Combined)', '');
  lines.push(`- MASP stable non-empty recall (post-gate): ${formatMetricPct(masp.postGateStableNonEmptyExpectedNoteRecall)} (${formatDeltaPct(masp.postGateStableNonEmptyExpectedNoteRecall, masp.preGateStableNonEmptyExpectedNoteRecall)} vs pre-gate).`);
  lines.push(`- spectral stable non-empty recall (post-gate): ${formatMetricPct(spectral.postGateStableNonEmptyExpectedNoteRecall)} (${formatDeltaPct(spectral.postGateStableNonEmptyExpectedNoteRecall, spectral.preGateStableNonEmptyExpectedNoteRecall)} vs pre-gate).`);
  lines.push(`- spectral empty FAR (post-gate): ${formatMetricPct(spectral.postGateEmptyWindowFalseAcceptRate)} (${formatDeltaPct(spectral.postGateEmptyWindowFalseAcceptRate, spectral.preGateEmptyWindowFalseAcceptRate)} vs pre-gate).`);
  lines.push(`- spectral transition accept (post-gate): ${formatMetricPct(spectral.postGateTransitionWindowAcceptRate)} (${formatDeltaPct(spectral.postGateTransitionWindowAcceptRate, spectral.preGateTransitionWindowAcceptRate)} vs pre-gate).`);
  lines.push(`- spectral extra-note rate (post-gate): ${formatMetricPct(spectral.postGateExtraNoteRate)} (${formatDeltaPct(spectral.postGateExtraNoteRate, spectral.preGateExtraNoteRate)} vs pre-gate).`);
  lines.push('');

  const maspRecallLimited = (masp.postGateStableNonEmptyExpectedNoteRecall ?? 0) < 0.6;
  const maspSuppressionGain = (masp.preGateEmptyWindowFalseAcceptRate ?? 0) - (masp.postGateEmptyWindowFalseAcceptRate ?? 0);
  lines.push('## Questions Answered', '');
  lines.push(`- MASP: gate material impact = ${maspSuppressionGain > 0.05 ? 'yes on false activation' : 'limited'}; recall-limited = ${maspRecallLimited ? 'yes' : 'no'}.`);

  const spectralRemainingMode = inferPrimaryFailureMode(spectral);
  lines.push(`- spectral empty-window false activation reduced by ${formatDeltaPct(spectral.postGateEmptyWindowFalseAcceptRate, spectral.preGateEmptyWindowFalseAcceptRate)}.`);
  lines.push(`- spectral transition-window over-acceptance reduced by ${formatDeltaPct(spectral.postGateTransitionWindowAcceptRate, spectral.preGateTransitionWindowAcceptRate)}.`);
  lines.push(`- spectral stable non-empty recall preserved at ${formatMetricPct(spectral.postGateStableNonEmptyExpectedNoteRecall)} (${formatDeltaPct(spectral.postGateStableNonEmptyExpectedNoteRecall, spectral.preGateStableNonEmptyExpectedNoteRecall)} delta).`);
  lines.push(`- spectral remaining dominant issue after gating: ${spectralRemainingMode}.`);

  const spectralCredible =
    (spectral.postGateStableNonEmptyExpectedNoteRecall ?? 0) >= (spectral.preGateStableNonEmptyExpectedNoteRecall ?? 0) - 0.03 &&
    (spectral.postGateEmptyWindowFalseAcceptRate ?? 1) <= (spectral.preGateEmptyWindowFalseAcceptRate ?? 1) &&
    (spectral.postGateTransitionWindowAcceptRate ?? 1) <= (spectral.preGateTransitionWindowAcceptRate ?? 1);
  lines.push(`- Is spectral now more credible for note-centric poly gameplay? ${spectralCredible ? 'Yes' : 'Partially'} (based on stable recall retention plus empty/transition suppression).`);
  lines.push(`- Best tradeoff config found in this run: activation gate \`${activationGatePolicy.id}\` + note-set policy \`${noteSetPolicy.id}\`.`);
  lines.push(`- Useful recall sacrificed (spectral stable non-empty): ${formatDeltaPct(spectral.postGateStableNonEmptyExpectedNoteRecall, spectral.preGateStableNonEmptyExpectedNoteRecall)}.`);
  lines.push('');

  lines.push('## Baseline Comparison (Combined, Post-Gate)', '');
  lines.push('| Algorithm | Baseline recall | Candidate recall | Baseline empty FAR | Candidate empty FAR | Baseline transition accept | Candidate transition accept |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const algorithm of ALGORITHMS) {
    const baseline = baselineAggregates[algorithm].combined;
    const candidate = aggregates[algorithm].combined;
    lines.push(`| ${algorithm} | ${formatMetricPct(baseline.postGateExpectedNoteRecall)} | ${formatMetricPct(candidate.postGateExpectedNoteRecall)} | ${formatMetricPct(baseline.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(candidate.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(baseline.postGateTransitionWindowAcceptRate)} | ${formatMetricPct(candidate.postGateTransitionWindowAcceptRate)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function buildActivationGateAuditMarkdown(
  activationGatePolicy: ActivationGatePolicy,
  aggregates: Record<AlgorithmName, Record<DatasetBucket, NoteSetMetrics>>
): string {
  const lines: string[] = [
    '# Activation Gate Audit Note',
    '',
    '## Insertion Point',
    '',
    '- Gate is applied after note-set validation evidence is computed in `evaluateNoteSetWindow`.',
    '- Temporal hysteresis (if enabled) is applied in `evaluatePolyphonicTelemetryForConfig` as a post-pass over per-file window order.',
    '',
    '## Policy Family',
    '',
    '- Empty-window suppression: quiet requirement + max validated notes + max extra notes + max raw confidence.',
    '- Transition-window suppression: min stability, max overlap, min note ratio, optional exact-only and superset restrictions.',
    '- Stable non-empty behavior: preserve permissive superset acceptance when configured.',
    '- Optional temporal smoothing: `hysteresisFrames`.',
    '',
    '## Chosen Config (This Run)',
    '',
    `- id: ${activationGatePolicy.id}`,
    `- enabled: ${activationGatePolicy.gateEnabled}`,
    `- empty_window_must_be_quiet: ${activationGatePolicy.emptyWindowMustBeQuiet}`,
    `- gate_empty_window_max_validated_notes: ${activationGatePolicy.emptyWindowMaxValidatedNotes}`,
    `- gate_empty_window_max_extra_notes: ${activationGatePolicy.emptyWindowMaxExtraNotes}`,
    `- gate_empty_window_max_confidence: ${activationGatePolicy.emptyWindowMaxConfidence ?? 'none'}`,
    `- gate_transition_min_stable_ratio: ${roundNumber(activationGatePolicy.transitionMinStableRatio, 3)}`,
    `- gate_transition_max_overlap_ratio: ${roundNumber(activationGatePolicy.transitionMaxOverlapRatio, 3)}`,
    `- gate_transition_min_note_ratio: ${roundNumber(activationGatePolicy.transitionMinNoteRatio, 3)}`,
    `- gate_transition_allow_superset: ${activationGatePolicy.transitionAllowSuperset}`,
    `- gate_stable_allow_superset_if_expected_covered: ${activationGatePolicy.stableAllowSupersetIfExpectedCovered}`,
    `- gate_min_expected_note_ratio_for_activation: ${roundNumber(activationGatePolicy.minExpectedNoteRatioForActivation, 3)}`,
    `- gate_require_exact_on_transition: ${activationGatePolicy.requireExactOnTransition}`,
    `- gate_hysteresis_frames: ${activationGatePolicy.hysteresisFrames}`,
    '',
    '## Main Effect by Window Type (Combined)',
    ''
  ];

  lines.push('| Algorithm | Empty FAR pre | Empty FAR post | Transition accept pre | Transition accept post | Stable recall pre | Stable recall post | Gate suppressed |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const algorithm of ALGORITHMS) {
    const metric = aggregates[algorithm].combined;
    lines.push(`| ${algorithm} | ${formatMetricPct(metric.preGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(metric.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(metric.preGateTransitionWindowAcceptRate)} | ${formatMetricPct(metric.postGateTransitionWindowAcceptRate)} | ${formatMetricPct(metric.preGateStableNonEmptyExpectedNoteRecall)} | ${formatMetricPct(metric.postGateStableNonEmptyExpectedNoteRecall)} | ${formatMetricPct(metric.gateSuppressedRate)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function inferPrimaryFailureMode(metric: NoteSetMetrics): string {
  const missPenalty = 1 - (metric.postGateStableNonEmptyExpectedNoteRecall ?? metric.postGateExpectedNoteRecall ?? 0);
  const extraPenalty = metric.postGateExtraNoteRate ?? metric.extraNoteRate ?? 0;
  const silencePenalty = metric.postGateEmptyWindowFalseAcceptRate ?? metric.emptyWindowFalseAcceptRate ?? 0;
  const transitionPenalty = metric.postGateTransitionWindowAcceptRate ?? metric.transitionWindowAcceptRate ?? 0;

  const modes: Array<{ id: string; penalty: number }> = [
    { id: 'missing expected notes', penalty: missPenalty },
    { id: 'extra-note supersets / contamination', penalty: extraPenalty },
    { id: 'silence hallucination', penalty: silencePenalty },
    { id: 'transition smearing', penalty: transitionPenalty }
  ];
  modes.sort((left, right) => right.penalty - left.penalty);
  return modes[0]?.id ?? 'insufficient data';
}

function formatDeltaPct(after: number | null, before: number | null): string {
  if (after === null || before === null || !Number.isFinite(after) || !Number.isFinite(before)) return '-';
  const delta = after - before;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatPct(delta)}`;
}

function formatMetricPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return formatPct(value);
}

function formatMetricNumber(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function sampleEvenly<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  if (limit <= 0) return [];
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const ratio = limit === 1 ? 0.5 : index / (limit - 1);
    const selectedIndex = Math.min(values.length - 1, Math.round(ratio * (values.length - 1)));
    out.push(values[selectedIndex]);
  }
  return out;
}

function parseEnvFloat(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

function parseEnvInt(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

function parseEnvIntNullable(name: string, fallback: number | null, minValue: number): number | null {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'null' || normalized === '-1') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
