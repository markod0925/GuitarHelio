import { applyHighPass, applyLowPass, applyNoiseGate, applyWindow, fillWindowKernel, normalizeFrame, removeDc } from './debugSignalProcessing.js';
const DEFAULT_CONFIG = {
    windowType: 'hann',
    normalize: false,
    dcRemoval: true,
    highPass: false,
    lowPass: false,
    bandPass: false,
    noiseGate: false,
    silenceGateThreshold: 0.0025,
    highPassHz: 55,
    lowPassHz: 1800
};
export class AudioPreprocessService {
    config;
    windowKernel;
    dryScratch;
    constructor(frameSize, config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.windowKernel = fillWindowKernel(new Float32Array(frameSize), this.config.windowType);
        this.dryScratch = new Float32Array(frameSize);
    }
    updateFrameSize(frameSize) {
        if (this.windowKernel.length === frameSize)
            return;
        this.windowKernel = fillWindowKernel(new Float32Array(frameSize), this.config.windowType);
        this.dryScratch = new Float32Array(frameSize);
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        fillWindowKernel(this.windowKernel, this.config.windowType);
    }
    getConfig() {
        return { ...this.config };
    }
    processFrame(rawFrame, sampleRate, outFrame) {
        const length = Math.min(rawFrame.length, outFrame.length);
        for (let i = 0; i < length; i += 1) {
            outFrame[i] = rawFrame[i];
            this.dryScratch[i] = rawFrame[i];
        }
        for (let i = length; i < outFrame.length; i += 1) {
            outFrame[i] = 0;
            this.dryScratch[i] = 0;
        }
        let removedDcOffset = 0;
        if (this.config.dcRemoval) {
            removedDcOffset = removeDc(outFrame);
        }
        if (this.config.bandPass || this.config.highPass) {
            applyHighPass(outFrame, sampleRate, this.config.highPassHz);
        }
        if (this.config.bandPass || this.config.lowPass) {
            applyLowPass(outFrame, sampleRate, this.config.lowPassHz);
        }
        let gateClosed = false;
        if (this.config.noiseGate) {
            gateClosed = applyNoiseGate(outFrame, this.config.silenceGateThreshold);
        }
        let gainApplied = 1;
        if (this.config.normalize && !gateClosed) {
            gainApplied = normalizeFrame(outFrame);
        }
        applyWindow(outFrame, this.windowKernel, outFrame);
        return {
            silenceGateOpen: !gateClosed,
            gainApplied,
            removedDcOffset
        };
    }
}
