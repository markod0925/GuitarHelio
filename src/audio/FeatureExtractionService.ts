import type { PrecomputedFeatures, ReferenceNoteSelection } from '../pitch/types';
import type { SpectralRuntimeModel } from './pitchDetector';
import {
  DEFAULT_FFT_SIZE,
  buildFftPlan,
  computeMagnitudeSpectrum,
  computeSignalMetrics,
  computeTopSpectralPeaks,
  type FftPlan
} from './debugSignalProcessing';

export class FeatureExtractionService {
  private fftSize: number;
  private fftPlan: FftPlan;
  private re: Float64Array;
  private im: Float64Array;
  private magnitude: Float32Array;
  private previousProcessedRms = 0;

  constructor(fftSize = DEFAULT_FFT_SIZE) {
    this.fftSize = fftSize;
    this.fftPlan = buildFftPlan(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.magnitude = new Float32Array(fftSize / 2 + 1);
  }

  updateFftSize(fftSize: number): void {
    if (this.fftSize === fftSize) return;
    this.fftSize = fftSize;
    this.fftPlan = buildFftPlan(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.magnitude = new Float32Array(fftSize / 2 + 1);
  }

  getFftSize(): number {
    return this.fftSize;
  }

  extractFeatures(
    processedFrame: Float32Array,
    sampleRate: number,
    referenceNote: ReferenceNoteSelection | null,
    spectralModel: SpectralRuntimeModel | null
  ): PrecomputedFeatures {
    computeMagnitudeSpectrum(processedFrame, this.fftSize, this.fftPlan, this.re, this.im, this.magnitude);
    const metrics = computeSignalMetrics(processedFrame, this.magnitude, sampleRate, this.fftSize, this.previousProcessedRms);
    this.previousProcessedRms = metrics.rms;
    const topSpectralPeaks = computeTopSpectralPeaks(this.magnitude, sampleRate, this.fftSize, 6);
    const candidateNotes = spectralModel?.notes ?? [];
    let totalEnergy = 0;
    for (let i = 0; i < this.magnitude.length; i += 1) {
      totalEnergy += this.magnitude[i];
    }
    return {
      metrics,
      fftSize: this.fftSize,
      magnitudeSpectrum: new Float32Array(this.magnitude),
      frequencyResolutionHz: sampleRate / this.fftSize,
      topSpectralPeaks,
      spectralEnergyTotal: totalEnergy,
      referenceNote,
      spectralModel,
      candidateNotes
    };
  }
}
