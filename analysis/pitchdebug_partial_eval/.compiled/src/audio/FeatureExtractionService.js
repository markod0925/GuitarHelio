import { DEFAULT_FFT_SIZE, buildFftPlan, computeMagnitudeSpectrum, computeSignalMetrics, computeTopSpectralPeaks } from './debugSignalProcessing.js';
export class FeatureExtractionService {
    fftSize;
    fftPlan;
    re;
    im;
    magnitude;
    previousProcessedRms = 0;
    constructor(fftSize = DEFAULT_FFT_SIZE) {
        this.fftSize = fftSize;
        this.fftPlan = buildFftPlan(fftSize);
        this.re = new Float64Array(fftSize);
        this.im = new Float64Array(fftSize);
        this.magnitude = new Float32Array(fftSize / 2 + 1);
    }
    updateFftSize(fftSize) {
        if (this.fftSize === fftSize)
            return;
        this.fftSize = fftSize;
        this.fftPlan = buildFftPlan(fftSize);
        this.re = new Float64Array(fftSize);
        this.im = new Float64Array(fftSize);
        this.magnitude = new Float32Array(fftSize / 2 + 1);
    }
    getFftSize() {
        return this.fftSize;
    }
    extractFeatures(processedFrame, sampleRate, referenceNote, spectralModel) {
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
