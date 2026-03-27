import initDspCore, { DspMode, GhDspCore, PitchDetectorPreset } from './dsp-core/gh_dsp_core.js';
import {
  MASP_TUNED_PARAMS,
  computeCentError,
  computeHar,
  computeHarmonicityH,
  computeMbw,
  computeValidationDecision,
  scoreMaspMidiFrame
} from './maspCore';
import { MASP_GAME_SCENE_PRESET, resolveMaspResampleMode } from './maspShared';

const DETECTOR_PRESETS = {
  baseline: {
    windowSeconds: 2048 / 48000,
    chunkSeconds: 1024 / 48000,
    minFrequencyHz: 65,
    maxFrequencyHz: 1200,
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  },
  ac14: {
    windowSeconds: 0.08534542062883915,
    chunkSeconds: 0.03524227822491771,
    minFrequencyHz: 55,
    maxFrequencyHz: 1200,
    energyThreshold: 0.003074202393734413,
    correlationThreshold: 0.6559736283225794,
    decayGraceFrames: 4,
    decayEnergyFactor: 0.4157769062463687,
    decayCorrelationThreshold: 0.6288579679610562
  },
  spectral_game_runtime_unified_v3: {
    windowSeconds: 0.0464399093,
    chunkSeconds: 0.0116099773,
    minFrequencyHz: 75,
    maxFrequencyHz: 3600,
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  },
  fretnet: {
    windowSeconds: 4096 / 48000,
    chunkSeconds: 512 / 22050,
    minFrequencyHz: 75,
    maxFrequencyHz: 3600,
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  },
  [MASP_GAME_SCENE_PRESET]: {
    windowSeconds: 4096 / 22050,
    chunkSeconds: 512 / 22050,
    minFrequencyHz: 65,
    maxFrequencyHz: 1200,
    energyThreshold: 0.0032,
    correlationThreshold: 0.58,
    decayGraceFrames: 8,
    decayEnergyFactor: 0.55,
    decayCorrelationThreshold: 0.52
  }
};

const DEFAULT_DETECTOR_PRESET = 'baseline';
const MASP_FFT_SIZE = 4096;
const MASP_STRICT_SAMPLE_RATE = 22050;
const MASP_TARGET_RMS = 0.1;
const MASP_CONTEXT_STALE_SECONDS = 0.25;
const MASP_HARMONIC_LOCAL_BANDWIDTH_BINS = 2;
const MAX_DELAY_SAMPLES = 720;
const NLMS_TAPS = 64;
const NLMS_MU = 0.08;
const NLMS_EPS = 1e-6;

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.detectorPreset = normalizeDetectorPreset(options?.processorOptions?.detectorPreset);
    this.detectorConfig = getDetectorPresetConfig(this.detectorPreset);
    this.configureAnalysisWindow(this.detectorConfig);
    this.resetAnalysisState();
    this.audioInputMode = 'speaker';
    this.spectralModel = sanitizeSpectralModel(options?.processorOptions?.spectralModel);
    this.dspWasmBytes = options?.processorOptions?.dspWasmBytes ?? null;
    this.dspCore = null;
    this.legacyFallback = false;
    this.backendStatus = null;
    this.maspContext = null;
    this.maspContextAudioTime = Number.NEGATIVE_INFINITY;
    this.maspWindow = buildHannWindow(MASP_FFT_SIZE);
    this.maspFftPlan = buildFftPlan(MASP_FFT_SIZE);
    this.maspStrictFrame = new Float32Array(MASP_FFT_SIZE);
    this.maspRe = new Float64Array(MASP_FFT_SIZE);
    this.maspIm = new Float64Array(MASP_FFT_SIZE);
    this.maspMag = new Float32Array(MASP_FFT_SIZE / 2 + 1);
    this.maspMaps = buildMaspHarmonicMaps(
      MASP_STRICT_SAMPLE_RATE,
      MASP_FFT_SIZE,
      MASP_TUNED_PARAMS.midiMin,
      88,
      MASP_TUNED_PARAMS.maxHarmonics,
      MASP_HARMONIC_LOCAL_BANDWIDTH_BINS
    );
    this.port.onmessage = (event) => this.handleControlMessage(event.data);
    void this.initializeDspCore();
  }

  async initializeDspCore() {
    try {
      const moduleOrPath = this.dspWasmBytes ?? './dsp-core/gh_dsp_core_bg.wasm';
      await initDspCore({ module_or_path: moduleOrPath });
      const core = new GhDspCore();
      core.prepare(sampleRate, this.bufferSize, this.resolveDspMode(this.audioInputMode));
      core.set_pitch_detector_preset(this.resolvePitchPreset(this.detectorPreset));
      this.applySpectralModel(core, this.spectralModel);
      this.dspCore = core;
      this.legacyFallback = false;
      this.publishBackendStatus(false);
    } catch (error) {
      this.dspCore = null;
      this.legacyFallback = true;
      this.publishBackendStatus(true, toErrorMessage(error));
    }
  }

  handleControlMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'masp_context') {
      this.maspContext = sanitizeMaspContext(payload.context);
      this.maspContextAudioTime = Number.isFinite(payload.context_audio_time)
        ? payload.context_audio_time
        : Number.NEGATIVE_INFINITY;
      return;
    }
    if (payload.type !== 'config') return;
    if (payload.audioInputMode !== 'speaker' && payload.audioInputMode !== 'headphones') return;
    this.audioInputMode = payload.audioInputMode;
    this.spectralModel = sanitizeSpectralModel(payload.spectralModel);
    const nextPreset = normalizeDetectorPreset(payload.detectorPreset);
    if (nextPreset !== this.detectorPreset) {
      this.detectorPreset = nextPreset;
      this.detectorConfig = getDetectorPresetConfig(this.detectorPreset);
      this.configureAnalysisWindow(this.detectorConfig);
      this.resetAnalysisState();
    }
    if (!this.dspCore) return;
    this.dspCore.prepare(sampleRate, this.bufferSize, this.resolveDspMode(this.audioInputMode));
    this.dspCore.set_pitch_detector_preset(this.resolvePitchPreset(this.detectorPreset));
    this.applySpectralModel(this.dspCore, this.spectralModel);
    this.dspCore.reset();
  }

  resolveDspMode(audioInputMode) {
    return audioInputMode === 'headphones' ? DspMode.Headphones : DspMode.Speaker;
  }

  resolvePitchPreset(detectorPreset) {
    if (detectorPreset === 'ac14') {
      return PitchDetectorPreset.Ac14;
    }
    if (detectorPreset === MASP_GAME_SCENE_PRESET) {
      return PitchDetectorPreset.Baseline;
    }
    if (detectorPreset === 'fretnet') {
      return PitchDetectorPreset.Fretnet;
    }
    if (detectorPreset === 'spectral_game_runtime_unified_v3') {
      return PitchDetectorPreset.SpectralGameRuntimeUnifiedV3;
    }
    return PitchDetectorPreset.Baseline;
  }

  applySpectralModel(core, model) {
    if (
      !core ||
      !model ||
      (this.detectorPreset !== 'spectral_game_runtime_unified_v3' && this.detectorPreset !== 'fretnet')
    ) {
      return;
    }
    try {
      core.set_spectral_model(JSON.stringify(model));
    } catch (error) {
      this.publishBackendStatus(true, toErrorMessage(error));
      throw error;
    }
  }

  configureAnalysisWindow(detectorConfig) {
    if (this.detectorPreset === MASP_GAME_SCENE_PRESET) {
      const mode = resolveMaspResampleMode(sampleRate);
      if (mode === 'native_22050') {
        this.bufferSize = MASP_FFT_SIZE;
        this.hopSize = 512;
      } else if (mode === 'decimate_44100') {
        this.bufferSize = MASP_FFT_SIZE * 2;
        this.hopSize = 1024;
      } else if (mode === 'linear_48000') {
        this.bufferSize = Math.max(MASP_FFT_SIZE, Math.round((MASP_FFT_SIZE * sampleRate) / MASP_STRICT_SAMPLE_RATE));
        this.hopSize = Math.max(128, Math.round((512 * sampleRate) / MASP_STRICT_SAMPLE_RATE));
      } else {
        this.bufferSize = clampInteger(Math.round(detectorConfig.windowSeconds * sampleRate), 512, 16384);
        this.hopSize = clampInteger(Math.round(detectorConfig.chunkSeconds * sampleRate), 128, this.bufferSize);
      }
      this.minLag = Math.max(1, Math.floor(sampleRate / detectorConfig.maxFrequencyHz));
      this.maxLag = Math.max(this.minLag + 1, Math.floor(sampleRate / detectorConfig.minFrequencyHz));
      return;
    }
    const windowSamples = Math.floor(detectorConfig.windowSeconds * sampleRate);
    const hopSamples = Math.floor(detectorConfig.chunkSeconds * sampleRate);
    this.bufferSize = clampInteger(windowSamples, 512, 16384);
    this.hopSize = clampInteger(hopSamples, 128, this.bufferSize);
    this.minLag = Math.max(1, Math.floor(sampleRate / detectorConfig.maxFrequencyHz));
    this.maxLag = Math.max(this.minLag + 1, Math.floor(sampleRate / detectorConfig.minFrequencyHz));
  }

  resetAnalysisState() {
    this.micRing = new Float32Array(this.bufferSize);
    this.referenceRing = new Float32Array(this.bufferSize);
    this.micFrame = new Float32Array(this.bufferSize);
    this.referenceFrame = new Float32Array(this.bufferSize);
    this.alignedReferenceFrame = new Float32Array(this.bufferSize);
    this.residualFrame = new Float32Array(this.bufferSize);
    this.nlmsWeights = new Float32Array(NLMS_TAPS);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastAnalysis = 0;
    this.prevMicRms = 0;
    this.decayGraceFramesRemaining = 0;
  }

  publishBackendStatus(legacyFallback, reason) {
    if (this.backendStatus === legacyFallback) return;
    this.backendStatus = legacyFallback;
    this.port.postMessage({
      type: 'status',
      legacy_fallback: legacyFallback,
      reason
    });
  }

  process(inputs) {
    const micChannel = inputs[0]?.[0];
    if (!micChannel) return true;
    const referenceChannel = inputs[0]?.[1];

    for (let i = 0; i < micChannel.length; i += 1) {
      this.micRing[this.writeIndex] = micChannel[i];
      this.referenceRing[this.writeIndex] = referenceChannel ? referenceChannel[i] : 0;
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      this.totalSamples += 1;
      this.samplesSinceLastAnalysis += 1;
    }

    if (this.totalSamples < this.bufferSize || this.samplesSinceLastAnalysis < this.hopSize) {
      return true;
    }
    this.samplesSinceLastAnalysis = 0;

    this.copyRingToFrame(this.micRing, this.micFrame);
    this.copyRingToFrame(this.referenceRing, this.referenceFrame);

    let suppression;
    try {
      suppression =
        this.dspCore && !this.legacyFallback
          ? processEchoSuppressionWithCore(
              this.dspCore,
              this.micFrame,
              this.referenceFrame,
              this.alignedReferenceFrame,
              this.residualFrame,
              this.prevMicRms,
              this.detectorPreset
            )
          : processEchoSuppression(
              this.micFrame,
              this.referenceFrame,
              this.alignedReferenceFrame,
              this.residualFrame,
              this.nlmsWeights,
              this.prevMicRms
            );
    } catch (error) {
      this.dspCore = null;
      this.legacyFallback = true;
      this.publishBackendStatus(true, toErrorMessage(error));
      suppression = processEchoSuppression(
        this.micFrame,
        this.referenceFrame,
        this.alignedReferenceFrame,
        this.residualFrame,
        this.nlmsWeights,
        this.prevMicRms
      );
    }
    this.prevMicRms = suppression.micRms;

    if (this.detectorPreset === 'ac14' && suppression.referencePolicyApplied) {
      this.decayGraceFramesRemaining = 0;
      const midiEstimate = sanitizeMidiEstimate(suppression.midiEstimate);
      const referenceMidi = sanitizeMidiEstimate(suppression.referenceMidi);
      this.port.postMessage({
        type: 'frame',
        t_seconds: currentTime,
        midi_estimate: midiEstimate,
        confidence: midiEstimate === null ? 0 : clamp01(suppression.confidence),
        mic_rms: suppression.micRms,
        reference_midi: referenceMidi,
        reference_correlation: suppression.referenceCorrelation,
        energy_ratio_db: suppression.energyRatioDb,
        onset_strength: suppression.onsetStrength,
        contamination_score: suppression.contaminationScore,
        rejected_as_reference_bleed: Boolean(suppression.rejectedAsReferenceBleed),
        reference_policy_applied: true,
        delay_samples: suppression.delaySamples
      });
      return true;
    }

    if (this.detectorPreset === 'spectral_game_runtime_unified_v3' || this.detectorPreset === 'fretnet') {
      this.decayGraceFramesRemaining = 0;
      const midiEstimate = sanitizeMidiEstimate(suppression.midiEstimate);
      const referenceMidi = sanitizeMidiEstimate(suppression.referenceMidi);
      this.port.postMessage({
        type: 'frame',
        t_seconds: currentTime,
        midi_estimate: midiEstimate,
        confidence: midiEstimate === null ? 0 : clamp01(suppression.confidence),
        mic_rms: suppression.micRms,
        reference_midi: referenceMidi,
        reference_correlation: suppression.referenceCorrelation,
        energy_ratio_db: suppression.energyRatioDb,
        onset_strength: suppression.onsetStrength,
        contamination_score: suppression.contaminationScore,
        rejected_as_reference_bleed: Boolean(suppression.rejectedAsReferenceBleed),
        reference_policy_applied: Boolean(suppression.referencePolicyApplied),
        selected_notes: suppression.selectedNotes,
        chord_scores: suppression.chordScores,
        detected_string: suppression.detectedString,
        detected_fret: suppression.detectedFret,
        best_note_id: suppression.bestNoteId,
        delay_samples: suppression.delaySamples
      });
      return true;
    }

    if (this.detectorPreset === MASP_GAME_SCENE_PRESET) {
      const maspResult = this.evaluateMaspFrame(currentTime);
      if (maspResult) {
        this.decayGraceFramesRemaining = 0;
        const referenceMidi = sanitizeMidiEstimate(suppression.referenceMidi);
        this.port.postMessage({
          type: 'frame',
          t_seconds: currentTime,
          midi_estimate: maspResult.midiEstimate,
          confidence: maspResult.confidence,
          mic_rms: suppression.micRms,
          reference_midi: referenceMidi,
          reference_correlation: suppression.referenceCorrelation,
          energy_ratio_db: suppression.energyRatioDb,
          onset_strength: suppression.onsetStrength,
          contamination_score: suppression.contaminationScore,
          rejected_as_reference_bleed: Boolean(suppression.rejectedAsReferenceBleed),
          reference_policy_applied: Boolean(suppression.referencePolicyApplied),
          selected_notes: maspResult.selectedNotes,
          chord_scores: maspResult.chordScores,
          detected_string: maspResult.detectedString,
          detected_fret: maspResult.detectedFret,
          best_note_id: maspResult.bestNoteId,
          delay_samples: suppression.delaySamples
        });
        return true;
      }
    }

    const hasRustPitch = Number.isFinite(suppression.pitchHz) && suppression.pitchHz > 0;
    let residualPitchHz = hasRustPitch ? suppression.pitchHz : 0;
    let residualPitchConfidence = hasRustPitch ? suppression.pitchConfidence : 0;
    if (!hasRustPitch) {
      const decayActive = this.decayGraceFramesRemaining > 0;
      const fallbackPitch = detectPitch(this.residualFrame, sampleRate, this.minLag, this.maxLag, {
        energyThreshold: decayActive
          ? this.detectorConfig.energyThreshold * this.detectorConfig.decayEnergyFactor
          : this.detectorConfig.energyThreshold,
        correlationThreshold: decayActive
          ? this.detectorConfig.decayCorrelationThreshold
          : this.detectorConfig.correlationThreshold
      });
      residualPitchHz = fallbackPitch.frequencyHz;
      residualPitchConfidence = fallbackPitch.confidence;
      if (fallbackPitch.frequencyHz > 0) {
        this.decayGraceFramesRemaining = this.detectorConfig.decayGraceFrames;
      } else if (this.decayGraceFramesRemaining > 0) {
        this.decayGraceFramesRemaining -= 1;
      }
    } else {
      this.decayGraceFramesRemaining = 0;
    }

    const referencePitch = detectPitch(this.alignedReferenceFrame, sampleRate, this.minLag, this.maxLag, {
      energyThreshold: this.detectorConfig.energyThreshold,
      correlationThreshold: this.detectorConfig.correlationThreshold
    });
    const residualMidiEstimate = residualPitchHz > 0 ? 69 + 12 * Math.log2(residualPitchHz / 440) : null;
    const referenceMidiEstimate = referencePitch.frequencyHz > 0 ? 69 + 12 * Math.log2(referencePitch.frequencyHz / 440) : null;

    this.port.postMessage({
      type: 'frame',
      t_seconds: currentTime,
      midi_estimate: residualMidiEstimate,
      confidence: residualMidiEstimate === null ? 0 : clamp01(residualPitchConfidence),
      mic_rms: suppression.micRms,
      reference_midi: referenceMidiEstimate,
      reference_correlation: suppression.referenceCorrelation,
      energy_ratio_db: suppression.energyRatioDb,
      onset_strength: suppression.onsetStrength,
      contamination_score: suppression.contaminationScore,
      delay_samples: suppression.delaySamples
    });
    return true;
  }

  copyRingToFrame(ring, frame) {
    for (let i = 0; i < this.bufferSize; i += 1) {
      const idx = (this.writeIndex + i) % this.bufferSize;
      frame[i] = ring[idx];
    }
  }

  evaluateMaspFrame(nowAudioTime) {
    const mode = resolveMaspResampleMode(sampleRate);
    if (mode === 'unsupported') {
      return null;
    }
    const context = this.maspContext;
    if (!context) {
      return buildMaspNoHitResult();
    }
    if (!Number.isFinite(this.maspContextAudioTime) || nowAudioTime - this.maspContextAudioTime > MASP_CONTEXT_STALE_SECONDS) {
      return buildMaspNoHitResult();
    }
    if (context.expected_midis.length === 0 || context.expected_notes.length === 0) {
      return buildMaspNoHitResult();
    }
    const playheadWithinWindow =
      context.playhead_sec >= context.start_sec - 0.02 && context.playhead_sec <= context.end_sec + 0.02;
    if (!playheadWithinWindow) {
      return buildMaspNoHitResult();
    }

    const strictSamples = resampleForMasp(this.residualFrame, mode, this.maspStrictFrame);
    if (!strictSamples) {
      return buildMaspNoHitResult();
    }
    const noiseRms = clamp01(computeRms(strictSamples));
    normalizeToTargetRms(strictSamples, MASP_TARGET_RMS);

    this.maspRe.fill(0);
    this.maspIm.fill(0);
    for (let i = 0; i < MASP_FFT_SIZE; i += 1) {
      this.maspRe[i] = strictSamples[i] * this.maspWindow[i];
    }
    fftInPlace(this.maspRe, this.maspIm, this.maspFftPlan);
    for (let i = 0; i < this.maspMag.length; i += 1) {
      const re = this.maspRe[i];
      const im = this.maspIm[i];
      this.maspMag[i] = Math.hypot(re, im);
    }

    const pitchSpectrum = scoreMaspMidiFrame(this.maspMag, this.maspMaps, MASP_TUNED_PARAMS);
    const metrics = {
      h: computeHarmonicityH(
        this.maspMag,
        pitchSpectrum,
        MASP_STRICT_SAMPLE_RATE,
        MASP_FFT_SIZE,
        MASP_TUNED_PARAMS.midiMin
      ),
      har: computeHar(pitchSpectrum, context.expected_midis, MASP_TUNED_PARAMS.midiMin),
      mbw: computeMbw(this.maspMag, context.expected_midis, this.maspMaps),
      centError: computeCentError(pitchSpectrum, context.expected_midis, MASP_TUNED_PARAMS.midiMin),
      noiseRms
    };
    const decision = computeValidationDecision({
      metrics,
      hTarget: 1.0,
      params: MASP_TUNED_PARAMS
    });
    if (!decision.pass) {
      return buildMaspNoHitResult(clamp01(decision.weightedScore));
    }

    const bestMidi = pickBestExpectedMidi(pitchSpectrum, context.expected_midis, MASP_TUNED_PARAMS.midiMin);
    if (bestMidi === null) {
      return buildMaspNoHitResult(clamp01(decision.weightedScore));
    }

    const noteScores = buildMaspNoteScores(context.expected_notes, pitchSpectrum, MASP_TUNED_PARAMS.midiMin);
    const bestNote = noteScores[0] ?? null;
    return {
      midiEstimate: bestMidi,
      confidence: clamp01(decision.weightedScore),
      selectedNotes: noteScores.map((entry) => ({
        note_id: entry.note.note_id,
        midi: entry.note.midi,
        string: entry.note.string,
        fret: entry.note.fret,
        score: entry.score
      })),
      chordScores: [
        {
          chord_id: `active_${context.expected_midis.join('_')}`,
          score: metrics.har
        }
      ],
      detectedString: bestNote ? bestNote.note.string : null,
      detectedFret: bestNote ? bestNote.note.fret : null,
      bestNoteId: bestNote ? bestNote.note.note_id : null
    };
  }
}

registerProcessor('gh-pitch-processor', PitchProcessor);

function processEchoSuppressionWithCore(
  dspCore,
  mic,
  reference,
  alignedReference,
  residual,
  previousMicRms,
  detectorPreset
) {
  dspCore.set_reference_block(reference);
  const output = dspCore.process_block(mic) ?? {};

  const delaySamples = sanitizeDelay(output.delay_samples);
  const referenceCorrelation = clampSigned(output.reference_correlation);
  const energyRatioDb = sanitizeNumber(output.energy_ratio_db);
  const onsetStrength = sanitizeNumber(output.onset_strength);
  const contaminationScore = sanitizeNumber(output.contamination_score);
  const midiEstimate = sanitizeNumber(output.midi_estimate);
  const confidence = clamp01(output.confidence);
  const referenceMidi = sanitizeNumber(output.reference_midi);
  const pitchHz = sanitizeNumber(output.pitch_hz);
  const pitchConfidence = clamp01(output.pitch_confidence);
  const rejectedAsReferenceBleed = Boolean(output.rejected_as_reference_bleed);
  const referencePolicyApplied = Boolean(output.reference_policy_applied);
  const selectedNotes = sanitizeSelectedNotes(output.selected_notes);
  const chordScores = sanitizeChordScores(output.chord_scores);
  const detectedString = sanitizeOptionalInteger(output.detected_string);
  const detectedFret = sanitizeOptionalInteger(output.detected_fret);
  const bestNoteId = sanitizeOptionalString(output.best_note_id);
  const residualBlock = output.residual_block;

  if (detectorPreset === 'ac14' && referencePolicyApplied) {
    return {
      delaySamples,
      referenceCorrelation,
      energyRatioDb: Number.isFinite(energyRatioDb) ? energyRatioDb : 0,
      onsetStrength: Number.isFinite(onsetStrength) ? clamp01(onsetStrength) : 0,
      contaminationScore: Number.isFinite(contaminationScore) ? clamp01(contaminationScore) : 0,
      micRms: previousMicRms,
      midiEstimate,
      confidence,
      referenceMidi,
      pitchHz,
      pitchConfidence,
      rejectedAsReferenceBleed,
      referencePolicyApplied,
      selectedNotes,
      chordScores,
      detectedString,
      detectedFret,
      bestNoteId
    };
  }

  alignReference(reference, alignedReference, delaySamples);
  copyResidualBlock(residualBlock, residual);

  const micRms = computeRms(mic);
  const safeEnergyRatioDb = Number.isFinite(energyRatioDb)
    ? energyRatioDb
    : 20 * Math.log10((micRms + 1e-6) / (computeRms(alignedReference) + 1e-6));
  const safeOnsetStrength = Number.isFinite(onsetStrength)
    ? clamp01(onsetStrength)
    : clamp01((micRms - previousMicRms) / Math.max(previousMicRms, 1e-4));
  const safeContaminationScore = Number.isFinite(contaminationScore)
    ? clamp01(contaminationScore)
    : computeContaminationScore(referenceCorrelation, safeEnergyRatioDb, safeOnsetStrength);

  return {
    delaySamples,
    referenceCorrelation,
    energyRatioDb: safeEnergyRatioDb,
    onsetStrength: safeOnsetStrength,
    contaminationScore: safeContaminationScore,
    micRms,
    midiEstimate,
    confidence,
    referenceMidi,
    pitchHz,
    pitchConfidence,
    rejectedAsReferenceBleed,
    referencePolicyApplied,
    selectedNotes,
    chordScores,
    detectedString,
    detectedFret,
    bestNoteId
  };
}

function processEchoSuppression(
  mic,
  reference,
  alignedReference,
  residual,
  nlmsWeights,
  previousMicRms
) {
  const delayEstimate = estimateDelayAndCorrelation(mic, reference, MAX_DELAY_SAMPLES);
  alignReference(reference, alignedReference, delayEstimate.delaySamples);
  runNlms(mic, alignedReference, residual, nlmsWeights);

  const micRms = computeRms(mic);
  const referenceRms = computeRms(alignedReference);
  const energyRatioDb = 20 * Math.log10((micRms + 1e-6) / (referenceRms + 1e-6));
  const onsetStrength = clamp01((micRms - previousMicRms) / Math.max(previousMicRms, 1e-4));
  const contaminationScore = computeContaminationScore(
    delayEstimate.referenceCorrelation,
    energyRatioDb,
    onsetStrength
  );

  return {
    delaySamples: delayEstimate.delaySamples,
    referenceCorrelation: delayEstimate.referenceCorrelation,
    energyRatioDb,
    onsetStrength,
    contaminationScore,
    micRms
  };
}

function estimateDelayAndCorrelation(mic, reference, maxDelaySamples) {
  const maxDelay = Math.min(maxDelaySamples, mic.length - 2, reference.length - 2);
  let bestDelay = 0;
  let bestCorrelation = -1;

  for (let delay = -maxDelay; delay <= maxDelay; delay += 1) {
    let cross = 0;
    let normMic = 0;
    let normRef = 0;
    for (let i = 0; i < mic.length; i += 1) {
      const j = i - delay;
      if (j < 0 || j >= reference.length) continue;
      const m = mic[i];
      const r = reference[j];
      cross += m * r;
      normMic += m * m;
      normRef += r * r;
    }
    const denom = Math.sqrt(normMic * normRef);
    if (denom <= 1e-8) continue;
    const correlation = cross / denom;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestDelay = delay;
    }
  }

  return {
    delaySamples: bestDelay,
    referenceCorrelation: clampSigned(bestCorrelation)
  };
}

function copyResidualBlock(source, target) {
  if (source instanceof Float32Array && source.length === target.length) {
    target.set(source);
    return;
  }
  target.fill(0);
  if (!source || typeof source.length !== 'number') {
    return;
  }
  const copyLength = Math.min(target.length, source.length);
  for (let i = 0; i < copyLength; i += 1) {
    target[i] = source[i];
  }
}

function alignReference(reference, out, delaySamples) {
  for (let i = 0; i < reference.length; i += 1) {
    const sourceIndex = i - delaySamples;
    out[i] = sourceIndex >= 0 && sourceIndex < reference.length ? reference[sourceIndex] : 0;
  }
}

function runNlms(mic, alignedReference, residual, nlmsWeights) {
  const taps = nlmsWeights.length;
  for (let n = 0; n < mic.length; n += 1) {
    let yHat = 0;
    let norm = NLMS_EPS;
    for (let k = 0; k < taps; k += 1) {
      const xIndex = n - k;
      const x = xIndex >= 0 ? alignedReference[xIndex] : 0;
      yHat += nlmsWeights[k] * x;
      norm += x * x;
    }
    const error = mic[n] - yHat;
    residual[n] = error;
    const gain = (NLMS_MU * error) / norm;
    for (let k = 0; k < taps; k += 1) {
      const xIndex = n - k;
      const x = xIndex >= 0 ? alignedReference[xIndex] : 0;
      nlmsWeights[k] += gain * x;
    }
  }
}

function computeContaminationScore(referenceCorrelation, energyRatioDb, onsetStrength) {
  const corrScore = clamp01((referenceCorrelation - 0.55) / 0.45);
  const bleedScore = clamp01((-energyRatioDb - 3) / 18);
  const onsetRelief = clamp01(onsetStrength);
  return clamp01(corrScore * 0.65 + bleedScore * 0.35 - onsetRelief * 0.25);
}

function detectPitch(samples, sampleRateHz, minLag, maxLag, options = {}) {
  const energyThreshold = Number.isFinite(options.energyThreshold)
    ? Math.max(0, options.energyThreshold)
    : DETECTOR_PRESETS.baseline.energyThreshold;
  const correlationThreshold = Number.isFinite(options.correlationThreshold)
    ? clamp01(options.correlationThreshold)
    : DETECTOR_PRESETS.baseline.correlationThreshold;
  const count = samples.length;
  let mean = 0;
  for (let i = 0; i < count; i += 1) {
    mean += samples[i];
  }
  mean /= count;

  let energy = 0;
  for (let i = 0; i < count; i += 1) {
    const centered = samples[i] - mean;
    energy += centered * centered;
  }
  const rms = Math.sqrt(energy / count);
  if (!Number.isFinite(rms) || rms < energyThreshold) {
    return { frequencyHz: 0, confidence: 0 };
  }

  const safeMaxLag = Math.min(maxLag, count - 2);
  let bestLag = -1;
  let bestCorrelation = -1;
  for (let lag = minLag; lag <= safeMaxLag; lag += 1) {
    let cross = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < count - lag; i += 1) {
      const a = samples[i] - mean;
      const b = samples[i + lag] - mean;
      cross += a * b;
      normA += a * a;
      normB += b * b;
    }

    const denom = Math.sqrt(normA * normB);
    if (denom <= 1e-8) continue;
    const correlation = cross / denom;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestCorrelation < correlationThreshold) {
    return { frequencyHz: 0, confidence: clamp01(bestCorrelation) };
  }

  const frequencyHz = sampleRateHz / bestLag;
  const confidence = clamp01((bestCorrelation - 0.45) / 0.5);
  return { frequencyHz, confidence };
}

function buildMaspNoHitResult(confidence = 0) {
  return {
    midiEstimate: null,
    confidence: clamp01(confidence),
    selectedNotes: [],
    chordScores: [],
    detectedString: null,
    detectedFret: null,
    bestNoteId: null
  };
}

function pickBestExpectedMidi(pitchSpectrum, expectedMidis, midiMin) {
  let bestMidi = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const midi of expectedMidis) {
    if (!Number.isFinite(midi)) continue;
    const idx = Math.round(midi) - midiMin;
    if (idx < 0 || idx >= pitchSpectrum.length) continue;
    const score = pitchSpectrum[idx];
    if (score > bestScore) {
      bestScore = score;
      bestMidi = Math.round(midi);
    }
  }
  return bestMidi;
}

function buildMaspNoteScores(expectedNotes, pitchSpectrum, midiMin) {
  const out = [];
  for (const note of expectedNotes) {
    const idx = Math.round(note.midi) - midiMin;
    const score = idx >= 0 && idx < pitchSpectrum.length ? pitchSpectrum[idx] : 0;
    out.push({ note, score });
  }
  out.sort((a, b) => b.score - a.score || a.note.string - b.note.string || a.note.fret - b.note.fret);
  return out;
}

function normalizeToTargetRms(samples, targetRms) {
  const currentRms = computeRms(samples);
  if (!(currentRms > 0) || !(targetRms > 0)) return;
  const gain = targetRms / currentRms;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= gain;
  }
}

function buildHannWindow(length) {
  const window = new Float64Array(length);
  if (length <= 1) {
    if (length === 1) window[0] = 1;
    return window;
  }
  const denom = length - 1;
  for (let i = 0; i < length; i += 1) {
    const phase = (2 * Math.PI * i) / denom;
    window[i] = 0.5 - 0.5 * Math.cos(phase);
  }
  return window;
}

function buildFftPlan(nfft) {
  const bits = Math.round(Math.log2(nfft));
  if (1 << bits !== nfft) {
    throw new Error(`nfft must be power of two, got ${nfft}`);
  }
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

function fftInPlace(re, im, plan) {
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

function buildMaspHarmonicMaps(sampleRate, nfft, midiMin, midiMax, maxHarmonics, localBandwidthBins) {
  const nyquist = sampleRate * 0.5;
  const hzPerBin = sampleRate / nfft;
  const maxBin = Math.floor(nfft / 2);
  const maps = [];
  for (let midi = midiMin; midi <= midiMax; midi += 1) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
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

function resampleForMasp(source, mode, out) {
  if (!source || source.length <= 0 || out.length !== MASP_FFT_SIZE) return null;
  if (mode === 'native_22050') {
    if (source.length < MASP_FFT_SIZE) return null;
    for (let i = 0; i < MASP_FFT_SIZE; i += 1) {
      out[i] = source[i];
    }
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
      const srcPos = i * scale;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;
      const x0 = source[srcIdx];
      const x1 = source[Math.min(source.length - 1, srcIdx + 1)];
      out[i] = x0 + (x1 - x0) * frac;
    }
    return out;
  }
  return null;
}

function computeRms(samples) {
  if (!samples.length) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    energy += value * value;
  }
  return Math.sqrt(energy / samples.length);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function sanitizeDelay(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function sanitizeNumber(value) {
  if (!Number.isFinite(value)) return Number.NaN;
  return value;
}

function sanitizeMidiEstimate(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeOptionalInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function sanitizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeSelectedNotes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const midi = Number(item.midi);
    if (!Number.isFinite(midi)) continue;
    out.push({
      note_id: sanitizeOptionalString(item.note_id),
      midi,
      string: sanitizeOptionalInteger(item.string),
      fret: sanitizeOptionalInteger(item.fret),
      score: Number.isFinite(item.score) ? Number(item.score) : 0
    });
  }
  return out;
}

function sanitizeChordScores(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const chordId = sanitizeOptionalString(item.chord_id);
    if (!chordId) continue;
    out.push({
      chord_id: chordId,
      score: Number.isFinite(item.score) ? Number(item.score) : 0
    });
  }
  return out;
}

function sanitizeSpectralModel(value) {
  if (!value || typeof value !== 'object') return null;
  const notesRaw = Array.isArray(value.notes) ? value.notes : [];
  const chordsRaw = Array.isArray(value.chords) ? value.chords : [];
  const notes = [];
  const noteIds = new Set();
  for (const note of notesRaw) {
    if (!note || typeof note !== 'object') continue;
    const id = sanitizeOptionalString(note.id);
    const string = sanitizeOptionalInteger(note.string);
    const fret = sanitizeOptionalInteger(note.fret);
    const midi = Number(note.midi);
    const frequencyHz = Number(note.frequency_hz);
    if (!id || noteIds.has(id)) continue;
    if (!Number.isFinite(midi) || string === null || fret === null) continue;
    notes.push({
      id,
      string,
      fret,
      midi,
      frequency_hz: Number.isFinite(frequencyHz)
        ? frequencyHz
        : 440 * Math.pow(2, (midi - 69) / 12)
    });
    noteIds.add(id);
  }
  const chords = [];
  for (const chord of chordsRaw) {
    if (!chord || typeof chord !== 'object') continue;
    const id = sanitizeOptionalString(chord.id);
    if (!id) continue;
    const membersRaw = Array.isArray(chord.member_note_ids) ? chord.member_note_ids : [];
    const member_note_ids = membersRaw
      .map((entry) => sanitizeOptionalString(entry))
      .filter((entry) => entry && noteIds.has(entry));
    if (member_note_ids.length === 0) continue;
    chords.push({
      id,
      member_note_ids: Array.from(new Set(member_note_ids))
    });
  }
  if (notes.length === 0) return null;
  return { notes, chords };
}

function sanitizeMaspContext(value) {
  if (!value || typeof value !== 'object') return null;
  const playheadSec = sanitizeNumber(value.playhead_sec);
  const startSec = sanitizeNumber(value.start_sec);
  const endSec = sanitizeNumber(value.end_sec);
  if (!Number.isFinite(playheadSec) || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
    return null;
  }
  const expectedMidis = Array.isArray(value.expected_midis)
    ? Array.from(
      new Set(value.expected_midis
        .map((entry) => sanitizeOptionalInteger(entry))
        .filter((entry) => entry !== null))
    ).sort((a, b) => a - b)
    : [];
  const notesRaw = Array.isArray(value.expected_notes) ? value.expected_notes : [];
  const expectedNotes = [];
  for (const note of notesRaw) {
    if (!note || typeof note !== 'object') continue;
    const noteId = sanitizeOptionalString(note.note_id);
    const midi = sanitizeOptionalInteger(note.midi);
    const string = sanitizeOptionalInteger(note.string);
    const fret = sanitizeOptionalInteger(note.fret);
    const onsetSec = sanitizeNumber(note.onset_sec);
    const offsetSec = sanitizeNumber(note.offset_sec);
    if (!noteId || midi === null || string === null || fret === null) continue;
    if (!Number.isFinite(onsetSec) || !Number.isFinite(offsetSec) || offsetSec < onsetSec) continue;
    expectedNotes.push({
      note_id: noteId,
      midi,
      string,
      fret,
      onset_sec: onsetSec,
      offset_sec: offsetSec
    });
  }
  if (expectedMidis.length === 0 || expectedNotes.length === 0) return null;
  return {
    playhead_sec: playheadSec,
    start_sec: startSec,
    end_sec: endSec,
    expected_midis: expectedMidis,
    expected_notes: expectedNotes
  };
}

function normalizeDetectorPreset(value) {
  if (value === 'ac14') return 'ac14';
  if (value === 'fretnet') return 'fretnet';
  if (value === MASP_GAME_SCENE_PRESET) return MASP_GAME_SCENE_PRESET;
  if (value === 'spectral_game_runtime_unified_v3') return 'spectral_game_runtime_unified_v3';
  return DEFAULT_DETECTOR_PRESET;
}

function getDetectorPresetConfig(detectorPreset) {
  if (detectorPreset === 'ac14') return DETECTOR_PRESETS.ac14;
  if (detectorPreset === 'fretnet') return DETECTOR_PRESETS.fretnet;
  if (detectorPreset === MASP_GAME_SCENE_PRESET) return DETECTOR_PRESETS[MASP_GAME_SCENE_PRESET];
  if (detectorPreset === 'spectral_game_runtime_unified_v3') {
    return DETECTOR_PRESETS.spectral_game_runtime_unified_v3;
  }
  return DETECTOR_PRESETS.baseline;
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'DSP core unavailable';
}
