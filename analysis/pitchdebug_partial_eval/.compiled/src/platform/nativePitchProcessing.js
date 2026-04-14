export class NativeSampleAccumulator {
    blockSize;
    stagedSampleCount = 0;
    totalReceivedSamples = 0;
    totalConsumedSamples = 0;
    emittedBlockCount = 0;
    finalized = false;
    constructor(blockSize) {
        this.blockSize = blockSize;
        if (!Number.isInteger(blockSize) || blockSize <= 0) {
            throw new Error(`NativeSampleAccumulator requires a positive integer block size, got ${blockSize}.`);
        }
    }
    append(sampleCount) {
        this.ensureOpen();
        const normalizedSampleCount = normalizePositiveInteger(sampleCount, 'sampleCount');
        this.totalReceivedSamples += normalizedSampleCount;
        this.stagedSampleCount += normalizedSampleCount;
        const emittedBlockCount = Math.floor(this.stagedSampleCount / this.blockSize);
        const consumedSampleCount = emittedBlockCount * this.blockSize;
        this.stagedSampleCount -= consumedSampleCount;
        this.totalConsumedSamples += consumedSampleCount;
        this.emittedBlockCount += emittedBlockCount;
        return {
            emittedBlockCount,
            consumedSampleCount,
            stagedSampleCount: this.stagedSampleCount
        };
    }
    reset() {
        this.ensureOpen();
        this.stagedSampleCount = 0;
    }
    finalize(options = {}) {
        this.ensureOpen();
        this.finalized = true;
        const discardPendingSamples = options.discardPendingSamples ?? true;
        const discardedSampleCount = discardPendingSamples ? this.stagedSampleCount : 0;
        if (discardPendingSamples) {
            this.stagedSampleCount = 0;
        }
        return {
            discardedSampleCount,
            stagedSampleCount: this.stagedSampleCount
        };
    }
    snapshot() {
        return {
            blockSize: this.blockSize,
            stagedSampleCount: this.stagedSampleCount,
            totalReceivedSamples: this.totalReceivedSamples,
            totalConsumedSamples: this.totalConsumedSamples,
            emittedBlockCount: this.emittedBlockCount,
            finalized: this.finalized
        };
    }
    ensureOpen() {
        if (this.finalized) {
            throw new Error('NativeSampleAccumulator cannot be used after finalize().');
        }
    }
}
export function evaluateNativeProcessingProgress(diagnostics) {
    const callbackCount = normalizeOptionalCounter(diagnostics?.callback_count);
    const signalCallbackCount = normalizeOptionalCounter(diagnostics?.signal_callback_count);
    const stagedSampleCount = normalizeOptionalCounter(diagnostics?.staged_sample_count);
    const targetBlockSize = normalizeOptionalCounter(diagnostics?.target_block_size);
    const processedBlockCount = normalizeOptionalCounter(diagnostics?.processed_block_count);
    const emittedResultCount = normalizeOptionalCounter(diagnostics?.emitted_result_count);
    const runtimeProcessNullResultCount = normalizeOptionalCounter(diagnostics?.runtime_process_null_result_count);
    const runtimeProcessErrorCount = normalizeOptionalCounter(diagnostics?.runtime_process_error_count);
    const lastError = typeof diagnostics?.last_error === 'string' ? diagnostics.last_error.trim() : '';
    if (callbackCount <= 0) {
        return {
            state: 'waiting_for_callbacks',
            reason: 'no_callbacks'
        };
    }
    if (signalCallbackCount <= 0) {
        return {
            state: 'waiting_for_signal',
            reason: 'callbacks_without_signal'
        };
    }
    if (runtimeProcessErrorCount > 0 || lastError.length > 0) {
        return {
            state: 'runtime_error',
            reason: 'runtime_error',
            processedBlockCount,
            runtimeProcessErrorCount,
            lastError: lastError.length > 0 ? lastError : 'Native runtime reported an unspecified error.'
        };
    }
    if (processedBlockCount > 0 && emittedResultCount <= 0 && runtimeProcessNullResultCount > 0) {
        return {
            state: 'runtime_returned_no_result',
            reason: 'runtime_returned_no_result',
            processedBlockCount,
            runtimeProcessNullResultCount
        };
    }
    if (processedBlockCount > 0) {
        return {
            state: 'processing_active',
            reason: 'processing_blocks',
            processedBlockCount,
            emittedResultCount
        };
    }
    if (targetBlockSize > 0 && stagedSampleCount < targetBlockSize) {
        return {
            state: 'waiting_for_full_block',
            reason: 'insufficient_samples',
            stagedSampleCount,
            targetBlockSize,
            missingSampleCount: targetBlockSize - stagedSampleCount
        };
    }
    return {
        state: 'ready_but_not_processing',
        reason: 'processing_stalled',
        stagedSampleCount,
        targetBlockSize,
        callbackCount,
        signalCallbackCount
    };
}
function normalizePositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer, got ${value}.`);
    }
    return value;
}
function normalizeOptionalCounter(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 0;
}
