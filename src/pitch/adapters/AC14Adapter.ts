import { PitchDetectorPreset } from '../../audio/dsp-core/gh_dsp_core.js';
import type { AudioFrameContext, PitchDetectorConfig, PitchDetectorResult } from '../types';
import {
  buildCommonRejectReason,
  createPreparedCore,
  ensureDspCoreLoaded,
  finiteNumber,
  makeAcceptedResult,
  makeRejectedResult
} from './shared';

export class AC14Adapter {
  readonly name = 'ac14';
  private enabled = true;
  private core: ReturnType<typeof createPreparedCore> | null = null;
  private preparedSampleRate = 0;
  private preparedBlockSize = 0;

  async init(config: PitchDetectorConfig): Promise<void> {
    this.enabled = config.enabled;
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
    const pitchHz = finiteNumber(output.pitch_hz);
    const pitchConfidence = finiteNumber(output.pitch_confidence) ?? 0;
    const referencePolicyApplied = output.reference_policy_applied === true;
    const rejectedAsReferenceBleed = output.rejected_as_reference_bleed === true;
    const autocorrLag = input.optionalFeatures?.metrics.autocorrelationBestLag;
    const debug = {
      rawCandidateHz: pitchHz ?? null,
      periodLag: autocorrLag ?? null,
      periodicity: pitchConfidence,
      octaveAmbiguity: pitchHz && input.optionalFeatures?.topSpectralPeaks?.[0]
        ? Math.abs(input.optionalFeatures.topSpectralPeaks[0].frequencyHz - pitchHz * 2) <= 8
        : false,
      smoothingState: 'disabled',
      referencePolicyApplied,
      rejectedAsReferenceBleed,
      referenceCorrelation: finiteNumber(output.reference_correlation) ?? null,
      contaminationScore: finiteNumber(output.contamination_score) ?? null
    };
    if (midi === undefined) {
      return makeRejectedResult(
        this.name,
        rejectedAsReferenceBleed
          ? 'reference_bleed_rejected'
          : buildCommonRejectReason(input.optionalFeatures, pitchHz ? 'autocorrelation_gate_failed' : 'no_pitch_candidate'),
        debug
      );
    }
    const result = makeAcceptedResult(this.name, midi, confidence, debug, pitchHz
      ? [{
          pitchHz,
          midi,
          noteName: undefined,
          confidence: pitchConfidence,
          label: 'raw_ac14_candidate'
        }]
      : []);
    result.cents = input.optionalFeatures?.referenceNote
      ? (midi - input.optionalFeatures.referenceNote.midi) * 100
      : undefined;
    return result;
  }

  private ensureCore(sampleRate: number, blockSize: number) {
    if (!this.core || this.preparedSampleRate !== sampleRate || this.preparedBlockSize !== blockSize) {
      this.core?.free();
      this.core = createPreparedCore(PitchDetectorPreset.Ac14, sampleRate, blockSize);
      this.preparedSampleRate = sampleRate;
      this.preparedBlockSize = blockSize;
    }
    return this.core;
  }
}
