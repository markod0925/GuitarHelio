use serde::Deserialize;
use wasm_bindgen::prelude::*;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::collections::HashMap;
use std::sync::Arc;

const DEFAULT_TAPS: usize = 64;
const NLMS_MU: f32 = 0.08;
const NLMS_EPS: f32 = 1e-6;
const MAX_DELAY_SAMPLES: isize = 720;
const BASELINE_MIN_FREQ_HZ: f32 = 65.0;
const BASELINE_MAX_FREQ_HZ: f32 = 1200.0;
const BASELINE_ENERGY_THRESHOLD: f32 = 0.0032;
const BASELINE_CORRELATION_THRESHOLD: f32 = 0.58;
const BASELINE_DECAY_GRACE_FRAMES: u32 = 8;
const BASELINE_DECAY_ENERGY_FACTOR: f32 = 0.55;
const BASELINE_DECAY_CORRELATION_THRESHOLD: f32 = 0.52;
const AC14_MIN_FREQ_HZ: f32 = 55.0;
const AC14_MAX_FREQ_HZ: f32 = 1200.0;
const AC14_ENERGY_THRESHOLD: f32 = 0.0030742024;
const AC14_CORRELATION_THRESHOLD: f32 = 0.6559736;
const AC14_DECAY_GRACE_FRAMES: u32 = 4;
const AC14_DECAY_ENERGY_FACTOR: f32 = 0.4157769;
const AC14_DECAY_CORRELATION_THRESHOLD: f32 = 0.628858;

const SPECTRAL_FFT_SIZE: usize = 4096;
const SPECTRAL_MIN_FREQ_HZ: f32 = 75.0;
const SPECTRAL_MAX_HARMONIC_FREQ_HZ: f32 = 3600.0;
const SPECTRAL_MAX_HARMONICS: usize = 4;
const SPECTRAL_BASE_BANDWIDTH_HZ: f32 = 17.3;
const SPECTRAL_RELATIVE_BANDWIDTH: f32 = 0.0148;
const SPECTRAL_MAGNITUDE_COMPRESSION_GAMMA: f32 = 0.24;
const SPECTRAL_USE_LOG_MAGNITUDE: bool = false;
const SPECTRAL_USE_LOCAL_WHITENING: bool = true;
const SPECTRAL_WHITENING_RADIUS_BINS: usize = 10;
const SPECTRAL_USE_HARMONIC_PENALTY: bool = false;
const SPECTRAL_SUBHARMONIC_PENALTY_ALPHA: f32 = 0.0;
const SPECTRAL_NORMALIZE_BY_WEIGHT_SUM: bool = true;
const SPECTRAL_NORMALIZE_BY_BAND_ENERGY: bool = false;
const SPECTRAL_MIN_RMS: f32 = 0.00005;
const SPECTRAL_CONFIDENCE_CONTRAST_WEIGHT: f32 = 0.575;
const SPECTRAL_CONFIDENCE_ENERGY_WEIGHT: f32 = 0.425;
const SPECTRAL_CONFIDENCE_GAIN: f32 = 2.28;
const SPECTRAL_CONFIDENCE_BIAS: f32 = 0.915;
const SPECTRAL_POLYPHONY_MAX_NOTES: usize = 3;
const SPECTRAL_POLYPHONY_MIN_RELATIVE_SCORE: f32 = 0.35;
const SPECTRAL_POLYPHONY_MIN_ABSOLUTE_SCORE: f32 = 0.0;
const SPECTRAL_POLYPHONY_HARMONIC_SUPPRESSION: f32 = 0.55;
const SPECTRAL_POLYPHONY_HARMONIC_TOLERANCE_CENTS: f32 = 35.0;
const SPECTRAL_POLYPHONY_DEDUPE_MIDI: bool = true;
const SPECTRAL_CHORD_ALPHA: f32 = 0.7;
const SPECTRAL_EMIT_CHORD_SCORES: bool = true;
const SPECTRAL_DC_REMOVE: bool = true;
const SPECTRAL_TIE_EPSILON: f32 = 1e-6;

#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum DspMode {
    Speaker,
    Headphones,
}

#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum PitchDetectorPreset {
    Baseline,
    Ac14,
    SpectralGameRuntimeUnifiedV3,
}

#[derive(Clone, Copy)]
struct PitchDetectorConfig {
    min_freq_hz: f32,
    max_freq_hz: f32,
    energy_threshold: f32,
    correlation_threshold: f32,
    decay_grace_frames: u32,
    decay_energy_factor: f32,
    decay_correlation_threshold: f32,
}

#[derive(Clone, Debug)]
struct SpectralNoteCandidate {
    id: String,
    guitar_string: u32,
    fret: u32,
    midi: f32,
    frequency_hz: f32,
}

#[derive(Clone, Debug)]
struct SpectralChordCandidate {
    id: String,
    member_indices: Vec<usize>,
}

#[derive(Clone, Debug)]
struct SpectralSelectedNote {
    note_id: String,
    midi: f32,
    guitar_string: u32,
    fret: u32,
    score: f32,
}

#[derive(Clone, Debug)]
struct SpectralChordScore {
    chord_id: String,
    score: f32,
}

#[derive(Clone, Debug)]
struct SpectralFrameOutput {
    midi_estimate: Option<f32>,
    confidence: f32,
    selected_notes: Vec<SpectralSelectedNote>,
    chord_scores: Vec<SpectralChordScore>,
    best_note_id: Option<String>,
    detected_string: Option<u32>,
    detected_fret: Option<u32>,
}

#[derive(Deserialize)]
struct SpectralRuntimeModelPayload {
    notes: Vec<SpectralRuntimeNotePayload>,
    #[serde(default)]
    chords: Vec<SpectralRuntimeChordPayload>,
}

#[derive(Deserialize)]
struct SpectralRuntimeNotePayload {
    id: String,
    #[serde(rename = "string")]
    guitar_string: u32,
    fret: u32,
    midi: f32,
    #[serde(default)]
    frequency_hz: Option<f32>,
}

#[derive(Deserialize)]
struct SpectralRuntimeChordPayload {
    id: String,
    member_note_ids: Vec<String>,
}

struct SpectralUnifiedBackend {
    notes: Vec<SpectralNoteCandidate>,
    chords: Vec<SpectralChordCandidate>,
    max_harmonics: usize,
    weights: Vec<f32>,
    fft_size: usize,
    fft: Arc<dyn Fft<f32>>,
    fft_buffer: Vec<Complex<f32>>,
    hann_window: Vec<f32>,
    magnitude_buffer: Vec<f32>,
    whitening_buffer: Vec<f32>,
    whitening_prefix: Vec<f32>,
}

#[wasm_bindgen]
pub struct GhDspCore {
    sample_rate: u32,
    block_size: usize,
    mode: DspMode,
    pitch_preset: PitchDetectorPreset,
    pitch_decay_frames_remaining: u32,
    reference_block: Vec<f32>,
    aligned_reference: Vec<f32>,
    residual_block: Vec<f32>,
    nlms_weights: Vec<f32>,
    prev_mic_rms: f32,
    spectral_backend: Option<SpectralUnifiedBackend>,
}

#[wasm_bindgen]
impl GhDspCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GhDspCore {
        GhDspCore {
            sample_rate: 48_000,
            block_size: 2048,
            mode: DspMode::Speaker,
            pitch_preset: PitchDetectorPreset::Baseline,
            pitch_decay_frames_remaining: 0,
            reference_block: vec![0.0; 2048],
            aligned_reference: vec![0.0; 2048],
            residual_block: vec![0.0; 2048],
            nlms_weights: vec![0.0; DEFAULT_TAPS],
            prev_mic_rms: 0.0,
            spectral_backend: None,
        }
    }

    #[wasm_bindgen]
    pub fn prepare(&mut self, sample_rate: u32, block_size: usize, mode: DspMode) {
        let safe_block_size = block_size.max(64);
        self.sample_rate = sample_rate.max(8_000);
        self.block_size = safe_block_size;
        self.mode = mode;
        self.reference_block = vec![0.0; safe_block_size];
        self.aligned_reference = vec![0.0; safe_block_size];
        self.residual_block = vec![0.0; safe_block_size];
        self.nlms_weights.fill(0.0);
        self.prev_mic_rms = 0.0;
        self.pitch_decay_frames_remaining = 0;
        if let Some(backend) = self.spectral_backend.as_mut() {
            backend.ensure_window_size(self.block_size);
        }
    }

    #[wasm_bindgen]
    pub fn set_pitch_detector_preset(&mut self, preset: PitchDetectorPreset) {
        self.pitch_preset = preset;
        self.pitch_decay_frames_remaining = 0;
    }

    #[wasm_bindgen]
    pub fn set_reference_block(&mut self, reference_block: Vec<f32>) {
        if reference_block.len() == self.block_size {
            self.reference_block.copy_from_slice(&reference_block);
            return;
        }

        self.reference_block.fill(0.0);
        let copy_len = reference_block.len().min(self.block_size);
        self.reference_block[..copy_len].copy_from_slice(&reference_block[..copy_len]);
    }

    #[wasm_bindgen]
    pub fn set_spectral_model(&mut self, model_json: String) -> Result<(), JsValue> {
        if model_json.trim().is_empty() {
            self.spectral_backend = None;
            return Ok(());
        }

        let payload: SpectralRuntimeModelPayload = serde_json::from_str(&model_json)
            .map_err(|error| JsValue::from_str(&format!("Failed to parse spectral model JSON: {error}")))?;

        let backend = SpectralUnifiedBackend::from_payload(payload, self.block_size)
            .map_err(|error| JsValue::from_str(&error))?;
        self.spectral_backend = Some(backend);
        Ok(())
    }

    #[wasm_bindgen]
    pub fn process_block(&mut self, mic_block: Vec<f32>) -> JsValue {
        let mut safe_mic_block = vec![0.0; self.block_size];
        let copy_len = mic_block.len().min(self.block_size);
        safe_mic_block[..copy_len].copy_from_slice(&mic_block[..copy_len]);

        let (delay_samples, reference_correlation) =
            estimate_delay_and_correlation(&safe_mic_block, &self.reference_block);
        align_reference(
            &self.reference_block,
            &mut self.aligned_reference,
            delay_samples,
        );
        run_nlms(
            &safe_mic_block,
            &self.aligned_reference,
            &mut self.residual_block,
            &mut self.nlms_weights,
        );

        let mic_rms = compute_rms(&safe_mic_block);
        let ref_rms = compute_rms(&self.aligned_reference);
        let energy_ratio_db = 20.0 * ((mic_rms + 1e-6) / (ref_rms + 1e-6)).log10();
        let onset_strength = clamp01((mic_rms - self.prev_mic_rms) / self.prev_mic_rms.max(1e-4));
        let contamination_score = compute_contamination_score(
            reference_correlation,
            energy_ratio_db,
            onset_strength,
            self.mode,
        );
        self.prev_mic_rms = mic_rms;
        let config = self.pitch_config();

        let (reference_hz, _) = detect_pitch_autocorr(
            &self.aligned_reference,
            self.sample_rate as f32,
            config.min_freq_hz,
            config.max_freq_hz,
            config.energy_threshold,
            config.correlation_threshold,
        );
        let reference_midi = reference_hz.map(midi_from_hz);

        let mut selected_notes = Vec::<SpectralSelectedNote>::new();
        let mut chord_scores = Vec::<SpectralChordScore>::new();
        let mut best_note_id: Option<String> = None;
        let mut detected_string: Option<u32> = None;
        let mut detected_fret: Option<u32> = None;

        let (midi_estimate, confidence, pitch_hz, pitch_confidence, rejected_as_reference_bleed, reference_policy_applied) =
            match self.pitch_preset {
                PitchDetectorPreset::Baseline => {
                    let (frequency_hz, autocorr_confidence) = self.detect_pitch_on_residual(config);
                    (
                        frequency_hz.map(midi_from_hz),
                        clamp01(autocorr_confidence),
                        frequency_hz,
                        clamp01(autocorr_confidence),
                        false,
                        false,
                    )
                }
                PitchDetectorPreset::Ac14 => {
                    let (frequency_hz, autocorr_confidence) = self.detect_pitch_on_residual(config);
                    let raw_midi = frequency_hz.map(midi_from_hz);
                    let (policy_midi, policy_confidence, rejected) = apply_reference_contamination_policy(
                        raw_midi,
                        autocorr_confidence,
                        reference_midi,
                        reference_correlation,
                        energy_ratio_db,
                        onset_strength,
                        contamination_score,
                        self.mode,
                    );
                    (
                        policy_midi,
                        policy_confidence,
                        frequency_hz,
                        clamp01(autocorr_confidence),
                        rejected,
                        true,
                    )
                }
                PitchDetectorPreset::SpectralGameRuntimeUnifiedV3 => {
                    let spectral = self
                        .spectral_backend
                        .as_mut()
                        .map(|backend| backend.process_window(&self.residual_block, self.sample_rate));
                    if let Some(frame) = spectral {
                        selected_notes = frame.selected_notes;
                        chord_scores = frame.chord_scores;
                        best_note_id = frame.best_note_id;
                        detected_string = frame.detected_string;
                        detected_fret = frame.detected_fret;
                        (
                            frame.midi_estimate,
                            frame.confidence,
                            None,
                            frame.confidence,
                            false,
                            false,
                        )
                    } else {
                        (None, 0.0, None, 0.0, false, false)
                    }
                }
            };

        let output = js_sys::Object::new();
        set_number(&output, "delay_samples", delay_samples as f64);
        set_number(
            &output,
            "reference_correlation",
            reference_correlation as f64,
        );
        set_number(&output, "energy_ratio_db", energy_ratio_db as f64);
        set_number(&output, "onset_strength", onset_strength as f64);
        set_number(&output, "contamination_score", contamination_score as f64);
        set_number(
            &output,
            "midi_estimate",
            midi_estimate.map_or(f64::NAN, |value| value as f64),
        );
        set_number(&output, "confidence", confidence as f64);
        set_number(
            &output,
            "reference_midi",
            reference_midi.map_or(f64::NAN, |value| value as f64),
        );
        set_number(
            &output,
            "pitch_hz",
            pitch_hz.map_or(f64::NAN, |value| value as f64),
        );
        set_number(&output, "pitch_confidence", pitch_confidence as f64);
        set_bool(
            &output,
            "rejected_as_reference_bleed",
            rejected_as_reference_bleed,
        );
        set_bool(
            &output,
            "reference_policy_applied",
            reference_policy_applied,
        );
        set_number(
            &output,
            "detected_string",
            detected_string.map_or(f64::NAN, |value| value as f64),
        );
        set_number(
            &output,
            "detected_fret",
            detected_fret.map_or(f64::NAN, |value| value as f64),
        );
        if let Some(note_id) = best_note_id {
            set_value(&output, "best_note_id", &JsValue::from_str(&note_id));
        }
        let selected_notes_value = spectral_selected_notes_to_js_array(&selected_notes);
        set_value(&output, "selected_notes", selected_notes_value.as_ref());
        let chord_scores_value = spectral_chord_scores_to_js_array(&chord_scores);
        set_value(&output, "chord_scores", chord_scores_value.as_ref());

        let residual = js_sys::Float32Array::from(self.residual_block.as_slice());
        set_value(&output, "residual_block", residual.as_ref());
        output.into()
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) {
        self.reference_block.fill(0.0);
        self.aligned_reference.fill(0.0);
        self.residual_block.fill(0.0);
        self.nlms_weights.fill(0.0);
        self.prev_mic_rms = 0.0;
        self.pitch_decay_frames_remaining = 0;
    }
}

impl GhDspCore {
    fn detect_pitch_on_residual(&mut self, config: PitchDetectorConfig) -> (Option<f32>, f32) {
        let decay_active = self.pitch_decay_frames_remaining > 0;
        let energy_threshold = if decay_active {
            config.energy_threshold * config.decay_energy_factor
        } else {
            config.energy_threshold
        };
        let correlation_threshold = if decay_active {
            config
                .decay_correlation_threshold
                .min(config.correlation_threshold)
        } else {
            config.correlation_threshold
        };

        let (frequency_hz, confidence) = detect_pitch_autocorr(
            &self.residual_block,
            self.sample_rate as f32,
            config.min_freq_hz,
            config.max_freq_hz,
            energy_threshold,
            correlation_threshold,
        );

        if frequency_hz.is_some() {
            self.pitch_decay_frames_remaining = config.decay_grace_frames;
        } else if self.pitch_decay_frames_remaining > 0 {
            self.pitch_decay_frames_remaining -= 1;
        }

        (frequency_hz, confidence)
    }

    fn pitch_config(&self) -> PitchDetectorConfig {
        match self.pitch_preset {
            PitchDetectorPreset::Baseline | PitchDetectorPreset::SpectralGameRuntimeUnifiedV3 => PitchDetectorConfig {
                min_freq_hz: BASELINE_MIN_FREQ_HZ,
                max_freq_hz: BASELINE_MAX_FREQ_HZ,
                energy_threshold: BASELINE_ENERGY_THRESHOLD,
                correlation_threshold: BASELINE_CORRELATION_THRESHOLD,
                decay_grace_frames: BASELINE_DECAY_GRACE_FRAMES,
                decay_energy_factor: BASELINE_DECAY_ENERGY_FACTOR,
                decay_correlation_threshold: BASELINE_DECAY_CORRELATION_THRESHOLD,
            },
            PitchDetectorPreset::Ac14 => PitchDetectorConfig {
                min_freq_hz: AC14_MIN_FREQ_HZ,
                max_freq_hz: AC14_MAX_FREQ_HZ,
                energy_threshold: AC14_ENERGY_THRESHOLD,
                correlation_threshold: AC14_CORRELATION_THRESHOLD,
                decay_grace_frames: AC14_DECAY_GRACE_FRAMES,
                decay_energy_factor: AC14_DECAY_ENERGY_FACTOR,
                decay_correlation_threshold: AC14_DECAY_CORRELATION_THRESHOLD,
            },
        }
    }
}

impl SpectralUnifiedBackend {
    fn from_payload(payload: SpectralRuntimeModelPayload, window_size: usize) -> Result<Self, String> {
        if payload.notes.is_empty() {
            return Err("Spectral model must contain at least one note".to_owned());
        }

        let mut note_ids = HashMap::<String, usize>::new();
        let mut notes = Vec::<SpectralNoteCandidate>::with_capacity(payload.notes.len());
        for raw_note in payload.notes {
            if raw_note.id.trim().is_empty() {
                return Err("Spectral note id cannot be empty".to_owned());
            }
            if !raw_note.midi.is_finite() {
                return Err(format!("Spectral note '{}' has invalid midi", raw_note.id));
            }
            let frequency_hz = raw_note
                .frequency_hz
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or_else(|| hz_from_midi(raw_note.midi));
            let index = notes.len();
            note_ids.insert(raw_note.id.clone(), index);
            notes.push(SpectralNoteCandidate {
                id: raw_note.id,
                guitar_string: raw_note.guitar_string,
                fret: raw_note.fret,
                midi: raw_note.midi,
                frequency_hz,
            });
        }

        let mut chords = Vec::<SpectralChordCandidate>::new();
        for raw_chord in payload.chords {
            if raw_chord.id.trim().is_empty() {
                continue;
            }
            let mut member_indices = Vec::<usize>::new();
            for note_id in raw_chord.member_note_ids {
                if let Some(index) = note_ids.get(&note_id) {
                    member_indices.push(*index);
                }
            }
            member_indices.sort_unstable();
            member_indices.dedup();
            if member_indices.is_empty() {
                continue;
            }
            chords.push(SpectralChordCandidate {
                id: raw_chord.id,
                member_indices,
            });
        }

        let mut backend = Self {
            notes,
            chords,
            max_harmonics: SPECTRAL_MAX_HARMONICS,
            weights: harmonic_weights(SPECTRAL_MAX_HARMONICS),
            fft_size: SPECTRAL_FFT_SIZE,
            fft: FftPlanner::<f32>::new().plan_fft_forward(SPECTRAL_FFT_SIZE),
            fft_buffer: vec![Complex::new(0.0, 0.0); SPECTRAL_FFT_SIZE],
            hann_window: build_hann_window(window_size.max(1)),
            magnitude_buffer: vec![0.0; SPECTRAL_FFT_SIZE / 2 + 1],
            whitening_buffer: vec![0.0; SPECTRAL_FFT_SIZE / 2 + 1],
            whitening_prefix: vec![0.0; SPECTRAL_FFT_SIZE / 2 + 2],
        };
        backend.ensure_window_size(window_size.max(1));
        Ok(backend)
    }

    fn ensure_window_size(&mut self, window_size: usize) {
        if self.hann_window.len() != window_size {
            self.hann_window = build_hann_window(window_size.max(1));
        }
        if self.fft_size < window_size {
            self.resize_fft(window_size.next_power_of_two().max(SPECTRAL_FFT_SIZE));
        }
    }

    fn resize_fft(&mut self, next_fft_size: usize) {
        self.fft_size = next_fft_size.max(64);
        self.fft = FftPlanner::<f32>::new().plan_fft_forward(self.fft_size);
        self.fft_buffer = vec![Complex::new(0.0, 0.0); self.fft_size];
        let half = self.fft_size / 2 + 1;
        self.magnitude_buffer = vec![0.0; half];
        self.whitening_buffer = vec![0.0; half];
        self.whitening_prefix = vec![0.0; half + 1];
    }

    fn process_window(&mut self, window: &[f32], sample_rate: u32) -> SpectralFrameOutput {
        if self.notes.is_empty() || sample_rate == 0 || window.is_empty() {
            return SpectralFrameOutput {
                midi_estimate: None,
                confidence: 0.0,
                selected_notes: Vec::new(),
                chord_scores: Vec::new(),
                best_note_id: None,
                detected_string: None,
                detected_fret: None,
            };
        }

        self.ensure_window_size(window.len());

        let mean = if SPECTRAL_DC_REMOVE {
            window.iter().copied().sum::<f32>() / window.len() as f32
        } else {
            0.0
        };
        let rms = centered_rms(window, mean);

        for value in &mut self.fft_buffer {
            *value = Complex::new(0.0, 0.0);
        }
        for (index, sample) in window.iter().enumerate() {
            self.fft_buffer[index].re = (*sample - mean) * self.hann_window[index];
        }
        self.fft.process(&mut self.fft_buffer);

        self.prepare_magnitude_spectrum();

        let total_band_energy = self.magnitude_buffer.iter().copied().sum::<f32>().max(1e-9);
        let mut raw_scores = Vec::<(usize, f32)>::with_capacity(self.notes.len());
        for (index, note) in self.notes.iter().enumerate() {
            let score = note_spectral_score(
                note.frequency_hz,
                &self.magnitude_buffer,
                sample_rate as f32,
                self.fft_size,
                SPECTRAL_MIN_FREQ_HZ,
                SPECTRAL_MAX_HARMONIC_FREQ_HZ,
                self.max_harmonics,
                &self.weights,
                SPECTRAL_BASE_BANDWIDTH_HZ,
                SPECTRAL_RELATIVE_BANDWIDTH,
                SPECTRAL_USE_HARMONIC_PENALTY,
                SPECTRAL_SUBHARMONIC_PENALTY_ALPHA,
                SPECTRAL_NORMALIZE_BY_WEIGHT_SUM,
                SPECTRAL_NORMALIZE_BY_BAND_ENERGY,
                total_band_energy,
            );
            raw_scores.push((index, score));
        }

        let relative_scores = relative_note_scores(self.notes.len(), &raw_scores);
        let (best_index, best_score) = best_note(&raw_scores);
        let second_score = second_best_score(&raw_scores, best_index).unwrap_or(best_score);

        if rms < SPECTRAL_MIN_RMS || !best_score.is_finite() {
            return SpectralFrameOutput {
                midi_estimate: None,
                confidence: 0.0,
                selected_notes: Vec::new(),
                chord_scores: Vec::new(),
                best_note_id: None,
                detected_string: None,
                detected_fret: None,
            };
        }

        let selected_notes = self.select_polyphonic_notes(&raw_scores, &relative_scores, best_score);
        let chord_scores = if SPECTRAL_EMIT_CHORD_SCORES {
            self.score_chords(&raw_scores)
        } else {
            Vec::new()
        };

        let spread = (best_score - second_score).max(0.0);
        let contrast = spread / (best_score.abs() + second_score.abs() + 1e-6);
        let energy = clamp01((rms - SPECTRAL_MIN_RMS) / (SPECTRAL_MIN_RMS * 10.0).max(1e-6));
        let weight_sum = (SPECTRAL_CONFIDENCE_CONTRAST_WEIGHT + SPECTRAL_CONFIDENCE_ENERGY_WEIGHT).max(1e-6);
        let base =
            (SPECTRAL_CONFIDENCE_CONTRAST_WEIGHT * contrast + SPECTRAL_CONFIDENCE_ENERGY_WEIGHT * energy)
                / weight_sum;
        let confidence = clamp01(base * SPECTRAL_CONFIDENCE_GAIN + SPECTRAL_CONFIDENCE_BIAS);

        let best_note = &self.notes[best_index];
        let (detected_string, detected_fret) = resolve_detected_position(best_index, best_score, &self.notes, &raw_scores);

        SpectralFrameOutput {
            midi_estimate: Some(best_note.midi),
            confidence,
            selected_notes,
            chord_scores,
            best_note_id: Some(best_note.id.clone()),
            detected_string,
            detected_fret,
        }
    }

    fn prepare_magnitude_spectrum(&mut self) {
        let nyquist_bin = self.fft_size / 2;
        if self.magnitude_buffer.len() != nyquist_bin + 1 {
            self.magnitude_buffer.resize(nyquist_bin + 1, 0.0);
        }
        for bin in 0..=nyquist_bin {
            let value = self.fft_buffer[bin];
            let mut magnitude = (value.re * value.re + value.im * value.im).sqrt();
            if SPECTRAL_MAGNITUDE_COMPRESSION_GAMMA.is_finite()
                && SPECTRAL_MAGNITUDE_COMPRESSION_GAMMA > 0.0
                && (SPECTRAL_MAGNITUDE_COMPRESSION_GAMMA - 1.0).abs() > 1e-6
            {
                magnitude = magnitude.powf(SPECTRAL_MAGNITUDE_COMPRESSION_GAMMA);
            }
            if SPECTRAL_USE_LOG_MAGNITUDE {
                magnitude = (1.0 + magnitude.max(0.0)).ln();
            }
            self.magnitude_buffer[bin] = magnitude.max(0.0);
        }

        if SPECTRAL_USE_LOCAL_WHITENING {
            local_whiten(
                &self.magnitude_buffer,
                SPECTRAL_WHITENING_RADIUS_BINS,
                &mut self.whitening_prefix,
                &mut self.whitening_buffer,
            );
            self.magnitude_buffer.copy_from_slice(&self.whitening_buffer);
        }
    }

    fn select_polyphonic_notes(
        &self,
        raw_scores: &[(usize, f32)],
        relative_scores: &[f32],
        best_score: f32,
    ) -> Vec<SpectralSelectedNote> {
        if raw_scores.is_empty() || SPECTRAL_POLYPHONY_MAX_NOTES == 0 {
            return Vec::new();
        }

        let mut working = vec![0.0f32; self.notes.len()];
        for (index, score) in raw_scores {
            working[*index] = score.max(0.0);
        }

        let min_relative = best_score.max(0.0) * SPECTRAL_POLYPHONY_MIN_RELATIVE_SCORE.max(0.0);
        let min_absolute = SPECTRAL_POLYPHONY_MIN_ABSOLUTE_SCORE.max(0.0);
        let mut selected = Vec::<(usize, f32)>::new();

        while selected.len() < SPECTRAL_POLYPHONY_MAX_NOTES {
            let Some((best_index, score)) = best_nonzero_index(&working) else {
                break;
            };
            if score < min_relative || score < min_absolute {
                break;
            }
            if SPECTRAL_POLYPHONY_DEDUPE_MIDI
                && selected.iter().any(|(selected_index, _)| {
                    (self.notes[*selected_index].midi - self.notes[best_index].midi).abs() < 0.01
                })
            {
                working[best_index] = 0.0;
                continue;
            }

            selected.push((best_index, score));
            working[best_index] = 0.0;
            self.apply_polyphonic_suppression(best_index, &mut working);
        }

        selected
            .into_iter()
            .map(|(index, score)| SpectralSelectedNote {
                note_id: self.notes[index].id.clone(),
                midi: self.notes[index].midi,
                guitar_string: self.notes[index].guitar_string,
                fret: self.notes[index].fret,
                score: score.max(*relative_scores.get(index).unwrap_or(&0.0)),
            })
            .collect()
    }

    fn apply_polyphonic_suppression(&self, selected_index: usize, working_scores: &mut [f32]) {
        if SPECTRAL_POLYPHONY_HARMONIC_SUPPRESSION >= 1.0 {
            return;
        }
        let selected_note = &self.notes[selected_index];
        let selected_frequency = selected_note.frequency_hz;

        for (index, score) in working_scores.iter_mut().enumerate() {
            if *score <= 0.0 {
                continue;
            }
            if SPECTRAL_POLYPHONY_DEDUPE_MIDI
                && (self.notes[index].midi - selected_note.midi).abs() < 0.01
            {
                *score = 0.0;
                continue;
            }
            let candidate_frequency = self.notes[index].frequency_hz;
            if harmonic_related(
                selected_frequency,
                candidate_frequency,
                self.max_harmonics.max(8),
                SPECTRAL_POLYPHONY_HARMONIC_TOLERANCE_CENTS,
            ) {
                *score *= SPECTRAL_POLYPHONY_HARMONIC_SUPPRESSION;
            }
        }
    }

    fn score_chords(&self, raw_scores: &[(usize, f32)]) -> Vec<SpectralChordScore> {
        if self.chords.is_empty() {
            return Vec::new();
        }
        let mut score_by_index = vec![0.0f32; self.notes.len()];
        for (index, score) in raw_scores {
            score_by_index[*index] = score.max(0.0);
        }

        let mut out = Vec::<SpectralChordScore>::with_capacity(self.chords.len());
        for chord in &self.chords {
            if chord.member_indices.is_empty() {
                continue;
            }
            let mut values = Vec::<f32>::with_capacity(chord.member_indices.len());
            for member_index in &chord.member_indices {
                values.push(score_by_index[*member_index]);
            }
            let mean = values.iter().copied().sum::<f32>() / values.len() as f32;
            let min = values
                .iter()
                .copied()
                .fold(f32::INFINITY, f32::min)
                .max(0.0);
            let score = SPECTRAL_CHORD_ALPHA * mean + (1.0 - SPECTRAL_CHORD_ALPHA) * min;
            out.push(SpectralChordScore {
                chord_id: chord.id.clone(),
                score: score.max(0.0),
            });
        }

        out.sort_by(|a, b| b.score.total_cmp(&a.score));
        out
    }
}

fn detect_pitch_autocorr(
    samples: &[f32],
    sample_rate_hz: f32,
    min_freq_hz: f32,
    max_freq_hz: f32,
    energy_threshold: f32,
    correlation_threshold: f32,
) -> (Option<f32>, f32) {
    if samples.is_empty() || sample_rate_hz <= 0.0 {
        return (None, 0.0);
    }

    let mut mean = 0.0f32;
    for sample in samples {
        mean += *sample;
    }
    mean /= samples.len() as f32;

    let mut energy = 0.0f32;
    for sample in samples {
        let centered = *sample - mean;
        energy += centered * centered;
    }
    let rms = (energy / samples.len() as f32).sqrt();
    if !rms.is_finite() || rms < energy_threshold.max(0.0) {
        return (None, 0.0);
    }

    let min_lag = (sample_rate_hz / max_freq_hz.max(1.0)).floor().max(1.0) as usize;
    let max_lag = ((sample_rate_hz / min_freq_hz.max(1.0)).floor() as usize)
        .min(samples.len().saturating_sub(2));
    if max_lag <= min_lag {
        return (None, 0.0);
    }

    let mut best_lag = 0usize;
    let mut best_correlation = -1.0f32;
    for lag in min_lag..=max_lag {
        let upper = samples.len() - lag;
        let mut cross = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for i in 0..upper {
            let a = samples[i] - mean;
            let b = samples[i + lag] - mean;
            cross += a * b;
            norm_a += a * a;
            norm_b += b * b;
        }

        let denom = (norm_a * norm_b).sqrt();
        if denom <= 1e-8 {
            continue;
        }
        let correlation = cross / denom;
        if correlation > best_correlation {
            best_correlation = correlation;
            best_lag = lag;
        }
    }

    if best_lag == 0 || best_correlation < clamp01(correlation_threshold) {
        return (None, clamp01(best_correlation));
    }

    let frequency_hz = sample_rate_hz / best_lag as f32;
    if !frequency_hz.is_finite() || frequency_hz <= 0.0 {
        return (None, 0.0);
    }
    let confidence = clamp01((best_correlation - 0.45) / 0.5);
    (Some(frequency_hz), confidence)
}

fn midi_from_hz(frequency_hz: f32) -> f32 {
    69.0 + 12.0 * (frequency_hz / 440.0).log2()
}

fn hz_from_midi(midi: f32) -> f32 {
    440.0 * 2.0f32.powf((midi - 69.0) / 12.0)
}

fn apply_reference_contamination_policy(
    midi_estimate: Option<f32>,
    confidence: f32,
    reference_midi: Option<f32>,
    reference_correlation: f32,
    energy_ratio_db: f32,
    onset_strength: f32,
    contamination_score: f32,
    mode: DspMode,
) -> (Option<f32>, f32, bool) {
    let midi = if let Some(value) = midi_estimate {
        if value.is_finite() {
            value
        } else {
            return (None, 0.0, false);
        }
    } else {
        return (None, 0.0, false);
    };

    let reference = if let Some(value) = reference_midi {
        if value.is_finite() {
            value
        } else {
            return (Some(midi), clamp01(confidence), false);
        }
    } else {
        return (Some(midi), clamp01(confidence), false);
    };

    let pitch_match = (midi - reference).abs() <= 0.25;
    if !pitch_match {
        return (Some(midi), clamp01(confidence), false);
    }

    match mode {
        DspMode::Headphones => {
            if reference_correlation >= 0.94 && energy_ratio_db <= -14.0 {
                (None, 0.0, true)
            } else {
                (
                    Some(midi),
                    clamp01(confidence * (1.0 - 0.3 * contamination_score)),
                    false,
                )
            }
        }
        DspMode::Speaker => {
            let high_correlation = reference_correlation >= 0.86;
            let low_mic_dominance = energy_ratio_db <= -10.0;
            let strong_onset = onset_strength >= 0.22;
            let mic_dominant = energy_ratio_db >= 4.0;
            if high_correlation && low_mic_dominance && !strong_onset && !mic_dominant {
                (None, 0.0, true)
            } else {
                (
                    Some(midi),
                    clamp01(confidence * (1.0 - 0.45 * contamination_score)),
                    false,
                )
            }
        }
    }
}

fn estimate_delay_and_correlation(mic: &[f32], reference: &[f32]) -> (isize, f32) {
    let max_delay = MAX_DELAY_SAMPLES
        .min(mic.len() as isize - 2)
        .min(reference.len() as isize - 2)
        .max(0);

    let mut best_delay = 0isize;
    let mut best_correlation = -1.0f32;

    for delay in -max_delay..=max_delay {
        let mut cross = 0.0f32;
        let mut norm_mic = 0.0f32;
        let mut norm_ref = 0.0f32;
        for (i, m) in mic.iter().enumerate() {
            let j = i as isize - delay;
            if j < 0 || j >= reference.len() as isize {
                continue;
            }
            let r = reference[j as usize];
            cross += m * r;
            norm_mic += m * m;
            norm_ref += r * r;
        }

        let denom = (norm_mic * norm_ref).sqrt();
        if denom <= 1e-8 {
            continue;
        }
        let correlation = cross / denom;
        if correlation > best_correlation {
            best_correlation = correlation;
            best_delay = delay;
        }
    }

    (best_delay, clamp_signed(best_correlation))
}

fn align_reference(reference: &[f32], out: &mut [f32], delay_samples: isize) {
    for i in 0..out.len() {
        let source_index = i as isize - delay_samples;
        out[i] = if source_index >= 0 && source_index < reference.len() as isize {
            reference[source_index as usize]
        } else {
            0.0
        };
    }
}

fn run_nlms(mic: &[f32], aligned_reference: &[f32], residual: &mut [f32], weights: &mut [f32]) {
    let taps = weights.len();
    for n in 0..mic.len() {
        let mut y_hat = 0.0f32;
        let mut norm = NLMS_EPS;
        for k in 0..taps {
            let x = if n >= k {
                aligned_reference[n - k]
            } else {
                0.0
            };
            y_hat += weights[k] * x;
            norm += x * x;
        }

        let error = mic[n] - y_hat;
        residual[n] = error;
        let gain = (NLMS_MU * error) / norm;
        for k in 0..taps {
            let x = if n >= k {
                aligned_reference[n - k]
            } else {
                0.0
            };
            weights[k] += gain * x;
        }
    }
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy = samples
        .iter()
        .fold(0.0f32, |acc, value| acc + value * value);
    (energy / samples.len() as f32).sqrt()
}

fn centered_rms(samples: &[f32], mean: f32) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for sample in samples {
        let centered = *sample - mean;
        sum += centered * centered;
    }
    (sum / samples.len() as f32).sqrt()
}

fn compute_contamination_score(
    reference_correlation: f32,
    energy_ratio_db: f32,
    onset_strength: f32,
    mode: DspMode,
) -> f32 {
    let corr_score = clamp01((reference_correlation - 0.55) / 0.45);
    let bleed_score = clamp01((-energy_ratio_db - 3.0) / 18.0);
    let base = clamp01(corr_score * 0.65 + bleed_score * 0.35 - onset_strength * 0.25);

    match mode {
        DspMode::Speaker => base,
        DspMode::Headphones => clamp01(base * 0.7),
    }
}

fn harmonic_weights(max_harmonics: usize) -> Vec<f32> {
    if max_harmonics == 0 {
        return vec![1.0];
    }
    let mut out = Vec::with_capacity(max_harmonics);
    for harmonic_index in 0..max_harmonics {
        let harmonic = harmonic_index as f32 + 1.0;
        out.push(1.0 / harmonic.sqrt());
    }
    out
}

fn note_spectral_score(
    frequency_hz: f32,
    spectrum_magnitude: &[f32],
    sample_rate_hz: f32,
    fft_size: usize,
    min_freq_hz: f32,
    max_harmonic_freq_hz: f32,
    max_harmonics: usize,
    weights: &[f32],
    base_bandwidth_hz: f32,
    relative_bandwidth: f32,
    use_harmonic_penalty: bool,
    subharmonic_penalty_alpha: f32,
    normalize_by_weight_sum: bool,
    normalize_by_band_energy: bool,
    total_band_energy: f32,
) -> f32 {
    if !frequency_hz.is_finite()
        || frequency_hz < min_freq_hz
        || spectrum_magnitude.is_empty()
        || sample_rate_hz <= 0.0
        || fft_size < 2
    {
        return 0.0;
    }

    let nyquist_hz = sample_rate_hz * 0.5;
    let fallback_weight = weights.last().copied().unwrap_or(0.16);
    let mut weighted_sum = 0.0f32;
    let mut weight_sum = 0.0f32;

    for harmonic_idx in 0..max_harmonics {
        let harmonic = harmonic_idx as f32 + 1.0;
        let target_hz = harmonic * frequency_hz;
        if target_hz >= nyquist_hz || target_hz > max_harmonic_freq_hz {
            break;
        }
        let weight = weights
            .get(harmonic_idx)
            .copied()
            .unwrap_or(fallback_weight);
        let energy = energy_around_frequency(
            spectrum_magnitude,
            target_hz,
            sample_rate_hz,
            fft_size,
            base_bandwidth_hz,
            relative_bandwidth,
        );
        weighted_sum += weight * energy;
        weight_sum += weight;
    }

    if weight_sum <= 1e-9 {
        return 0.0;
    }

    let mut score = if normalize_by_weight_sum {
        weighted_sum / weight_sum
    } else {
        weighted_sum
    };

    if use_harmonic_penalty {
        let mut penalty = 0.0f32;
        if frequency_hz * 0.5 >= min_freq_hz {
            penalty += subharmonic_penalty_alpha
                * energy_around_frequency(
                    spectrum_magnitude,
                    frequency_hz * 0.5,
                    sample_rate_hz,
                    fft_size,
                    base_bandwidth_hz,
                    relative_bandwidth,
                );
        }
        if frequency_hz / 3.0 >= min_freq_hz {
            penalty += 0.5
                * subharmonic_penalty_alpha
                * energy_around_frequency(
                    spectrum_magnitude,
                    frequency_hz / 3.0,
                    sample_rate_hz,
                    fft_size,
                    base_bandwidth_hz,
                    relative_bandwidth,
                );
        }
        score = (score - penalty).max(0.0);
    } else {
        score = score.max(0.0);
    }

    if normalize_by_band_energy {
        score /= total_band_energy.max(1e-9);
    }
    score
}

fn energy_around_frequency(
    spectrum_magnitude: &[f32],
    target_freq_hz: f32,
    sample_rate_hz: f32,
    fft_size: usize,
    base_bandwidth_hz: f32,
    relative_bandwidth: f32,
) -> f32 {
    if spectrum_magnitude.is_empty()
        || !target_freq_hz.is_finite()
        || target_freq_hz <= 0.0
        || sample_rate_hz <= 0.0
        || fft_size < 2
    {
        return 0.0;
    }

    let bandwidth_hz = base_bandwidth_hz.max(relative_bandwidth.max(0.0) * target_freq_hz);
    let lo_hz = (target_freq_hz - bandwidth_hz).max(0.0);
    let hi_hz = target_freq_hz + bandwidth_hz;
    let fft_scale = fft_size as f32 / sample_rate_hz;
    let mut bin_lo = (lo_hz * fft_scale).floor() as isize;
    let mut bin_hi = (hi_hz * fft_scale).ceil() as isize;
    let max_bin = spectrum_magnitude.len().saturating_sub(1) as isize;
    bin_lo = bin_lo.clamp(0, max_bin);
    bin_hi = bin_hi.clamp(0, max_bin);
    if bin_hi < bin_lo {
        return 0.0;
    }

    let start = bin_lo as usize;
    let end = bin_hi as usize;
    let mut sum = 0.0f32;
    let mut count = 0usize;
    for value in spectrum_magnitude.iter().take(end + 1).skip(start) {
        sum += *value;
        count += 1;
    }

    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
}

fn local_whiten(input: &[f32], radius_bins: usize, prefix: &mut Vec<f32>, output: &mut Vec<f32>) {
    if input.is_empty() {
        output.clear();
        return;
    }
    if output.len() != input.len() {
        output.resize(input.len(), 0.0);
    }
    if prefix.len() != input.len() + 1 {
        prefix.resize(input.len() + 1, 0.0);
    }

    prefix[0] = 0.0;
    for (index, value) in input.iter().enumerate() {
        prefix[index + 1] = prefix[index] + value.max(0.0);
    }

    for index in 0..input.len() {
        let lo = index.saturating_sub(radius_bins);
        let hi = (index + radius_bins).min(input.len() - 1);
        let window_len = (hi - lo + 1) as f32;
        let local_sum = prefix[hi + 1] - prefix[lo];
        let local_mean = (local_sum / window_len).max(1e-12);
        output[index] = input[index] / local_mean;
    }
}

fn relative_note_scores(note_count: usize, raw_scores: &[(usize, f32)]) -> Vec<f32> {
    let mut out = vec![0.0f32; note_count];
    let best = raw_scores
        .iter()
        .map(|(_, score)| *score)
        .filter(|score| score.is_finite())
        .fold(0.0f32, f32::max);
    if best <= 1e-12 {
        return out;
    }
    for (index, score) in raw_scores {
        out[*index] = (*score / best).clamp(0.0, 1.0);
    }
    out
}

fn resolve_detected_position(
    best_index: usize,
    best_score: f32,
    notes: &[SpectralNoteCandidate],
    raw_scores: &[(usize, f32)],
) -> (Option<u32>, Option<u32>) {
    let Some(best_note) = notes.get(best_index) else {
        return (None, None);
    };
    if !best_score.is_finite() || best_score <= 0.0 {
        return (None, None);
    }

    let tied = raw_scores
        .iter()
        .filter(|(index, score)| {
            (notes[*index].midi - best_note.midi).abs() < 0.01
                && (*score - best_score).abs() <= SPECTRAL_TIE_EPSILON
        })
        .count();

    if tied == 1 {
        (Some(best_note.guitar_string), Some(best_note.fret))
    } else {
        (None, None)
    }
}

fn best_note(raw_scores: &[(usize, f32)]) -> (usize, f32) {
    let mut best_index = 0usize;
    let mut best_score = f32::NEG_INFINITY;
    for (index, score) in raw_scores {
        if *score > best_score {
            best_score = *score;
            best_index = *index;
        }
    }
    (best_index, best_score)
}

fn second_best_score(raw_scores: &[(usize, f32)], best_index: usize) -> Option<f32> {
    let mut second = f32::NEG_INFINITY;
    for (index, score) in raw_scores {
        if *index != best_index && *score > second {
            second = *score;
        }
    }
    if second.is_finite() {
        Some(second)
    } else {
        None
    }
}

fn best_nonzero_index(scores: &[f32]) -> Option<(usize, f32)> {
    let mut best_index = None;
    let mut best_score = 0.0f32;
    for (index, score) in scores.iter().enumerate() {
        if *score > best_score {
            best_score = *score;
            best_index = Some(index);
        }
    }
    best_index.map(|index| (index, best_score))
}

fn harmonic_related(
    reference_freq_hz: f32,
    candidate_freq_hz: f32,
    max_harmonic_order: usize,
    tolerance_cents: f32,
) -> bool {
    if reference_freq_hz <= 0.0
        || candidate_freq_hz <= 0.0
        || !reference_freq_hz.is_finite()
        || !candidate_freq_hz.is_finite()
    {
        return false;
    }
    let tolerance = tolerance_cents.abs().max(1.0);
    for order in 2..=max_harmonic_order.max(2) {
        let harmonic = order as f32;
        if within_harmonic_tolerance(candidate_freq_hz / reference_freq_hz, harmonic, tolerance)
            || within_harmonic_tolerance(reference_freq_hz / candidate_freq_hz, harmonic, tolerance)
        {
            return true;
        }
    }
    false
}

fn within_harmonic_tolerance(ratio: f32, harmonic: f32, tolerance_cents: f32) -> bool {
    if ratio <= 0.0 || harmonic <= 0.0 {
        return false;
    }
    let cents_delta = 1200.0 * (ratio / harmonic).log2();
    cents_delta.abs() <= tolerance_cents
}

fn build_hann_window(size: usize) -> Vec<f32> {
    if size <= 1 {
        return vec![1.0; size.max(1)];
    }
    let denominator = (size - 1) as f32;
    (0..size)
        .map(|index| {
            let phase = std::f32::consts::TAU * index as f32 / denominator;
            0.5 - 0.5 * phase.cos()
        })
        .collect()
}

fn spectral_selected_notes_to_js_array(notes: &[SpectralSelectedNote]) -> js_sys::Array {
    let out = js_sys::Array::new();
    for note in notes {
        let object = js_sys::Object::new();
        set_value(&object, "note_id", &JsValue::from_str(&note.note_id));
        set_number(&object, "midi", note.midi as f64);
        set_number(&object, "string", note.guitar_string as f64);
        set_number(&object, "fret", note.fret as f64);
        set_number(&object, "score", note.score as f64);
        out.push(object.as_ref());
    }
    out
}

fn spectral_chord_scores_to_js_array(scores: &[SpectralChordScore]) -> js_sys::Array {
    let out = js_sys::Array::new();
    for chord in scores {
        let object = js_sys::Object::new();
        set_value(&object, "chord_id", &JsValue::from_str(&chord.chord_id));
        set_number(&object, "score", chord.score as f64);
        out.push(object.as_ref());
    }
    out
}

fn set_number(object: &js_sys::Object, key: &str, value: f64) {
    let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), &JsValue::from_f64(value));
}

fn set_bool(object: &js_sys::Object, key: &str, value: bool) {
    let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), &JsValue::from_bool(value));
}

fn set_value(object: &js_sys::Object, key: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), value);
}

fn clamp01(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

fn clamp_signed(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(-1.0, 1.0)
}
