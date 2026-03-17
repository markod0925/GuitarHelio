pub mod sac;
pub mod spectral_harmonic;

pub const DEFAULT_HARMONIC_WEIGHTS: [f32; 8] = [1.0, 0.85, 0.70, 0.55, 0.40, 0.30, 0.22, 0.16];

pub fn harmonic_weights(harmonic_count: usize) -> Vec<f32> {
    let count = harmonic_count.max(1);
    let fallback = *DEFAULT_HARMONIC_WEIGHTS.last().unwrap_or(&0.16);
    (0..count)
        .map(|index| {
            DEFAULT_HARMONIC_WEIGHTS
                .get(index)
                .copied()
                .unwrap_or(fallback)
        })
        .collect()
}

pub fn clamp01(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

pub fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for sample in samples {
        sum += sample * sample;
    }
    (sum / samples.len() as f32).sqrt()
}
