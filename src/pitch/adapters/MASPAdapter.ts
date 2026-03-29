import {
  MASP_TUNED_PARAMS,
  computeCentError,
  computeHar,
  computeHarmonicityH,
  computeMbw,
  computeValidationDecision,
  scoreMaspMidiFrame,
  type MaspHarmonicMap
} from '../../audio/maspCore';
import { resolveMaspResampleMode } from '../../audio/maspShared';
import type { AudioFrameContext, PitchCandidate, PitchDetectorConfig, PitchDetectorResult } from '../types';
import { computeRms } from '../../audio/debugSignalProcessing';
import { midiToHz, midiToNoteName } from '../../ui/song-select/utils/songSelectUtils';

const MASP_FFT_SIZE = 4096;
const MASP_STRICT_SAMPLE_RATE = 22050;
const MASP_TARGET_RMS = 0.1;
const MASP_HARMONIC_LOCAL_BANDWIDTH_BINS = 2;

export class MASPAdapter {
  readonly name = 'MASP';
  private enabled = true;
  private readonly window = buildHannWindow(MASP_FFT_SIZE);
  private readonly fftPlan = buildFftPlan(MASP_FFT_SIZE);
  private readonly strictFrame = new Float32Array(MASP_FFT_SIZE);
  private readonly re = new Float64Array(MASP_FFT_SIZE);
  private readonly im = new Float64Array(MASP_FFT_SIZE);
  private readonly magnitude = new Float32Array(MASP_FFT_SIZE / 2 + 1);
  private maps: MaspHarmonicMap[] = buildMaspHarmonicMaps(
    MASP_STRICT_SAMPLE_RATE,
    MASP_FFT_SIZE,
    MASP_TUNED_PARAMS.midiMin,
    88,
    MASP_TUNED_PARAMS.maxHarmonics,
    MASP_HARMONIC_LOCAL_BANDWIDTH_BINS
  );
  private previousAcceptedMidi: number | null = null;

  init(config: PitchDetectorConfig): void {
    this.enabled = config.enabled;
  }

  reset(): void {
    this.previousAcceptedMidi = null;
  }

  processFrame(input: AudioFrameContext): PitchDetectorResult {
    if (!this.enabled) {
      return {
        detectorName: this.name,
        accepted: false,
        rejectReason: 'disabled'
      };
    }

    const mode = resolveMaspResampleMode(input.sampleRate);
    const strictFrame = resampleForMasp(input.processedFrame, mode, this.strictFrame);
    if (!strictFrame) {
      return {
        detectorName: this.name,
        accepted: false,
        rejectReason: 'unsupported_resample_mode',
        debug: {
          resampleMode: mode
        }
      };
    }

    const referenceNote = input.optionalFeatures?.referenceNote;
    const expectedMidis = referenceNote
      ? [referenceNote.midi]
      : buildExpectedMidis(input.optionalFeatures?.candidateNotes ?? []);
    const expectedCandidates = buildExpectedCandidates(expectedMidis, input.optionalFeatures?.candidateNotes ?? []);

    const noiseRms = computeRms(strictFrame);
    normalizeToTargetRms(strictFrame, MASP_TARGET_RMS);
    this.re.fill(0);
    this.im.fill(0);
    for (let i = 0; i < MASP_FFT_SIZE; i += 1) {
      this.re[i] = strictFrame[i] * this.window[i];
    }
    fftInPlace(this.re, this.im, this.fftPlan);
    for (let i = 0; i < this.magnitude.length; i += 1) {
      this.magnitude[i] = Math.hypot(this.re[i], this.im[i]);
    }
    const pitchSpectrum = scoreMaspMidiFrame(this.magnitude, this.maps, MASP_TUNED_PARAMS);
    const bestSpectrum = topSpectrumIndices(pitchSpectrum, 3).map((index) => ({
      midi: MASP_TUNED_PARAMS.midiMin + index,
      score: pitchSpectrum[index]
    }));
    const bestMidi = referenceNote
      ? referenceNote.midi
      : (bestSpectrum[0]?.midi ?? null);
    const secondBestScore = bestSpectrum[1]?.score ?? 0;
    const metrics = {
      h: computeHarmonicityH(this.magnitude, pitchSpectrum, MASP_STRICT_SAMPLE_RATE, MASP_FFT_SIZE, MASP_TUNED_PARAMS.midiMin),
      har: computeHar(pitchSpectrum, expectedMidis, MASP_TUNED_PARAMS.midiMin),
      mbw: computeMbw(this.magnitude, expectedMidis, this.maps),
      centError: computeCentError(pitchSpectrum, expectedMidis, MASP_TUNED_PARAMS.midiMin),
      noiseRms
    };
    const decision = computeValidationDecision({
      metrics,
      hTarget: 1,
      params: MASP_TUNED_PARAMS
    });
    const temporalStability = bestMidi !== null && this.previousAcceptedMidi !== null
      ? Math.max(0, 1 - Math.abs(bestMidi - this.previousAcceptedMidi) / 12)
      : 1;
    const candidates: PitchCandidate[] = bestSpectrum.map((item) => ({
      pitchHz: midiToHz(item.midi),
      midi: item.midi,
      noteName: midiToNoteName(item.midi),
      confidence: item.score,
      label: expectedCandidates.get(item.midi) ?? undefined
    }));
    const debug = {
      bestNoteHypothesis: bestMidi !== null ? midiToNoteName(bestMidi) : null,
      bestScore: bestSpectrum[0]?.score ?? 0,
      secondBestScore,
      scoreMargin: (bestSpectrum[0]?.score ?? 0) - secondBestScore,
      harmonicAgreement: metrics.har,
      harmonicity: metrics.h,
      temporalStability,
      thresholdFailure: decision.pass ? null : decision.reason,
      validationReason: decision.reason,
      centError: metrics.centError,
      noiseRms,
      resampleMode: mode
    };

    if (!decision.pass || bestMidi === null) {
      return {
        detectorName: this.name,
        accepted: false,
        confidence: decision.weightedScore,
        candidates,
        rejectReason: bestMidi === null ? 'no_best_hypothesis' : decision.reason,
        debug
      };
    }

    this.previousAcceptedMidi = bestMidi;
    const cents = referenceNote ? (bestMidi - referenceNote.midi) * 100 : metrics.centError;
    return {
      detectorName: this.name,
      accepted: true,
      midi: bestMidi,
      pitchHz: midiToHz(bestMidi),
      noteName: midiToNoteName(bestMidi),
      cents,
      confidence: decision.weightedScore,
      stringId: expectedCandidates.get(bestMidi)?.match(/^s(\d+)_/) ? Number(expectedCandidates.get(bestMidi)?.match(/^s(\d+)_/)?.[1]) : null,
      fret: expectedCandidates.get(bestMidi)?.match(/_f(\d+)$/) ? Number(expectedCandidates.get(bestMidi)?.match(/_f(\d+)$/)?.[1]) : null,
      candidates,
      debug
    };
  }
}

function buildExpectedMidis(candidateNotes: Array<{ midi: number }>): number[] {
  const values = new Set<number>();
  for (const note of candidateNotes) {
    if (Number.isFinite(note.midi)) values.add(Math.round(note.midi));
  }
  return Array.from(values).sort((a, b) => a - b);
}

function buildExpectedCandidates(candidateMidis: number[], candidateNotes: Array<{ midi: number; string: number; fret: number }>): Map<number, string> {
  const out = new Map<number, string>();
  for (const midi of candidateMidis) {
    const note = candidateNotes.find((entry) => Math.round(entry.midi) === midi);
    if (note) {
      out.set(midi, `s${note.string}_f${note.fret}`);
    }
  }
  return out;
}

function normalizeToTargetRms(samples: Float32Array, targetRms: number): void {
  const currentRms = computeRms(samples);
  if (!(currentRms > 0) || !(targetRms > 0)) return;
  const gain = targetRms / currentRms;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= gain;
  }
}

function topSpectrumIndices(spectrum: readonly number[], count: number): number[] {
  const out = spectrum.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  return out.slice(0, count).map((entry) => entry.index);
}

type FftPlan = {
  nfft: number;
  bitrev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
};

function buildHannWindow(length: number): Float64Array {
  const out = new Float64Array(length);
  const denom = Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }
  return out;
}

function buildFftPlan(nfft: number): FftPlan {
  const bits = Math.round(Math.log2(nfft));
  const bitrev = new Uint32Array(nfft);
  for (let i = 0; i < nfft; i += 1) {
    let x = i;
    let y = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    bitrev[i] = y;
  }
  const cos = new Float64Array(nfft / 2);
  const sin = new Float64Array(nfft / 2);
  for (let i = 0; i < nfft / 2; i += 1) {
    const angle = (-2 * Math.PI * i) / nfft;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  return { nfft, bitrev, cos, sin };
}

function fftInPlace(re: Float64Array, im: Float64Array, plan: FftPlan): void {
  const n = plan.nfft;
  for (let i = 0; i < n; i += 1) {
    const j = plan.bitrev[i];
    if (j <= i) continue;
    const tmpRe = re[i];
    re[i] = re[j];
    re[j] = tmpRe;
    const tmpIm = im[i];
    im[i] = im[j];
    im[j] = tmpIm;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k += 1) {
        const tableIndex = k * step;
        const wr = plan.cos[tableIndex];
        const wi = plan.sin[tableIndex];
        const even = start + k;
        const odd = even + half;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        const ur = re[even];
        const ui = im[even];
        re[even] = ur + tr;
        im[even] = ui + ti;
        re[odd] = ur - tr;
        im[odd] = ui - ti;
      }
    }
  }
}

function buildMaspHarmonicMaps(
  sampleRate: number,
  nfft: number,
  midiMin: number,
  midiMax: number,
  maxHarmonics: number,
  localBandwidthBins: number
): MaspHarmonicMap[] {
  const nyquist = sampleRate * 0.5;
  const hzPerBin = sampleRate / nfft;
  const maxBin = Math.floor(nfft / 2);
  const maps: MaspHarmonicMap[] = [];
  for (let midi = midiMin; midi <= midiMax; midi += 1) {
    const f0 = midiToHz(midi);
    const ranges = [];
    for (let harmonic = 1; harmonic <= maxHarmonics; harmonic += 1) {
      const harmonicHz = f0 * harmonic;
      if (harmonicHz >= nyquist) break;
      const center = Math.round(harmonicHz / hzPerBin);
      ranges.push({
        start: Math.max(0, center - localBandwidthBins),
        end: Math.min(maxBin, center + localBandwidthBins)
      });
    }
    maps.push({ midi, f0_hz: f0, ranges });
  }
  return maps;
}

function resampleForMasp(source: Float32Array, mode: ReturnType<typeof resolveMaspResampleMode>, out: Float32Array): Float32Array | null {
  if (source.length <= 0 || out.length !== MASP_FFT_SIZE) return null;
  if (mode === 'native_22050') {
    if (source.length < MASP_FFT_SIZE) return null;
    out.set(source.subarray(0, MASP_FFT_SIZE));
    return out;
  }
  if (mode === 'decimate_44100') {
    if (source.length < MASP_FFT_SIZE * 2) return null;
    for (let i = 0; i < MASP_FFT_SIZE; i += 1) {
      out[i] = source[i * 2];
    }
    return out;
  }
  if (mode === 'linear_48000') {
    if (source.length < 2) return null;
    const scale = (source.length - 1) / Math.max(1, MASP_FFT_SIZE - 1);
    for (let i = 0; i < MASP_FFT_SIZE; i += 1) {
      const position = i * scale;
      const index = Math.floor(position);
      const fraction = position - index;
      const x0 = source[index];
      const x1 = source[Math.min(source.length - 1, index + 1)];
      out[i] = x0 + (x1 - x0) * fraction;
    }
    return out;
  }
  return null;
}
