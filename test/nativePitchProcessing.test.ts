import { describe, expect, test } from 'vitest';
import { evaluateNativeProcessingProgress, NativeSampleAccumulator } from '../src/platform/nativePitchProcessing';

describe('NativeSampleAccumulator', () => {
  test('accumulates repeated 96-sample callbacks into 2048-sample blocks without sample loss', () => {
    const accumulator = new NativeSampleAccumulator(2048);

    for (let index = 0; index < 21; index += 1) {
      const result = accumulator.append(96);
      expect(result.emittedBlockCount).toBe(0);
      expect(result.stagedSampleCount).toBe(96 * (index + 1));
    }

    const thresholdCrossing = accumulator.append(96);
    expect(thresholdCrossing.emittedBlockCount).toBe(1);
    expect(thresholdCrossing.consumedSampleCount).toBe(2048);
    expect(thresholdCrossing.stagedSampleCount).toBe(64);
    expect(accumulator.snapshot()).toMatchObject({
      totalReceivedSamples: 2112,
      totalConsumedSamples: 2048,
      emittedBlockCount: 1,
      stagedSampleCount: 64
    });
  });

  test('accumulates repeated 96-sample callbacks into 4096-sample blocks with preserved remainder', () => {
    const accumulator = new NativeSampleAccumulator(4096);

    for (let index = 0; index < 42; index += 1) {
      const result = accumulator.append(96);
      expect(result.emittedBlockCount).toBe(0);
    }

    const thresholdCrossing = accumulator.append(96);
    expect(thresholdCrossing.emittedBlockCount).toBe(1);
    expect(thresholdCrossing.consumedSampleCount).toBe(4096);
    expect(thresholdCrossing.stagedSampleCount).toBe(32);
    expect(accumulator.snapshot()).toMatchObject({
      totalReceivedSamples: 4128,
      totalConsumedSamples: 4096,
      emittedBlockCount: 1,
      stagedSampleCount: 32
    });
  });

  test('supports mixed callback sizes without silently dropping remainder samples', () => {
    const accumulator = new NativeSampleAccumulator(2048);
    const callbackSizes = [96, 128, 256, 1600, 64];

    let totalReceived = 0;
    for (const callbackSize of callbackSizes) {
      totalReceived += callbackSize;
      accumulator.append(callbackSize);
    }

    expect(accumulator.snapshot()).toMatchObject({
      totalReceivedSamples: totalReceived,
      totalConsumedSamples: 2048,
      emittedBlockCount: 1,
      stagedSampleCount: totalReceived - 2048
    });
  });

  test('reset clears only staged samples and preserves received/consumed accounting', () => {
    const accumulator = new NativeSampleAccumulator(2048);

    accumulator.append(96);
    accumulator.append(96);
    accumulator.reset();

    expect(accumulator.snapshot()).toMatchObject({
      totalReceivedSamples: 192,
      totalConsumedSamples: 0,
      emittedBlockCount: 0,
      stagedSampleCount: 0
    });

    const postReset = accumulator.append(2048);
    expect(postReset.emittedBlockCount).toBe(1);
    expect(accumulator.snapshot()).toMatchObject({
      totalReceivedSamples: 2240,
      totalConsumedSamples: 2048,
      emittedBlockCount: 1,
      stagedSampleCount: 0
    });
  });

  test('finalize is deterministic when discarding or preserving pending samples', () => {
    const discardAccumulator = new NativeSampleAccumulator(2048);
    discardAccumulator.append(1000);
    expect(discardAccumulator.finalize()).toEqual({
      discardedSampleCount: 1000,
      stagedSampleCount: 0
    });

    const preserveAccumulator = new NativeSampleAccumulator(2048);
    preserveAccumulator.append(1000);
    expect(preserveAccumulator.finalize({ discardPendingSamples: false })).toEqual({
      discardedSampleCount: 0,
      stagedSampleCount: 1000
    });
  });

  test('rejects use after finalize so stop/reset behavior stays explicit', () => {
    const accumulator = new NativeSampleAccumulator(2048);
    accumulator.append(96);
    accumulator.finalize();

    expect(() => accumulator.append(96)).toThrow(/finalize/);
    expect(() => accumulator.reset()).toThrow(/finalize/);
  });
});

describe('evaluateNativeProcessingProgress', () => {
  test('reports waiting for a full block while callbacks are still accumulating', () => {
    expect(
      evaluateNativeProcessingProgress({
        callback_count: 20,
        signal_callback_count: 10,
        staged_sample_count: 1920,
        target_block_size: 2048,
        processed_block_count: 0,
        emitted_result_count: 0
      })
    ).toEqual({
      state: 'waiting_for_full_block',
      reason: 'insufficient_samples',
      stagedSampleCount: 1920,
      targetBlockSize: 2048,
      missingSampleCount: 128
    });
  });

  test('reports a precise stall when enough staged samples exist but processing is still zero', () => {
    expect(
      evaluateNativeProcessingProgress({
        callback_count: 3079,
        signal_callback_count: 1451,
        staged_sample_count: 4096,
        target_block_size: 2048,
        processed_block_count: 0,
        emitted_result_count: 0
      })
    ).toEqual({
      state: 'ready_but_not_processing',
      reason: 'processing_stalled',
      stagedSampleCount: 4096,
      targetBlockSize: 2048,
      callbackCount: 3079,
      signalCallbackCount: 1451
    });
  });

  test('distinguishes runtime no-result and runtime error cases once blocks are processed', () => {
    expect(
      evaluateNativeProcessingProgress({
        callback_count: 200,
        signal_callback_count: 100,
        staged_sample_count: 0,
        target_block_size: 2048,
        processed_block_count: 3,
        emitted_result_count: 0,
        runtime_process_null_result_count: 3
      })
    ).toEqual({
      state: 'runtime_returned_no_result',
      reason: 'runtime_returned_no_result',
      processedBlockCount: 3,
      runtimeProcessNullResultCount: 3
    });

    expect(
      evaluateNativeProcessingProgress({
        callback_count: 200,
        signal_callback_count: 100,
        staged_sample_count: 0,
        target_block_size: 2048,
        processed_block_count: 3,
        emitted_result_count: 0,
        runtime_process_error_count: 1,
        last_error: 'ORT init failed'
      })
    ).toEqual({
      state: 'runtime_error',
      reason: 'runtime_error',
      processedBlockCount: 3,
      runtimeProcessErrorCount: 1,
      lastError: 'ORT init failed'
    });
  });
});
