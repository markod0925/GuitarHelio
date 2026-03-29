import { PitchDetectorPreset } from '../../audio/dsp-core/gh_dsp_core.js';
import type { AudioFrameContext, PitchDetectorConfig, PitchDetectorResult } from '../types';
import {
  buildCommonRejectReason,
  createPreparedCore,
  ensureDspCoreLoaded,
  extractSelectedNoteCandidates,
  finiteInteger,
  finiteNumber,
  makeAcceptedResult,
  makeRejectedResult,
  resolveDefaultSpectralModelJson,
  stringOrNull
} from './shared';

export class FretNetAdapter {
  readonly name = 'FRETNET';
  private enabled = true;
  private core: ReturnType<typeof createPreparedCore> | null = null;
  private preparedSampleRate = 0;
  private preparedBlockSize = 0;
  private spectralModelJson = resolveDefaultSpectralModelJson();

  async init(config: PitchDetectorConfig): Promise<void> {
    this.enabled = config.enabled;
    const configuredModel = typeof config.detectorSpecific?.spectralModelJson === 'string'
      ? config.detectorSpecific.spectralModelJson
      : null;
    this.spectralModelJson = configuredModel ?? resolveDefaultSpectralModelJson();
    await ensureDspCoreLoaded();
  }

  reset(): void {
    this.core?.reset();
  }

  dispose(): void {
    this.core?.free();
    this.core = null;
  }

  processFrame(input: AudioFrameContext): PitchDetectorResult {
    if (!this.enabled) {
      return makeRejectedResult(this.name, 'disabled');
    }
    const startedAt = performance.now();
    const core = this.ensureCore(input.sampleRate, input.processedFrame.length);
    core.set_reference_block(new Float32Array(input.processedFrame.length));
    const output = core.process_block(input.processedFrame) as Record<string, unknown>;
    const midi = finiteNumber(output.midi_estimate);
    const confidence = finiteNumber(output.confidence) ?? 0;
    const candidates = extractSelectedNoteCandidates(output.selected_notes);
    const debug = {
      topPredictedClasses: candidates.map((candidate) => candidate.label ?? candidate.noteName ?? candidate.midi),
      topConfidenceValues: candidates.map((candidate) => candidate.confidence ?? 0),
      predictedString: finiteInteger(output.detected_string),
      predictedFret: finiteInteger(output.detected_fret),
      derivedMidi: midi ?? null,
      inferenceTime: performance.now() - startedAt,
      inputPreprocessingSummary: {
        sampleRate: input.sampleRate,
        frameSize: input.processedFrame.length,
        lowBandEnergyRatio: input.optionalFeatures?.metrics.lowBandEnergyRatio ?? 0
      },
      bestNoteId: stringOrNull(output.best_note_id),
      bestScore: candidates[0]?.confidence ?? null,
      secondBestScore: candidates[1]?.confidence ?? null
    };
    if (midi === undefined) {
      return makeRejectedResult(this.name, buildCommonRejectReason(input.optionalFeatures, 'no_fretnet_class'), debug);
    }
    const result = makeAcceptedResult(this.name, midi, confidence, debug, candidates);
    result.stringId = finiteInteger(output.detected_string);
    result.fret = finiteInteger(output.detected_fret);
    result.cents = input.optionalFeatures?.referenceNote
      ? (midi - input.optionalFeatures.referenceNote.midi) * 100
      : undefined;
    return result;
  }

  private ensureCore(sampleRate: number, blockSize: number) {
    if (!this.core || this.preparedSampleRate !== sampleRate || this.preparedBlockSize !== blockSize) {
      this.core?.free();
      this.core = createPreparedCore(PitchDetectorPreset.Fretnet, sampleRate, blockSize, this.spectralModelJson);
      this.preparedSampleRate = sampleRate;
      this.preparedBlockSize = blockSize;
    }
    return this.core;
  }
}
