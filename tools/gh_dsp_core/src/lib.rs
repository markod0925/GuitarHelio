use wasm_bindgen::prelude::*;

const DEFAULT_TAPS: usize = 64;
const NLMS_MU: f32 = 0.08;
const NLMS_EPS: f32 = 1e-6;
const MAX_DELAY_SAMPLES: isize = 720;

#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum DspMode {
    Speaker,
    Headphones,
}

#[wasm_bindgen]
pub struct GhDspCore {
    sample_rate: u32,
    block_size: usize,
    mode: DspMode,
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

        let output = js_sys::Object::new();
        set_number(&output, "delay_samples", delay_samples as f64);
        set_number(&output, "reference_correlation", reference_correlation as f64);
        set_number(&output, "energy_ratio_db", energy_ratio_db as f64);
        set_number(&output, "onset_strength", onset_strength as f64);
        set_number(&output, "contamination_score", contamination_score as f64);
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
            let x = if n >= k { aligned_reference[n - k] } else { 0.0 };
            y_hat += weights[k] * x;
            norm += x * x;
        }

        let error = mic[n] - y_hat;
        residual[n] = error;
        let gain = (NLMS_MU * error) / norm;
        for k in 0..taps {
            let x = if n >= k { aligned_reference[n - k] } else { 0.0 };
            weights[k] += gain * x;
        }
    }
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy = samples.iter().fold(0.0f32, |acc, value| acc + value * value);
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
