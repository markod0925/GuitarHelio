import { describe, expect, test } from 'vitest';
import type { DatasetRow } from '../tools/benchmark_suites/shared';
import { midiToHz } from '../src/ui/song-select/utils/songSelectUtils';
import type { JamsNoteEvent } from '../tools/benchmark_suites/gameplay_validator_polyphonic';
import {
  buildAndroidMonoWindows,
  buildGuitarSetSoloWindows,
  buildStreamingBenchmarkSweepVariants,
  buildStreamingFrameTimeline,
  centsDifference,
  DEFAULT_GUITARSET_WINDOW_CONFIG,
  DEFAULT_MONO_BENCHMARK_CONFIG,
  evaluateMonoWindow,
  prepareMonoAudioForBenchmark,
  secondsToSampleIndex,
  type MonoFrameObservation,
  type MonoWindowSpec
} from '../tools/benchmark_suites/ac14_mono_streaming';

function datasetRow(overrides: Partial<DatasetRow> = {}): DatasetRow {
  return {
    fileId: overrides.fileId ?? 's01_f05_t01',
    filePath: overrides.filePath ?? 'assets/session_20260403_174852/audio/string_01_fret_05_take_01.wav',
    relativeFilePath: overrides.relativeFilePath ?? 'assets/session_20260403_174852/audio/string_01_fret_05_take_01.wav',
    stringId: overrides.stringId ?? 1,
    fret: overrides.fret ?? 5,
    take: overrides.take ?? 1,
    durationSec: overrides.durationSec ?? 3.25,
    sampleRate: overrides.sampleRate ?? 48000,
    sampleCount: overrides.sampleCount ?? 156000,
    manifestOrder: overrides.manifestOrder ?? 1
  };
}

function baseSpec(overrides: Partial<MonoWindowSpec> = {}): MonoWindowSpec {
  return {
    windowId: overrides.windowId ?? 'window_01',
    fileId: overrides.fileId ?? 'file_01',
    relativeFilePath: overrides.relativeFilePath ?? 'audio/file_01.wav',
    dataset: overrides.dataset ?? 'android',
    startSec: overrides.startSec ?? 0,
    endSec: overrides.endSec ?? 0.2,
    targetOnsetSec: overrides.targetOnsetSec ?? 0.05,
    expectedMidi: overrides.expectedMidi ?? 64,
    expectedAccept: overrides.expectedAccept ?? true,
    windowKind: overrides.windowKind ?? 'stable',
    windowCategory: overrides.windowCategory ?? 'single_note_window',
    isStableWindow: overrides.isStableWindow ?? true,
    sourceStringId: overrides.sourceStringId ?? 1,
    sourceFret: overrides.sourceFret ?? 5,
    sourceTake: overrides.sourceTake ?? 1,
    sourceBand: overrides.sourceBand ?? 'mid',
    noteLabel: overrides.noteLabel ?? 'E4'
  };
}

function frameObservation(
  frameIndex: number,
  centerSec: number,
  detectedMidi: number | null,
  detectedHz: number | null,
  overrides: Partial<MonoFrameObservation> = {}
): MonoFrameObservation {
  const frameSizeSamples = overrides.frameSizeSamples ?? 2048;
  const hopSizeSamples = overrides.hopSizeSamples ?? 512;
  const sampleRate = overrides.sampleRate ?? 48000;
  const startSample = Math.max(0, Math.round((centerSec * sampleRate) - frameSizeSamples / 2));
  return {
    frameIndex,
    timestampMs: centerSec * 1000,
    frameStartSec: startSample / sampleRate,
    frameCenterSec: centerSec,
    frameEndSec: (startSample + frameSizeSamples) / sampleRate,
    frameStartSample: startSample,
    frameEndSample: startSample + frameSizeSamples,
    frameSizeSamples,
    hopSizeSamples,
    sampleRate,
    runtimeMs: overrides.runtimeMs ?? 0.2,
    detectorAccepted: overrides.detectorAccepted ?? detectedMidi !== null,
    detectorConfidence: overrides.detectorConfidence ?? 0.9,
    detectedMidi,
    detectedHz,
    rejectReason: overrides.rejectReason ?? null
  };
}

describe('ac14 streaming gameplay benchmark helpers', () => {
  test('keeps Android and GuitarSet windows in seconds and maps frame/hop semantics explicitly', () => {
    const androidWindows = buildAndroidMonoWindows({
      datasetRow: datasetRow(),
      midi: 64,
      durationSec: 3.25
    });
    const stableWindows = androidWindows.filter((window) => window.windowKind === 'stable');

    expect(stableWindows.map((window) => [window.startSec, window.endSec])).toEqual([
      [0.5, 1.1],
      [1.15, 1.75],
      [1.8, 2.4]
    ]);
    expect(stableWindows.every((window) => window.targetOnsetSec !== null)).toBe(true);

    const timeline = buildStreamingFrameTimeline({
      sampleCount: 4096,
      sampleRate: 48000,
      frameSizeSamples: 2048,
      hopSizeSamples: 512
    });
    expect(timeline.slice(0, 4).map((frame) => frame.frameStartSample)).toEqual([0, 512, 1024, 1536]);
    expect(timeline[0]?.frameCenterSec).toBeCloseTo(2048 / 2 / 48000, 6);
    expect(secondsToSampleIndex(0.25, 44100)).toBe(11025);
    expect(secondsToSampleIndex(0.25, 48000)).toBe(12000);

    const events: JamsNoteEvent[] = [
      { startSec: 0.4, endSec: 1.2, midi: 64, sourceTrack: '0', annotationIndex: 0, observationIndex: 0 },
      { startSec: 1.8, endSec: 2.2, midi: 67, sourceTrack: '0', annotationIndex: 1, observationIndex: 1 }
    ];
    const guitarsetWindows = buildGuitarSetSoloWindows({
      fileId: 'track_01',
      relativeFilePath: 'tools/pitch-offline-bench/input/wav/track_01_solo.wav',
      durationSec: 3.0,
      events,
      config: DEFAULT_GUITARSET_WINDOW_CONFIG
    });
    expect(guitarsetWindows.every((window) => window.dataset === 'guitarset_solo')).toBe(true);
    expect(guitarsetWindows.some((window) => window.targetOnsetSec !== null)).toBe(true);
  });

  test('respects cents tolerance and keeps the requested pitch thresholds separate', () => {
    expect(centsDifference(880, 440)).toBeCloseTo(1200, 6);

    const expectedMidi = 64;
    const expectedHz = midiToHz(expectedMidi);
    const detectedHz = expectedHz * 2 ** (80 / 1200);
    const observations = [
      frameObservation(0, 0.01, expectedMidi, detectedHz),
      frameObservation(1, 0.06, expectedMidi, detectedHz),
      frameObservation(2, 0.11, expectedMidi, detectedHz)
    ];
    const spec = baseSpec({ expectedMidi, startSec: 0, endSec: 0.2, targetOnsetSec: 0.05 });

    const rejectAt30 = evaluateMonoWindow({
      spec,
      observations,
      config: {
        ...DEFAULT_MONO_BENCHMARK_CONFIG,
        pitchToleranceCents: 30
      }
    });
    const acceptAt100 = evaluateMonoWindow({
      spec,
      observations,
      config: {
        ...DEFAULT_MONO_BENCHMARK_CONFIG,
        pitchToleranceCents: 100
      }
    });

    expect(rejectAt30.accept).toBe(false);
    expect(rejectAt30.rejectReason).toBe('target_missed');
    expect(acceptAt100.accept).toBe(true);
    expect(acceptAt100.evidence.confirmedCentsError).toBeCloseTo(80, 3);
  });

  test('confirms a target only after the required consecutive good frames', () => {
    const expectedMidi = 64;
    const expectedHz = midiToHz(expectedMidi);
    const observations = [
      frameObservation(0, 0.01, expectedMidi, expectedHz),
      frameObservation(1, 0.06, expectedMidi, expectedHz),
      frameObservation(2, 0.11, expectedMidi, expectedHz),
      frameObservation(3, 0.16, expectedMidi, expectedHz)
    ];
    const spec = baseSpec({ expectedMidi, startSec: 0, endSec: 0.2, targetOnsetSec: 0.05 });

    const twoFrames = evaluateMonoWindow({
      spec,
      observations,
      config: {
        ...DEFAULT_MONO_BENCHMARK_CONFIG,
        pitchToleranceCents: 100,
        requiredConsecutiveFrames: 2
      }
    });
    const threeFrames = evaluateMonoWindow({
      spec,
      observations,
      config: {
        ...DEFAULT_MONO_BENCHMARK_CONFIG,
        pitchToleranceCents: 100,
        requiredConsecutiveFrames: 3
      }
    });

    expect(twoFrames.accept).toBe(true);
    expect(threeFrames.accept).toBe(true);
    expect(twoFrames.evidence.confirmedConsecutiveFrames).toBe(2);
    expect(threeFrames.evidence.confirmedConsecutiveFrames).toBe(3);
    expect(twoFrames.decisionLatencyMs).toBeLessThan(threeFrames.decisionLatencyMs ?? Number.POSITIVE_INFINITY);
  });

  test('keeps the gameplay sweep limited to 2048/4096 and both sample-rate scenarios', () => {
    const variants = buildStreamingBenchmarkSweepVariants();
    expect(variants).toHaveLength(24);
    expect(new Set(variants.map((variant) => variant.fftSize))).toEqual(new Set([2048, 4096]));
    expect(new Set(variants.map((variant) => variant.sampleRateMode))).toEqual(new Set(['force_48000', 'force_44100']));
    expect(new Set(variants.map((variant) => variant.pitchToleranceCents))).toEqual(new Set([30, 100, 300]));
    expect(new Set(variants.map((variant) => variant.requiredConsecutiveFrames))).toEqual(new Set([2, 3]));

    const source = new Float32Array([1, 0, -1, 0]);
    const forced48000 = prepareMonoAudioForBenchmark({
      samples: source,
      sampleRate: 44100,
      sampleRateMode: 'force_48000'
    });
    const forced44100 = prepareMonoAudioForBenchmark({
      samples: source,
      sampleRate: 48000,
      sampleRateMode: 'force_44100'
    });

    expect(forced48000.sampleRate).toBe(48000);
    expect(forced48000.resampled).toBe(true);
    expect(forced44100.sampleRate).toBe(44100);
    expect(forced44100.resampled).toBe(true);
  });

  test('builds GuitarSet _solo windows without introducing polyphonic categories', () => {
    const events: JamsNoteEvent[] = [
      { startSec: 0.4, endSec: 1.2, midi: 64, sourceTrack: '0', annotationIndex: 0, observationIndex: 0 },
      { startSec: 1.8, endSec: 2.2, midi: 67, sourceTrack: '0', annotationIndex: 1, observationIndex: 1 }
    ];

    const windows = buildGuitarSetSoloWindows({
      fileId: 'track_01',
      relativeFilePath: 'tools/pitch-offline-bench/input/wav/track_01_solo.wav',
      durationSec: 3.0,
      events,
      config: DEFAULT_GUITARSET_WINDOW_CONFIG
    });

    expect(new Set(windows.map((window) => window.windowCategory))).toEqual(
      new Set(['empty_window', 'transition_window', 'single_note_window'])
    );
    expect(windows.every((window) => window.dataset === 'guitarset_solo')).toBe(true);
  });
});
