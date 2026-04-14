#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import decodeAudio from 'audio-decode';
import { AudioPreprocessService } from '../../src/audio/AudioPreprocessService.js';
import { FeatureExtractionService } from '../../src/audio/FeatureExtractionService.js';
import initDspCore, { GhDspCore, PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { buildPracticeSpectralRuntimeModel } from '../../src/audio/spectralRuntimeModel.js';
import { midiForStringFret, STANDARD_TUNING } from '../../src/guitar/tuning.js';
import { MASPAdapter } from '../../src/pitch/adapters/MASPAdapter.js';
import { midiToHz, midiToNoteName } from '../../src/ui/song-select/utils/songSelectUtils.js';
const FRAME_SIZE = 4096;
const HOP_SIZE = 512;
const FFT_SIZE = 4096;
const SAMPLED_WINDOWS_PER_FILE = 18;
const WINDOW_MARGIN_SEC = 0.25;
const DATASET_ROOT = 'assets/session_20260403_174852';
const OUTPUT_ROOT = 'analysis/pitchdebug_partial_eval';
const WINDOWS_DATASET_ROOT = 'assets\\session_20260403_174852';
const FILE_NAME_PATTERN = /^string_(\d+)_fret_(\d+)_take_(\d+)\.wav$/i;
const PRIMARY_PIPELINE = 'raw';
const ALGORITHMS = ['ac14', 'spectral_game_runtime_unified_v3', 'MASP', 'FRETNET'];
const PIPELINES = [
    {
        id: 'raw',
        label: 'RAW',
        createProcessor: () => (rawFrame) => new Float32Array(rawFrame)
    },
    {
        id: 'hpf50_lpf2000',
        label: 'HPF 50 Hz + LPF 2000 Hz',
        createProcessor: (frameSize) => {
            const service = new AudioPreprocessService(frameSize, {
                windowType: 'rect',
                dcRemoval: false,
                normalize: false,
                highPass: true,
                lowPass: true,
                bandPass: false,
                noiseGate: false,
                highPassHz: 50,
                lowPassHz: 2000
            });
            return (rawFrame, sampleRate) => {
                const processed = new Float32Array(rawFrame.length);
                service.processFrame(rawFrame, sampleRate, processed);
                return processed;
            };
        }
    }
];
let dspCoreInitPromise = null;
class DspCoreDetector {
    preset;
    spectralModelJson;
    name;
    core = null;
    preparedSampleRate = 0;
    preparedBlockSize = 0;
    zeroReference = new Float32Array(0);
    constructor(name, preset, spectralModelJson = null) {
        this.preset = preset;
        this.spectralModelJson = spectralModelJson;
        this.name = name;
    }
    async init() {
        await ensureDspCoreReady();
    }
    reset() {
        this.core?.reset();
    }
    dispose() {
        this.core?.free();
        this.core = null;
    }
    processFrame(input) {
        const core = this.ensureCore(input.sampleRate, input.processedFrame.length);
        if (this.zeroReference.length !== input.processedFrame.length) {
            this.zeroReference = new Float32Array(input.processedFrame.length);
        }
        core.set_reference_block(this.zeroReference);
        const output = core.process_block(input.processedFrame);
        const midi = finiteNumber(output.midi_estimate);
        const confidence = finiteNumber(output.confidence) ?? 0;
        if (midi === null) {
            return {
                detectorName: this.name,
                accepted: false,
                confidence,
                rejectReason: buildRejectReason(input.optionalFeatures?.metrics.rmsDbfs ?? null),
                stringId: finiteInteger(output.detected_string),
                fret: finiteInteger(output.detected_fret)
            };
        }
        return {
            detectorName: this.name,
            accepted: true,
            midi,
            pitchHz: midiToHz(midi),
            noteName: midiToNoteName(Math.round(midi)),
            confidence,
            stringId: finiteInteger(output.detected_string),
            fret: finiteInteger(output.detected_fret)
        };
    }
    ensureCore(sampleRate, blockSize) {
        if (!this.core || this.preparedSampleRate !== sampleRate || this.preparedBlockSize !== blockSize) {
            this.core?.free();
            this.core = new GhDspCore();
            this.core.prepare(sampleRate, blockSize, 1);
            this.core.set_pitch_detector_preset(this.preset);
            if (this.spectralModelJson) {
                this.core.set_spectral_model(this.spectralModelJson);
            }
            this.preparedSampleRate = sampleRate;
            this.preparedBlockSize = blockSize;
        }
        return this.core;
    }
}
async function main() {
    const repoRoot = process.cwd();
    const datasetDir = path.resolve(repoRoot, DATASET_ROOT);
    const outputDir = path.resolve(repoRoot, OUTPUT_ROOT);
    const plotsDir = path.join(outputDir, 'plots');
    await fs.mkdir(plotsDir, { recursive: true });
    const datasetRows = await buildDatasetRows(datasetDir);
    if (datasetRows.length <= 0) {
        throw new Error(`No WAV files found under ${datasetDir}`);
    }
    const spectralModel = buildPracticeSpectralRuntimeModel(12);
    const spectralModelJson = JSON.stringify(spectralModel);
    console.log(`Initializing detectors for ${datasetRows.length} files...`);
    const detectors = await createDetectors(spectralModelJson);
    try {
        const pipelineResults = {};
        for (const pipeline of PIPELINES) {
            console.log(`Evaluating pipeline ${pipeline.id}...`);
            pipelineResults[pipeline.id] = await evaluatePipeline(datasetRows, pipeline, detectors, spectralModel);
        }
        const results = {
            generatedAtIso: new Date().toISOString(),
            datasetPath: DATASET_ROOT,
            datasetPathWindows: WINDOWS_DATASET_ROOT,
            outputDir: OUTPUT_ROOT,
            optionalPipelinesNotRun: ['low_shelf_+6db_120hz was not evaluated because there is no existing project wrapper for that shelf filter.'],
            mapping: {
                standardTuningMidi: STANDARD_TUNING,
                formula: 'midi = STANDARD_TUNING[string] + fret; frequencyHz = 440 * 2^((midi - 69) / 12)',
                openStringNotes: Object.entries(STANDARD_TUNING)
                    .map(([stringId, midi]) => ({
                    stringId: Number(stringId),
                    midi,
                    note: midiToNoteName(midi),
                    frequencyHz: roundNumber(midiToHz(midi), 6)
                }))
                    .sort((left, right) => right.stringId - left.stringId)
            },
            dataset: {
                fileCount: datasetRows.length,
                stringsCovered: uniqueSorted(datasetRows.map((row) => row.stringId)),
                fretsCovered: uniqueSorted(datasetRows.map((row) => row.fret)),
                files: datasetRows
            },
            frameConfig: {
                frameSize: FRAME_SIZE,
                hopSize: HOP_SIZE,
                fftSize: FFT_SIZE,
                sampledWindowsPerFile: SAMPLED_WINDOWS_PER_FILE,
                windowMarginSec: WINDOW_MARGIN_SEC
            },
            algorithms: [...ALGORITHMS],
            pipelines: pipelineResults
        };
        await writeResults(outputDir, results);
        await writePlots(plotsDir, results);
        await writeSummary(outputDir, results);
        console.log(`Dataset: ${DATASET_ROOT}`);
        console.log(`Files analyzed: ${datasetRows.length}`);
        console.log(`Strings covered: ${results.dataset.stringsCovered.join(', ')}`);
        console.log(`Frets covered: ${results.dataset.fretsCovered.join(', ')}`);
        console.log(`Algorithms: ${results.algorithms.join(', ')}`);
        console.log(`Outputs: ${OUTPUT_ROOT}`);
    }
    finally {
        for (const detector of detectors) {
            detector.dispose?.();
        }
    }
}
async function createDetectors(spectralModelJson) {
    const masp = new MASPAdapter();
    const detectors = [
        new DspCoreDetector('ac14', PitchDetectorPreset.Ac14),
        new DspCoreDetector('spectral_game_runtime_unified_v3', PitchDetectorPreset.SpectralGameRuntimeUnifiedV3, spectralModelJson),
        {
            name: masp.name,
            init: () => masp.init({ enabled: true }),
            reset: () => masp.reset(),
            processFrame: (input) => masp.processFrame(input),
            dispose: () => undefined
        },
        new DspCoreDetector('FRETNET', PitchDetectorPreset.Fretnet, spectralModelJson)
    ];
    for (const detector of detectors) {
        console.log(`Init detector ${detector.name}...`);
        await detector.init();
    }
    return detectors;
}
async function ensureDspCoreReady() {
    if (!dspCoreInitPromise) {
        dspCoreInitPromise = (async () => {
            const wasmPath = path.resolve(process.cwd(), 'src/audio/dsp-core/gh_dsp_core_bg.wasm');
            const wasmBytes = await fs.readFile(wasmPath);
            const moduleBytes = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
            await initDspCore({ module_or_path: moduleBytes });
        })();
    }
    await dspCoreInitPromise;
}
async function buildDatasetRows(datasetDir) {
    const audioDir = path.join(datasetDir, 'audio');
    const manifestPath = path.join(datasetDir, 'manifest.json');
    const manifest = await readJsonIfExists(manifestPath);
    const manifestByKey = new Map();
    for (const take of manifest?.takes ?? []) {
        const key = buildDatasetKey(take.stringId, take.fret, take.take);
        if (key) {
            manifestByKey.set(key, take);
            continue;
        }
        const parsed = typeof take.relativePath === 'string' ? parseTakeFromFileName(path.basename(take.relativePath)) : null;
        if (parsed) {
            manifestByKey.set(buildDatasetKey(parsed.stringId, parsed.fret, parsed.take), take);
        }
    }
    const entries = await fs.readdir(audioDir);
    const rows = [];
    for (const entry of entries) {
        if (!entry.toLowerCase().endsWith('.wav'))
            continue;
        const parsed = parseTakeFromFileName(entry);
        if (!parsed)
            continue;
        const fullPath = path.join(audioDir, entry);
        const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
        const manifestTake = manifestByKey.get(buildDatasetKey(parsed.stringId, parsed.fret, parsed.take));
        rows.push({
            filePath: fullPath,
            relativeFilePath: relativePath,
            stringId: parsed.stringId,
            fret: parsed.fret,
            take: parsed.take,
            durationSec: finiteNumber(manifestTake?.durationSec),
            sampleRate: finiteInteger(manifestTake?.sampleRate),
            sampleCount: finiteInteger(manifestTake?.sampleCount),
            manifestOrder: finiteInteger(manifestTake?.order)
        });
    }
    rows.sort((left, right) => (left.manifestOrder ?? Number.MAX_SAFE_INTEGER) - (right.manifestOrder ?? Number.MAX_SAFE_INTEGER) ||
        right.stringId - left.stringId ||
        left.fret - right.fret ||
        left.take - right.take ||
        left.relativeFilePath.localeCompare(right.relativeFilePath));
    return rows;
}
async function evaluatePipeline(datasetRows, pipeline, detectors, spectralModel) {
    const fileEvaluations = [];
    for (let rowIndex = 0; rowIndex < datasetRows.length; rowIndex += 1) {
        const row = datasetRows[rowIndex];
        console.log(`[${pipeline.id}] ${rowIndex + 1}/${datasetRows.length} ${row.relativeFilePath}`);
        const decoded = await decodeMonoAudio(row.filePath);
        const processor = pipeline.createProcessor(FRAME_SIZE);
        const featureService = new FeatureExtractionService(FFT_SIZE);
        for (const detector of detectors) {
            detector.reset();
        }
        const signalRmsDbfs = [];
        const signalSnrDb = [];
        const signalLowBandRatio = [];
        const frameResults = new Map();
        for (const detector of detectors) {
            frameResults.set(detector.name, []);
        }
        const frameStarts = buildSampledFrameStarts(decoded.samples.length, decoded.sampleRate);
        for (let frameIndex = 0; frameIndex < frameStarts.length; frameIndex += 1) {
            const start = frameStarts[frameIndex];
            const rawFrame = readFrame(decoded.samples, start, FRAME_SIZE);
            const processedFrame = processor(rawFrame, decoded.sampleRate);
            const features = featureService.extractFeatures(processedFrame, decoded.sampleRate, null, spectralModel);
            signalRmsDbfs.push(features.metrics.rmsDbfs);
            signalSnrDb.push(features.metrics.estimatedSnrDb);
            signalLowBandRatio.push(features.metrics.lowBandEnergyRatio);
            const frameContext = {
                timestampMs: (start / decoded.sampleRate) * 1000,
                frameIndex,
                sampleRate: decoded.sampleRate,
                rawFrame,
                processedFrame,
                analysisWindowId: frameIndex,
                optionalFeatures: features
            };
            for (const detector of detectors) {
                const result = detector.processFrame(frameContext);
                frameResults.get(detector.name)?.push(result);
            }
        }
        const groundTruthMidi = midiForStringFret(row.stringId, row.fret);
        const groundTruthFrequencyHz = midiToHz(groundTruthMidi);
        const algorithms = detectors.map((detector) => summarizeAlgorithmResult(detector.name, frameResults.get(detector.name) ?? [], row.stringId, row.fret, groundTruthFrequencyHz));
        fileEvaluations.push({
            pipeline: pipeline.id,
            filePath: row.filePath,
            relativeFilePath: row.relativeFilePath,
            stringId: row.stringId,
            fret: row.fret,
            take: row.take,
            durationSec: row.durationSec ?? roundNumber(decoded.samples.length / decoded.sampleRate, 5),
            sampleRate: decoded.sampleRate,
            sampleCount: decoded.samples.length,
            groundTruthMidi,
            groundTruthNote: midiToNoteName(groundTruthMidi),
            groundTruthFrequencyHz: roundNumber(groundTruthFrequencyHz, 6),
            signal: {
                medianRmsDbfs: roundNullable(median(signalRmsDbfs), 3),
                medianSnrDb: roundNullable(median(signalSnrDb), 3),
                medianLowBandEnergyRatio: roundNullable(median(signalLowBandRatio), 6)
            },
            algorithms
        });
    }
    return {
        fileEvaluations,
        aggregatesByAlgorithm: buildAggregatesByAlgorithm(fileEvaluations),
        aggregatesByAlgorithmAndString: buildGroupedAggregates(fileEvaluations, (row) => `${row.stringId}`),
        aggregatesByAlgorithmAndFret: buildGroupedAggregates(fileEvaluations, (row) => `${row.fret}`)
    };
}
function summarizeAlgorithmResult(algorithm, frameResults, targetString, targetFret, groundTruthFrequencyHz) {
    const accepted = frameResults.filter((result) => result.accepted && finiteNumber(result.pitchHz) !== null);
    const totalFrameCount = frameResults.length;
    const acceptedFrameRate = totalFrameCount > 0 ? accepted.length / totalFrameCount : 0;
    const failureReason = mostCommon(frameResults.map((result) => result.rejectReason ?? null));
    if (accepted.length <= 0) {
        return {
            algorithm,
            predictedFrequencyHz: null,
            predictedMidi: null,
            predictedNote: null,
            predictedString: null,
            predictedFret: null,
            confidence: null,
            acceptedFrameCount: 0,
            totalFrameCount,
            acceptedFrameRate,
            noDetection: true,
            failureReason,
            centsError: null,
            absCentsError: null,
            accurate50Cents: false,
            octaveError: false,
            stringCorrect: null,
            fretCorrect: null,
            stringFretCorrect: null
        };
    }
    const predictedFrequencyHz = median(accepted.map((result) => finiteNumber(result.pitchHz)).filter(Boolean));
    const predictedMidi = median(accepted.map((result) => finiteNumber(result.midi)).filter((value) => value !== null));
    const confidence = median(accepted.map((result) => finiteNumber(result.confidence)).filter((value) => value !== null));
    const predictedString = mostCommonNumber(accepted.map((result) => finiteInteger(result.stringId)));
    const predictedFret = mostCommonNumber(accepted.map((result) => finiteInteger(result.fret)));
    const centsError = predictedFrequencyHz === null ? null : centsBetweenFrequencies(predictedFrequencyHz, groundTruthFrequencyHz);
    const absCentsError = centsError === null ? null : Math.abs(centsError);
    const accurate50Cents = absCentsError !== null && absCentsError <= 50;
    const octaveError = absCentsError !== null && Math.abs(absCentsError - 1200) <= 100;
    const stringCorrect = predictedString === null ? null : predictedString === targetString;
    const fretCorrect = predictedFret === null ? null : predictedFret === targetFret;
    const stringFretCorrect = predictedString === null || predictedFret === null
        ? null
        : predictedString === targetString && predictedFret === targetFret;
    return {
        algorithm,
        predictedFrequencyHz: roundNullable(predictedFrequencyHz, 6),
        predictedMidi: roundNullable(predictedMidi, 6),
        predictedNote: predictedMidi === null ? null : midiToNoteName(Math.round(predictedMidi)),
        predictedString,
        predictedFret,
        confidence: roundNullable(confidence, 6),
        acceptedFrameCount: accepted.length,
        totalFrameCount,
        acceptedFrameRate: roundNumber(acceptedFrameRate, 6),
        noDetection: false,
        failureReason,
        centsError: roundNullable(centsError, 3),
        absCentsError: roundNullable(absCentsError, 3),
        accurate50Cents,
        octaveError,
        stringCorrect,
        fretCorrect,
        stringFretCorrect
    };
}
function buildAggregatesByAlgorithm(fileEvaluations) {
    const result = {};
    for (const algorithm of ALGORITHMS) {
        const rows = fileEvaluations.map((file) => file.algorithms.find((entry) => entry.algorithm === algorithm)).filter((value) => Boolean(value));
        result[algorithm] = computeAggregateMetrics(rows);
    }
    return result;
}
function buildGroupedAggregates(fileEvaluations, groupKey) {
    const grouped = {};
    for (const algorithm of ALGORITHMS) {
        const groups = new Map();
        for (const evaluation of fileEvaluations) {
            const row = evaluation.algorithms.find((entry) => entry.algorithm === algorithm);
            if (!row)
                continue;
            const key = groupKey(evaluation);
            const list = groups.get(key) ?? [];
            list.push(row);
            groups.set(key, list);
        }
        grouped[algorithm] = {};
        for (const [key, rows] of groups.entries()) {
            grouped[algorithm][key] = computeAggregateMetrics(rows);
        }
    }
    return grouped;
}
function computeAggregateMetrics(rows) {
    const fileCount = rows.length;
    const detected = rows.filter((row) => !row.noDetection);
    const cents = detected.map((row) => row.centsError).filter((value) => value !== null);
    const absCents = detected.map((row) => row.absCentsError).filter((value) => value !== null);
    const frameRates = rows.map((row) => row.acceptedFrameRate);
    const stringRows = rows.filter((row) => row.stringCorrect !== null);
    const fretRows = rows.filter((row) => row.fretCorrect !== null);
    const positionRows = rows.filter((row) => row.stringFretCorrect !== null);
    return {
        fileCount,
        pitchAccuracy50Cents: fileCount > 0 ? rows.filter((row) => row.accurate50Cents).length / fileCount : 0,
        medianAbsCentsError: roundNullable(median(absCents), 3),
        medianSignedCentsError: roundNullable(median(cents), 3),
        noDetectionRate: fileCount > 0 ? rows.filter((row) => row.noDetection).length / fileCount : 0,
        stringAccuracy: stringRows.length > 0 ? roundNumber(stringRows.filter((row) => row.stringCorrect).length / stringRows.length, 6) : null,
        fretAccuracy: fretRows.length > 0 ? roundNumber(fretRows.filter((row) => row.fretCorrect).length / fretRows.length, 6) : null,
        stringFretAccuracy: positionRows.length > 0 ? roundNumber(positionRows.filter((row) => row.stringFretCorrect).length / positionRows.length, 6) : null,
        octaveErrorRate: fileCount > 0 ? rows.filter((row) => row.octaveError).length / fileCount : 0,
        medianAcceptedFrameRate: roundNullable(median(frameRates), 6)
    };
}
async function writeResults(outputDir, results) {
    await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(outputDir, 'results.csv'), `${buildCsv(results)}\n`, 'utf8');
}
async function writeSummary(outputDir, results) {
    const primary = results.pipelines[PRIMARY_PIPELINE];
    const rankedByAccuracy = [...ALGORITHMS].sort((left, right) => primary.aggregatesByAlgorithm[right].pitchAccuracy50Cents - primary.aggregatesByAlgorithm[left].pitchAccuracy50Cents ||
        compareNullable(primary.aggregatesByAlgorithm[left].medianAbsCentsError, primary.aggregatesByAlgorithm[right].medianAbsCentsError) ||
        primary.aggregatesByAlgorithm[left].noDetectionRate - primary.aggregatesByAlgorithm[right].noDetectionRate);
    const rankedByMedian = [...ALGORITHMS].sort((left, right) => compareNullable(primary.aggregatesByAlgorithm[left].medianAbsCentsError, primary.aggregatesByAlgorithm[right].medianAbsCentsError) ||
        primary.aggregatesByAlgorithm[right].pitchAccuracy50Cents - primary.aggregatesByAlgorithm[left].pitchAccuracy50Cents);
    const rankedByFailures = [...ALGORITHMS].sort((left, right) => primary.aggregatesByAlgorithm[left].noDetectionRate - primary.aggregatesByAlgorithm[right].noDetectionRate ||
        primary.aggregatesByAlgorithm[right].pitchAccuracy50Cents - primary.aggregatesByAlgorithm[left].pitchAccuracy50Cents);
    const bestAlgorithm = rankedByAccuracy[0];
    const lowStringRows = primary.fileEvaluations.filter((row) => row.stringId >= 5);
    const lowStringAccuracy = Object.fromEntries(ALGORITHMS.map((algorithm) => [
        algorithm,
        computeAggregateMetrics(lowStringRows.map((row) => row.algorithms.find((entry) => entry.algorithm === algorithm)).filter((value) => Boolean(value))).pitchAccuracy50Cents
    ]));
    const octaveCounts = Object.fromEntries(ALGORITHMS.map((algorithm) => [
        algorithm,
        primary.fileEvaluations
            .map((row) => row.algorithms.find((entry) => entry.algorithm === algorithm))
            .filter((value) => Boolean(value))
            .filter((value) => value.octaveError)
            .length
    ]));
    const hpfComparisonLines = ALGORITHMS.map((algorithm) => {
        const rawMetrics = results.pipelines.raw.aggregatesByAlgorithm[algorithm];
        const filteredMetrics = results.pipelines.hpf50_lpf2000.aggregatesByAlgorithm[algorithm];
        return `| ${algorithm} | ${formatPct(rawMetrics.pitchAccuracy50Cents)} | ${formatPct(filteredMetrics.pitchAccuracy50Cents)} | ${formatPct(filteredMetrics.pitchAccuracy50Cents - rawMetrics.pitchAccuracy50Cents, true)} |`;
    }).join('\n');
    const summary = [
        '# PitchDebug Partial Evaluation',
        '',
        `- Dataset path used: \`${WINDOWS_DATASET_ROOT}\``,
        `- Files analyzed: ${results.dataset.fileCount}`,
        `- Strings covered: ${results.dataset.stringsCovered.join(', ')}`,
        `- Frets covered: ${results.dataset.fretsCovered.join(', ')}`,
        `- Algorithms successfully run: ${results.algorithms.join(', ')}`,
        `- Primary baseline: \`${PRIMARY_PIPELINE}\``,
        '',
        '## Mapping Used',
        '',
        `Standard tuning MIDI roots: ${Object.entries(STANDARD_TUNING).sort((left, right) => Number(right[0]) - Number(left[0])).map(([stringId, midi]) => `string ${stringId} = ${midiToNoteName(midi)} (${midi}, ${midiToHz(midi).toFixed(3)} Hz)`).join('; ')}.`,
        '',
        `Formula: \`${results.mapping.formula}\``,
        '',
        '## Per-Algorithm Metrics (RAW)',
        '',
        '| Algorithm | Pitch Accuracy (±50c) | Median | No-Detect | String/Fret Acc | Octave Error |',
        '| --- | ---: | ---: | ---: | ---: | ---: |',
        ...ALGORITHMS.map((algorithm) => {
            const metrics = primary.aggregatesByAlgorithm[algorithm];
            return `| ${algorithm} | ${formatPct(metrics.pitchAccuracy50Cents)} | ${formatNullable(metrics.medianAbsCentsError, 1, 'c')} | ${formatPct(metrics.noDetectionRate)} | ${formatNullablePct(metrics.stringFretAccuracy)} | ${formatPct(metrics.octaveErrorRate)} |`;
        }),
        '',
        '## Ranking',
        '',
        '| Category | 1st | 2nd | 3rd | 4th |',
        '| --- | --- | --- | --- | --- |',
        `| Best pitch accuracy | ${rankedByAccuracy.join(' | ')} |`,
        `| Lowest median error | ${rankedByMedian.join(' | ')} |`,
        `| Lowest failure rate | ${rankedByFailures.join(' | ')} |`,
        '',
        '## Key Insights',
        '',
        `1. ${bestAlgorithm} is the best overall RAW baseline on this partial session, leading the ranking by pitch accuracy and using the aggregate tie-breakers of median absolute cents error and no-detection rate.`,
        `2. Low-frequency behavior on strings 5-6 remains the hardest regime. RAW accuracy on those strings is ${ALGORITHMS.map((algorithm) => `${algorithm} ${formatPct(lowStringAccuracy[algorithm])}`).join(', ')}.`,
        `3. Octave errors / harmonic confusion are concentrated in ${Object.entries(octaveCounts).sort((left, right) => right[1] - left[1]).map(([algorithm, count]) => `${algorithm} (${count})`).join(', ')}.`,
        `4. Detection failures are dominated by ${ALGORITHMS.map((algorithm) => `${algorithm} ${formatPct(primary.aggregatesByAlgorithm[algorithm].noDetectionRate)}`).join(', ')}.`,
        `5. Issue attribution: ${inferIssueAttribution(results)}.`,
        '',
        '## Optional Preprocessing Comparison',
        '',
        'The project already exposes a simple HPF/LPF wrapper, so the same evaluation was also run with `hpf50_lpf2000`. The requested low-shelf pipeline was not added because there is no existing project wrapper for it.',
        '',
        '| Algorithm | RAW Accuracy | HPF/LPF Accuracy | Delta |',
        '| --- | ---: | ---: | ---: |',
        hpfComparisonLines,
        '',
        '## Plot Files',
        '',
        '- `plots/scatter_ac14.svg`',
        '- `plots/scatter_spectral_game_runtime_unified_v3.svg`',
        '- `plots/scatter_MASP.svg`',
        '- `plots/scatter_FRETNET.svg`',
        '- `plots/error_histogram.svg`',
        '- `plots/per_string_accuracy.svg`',
        '- `plots/per_fret_heatmap.svg`',
        '- `plots/failure_vs_frequency.svg`',
        ''
    ].join('\n');
    await fs.writeFile(path.join(outputDir, 'summary.md'), summary, 'utf8');
}
function inferIssueAttribution(results) {
    const raw = results.pipelines.raw.aggregatesByAlgorithm;
    const filtered = results.pipelines.hpf50_lpf2000.aggregatesByAlgorithm;
    const averageRawAccuracy = mean(ALGORITHMS.map((algorithm) => raw[algorithm].pitchAccuracy50Cents));
    const averageFilteredAccuracy = mean(ALGORITHMS.map((algorithm) => filtered[algorithm].pitchAccuracy50Cents));
    const rawNoDetect = mean(ALGORITHMS.map((algorithm) => raw[algorithm].noDetectionRate));
    const medianSignalDbfs = median(results.pipelines.raw.fileEvaluations.map((row) => row.signal.medianRmsDbfs).filter((value) => value !== null));
    if (medianSignalDbfs !== null && medianSignalDbfs < -45 && rawNoDetect > 0.2) {
        return 'signal level is a meaningful contributor, because median frame RMS is low and every detector shows elevated no-detect rates';
    }
    if (averageFilteredAccuracy - averageRawAccuracy >= 0.05) {
        return 'preprocessing contributes materially, because the simple HPF/LPF wrapper improves average pitch accuracy by more than five percentage points';
    }
    return 'the dominant differences are algorithmic on this dataset, because the same raw recordings produce materially different outcomes across detectors and the simple HPF/LPF wrapper does not shift the ranking enough to explain the gap';
}
async function writePlots(plotsDir, results) {
    const primary = results.pipelines[PRIMARY_PIPELINE];
    for (const algorithm of ALGORITHMS) {
        const filePath = path.join(plotsDir, `scatter_${sanitizeFileSegment(algorithm)}.svg`);
        await fs.writeFile(filePath, buildScatterSvg(primary.fileEvaluations, algorithm), 'utf8');
    }
    await fs.writeFile(path.join(plotsDir, 'error_histogram.svg'), buildHistogramSvg(primary.fileEvaluations), 'utf8');
    await fs.writeFile(path.join(plotsDir, 'per_string_accuracy.svg'), buildPerStringSvg(primary), 'utf8');
    await fs.writeFile(path.join(plotsDir, 'per_fret_heatmap.svg'), buildPerFretHeatmapSvg(primary), 'utf8');
    await fs.writeFile(path.join(plotsDir, 'failure_vs_frequency.svg'), buildFailureSvg(primary.fileEvaluations), 'utf8');
}
function buildCsv(results) {
    const header = [
        'pipeline',
        'file_path',
        'string',
        'fret',
        'take',
        'duration_sec',
        'sample_rate',
        'sample_count',
        'ground_truth_midi',
        'ground_truth_note',
        'ground_truth_frequency_hz',
        'algorithm',
        'predicted_frequency_hz',
        'predicted_midi',
        'predicted_note',
        'predicted_string',
        'predicted_fret',
        'confidence',
        'accepted_frame_count',
        'total_frame_count',
        'accepted_frame_rate',
        'no_detection',
        'failure_reason',
        'cents_error',
        'abs_cents_error',
        'accurate_50_cents',
        'octave_error',
        'string_correct',
        'fret_correct',
        'string_fret_correct',
        'median_rms_dbfs',
        'median_snr_db',
        'median_low_band_ratio'
    ];
    const rows = [header.join(',')];
    for (const pipeline of Object.values(results.pipelines)) {
        for (const evaluation of pipeline.fileEvaluations) {
            for (const algorithm of evaluation.algorithms) {
                rows.push([
                    evaluation.pipeline,
                    evaluation.relativeFilePath,
                    `${evaluation.stringId}`,
                    `${evaluation.fret}`,
                    `${evaluation.take}`,
                    formatCsvValue(evaluation.durationSec),
                    `${evaluation.sampleRate}`,
                    `${evaluation.sampleCount}`,
                    `${evaluation.groundTruthMidi}`,
                    evaluation.groundTruthNote,
                    `${evaluation.groundTruthFrequencyHz}`,
                    algorithm.algorithm,
                    formatCsvValue(algorithm.predictedFrequencyHz),
                    formatCsvValue(algorithm.predictedMidi),
                    formatCsvValue(algorithm.predictedNote),
                    formatCsvValue(algorithm.predictedString),
                    formatCsvValue(algorithm.predictedFret),
                    formatCsvValue(algorithm.confidence),
                    `${algorithm.acceptedFrameCount}`,
                    `${algorithm.totalFrameCount}`,
                    `${algorithm.acceptedFrameRate}`,
                    `${algorithm.noDetection}`,
                    formatCsvValue(algorithm.failureReason),
                    formatCsvValue(algorithm.centsError),
                    formatCsvValue(algorithm.absCentsError),
                    `${algorithm.accurate50Cents}`,
                    `${algorithm.octaveError}`,
                    formatCsvValue(algorithm.stringCorrect),
                    formatCsvValue(algorithm.fretCorrect),
                    formatCsvValue(algorithm.stringFretCorrect),
                    formatCsvValue(evaluation.signal.medianRmsDbfs),
                    formatCsvValue(evaluation.signal.medianSnrDb),
                    formatCsvValue(evaluation.signal.medianLowBandEnergyRatio)
                ].map(csvEscape).join(','));
            }
        }
    }
    return rows.join('\n');
}
function buildScatterSvg(fileEvaluations, algorithm) {
    const width = 800;
    const height = 560;
    const margin = { left: 72, right: 24, top: 52, bottom: 64 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const rows = fileEvaluations.map((row) => ({
        gt: row.groundTruthFrequencyHz,
        result: row.algorithms.find((entry) => entry.algorithm === algorithm) ?? null
    }));
    const detected = rows.filter((row) => row.result && !row.result.noDetection && row.result.predictedFrequencyHz !== null);
    const predictedValues = detected.map((row) => row.result?.predictedFrequencyHz ?? row.gt);
    const allValues = [...rows.map((row) => row.gt), ...predictedValues];
    const minValue = Math.min(...allValues) * 0.95;
    const maxValue = Math.max(...allValues) * 1.05;
    const xScale = linearScale(minValue, maxValue, margin.left, margin.left + innerWidth);
    const yScale = linearScale(minValue, maxValue, margin.top + innerHeight, margin.top);
    const ticks = buildLinearTicks(minValue, maxValue, 6);
    const failCount = rows.filter((row) => !row.result || row.result.noDetection).length;
    const elements = [];
    elements.push(svgHeader(width, height));
    elements.push(`<rect width="${width}" height="${height}" fill="#08111f" />`);
    elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(`Scatter: ${algorithm}`)}</text>`);
    elements.push(`<text x="${margin.left}" y="48" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">${escapeXml(`RAW baseline | detected ${detected.length}/${rows.length} | no-detect ${failCount}`)}</text>`);
    elements.push(buildAxes(width, height, margin, ticks, ticks, xScale, yScale, 'Ground truth frequency (Hz)', 'Predicted frequency (Hz)'));
    const diagStart = xScale(minValue);
    const diagEnd = xScale(maxValue);
    elements.push(`<line x1="${diagStart}" y1="${yScale(minValue)}" x2="${diagEnd}" y2="${yScale(maxValue)}" stroke="#334155" stroke-dasharray="6 4" />`);
    for (const row of detected) {
        const predicted = row.result?.predictedFrequencyHz ?? row.gt;
        elements.push(`<circle cx="${xScale(row.gt).toFixed(2)}" cy="${yScale(predicted).toFixed(2)}" r="4.5" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.85" />`);
    }
    elements.push('</svg>');
    return elements.join('\n');
}
function buildHistogramSvg(fileEvaluations) {
    const width = 920;
    const height = 560;
    const margin = { left: 72, right: 24, top: 52, bottom: 64 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const allErrors = ALGORITHMS.flatMap((algorithm) => fileEvaluations
        .map((row) => row.algorithms.find((entry) => entry.algorithm === algorithm)?.centsError ?? null)
        .filter((value) => value !== null));
    const maxAbs = Math.max(100, ...allErrors.map((value) => Math.abs(value)));
    const minValue = -Math.ceil(maxAbs / 50) * 50;
    const maxValue = Math.ceil(maxAbs / 50) * 50;
    const binCount = 16;
    const binWidth = (maxValue - minValue) / binCount;
    const binsByAlgorithm = new Map();
    let maxBin = 1;
    for (const algorithm of ALGORITHMS) {
        const bins = new Array(binCount).fill(0);
        const errors = fileEvaluations
            .map((row) => row.algorithms.find((entry) => entry.algorithm === algorithm)?.centsError ?? null)
            .filter((value) => value !== null);
        for (const error of errors) {
            const clampedIndex = Math.max(0, Math.min(binCount - 1, Math.floor((error - minValue) / binWidth)));
            bins[clampedIndex] += 1;
            maxBin = Math.max(maxBin, bins[clampedIndex]);
        }
        binsByAlgorithm.set(algorithm, bins);
    }
    const xScale = linearScale(minValue, maxValue, margin.left, margin.left + innerWidth);
    const yScale = linearScale(0, maxBin, margin.top + innerHeight, margin.top);
    const ticks = buildLinearTicks(minValue, maxValue, 8);
    const elements = [];
    elements.push(svgHeader(width, height));
    elements.push(`<rect width="${width}" height="${height}" fill="#08111f" />`);
    elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Cents Error Histogram (RAW)</text>`);
    elements.push(buildAxes(width, height, margin, ticks, buildLinearTicks(0, maxBin, 6), xScale, yScale, 'Signed cents error', 'File count'));
    const groupWidth = innerWidth / binCount;
    const barWidth = groupWidth / (ALGORITHMS.length + 1);
    for (let index = 0; index < binCount; index += 1) {
        const binStart = minValue + index * binWidth;
        for (let algorithmIndex = 0; algorithmIndex < ALGORITHMS.length; algorithmIndex += 1) {
            const algorithm = ALGORITHMS[algorithmIndex];
            const bins = binsByAlgorithm.get(algorithm) ?? [];
            const value = bins[index] ?? 0;
            const barHeight = margin.top + innerHeight - yScale(value);
            const x = margin.left + index * groupWidth + algorithmIndex * barWidth;
            elements.push(`<rect x="${x.toFixed(2)}" y="${yScale(value).toFixed(2)}" width="${(barWidth - 2).toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.7" />`);
        }
        elements.push(`<text x="${(xScale(binStart + binWidth / 2)).toFixed(2)}" y="${height - 14}" fill="#64748b" font-size="10" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(`${Math.round(binStart)}`)}</text>`);
    }
    elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 220, 72));
    elements.push('</svg>');
    return elements.join('\n');
}
function buildPerStringSvg(pipeline) {
    const width = 920;
    const height = 560;
    const margin = { left: 72, right: 24, top: 52, bottom: 64 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const strings = uniqueSorted(pipeline.fileEvaluations.map((row) => row.stringId)).sort((left, right) => right - left);
    const xBand = bandScale(strings.map(String), margin.left, margin.left + innerWidth, 0.18);
    const subBand = bandScale(ALGORITHMS.map(String), 0, xBand.bandWidth, 0.12);
    const yScale = linearScale(0, 1, margin.top + innerHeight, margin.top);
    const elements = [];
    elements.push(svgHeader(width, height));
    elements.push(`<rect width="${width}" height="${height}" fill="#08111f" />`);
    elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Per-String Pitch Accuracy (RAW)</text>`);
    elements.push(buildAxes(width, height, margin, strings.map((value) => ({ value, label: `String ${value}` })), buildPercentTicks(), xBand.centerForValue, yScale, 'String', 'Accuracy (±50c)'));
    for (const stringId of strings) {
        const x0 = xBand.positionForValue(String(stringId));
        if (x0 === null)
            continue;
        const groupRows = pipeline.fileEvaluations.filter((row) => row.stringId === stringId);
        for (const algorithm of ALGORITHMS) {
            const subX = subBand.positionForValue(algorithm);
            if (subX === null)
                continue;
            const metrics = computeAggregateMetrics(groupRows.map((row) => row.algorithms.find((entry) => entry.algorithm === algorithm)).filter((value) => Boolean(value)));
            const y = yScale(metrics.pitchAccuracy50Cents);
            const barHeight = margin.top + innerHeight - y;
            elements.push(`<rect x="${(x0 + subX).toFixed(2)}" y="${y.toFixed(2)}" width="${(subBand.bandWidth - 2).toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.8" />`);
        }
    }
    elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 220, 72));
    elements.push('</svg>');
    return elements.join('\n');
}
function buildPerFretHeatmapSvg(pipeline) {
    const frets = uniqueSorted(pipeline.fileEvaluations.map((row) => row.fret));
    const cellWidth = 54;
    const cellHeight = 42;
    const width = 180 + frets.length * cellWidth;
    const height = 120 + ALGORITHMS.length * cellHeight;
    const startX = 140;
    const startY = 70;
    const elements = [];
    elements.push(svgHeader(width, height));
    elements.push(`<rect width="${width}" height="${height}" fill="#08111f" />`);
    elements.push(`<text x="24" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Per-Fret Accuracy Heatmap (RAW)</text>`);
    for (let column = 0; column < frets.length; column += 1) {
        elements.push(`<text x="${startX + column * cellWidth + cellWidth / 2}" y="${startY - 12}" fill="#cbd5e1" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${frets[column]}</text>`);
    }
    for (let rowIndex = 0; rowIndex < ALGORITHMS.length; rowIndex += 1) {
        const algorithm = ALGORITHMS[rowIndex];
        elements.push(`<text x="24" y="${startY + rowIndex * cellHeight + 26}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
        for (let column = 0; column < frets.length; column += 1) {
            const fret = frets[column];
            const rows = pipeline.fileEvaluations
                .filter((evaluation) => evaluation.fret === fret)
                .map((evaluation) => evaluation.algorithms.find((entry) => entry.algorithm === algorithm))
                .filter((value) => Boolean(value));
            const accuracy = computeAggregateMetrics(rows).pitchAccuracy50Cents;
            const fill = heatColor(accuracy);
            const x = startX + column * cellWidth;
            const y = startY + rowIndex * cellHeight;
            elements.push(`<rect x="${x}" y="${y}" width="${cellWidth - 4}" height="${cellHeight - 4}" rx="6" fill="${fill}" />`);
            elements.push(`<text x="${x + (cellWidth - 4) / 2}" y="${y + 24}" fill="#020617" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(`${Math.round(accuracy * 100)}%`)}</text>`);
        }
    }
    elements.push('</svg>');
    return elements.join('\n');
}
function buildFailureSvg(fileEvaluations) {
    const width = 920;
    const height = 420;
    const margin = { left: 72, right: 24, top: 52, bottom: 64 };
    const innerWidth = width - margin.left - margin.right;
    const minFreq = Math.min(...fileEvaluations.map((row) => row.groundTruthFrequencyHz)) * 0.95;
    const maxFreq = Math.max(...fileEvaluations.map((row) => row.groundTruthFrequencyHz)) * 1.05;
    const xScale = linearScale(minFreq, maxFreq, margin.left, margin.left + innerWidth);
    const yStep = 64;
    const elements = [];
    elements.push(svgHeader(width, height));
    elements.push(`<rect width="${width}" height="${height}" fill="#08111f" />`);
    elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Failures vs Ground Truth Frequency (RAW)</text>`);
    const ticks = buildLinearTicks(minFreq, maxFreq, 8);
    elements.push(buildXAxisOnly(height, margin, ticks, xScale, 'Ground truth frequency (Hz)'));
    for (let index = 0; index < ALGORITHMS.length; index += 1) {
        const algorithm = ALGORITHMS[index];
        const y = margin.top + index * yStep + 40;
        elements.push(`<text x="20" y="${y + 4}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
        elements.push(`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#1e293b" />`);
        for (const evaluation of fileEvaluations) {
            const result = evaluation.algorithms.find((entry) => entry.algorithm === algorithm);
            if (!result?.noDetection)
                continue;
            elements.push(`<circle cx="${xScale(evaluation.groundTruthFrequencyHz).toFixed(2)}" cy="${y.toFixed(2)}" r="5" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.85" />`);
        }
    }
    elements.push('</svg>');
    return elements.join('\n');
}
function buildAxes(width, height, margin, xTicks, yTicks, xProject, yProject, xLabel, yLabel) {
    const elements = [];
    elements.push(`<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#475569" />`);
    elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#475569" />`);
    for (const tick of xTicks) {
        const value = typeof tick === 'number' ? tick : tick.value;
        const label = typeof tick === 'number' ? formatAxisTick(value) : (tick.label ?? formatAxisTick(value));
        const x = xProject(value);
        elements.push(`<line x1="${x.toFixed(2)}" y1="${margin.top}" x2="${x.toFixed(2)}" y2="${height - margin.bottom}" stroke="#122032" />`);
        elements.push(`<text x="${x.toFixed(2)}" y="${height - margin.bottom + 20}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(label)}</text>`);
    }
    for (const tick of yTicks) {
        const value = typeof tick === 'number' ? tick : tick.value;
        const label = typeof tick === 'number' ? formatAxisTick(value) : (tick.label ?? formatAxisTick(value));
        const y = yProject(value);
        elements.push(`<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}" stroke="#122032" />`);
        elements.push(`<text x="${margin.left - 10}" y="${y.toFixed(2)}" fill="#94a3b8" font-size="11" text-anchor="end" dominant-baseline="middle" font-family="Arial, sans-serif">${escapeXml(label)}</text>`);
    }
    elements.push(`<text x="${(margin.left + width - margin.right) / 2}" y="${height - 18}" fill="#cbd5e1" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(xLabel)}</text>`);
    elements.push(`<text x="18" y="${(margin.top + height - margin.bottom) / 2}" fill="#cbd5e1" font-size="12" text-anchor="middle" font-family="Arial, sans-serif" transform="rotate(-90 18 ${(margin.top + height - margin.bottom) / 2})">${escapeXml(yLabel)}</text>`);
    return elements.join('\n');
}
function buildXAxisOnly(height, margin, xTicks, xProject, xLabel) {
    const elements = [];
    const y = height - margin.bottom;
    elements.push(`<line x1="${margin.left}" y1="${y}" x2="${920 - margin.right}" y2="${y}" stroke="#475569" />`);
    for (const tick of xTicks) {
        const x = xProject(tick);
        elements.push(`<line x1="${x.toFixed(2)}" y1="${margin.top}" x2="${x.toFixed(2)}" y2="${y}" stroke="#122032" />`);
        elements.push(`<text x="${x.toFixed(2)}" y="${y + 20}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(formatAxisTick(tick))}</text>`);
    }
    elements.push(`<text x="${(margin.left + 920 - margin.right) / 2}" y="${height - 18}" fill="#cbd5e1" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(xLabel)}</text>`);
    return elements.join('\n');
}
function buildLegend(items, x, y) {
    const lines = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const yOffset = y + index * 18;
        lines.push(`<rect x="${x}" y="${yOffset - 10}" width="12" height="12" fill="${item.color}" />`);
        lines.push(`<text x="${x + 18}" y="${yOffset}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(item.label)}</text>`);
    }
    return lines;
}
async function decodeMonoAudio(filePath) {
    const bytes = await fs.readFile(filePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const decoded = await decodeAudio(arrayBuffer);
    if (decoded.numberOfChannels <= 1) {
        return {
            samples: new Float32Array(decoded.getChannelData(0)),
            sampleRate: decoded.sampleRate
        };
    }
    const mixed = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const channelData = decoded.getChannelData(channel);
        for (let index = 0; index < mixed.length; index += 1) {
            mixed[index] += channelData[index] / decoded.numberOfChannels;
        }
    }
    return { samples: mixed, sampleRate: decoded.sampleRate };
}
function readFrame(samples, start, frameSize) {
    const frame = new Float32Array(frameSize);
    if (start >= samples.length) {
        return frame;
    }
    const available = Math.min(frameSize, samples.length - start);
    frame.set(samples.subarray(start, start + available), 0);
    return frame;
}
function buildSampledFrameStarts(sampleCount, sampleRate) {
    if (!(sampleCount > 0) || !(sampleRate > 0)) {
        return [0];
    }
    const maxStart = Math.max(0, sampleCount - FRAME_SIZE);
    if (maxStart <= 0) {
        return [0];
    }
    const marginSamples = Math.min(maxStart, Math.round(WINDOW_MARGIN_SEC * sampleRate));
    const startMin = marginSamples;
    const startMax = Math.max(startMin, maxStart - marginSamples);
    const audioDurationSec = sampleCount / sampleRate;
    const targetCount = audioDurationSec >= 1.2
        ? SAMPLED_WINDOWS_PER_FILE
        : Math.max(6, Math.floor(SAMPLED_WINDOWS_PER_FILE / 2));
    if (startMax <= startMin || targetCount <= 1) {
        return [Math.round((startMin + startMax) / 2)];
    }
    const starts = [];
    for (let index = 0; index < targetCount; index += 1) {
        const ratio = targetCount === 1 ? 0.5 : index / (targetCount - 1);
        starts.push(Math.round(startMin + ratio * (startMax - startMin)));
    }
    return uniqueSorted(starts);
}
function parseTakeFromFileName(fileName) {
    const match = fileName.match(FILE_NAME_PATTERN);
    if (!match)
        return null;
    return {
        stringId: Number(match[1]),
        fret: Number(match[2]),
        take: Number(match[3])
    };
}
function buildDatasetKey(stringId, fret, take) {
    if (!Number.isFinite(stringId) || !Number.isFinite(fret) || !Number.isFinite(take)) {
        return null;
    }
    return `${Math.round(stringId)}:${Math.round(fret)}:${Math.round(take)}`;
}
async function readJsonIfExists(filePath) {
    try {
        const text = await fs.readFile(filePath, 'utf8');
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function finiteInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}
function buildRejectReason(rmsDbfs) {
    if (rmsDbfs !== null && rmsDbfs < -55) {
        return 'insufficient_signal_level';
    }
    return 'no_detection';
}
function centsBetweenFrequencies(observedHz, referenceHz) {
    return 1200 * Math.log2(observedHz / referenceHz);
}
function median(values) {
    if (values.length <= 0)
        return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
}
function mean(values) {
    if (values.length <= 0)
        return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function mostCommon(values) {
    const counts = new Map();
    for (const value of values) {
        if (!value)
            continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}
function mostCommonNumber(values) {
    const counts = new Map();
    for (const value of values) {
        if (value === null)
            continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
}
function uniqueSorted(values) {
    return [...new Set(values)].sort((left, right) => left - right);
}
function roundNumber(value, digits) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}
function roundNullable(value, digits) {
    return value === null ? null : roundNumber(value, digits);
}
function compareNullable(left, right) {
    if (left === null && right === null)
        return 0;
    if (left === null)
        return 1;
    if (right === null)
        return -1;
    return left - right;
}
function csvEscape(value) {
    if (/[",\n]/.test(value)) {
        return `"${value.replaceAll('"', '""')}"`;
    }
    return value;
}
function formatCsvValue(value) {
    if (value === null || value === undefined)
        return '';
    return String(value);
}
function sanitizeFileSegment(value) {
    return value.replace(/[^a-z0-9_-]+/gi, '_');
}
function svgHeader(width, height) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
}
function escapeXml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
function linearScale(domainMin, domainMax, rangeMin, rangeMax) {
    const safeSpan = domainMax - domainMin || 1;
    return (value) => rangeMin + ((value - domainMin) / safeSpan) * (rangeMax - rangeMin);
}
function buildLinearTicks(minValue, maxValue, count) {
    if (!(maxValue > minValue))
        return [minValue];
    const step = (maxValue - minValue) / Math.max(1, count - 1);
    const ticks = [];
    for (let index = 0; index < count; index += 1) {
        ticks.push(minValue + index * step);
    }
    return ticks;
}
function buildPercentTicks() {
    return [0, 0.25, 0.5, 0.75, 1];
}
function formatAxisTick(value) {
    if (Math.abs(value) >= 100)
        return `${Math.round(value)}`;
    if (Math.abs(value) >= 10)
        return value.toFixed(1);
    return value.toFixed(2);
}
function colorForAlgorithm(algorithm) {
    switch (algorithm) {
        case 'ac14':
            return '#38bdf8';
        case 'spectral_game_runtime_unified_v3':
            return '#22c55e';
        case 'MASP':
            return '#f59e0b';
        case 'FRETNET':
            return '#f43f5e';
        default:
            return '#cbd5e1';
    }
}
function heatColor(value) {
    const clamped = Math.max(0, Math.min(1, value));
    const hue = 10 + clamped * 110;
    return `hsl(${hue}, 75%, ${35 + clamped * 20}%)`;
}
function bandScale(values, rangeMin, rangeMax, paddingInner) {
    const span = rangeMax - rangeMin;
    const step = span / Math.max(1, values.length + paddingInner * Math.max(0, values.length - 1));
    const bandWidth = step * (1 - paddingInner);
    const positions = new Map();
    values.forEach((value, index) => {
        positions.set(value, rangeMin + index * step);
    });
    return {
        bandWidth,
        positionForValue: (value) => positions.get(value) ?? null,
        centerForValue: (value) => {
            const position = positions.get(String(value)) ?? positions.get(value) ?? null;
            return position === null ? rangeMin : position + bandWidth / 2;
        }
    };
}
function formatPct(value, signed = false) {
    const percent = value * 100;
    return `${signed && percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}
function formatNullable(value, digits, suffix = '') {
    if (value === null)
        return '-';
    return `${value.toFixed(digits)}${suffix}`;
}
function formatNullablePct(value) {
    if (value === null)
        return '-';
    return formatPct(value);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
