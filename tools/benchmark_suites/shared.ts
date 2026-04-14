#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import decodeAudio from 'audio-decode';
import initDspCore, { GhDspCore, PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { MASPAdapter } from '../../src/pitch/adapters/MASPAdapter';
import type {
  AudioFrameContext,
  PitchDetectorResult,
  PrecomputedFeatures,
  ReferenceNoteSelection
} from '../../src/pitch/types';
import type { SpectralRuntimeModel, SpectralRuntimeNote } from '../../src/audio/pitchDetector';
import { midiForStringFret } from '../../src/guitar/tuning';
import { midiToHz, midiToNoteName } from '../../src/ui/song-select/utils/songSelectUtils';

const execFile = promisify(execFileCb);

export type DatasetRow = {
  fileId: string;
  filePath: string;
  relativeFilePath: string;
  stringId: number;
  fret: number;
  take: number;
  durationSec: number | null;
  sampleRate: number | null;
  sampleCount: number | null;
  manifestOrder: number | null;
};

type DatasetManifestTake = {
  order?: number;
  stringId?: number;
  fret?: number;
  take?: number;
  relativePath?: string;
  durationSec?: number | null;
  sampleRate?: number | null;
  sampleCount?: number | null;
};

type DatasetManifest = {
  takes?: DatasetManifestTake[];
};

export type DecodedAudio = {
  samples: Float32Array;
  sampleRate: number;
};

export type DetectorRunner = {
  name: string;
  init: () => Promise<void> | void;
  reset: () => void;
  processFrame: (input: AudioFrameContext) => PitchDetectorResult;
  dispose?: () => void;
};

export type PyinFrameResult = {
  captureTimeSec: number;
  pitchHz: number | null;
  midiEstimate: number | null;
  confidence: number | null;
  reason: string | null;
  processingTimeMs: number | null;
  callbackToResultLatencyMs: number | null;
};

export type PyinTrace = {
  inputSampleRate: number;
  runtimeSampleRate: number;
  resampled: boolean;
  runtimeBlockSize: number;
  runtimeCallbackSize: number;
  runtimeHopSize: number;
  fminHz: number;
  fmaxHz: number;
  inferredFrameLength: number;
  runDurationMs: number;
  wallTimeMs: number;
  runtimeCallCount: number;
  emittedEventCount: number;
  meanWallTimePerRuntimeCallMs: number | null;
  frames: PyinFrameResult[];
};

export type PyinRuntimeTuning = {
  sampleRate?: number;
  blockSize?: number;
  callbackSize?: number;
  pyin?: {
    fminHz?: number;
    fmaxHz?: number;
    frameLength?: number;
    winLength?: number;
    hopLength?: number;
    resolution?: number;
    fillUnvoiced?: number;
    center?: boolean;
    padMode?: 'constant' | 'reflect';
  };
  cacheTag?: string;
  disableFallbackCache?: boolean;
};

export const DATASET_ROOT = 'assets/session_20260403_174852';
export const WINDOWS_DATASET_ROOT = 'assets\\session_20260403_174852';
export const FILE_NAME_PATTERN = /^string_(\d+)_fret_(\d+)_take_(\d+)\.wav$/i;

export const FRAME_SIZE = 4096;
export const HOP_SIZE = 512;
export const PYIN_BLOCK_SIZE = FRAME_SIZE;
export const PYIN_CALLBACK_SIZE = FRAME_SIZE;

let dspCoreInitPromise: Promise<void> | null = null;

export class DspCoreDetector implements DetectorRunner {
  readonly name: string;
  private core: GhDspCore | null = null;
  private preparedSampleRate = 0;
  private preparedBlockSize = 0;
  private zeroReference = new Float32Array(0);

  constructor(
    name: string,
    private readonly preset: PitchDetectorPreset,
    private spectralModelJson: string | null = null
  ) {
    this.name = name;
  }

  async init(): Promise<void> {
    await ensureDspCoreReady();
  }

  reset(): void {
    this.core?.reset();
  }

  dispose(): void {
    this.core?.free();
    this.core = null;
  }

  updateSpectralModel(modelJson: string | null): void {
    this.spectralModelJson = modelJson;
    if (!this.core || !modelJson) return;
    this.core.set_spectral_model(modelJson);
  }

  processFrame(input: AudioFrameContext): PitchDetectorResult {
    const core = this.ensureCore(input.sampleRate, input.processedFrame.length);
    if (this.zeroReference.length !== input.processedFrame.length) {
      this.zeroReference = new Float32Array(input.processedFrame.length);
    }
    core.set_reference_block(this.zeroReference);
    const output = core.process_block(input.processedFrame) as Record<string, unknown>;
    const midi = finiteNumber(output.midi_estimate);
    const confidence = finiteNumber(output.confidence) ?? 0;
    if (midi === null) {
      return {
        detectorName: this.name,
        accepted: false,
        confidence,
        rejectReason: buildRejectReason(input.optionalFeatures?.metrics.rmsDbfs ?? null),
        stringId: finiteInteger(output.detected_string),
        fret: finiteInteger(output.detected_fret),
        debug: output
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
      fret: finiteInteger(output.detected_fret),
      debug: output
    };
  }

  private ensureCore(sampleRate: number, blockSize: number): GhDspCore {
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

export function createMaspDetector(): DetectorRunner {
  const masp = new MASPAdapter();
  return {
    name: masp.name,
    init: () => masp.init({ enabled: true }),
    reset: () => masp.reset(),
    processFrame: (input) => masp.processFrame(input)
  };
}

export async function ensureDspCoreReady(): Promise<void> {
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

export async function buildDatasetRows(datasetDir: string): Promise<DatasetRow[]> {
  const audioDir = path.join(datasetDir, 'audio');
  const manifestPath = path.join(datasetDir, 'manifest.json');
  const manifest = await readJsonIfExists<DatasetManifest>(manifestPath);
  const manifestByKey = new Map<string, DatasetManifestTake>();

  for (const take of manifest?.takes ?? []) {
    const key = buildDatasetKey(take.stringId, take.fret, take.take);
    if (key) {
      manifestByKey.set(key, take);
      continue;
    }
    const parsed = typeof take.relativePath === 'string' ? parseTakeFromFileName(path.basename(take.relativePath)) : null;
    if (parsed) {
      manifestByKey.set(buildDatasetKey(parsed.stringId, parsed.fret, parsed.take)!, take);
    }
  }

  const entries = await fs.readdir(audioDir);
  const rows: DatasetRow[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.wav')) continue;
    const parsed = parseTakeFromFileName(entry);
    if (!parsed) continue;
    const fullPath = path.join(audioDir, entry);
    const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
    const manifestTake = manifestByKey.get(buildDatasetKey(parsed.stringId, parsed.fret, parsed.take)!);
    rows.push({
      fileId: `s${String(parsed.stringId).padStart(2, '0')}_f${String(parsed.fret).padStart(2, '0')}_t${String(parsed.take).padStart(2, '0')}`,
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

  rows.sort((left, right) =>
    (left.manifestOrder ?? Number.MAX_SAFE_INTEGER) - (right.manifestOrder ?? Number.MAX_SAFE_INTEGER) ||
    right.stringId - left.stringId ||
    left.fret - right.fret ||
    left.take - right.take ||
    left.relativeFilePath.localeCompare(right.relativeFilePath)
  );
  return rows;
}

export async function decodeMonoAudio(filePath: string): Promise<DecodedAudio> {
  const bytes = await fs.readFile(filePath);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = await decodeAudio(arrayBuffer) as {
    sampleRate: number;
    length: number;
    numberOfChannels: number;
    getChannelData: (channel: number) => Float32Array;
  };
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

export function readFrame(samples: Float32Array, start: number, frameSize: number): Float32Array {
  const frame = new Float32Array(frameSize);
  if (start >= samples.length) return frame;
  const available = Math.min(frameSize, samples.length - start);
  frame.set(samples.subarray(start, start + available), 0);
  return frame;
}

export function buildFrameStartsFullCoverage(sampleCount: number, frameSize = FRAME_SIZE, hopSize = HOP_SIZE): number[] {
  if (sampleCount <= frameSize) return [0];
  const starts: number[] = [];
  for (let start = 0; start <= sampleCount - frameSize; start += hopSize) {
    starts.push(start);
  }
  if (starts[starts.length - 1] !== sampleCount - frameSize) {
    starts.push(sampleCount - frameSize);
  }
  return starts;
}

export function buildEvenlySpacedFrameStarts(sampleCount: number, targetCount: number, frameSize = FRAME_SIZE): number[] {
  if (!(sampleCount > 0)) return [0];
  const maxStart = Math.max(0, sampleCount - frameSize);
  if (maxStart <= 0) return [0];
  const count = Math.max(2, targetCount);
  const starts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0.5 : index / (count - 1);
    starts.push(Math.round(ratio * maxStart));
  }
  return uniqueSorted(starts);
}

export function buildReferenceNote(stringId: number, fret: number, midi: number): ReferenceNoteSelection {
  return {
    enabled: true,
    label: `${midiToNoteName(midi)} s${stringId}f${fret}`,
    midi,
    frequencyHz: midiToHz(midi),
    stringId,
    fret,
    centsTolerance: 50,
    harmonicOverlays: 3
  };
}

export function buildSingleNoteRuntimeModel(target: { stringId: number; fret: number; midi: number }): SpectralRuntimeModel {
  const note: SpectralRuntimeNote = {
    id: `n_s${target.stringId}_f${target.fret}_m${target.midi}`,
    string: target.stringId,
    fret: target.fret,
    midi: target.midi,
    frequency_hz: midiToHz(target.midi)
  };
  return {
    notes: [note],
    chords: []
  };
}

export function buildFeatureContextWithTarget(
  baseFeatures: PrecomputedFeatures,
  target: { stringId: number; fret: number; midi: number },
  runtimeModel: SpectralRuntimeModel
): PrecomputedFeatures {
  return {
    ...baseFeatures,
    referenceNote: buildReferenceNote(target.stringId, target.fret, target.midi),
    spectralModel: runtimeModel,
    candidateNotes: runtimeModel.notes
  };
}

export async function resolvePyinCliPath(repoRoot: string): Promise<string> {
  const candidates = [
    path.join(repoRoot, 'tools/native_pitch_runtime/target/release/fretnet_host_cli'),
    path.join(repoRoot, 'tools/native_pitch_runtime/target/debug/fretnet_host_cli')
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error('pYIN host CLI not found. Build tools/native_pitch_runtime first (fretnet_host_cli).');
}

export async function runPyinTraceForFile(input: {
  filePath: string;
  fileId: string;
  cliPath: string;
  outputDir: string;
  tuning?: PyinRuntimeTuning;
}): Promise<PyinTrace> {
  const cacheTag = input.tuning?.cacheTag ? `.${sanitizeFileSegment(input.tuning.cacheTag)}` : '';
  const outputPath = path.join(input.outputDir, `${input.fileId}${cacheTag}.pyin.json`);
  const hasOverrides = hasPyinRuntimeOverrides(input.tuning);
  const cachedTracePath = await resolveExistingPyinTracePath({
    outputPath,
    fileId: input.fileId,
    outputDir: input.outputDir,
    allowFallbackCache: !hasOverrides && !input.tuning?.disableFallbackCache
  });
  if (cachedTracePath) {
    return parsePyinTraceJson(await fs.readFile(cachedTracePath, 'utf8'), null);
  }

  const blockSize = finiteInteger(input.tuning?.blockSize) ?? PYIN_BLOCK_SIZE;
  const callbackSize = finiteInteger(input.tuning?.callbackSize) ?? PYIN_CALLBACK_SIZE;
  const args = [
    '--audio-path', input.filePath,
    '--backend', 'pyin',
    '--mode', 'streaming',
    '--format', 'json',
    '--block-size', String(blockSize),
    '--callback-size', String(callbackSize),
    '--output', outputPath
  ];

  const sampleRate = finiteInteger(input.tuning?.sampleRate);
  if (sampleRate !== null) {
    args.push('--sample-rate', String(sampleRate));
  }

  const pyin = input.tuning?.pyin;
  const fminHz = finiteNumber(pyin?.fminHz);
  if (fminHz !== null) args.push('--pyin-fmin-hz', String(fminHz));
  const fmaxHz = finiteNumber(pyin?.fmaxHz);
  if (fmaxHz !== null) args.push('--pyin-fmax-hz', String(fmaxHz));
  const frameLength = finiteInteger(pyin?.frameLength);
  if (frameLength !== null) args.push('--pyin-frame-length', String(frameLength));
  const winLength = finiteInteger(pyin?.winLength);
  if (winLength !== null) args.push('--pyin-win-length', String(winLength));
  const hopLength = finiteInteger(pyin?.hopLength);
  if (hopLength !== null) args.push('--pyin-hop-length', String(hopLength));
  const resolution = finiteNumber(pyin?.resolution);
  if (resolution !== null) args.push('--pyin-resolution', String(resolution));
  const fillUnvoiced = finiteNumber(pyin?.fillUnvoiced);
  if (fillUnvoiced !== null) args.push('--pyin-fill-unvoiced', String(fillUnvoiced));
  if (pyin?.center === true) args.push('--pyin-center');
  if (pyin?.padMode === 'constant' || pyin?.padMode === 'reflect') {
    args.push('--pyin-pad-mode', pyin.padMode);
  }

  const startedAt = performance.now();
  await execFile(input.cliPath, args, { maxBuffer: 64 * 1024 * 1024 });
  const runDurationMs = performance.now() - startedAt;

  return parsePyinTraceJson(await fs.readFile(outputPath, 'utf8'), runDurationMs);
}

function hasPyinRuntimeOverrides(tuning: PyinRuntimeTuning | undefined): boolean {
  if (!tuning) return false;
  const pyin = tuning.pyin;
  return (
    tuning.sampleRate !== undefined ||
    tuning.blockSize !== undefined ||
    tuning.callbackSize !== undefined ||
    tuning.disableFallbackCache === true ||
    (typeof tuning.cacheTag === 'string' && tuning.cacheTag.trim().length > 0) ||
    pyin?.fminHz !== undefined ||
    pyin?.fmaxHz !== undefined ||
    pyin?.frameLength !== undefined ||
    pyin?.winLength !== undefined ||
    pyin?.hopLength !== undefined ||
    pyin?.resolution !== undefined ||
    pyin?.fillUnvoiced !== undefined ||
    pyin?.center !== undefined ||
    pyin?.padMode !== undefined
  );
}

async function resolveExistingPyinTracePath(input: {
  outputPath: string;
  fileId: string;
  outputDir: string;
  allowFallbackCache: boolean;
}): Promise<string | null> {
  const directPath = input.outputPath;
  if (await pathExists(directPath)) {
    return directPath;
  }

  if (!input.allowFallbackCache) {
    return null;
  }

  const analysisRoot = path.resolve(input.outputDir, '..', '..');
  const fileName = `${input.fileId}.pyin.json`;
  const fallbackCandidates = [
    path.join(analysisRoot, 'pitchdebug_partial_eval_raw_only', '.pyin_cache', fileName),
    path.join(analysisRoot, 'pitchdebug_partial_eval', '.pyin_cache', fileName)
  ];

  for (const candidate of fallbackCandidates) {
    if (!await pathExists(candidate)) {
      continue;
    }
    await fs.mkdir(path.dirname(directPath), { recursive: true });
    try {
      await fs.copyFile(candidate, directPath);
      return directPath;
    } catch {
      return candidate;
    }
  }

  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parsePyinTraceJson(jsonText: string, measuredRunDurationMs: number | null): PyinTrace {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const runtimeConfig = (parsed.runtime_config ?? {}) as Record<string, unknown>;
  const audio = (parsed.audio ?? {}) as Record<string, unknown>;
  const runs = Array.isArray(parsed.runs) ? parsed.runs as Array<Record<string, unknown>> : [];
  const streamingRun = runs.find((run) => run.mode === 'streaming') ?? runs[0] ?? {};
  const run = (streamingRun.run ?? {}) as Record<string, unknown>;
  const rawFrames = Array.isArray(run.frames) ? run.frames as Array<Record<string, unknown>> : [];
  const pyinConfig = (runtimeConfig.pyin ?? {}) as Record<string, unknown>;

  const runtimeSampleRate = finiteInteger(runtimeConfig.sample_rate) ?? finiteInteger(audio.runtime_sample_rate) ?? 48_000;
  const runtimeBlockSize = finiteInteger(runtimeConfig.block_size) ?? PYIN_BLOCK_SIZE;
  const fminHz = finiteNumber(pyinConfig.fmin_hz) ?? 82.40689;
  const fmaxHz = finiteNumber(pyinConfig.fmax_hz) ?? 1200.0;
  const inferredFrameLength =
    finiteInteger(pyinConfig.frame_length) ?? deriveDefaultPyinFrameLength(runtimeSampleRate, runtimeBlockSize, fminHz);
  const runtimeHopSize = finiteInteger(pyinConfig.hop_length) ?? runtimeBlockSize;
  const runSummary = (run.summary ?? {}) as Record<string, unknown>;
  const cachedWallTimeMs = finiteNumber(runSummary.wall_time_ms);
  const runDurationMs = measuredRunDurationMs ?? cachedWallTimeMs ?? 0;
  const wallTimeMs = cachedWallTimeMs ?? runDurationMs;
  const runtimeCallCount = finiteInteger(runSummary.runtime_call_count) ?? 0;
  const emittedEventCount = finiteInteger(runSummary.emitted_event_count) ?? rawFrames.length;
  const meanWallTimePerRuntimeCallMs = finiteNumber(runSummary.mean_wall_time_per_runtime_call_ms);

  return {
    inputSampleRate: finiteInteger(audio.input_sample_rate) ?? runtimeSampleRate,
    runtimeSampleRate,
    resampled: Boolean(audio.resampled),
    runtimeBlockSize,
    runtimeCallbackSize: finiteInteger(runSummary.callback_size) ?? PYIN_CALLBACK_SIZE,
    runtimeHopSize,
    fminHz,
    fmaxHz,
    inferredFrameLength,
    runDurationMs,
    wallTimeMs,
    runtimeCallCount,
    emittedEventCount,
    meanWallTimePerRuntimeCallMs,
    frames: rawFrames.map((frame) => {
      const event = (frame.event ?? {}) as Record<string, unknown>;
      const pitchHz = finiteNumber(event.pitch_hz);
      return {
        captureTimeSec: finiteNumber(frame.capture_time_sec) ?? finiteNumber(event.timestamp_sec) ?? 0,
        pitchHz: pitchHz !== null && pitchHz > 0 ? pitchHz : null,
        midiEstimate: finiteNumber(event.midi_estimate),
        confidence: finiteNumber(event.confidence),
        reason: typeof event.reason === 'string' ? event.reason : null,
        processingTimeMs: finiteNumber(event.processing_time_ms),
        callbackToResultLatencyMs: finiteNumber(event.callback_to_result_latency_ms)
      };
    })
  };
}

export function selectPyinFrameResultsForRange(
  trace: PyinTrace,
  windowStartSec: number,
  windowEndSec: number,
  maxFrames: number
): PitchDetectorResult[] {
  const frames = sampleEvenly(
    trace.frames.filter((frame) => frame.captureTimeSec >= windowStartSec && frame.captureTimeSec <= windowEndSec),
    maxFrames
  );
  if (frames.length <= 0) {
    return [
      {
        detectorName: 'pyin',
        accepted: false,
        confidence: 0,
        rejectReason: 'pyin_no_event_in_window',
        debug: {
          runtimeSampleRate: trace.runtimeSampleRate,
          inputSampleRate: trace.inputSampleRate,
          resampled: trace.resampled,
          blockSize: trace.runtimeBlockSize,
          hopSize: trace.runtimeHopSize
        }
      }
    ];
  }
  return frames.map((frame) => {
    if (frame.pitchHz === null || frame.midiEstimate === null) {
      return {
        detectorName: 'pyin',
        accepted: false,
        confidence: frame.confidence ?? 0,
        rejectReason: frame.reason ?? 'pyin_unvoiced',
        debug: {
          runtimeSampleRate: trace.runtimeSampleRate,
          inputSampleRate: trace.inputSampleRate,
          resampled: trace.resampled,
          blockSize: trace.runtimeBlockSize,
          hopSize: trace.runtimeHopSize
        }
      } as PitchDetectorResult;
    }
    return {
      detectorName: 'pyin',
      accepted: true,
      midi: frame.midiEstimate,
      pitchHz: frame.pitchHz,
      noteName: midiToNoteName(Math.round(frame.midiEstimate)),
      confidence: frame.confidence ?? 0,
      debug: {
        runtimeSampleRate: trace.runtimeSampleRate,
        inputSampleRate: trace.inputSampleRate,
        resampled: trace.resampled,
        blockSize: trace.runtimeBlockSize,
        hopSize: trace.runtimeHopSize
      }
    } as PitchDetectorResult;
  });
}

function deriveDefaultPyinFrameLength(sampleRate: number, runtimeBlockSize: number, fminHz: number): number {
  const safeRuntimeBlock = Math.max(256, runtimeBlockSize);
  if (!(fminHz > 0)) return safeRuntimeBlock;
  const maxPeriod = Math.max(1, Math.ceil(Math.max(sampleRate, 8_000) / fminHz));
  const minSafeFrame = (maxPeriod + 2) * 2;
  return Math.max(safeRuntimeBlock, nextPowerOfTwoAtLeast(minSafeFrame));
}

function nextPowerOfTwoAtLeast(value: number): number {
  if (!(value > 1)) return 1;
  return 2 ** Math.ceil(Math.log2(value));
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

export function parseTakeFromFileName(fileName: string): { stringId: number; fret: number; take: number } | null {
  const match = fileName.match(FILE_NAME_PATTERN);
  if (!match) return null;
  return {
    stringId: Number(match[1]),
    fret: Number(match[2]),
    take: Number(match[3])
  };
}

export function buildDatasetKey(stringId: number | undefined, fret: number | undefined, take: number | undefined): string | null {
  if (!Number.isFinite(stringId) || !Number.isFinite(fret) || !Number.isFinite(take)) {
    return null;
  }
  return `${Math.round(stringId!)}:${Math.round(fret!)}:${Math.round(take!)}`;
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function buildRejectReason(rmsDbfs: number | null): string {
  if (rmsDbfs !== null && rmsDbfs < -55) {
    return 'insufficient_signal_level';
  }
  return 'no_detection';
}

export function centsBetweenFrequencies(observedHz: number, referenceHz: number): number {
  return 1200 * Math.log2(observedHz / referenceHz);
}

export function absCentsForMidiEstimate(midi: number, referenceMidi: number): number {
  return Math.abs((midi - referenceMidi) * 100);
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (values.length <= 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function percentile(values: number[], p: number): number | null {
  if (values.length <= 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.max(0, Math.min(1, p));
  const index = Math.floor((sorted.length - 1) * clamped);
  return sorted[index] ?? null;
}

export function standardDeviation(values: number[]): number | null {
  if (values.length <= 1) return null;
  const mu = average(values);
  const variance = average(values.map((value) => (value - mu) ** 2));
  return Math.sqrt(variance);
}

export function mostCommonNumber(values: Array<number | null>): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
}

export function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

export function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function stringGroup(stringId: number): 'low' | 'mid' | 'high' {
  if (stringId >= 5) return 'low';
  if (stringId >= 3) return 'mid';
  return 'high';
}

export function buildAllStringFretPositions(maxFret = 12): Array<{ stringId: number; fret: number; midi: number }> {
  const out: Array<{ stringId: number; fret: number; midi: number }> = [];
  for (let stringId = 1; stringId <= 6; stringId += 1) {
    for (let fret = 0; fret <= maxFret; fret += 1) {
      out.push({ stringId, fret, midi: midiForStringFret(stringId, fret) });
    }
  }
  return out;
}

export function findClosestPositionForMidi(
  positions: Array<{ stringId: number; fret: number; midi: number }>,
  targetMidi: number,
  preferredStringId?: number
): { stringId: number; fret: number; midi: number } | null {
  const candidates = positions
    .filter((position) => position.midi === targetMidi)
    .sort((left, right) => {
      if (preferredStringId === undefined) return left.stringId - right.stringId || left.fret - right.fret;
      return (
        Math.abs(left.stringId - preferredStringId) - Math.abs(right.stringId - preferredStringId) ||
        left.fret - right.fret ||
        left.stringId - right.stringId
      );
    });
  return candidates[0] ?? null;
}

export function roundNumber(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function roundNullable(value: number | null, digits: number): number | null {
  return value === null ? null : roundNumber(value, digits);
}

export function formatPct(value: number, signed = false): string {
  const percent = value * 100;
  return `${signed && percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

export function formatNullable(value: number | null, digits: number, suffix = ''): string {
  if (value === null) return '-';
  return `${value.toFixed(digits)}${suffix}`;
}

export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function svgHeader(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
}

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function linearScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): (value: number) => number {
  const safeSpan = domainMax - domainMin || 1;
  return (value: number) => rangeMin + ((value - domainMin) / safeSpan) * (rangeMax - rangeMin);
}

export function bandScale(values: string[], rangeMin: number, rangeMax: number, paddingInner: number) {
  const span = rangeMax - rangeMin;
  const step = span / Math.max(1, values.length + paddingInner * Math.max(0, values.length - 1));
  const bandWidth = step * (1 - paddingInner);
  const positions = new Map<string, number>();
  values.forEach((value, index) => {
    positions.set(value, rangeMin + index * step);
  });
  return {
    bandWidth,
    positionForValue: (value: string) => positions.get(value) ?? null,
    centerForValue: (value: string) => {
      const position = positions.get(value);
      return position === undefined ? rangeMin : position + bandWidth / 2;
    }
  };
}

export function buildLegend(items: Array<{ label: string; color: string }>, x: number, y: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const yOffset = y + index * 18;
    lines.push(`<rect x="${x}" y="${yOffset - 10}" width="12" height="12" fill="${item.color}" />`);
    lines.push(`<text x="${x + 18}" y="${yOffset}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(item.label)}</text>`);
  }
  return lines;
}

export function colorForAlgorithm(algorithm: string): string {
  switch (algorithm) {
    case 'ac14': return '#38bdf8';
    case 'spectral_game_runtime_unified_v3': return '#22c55e';
    case 'MASP': return '#f59e0b';
    case 'FRETNET': return '#f43f5e';
    case 'pyin': return '#a78bfa';
    default: return '#cbd5e1';
  }
}

export function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '_');
}
