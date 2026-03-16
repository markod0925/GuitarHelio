use wasm_bindgen::prelude::*;

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

        let (pitch_hz, pitch_confidence) = self.detect_pitch_on_residual();

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
            "pitch_hz",
            pitch_hz.map_or(f64::NAN, |value| value as f64),
        );
        set_number(&output, "pitch_confidence", pitch_confidence as f64);
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
    fn detect_pitch_on_residual(&mut self) -> (Option<f32>, f32) {
        let config = self.pitch_config();
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
            PitchDetectorPreset::Baseline => PitchDetectorConfig {
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

fn set_number(object: &js_sys::Object, key: &str, value: f64) {
    let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), &JsValue::from_f64(value));
}

fn set_value(object: &js_sys::Object, key: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), value);
}
