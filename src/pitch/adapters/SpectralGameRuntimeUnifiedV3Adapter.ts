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

export class SpectralGameRuntimeUnifiedV3Adapter {
  readonly name = 'spectral_game_runtime_unified_v3';
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
    const core = this.ensureCore(input.sampleRate, input.processedFrame.length);
    core.set_reference_block(new Float32Array(input.processedFrame.length));
    const output = core.process_block(input.processedFrame) as Record<string, unknown>;
    const midi = finiteNumber(output.midi_estimate);
    const confidence = finiteNumber(output.confidence) ?? 0;
    const candidates = extractSelectedNoteCandidates(output.selected_notes);
    const bestScore = candidates[0]?.confidence ?? null;
    const secondBestScore = candidates[1]?.confidence ?? null;
    const debug = {
      bestMidi: midi ?? null,
      bestSpectralScore: bestScore,
      harmonicConsistency: input.optionalFeatures?.metrics.harmonicityScore ?? null,
      peakPatternSummary: input.optionalFeatures?.topSpectralPeaks.map((peak) => `${peak.frequencyHz.toFixed(1)}Hz`) ?? [],
      gateStates: {
        lowBandEnergyRatio: input.optionalFeatures?.metrics.lowBandEnergyRatio ?? 0,
        rmsDbfs: input.optionalFeatures?.metrics.rmsDbfs ?? -120
      },
      acceptRejectReasoning: midi === undefined ? buildCommonRejectReason(input.optionalFeatures, 'no_spectral_candidate') : 'accepted',
      bestNoteId: stringOrNull(output.best_note_id),
      scoreMargin: bestScore !== null && secondBestScore !== null ? bestScore - secondBestScore : null
    };
    if (midi === undefined) {
      return makeRejectedResult(this.name, buildCommonRejectReason(input.optionalFeatures, 'no_spectral_candidate'), debug);
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
      this.core = createPreparedCore(PitchDetectorPreset.SpectralGameRuntimeUnifiedV3, sampleRate, blockSize, this.spectralModelJson);
      this.preparedSampleRate = sampleRate;
      this.preparedBlockSize = blockSize;
    }
    return this.core;
  }
}
