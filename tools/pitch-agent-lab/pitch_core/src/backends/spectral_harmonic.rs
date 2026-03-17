use crate::types::{CandidateModel, CandidateSpec, FrameNoteScore, FrameTrace, PitchFrame};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

use super::{clamp01, harmonic_weights};

pub struct SpectralHarmonicBackend {
    notes: Vec<crate::types::NoteCandidate>,
    max_harmonics: usize,
    weights: Vec<f32>,
    min_freq_hz: f32,
    max_harmonic_freq_hz: f32,
    base_bandwidth_hz: f32,
    relative_bandwidth: f32,
    magnitude_compression_gamma: f32,
    use_log_magnitude: bool,
    use_local_whitening: bool,
    whitening_radius_bins: usize,
    use_harmonic_penalty: bool,
    subharmonic_penalty_alpha: f32,
    normalize_by_weight_sum: bool,
    normalize_by_band_energy: bool,
    confidence_contrast_weight: f32,
    confidence_energy_weight: f32,
    confidence_gain: f32,
    confidence_bias: f32,
    min_rms: f32,
    emit_frame_traces: bool,
    top_n_note_scores: Option<usize>,
    dc_remove: bool,
    fft_size: usize,
    fft: Arc<dyn Fft<f32>>,
    fft_buffer: Vec<Complex<f32>>,
    hann_window: Vec<f32>,
    magnitude_buffer: Vec<f32>,
    whitening_buffer: Vec<f32>,
    whitening_prefix: Vec<f32>,
}

impl SpectralHarmonicBackend {
    pub fn from_spec(
        spec: &CandidateSpec,
        candidate_model: &CandidateModel,
        window_size: usize,
    ) -> Self {
        let max_harmonics = spec
            .param_u32("max_harmonics", spec.param_u32("harmonic_count", 6))
            .max(1) as usize;
        let configured_fft = spec
            .param_u32("fft_size", 4096)
            .max(window_size as u32)
            .max(64);
        let fft_size = configured_fft as usize;
        let top_n = spec.param_u32("top_n_note_scores", 0);
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_size);
        let half_spectrum_len = fft_size / 2 + 1;

        Self {
            notes: candidate_model.notes.clone(),
            max_harmonics,
            weights: harmonic_weights(max_harmonics),
            min_freq_hz: spec.param_f64("min_freq_hz", 75.0) as f32,
            max_harmonic_freq_hz: spec.param_f64("max_harmonic_freq_hz", 4000.0) as f32,
            base_bandwidth_hz: spec.param_f64("base_bandwidth_hz", 18.0) as f32,
            relative_bandwidth: spec.param_f64("relative_bandwidth", 0.015) as f32,
            magnitude_compression_gamma: spec.param_f64("magnitude_compression_gamma", 0.5) as f32,
            use_log_magnitude: spec.param_bool("use_log_magnitude", false),
            use_local_whitening: spec.param_bool("use_local_whitening", true),
            whitening_radius_bins: spec.param_u32("whitening_radius_bins", 8) as usize,
            use_harmonic_penalty: spec.param_bool("use_harmonic_penalty", true),
            subharmonic_penalty_alpha: spec.param_f64("subharmonic_penalty_alpha", 0.35) as f32,
            normalize_by_weight_sum: spec.param_bool("normalize_by_weight_sum", true),
            normalize_by_band_energy: spec.param_bool("normalize_by_band_energy", false),
            confidence_contrast_weight: spec.param_f64("confidence_contrast_weight", 0.7) as f32,
            confidence_energy_weight: spec.param_f64("confidence_energy_weight", 0.3) as f32,
            confidence_gain: spec.param_f64("confidence_gain", 1.0) as f32,
            confidence_bias: spec.param_f64("confidence_bias", 0.0) as f32,
            min_rms: spec.param_f64("min_rms", 0.0008) as f32,
            emit_frame_traces: spec.param_bool("emit_frame_traces", true),
            top_n_note_scores: if top_n == 0 {
                None
            } else {
                Some(top_n as usize)
            },
            dc_remove: spec.param_bool("dc_remove", true),
            fft_size,
            fft,
            fft_buffer: vec![Complex::new(0.0, 0.0); fft_size],
            hann_window: build_hann_window(window_size),
            magnitude_buffer: vec![0.0; half_spectrum_len],
            whitening_buffer: vec![0.0; half_spectrum_len],
            whitening_prefix: vec![0.0; half_spectrum_len + 1],
        }
    }

    pub fn process_window(
        &mut self,
        window: &[f32],
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame {
        if self.notes.is_empty() || sample_rate == 0 || window.is_empty() {
            return PitchFrame {
                t_seconds,
                midi_estimate: None,
                confidence: 0.0,
                frame_trace: self.emit_empty_trace(t_seconds),
            };
        }

        if self.hann_window.len() != window.len() {
            self.hann_window = build_hann_window(window.len());
        }
        if window.len() > self.fft_size {
            self.resize_fft(window.len().next_power_of_two());
        }

        let mean = if self.dc_remove {
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
                self.min_freq_hz,
                self.max_harmonic_freq_hz,
                self.max_harmonics,
                &self.weights,
                self.base_bandwidth_hz,
                self.relative_bandwidth,
                self.use_harmonic_penalty,
                self.subharmonic_penalty_alpha,
                self.normalize_by_weight_sum,
                self.normalize_by_band_energy,
                total_band_energy,
            );
            raw_scores.push((index, score));
        }

        let relative_scores = relative_note_scores(self.notes.len(), &raw_scores);
        let (best_idx, best_score) = best_note(&raw_scores);
        let second_score = second_best_score(&raw_scores, best_idx).unwrap_or(best_score);
        let confidence = if rms < self.min_rms || !best_score.is_finite() {
            0.0
        } else {
            let spread = (best_score - second_score).max(0.0);
            let contrast = spread / (best_score.abs() + second_score.abs() + 1e-6);
            let energy = clamp01((rms - self.min_rms) / (self.min_rms * 10.0).max(1e-6));
            let weight_sum =
                (self.confidence_contrast_weight + self.confidence_energy_weight).max(1e-6);
            let base = (self.confidence_contrast_weight * contrast
                + self.confidence_energy_weight * energy)
                / weight_sum;
            clamp01(base * self.confidence_gain + self.confidence_bias)
        };
        let midi_estimate = if rms < self.min_rms || !best_score.is_finite() {
            None
        } else {
            Some(self.notes[best_idx].midi)
        };

        let frame_trace = if self.emit_frame_traces {
            Some(build_trace(
                t_seconds,
                &self.notes,
                &raw_scores,
                &relative_scores,
                best_idx,
                best_score,
                self.top_n_note_scores,
            ))
        } else {
            None
        };

        PitchFrame {
            t_seconds,
            midi_estimate,
            confidence,
            frame_trace,
        }
    }

    fn emit_empty_trace(&self, t_seconds: f64) -> Option<FrameTrace> {
        if !self.emit_frame_traces {
            return None;
        }
        Some(FrameTrace {
            t_seconds,
            best_note_id: None,
            best_note_midi: None,
            best_note_score: None,
            note_scores: Vec::new(),
            chord_scores: Vec::new(),
        })
    }

    fn resize_fft(&mut self, required_size: usize) {
        self.fft_size = required_size.max(64);
        let mut planner = FftPlanner::<f32>::new();
        self.fft = planner.plan_fft_forward(self.fft_size);
        self.fft_buffer = vec![Complex::new(0.0, 0.0); self.fft_size];
        let half_spectrum_len = self.fft_size / 2 + 1;
        self.magnitude_buffer = vec![0.0; half_spectrum_len];
        self.whitening_buffer = vec![0.0; half_spectrum_len];
        self.whitening_prefix = vec![0.0; half_spectrum_len + 1];
    }

    fn prepare_magnitude_spectrum(&mut self) {
        let nyquist_bin = self.fft_size / 2;
        if self.magnitude_buffer.len() != nyquist_bin + 1 {
            self.magnitude_buffer.resize(nyquist_bin + 1, 0.0);
        }
        for bin in 0..=nyquist_bin {
            let value = self.fft_buffer[bin];
            let mut magnitude = (value.re * value.re + value.im * value.im).sqrt();
            if self.magnitude_compression_gamma.is_finite()
                && self.magnitude_compression_gamma > 0.0
                && (self.magnitude_compression_gamma - 1.0).abs() > 1e-6
            {
                magnitude = magnitude.powf(self.magnitude_compression_gamma);
            }
            if self.use_log_magnitude {
                magnitude = (1.0 + magnitude.max(0.0)).ln();
            }
            self.magnitude_buffer[bin] = magnitude.max(0.0);
        }

        if self.use_local_whitening {
            local_whiten(
                &self.magnitude_buffer,
                self.whitening_radius_bins,
                &mut self.whitening_prefix,
                &mut self.whitening_buffer,
            );
            self.magnitude_buffer
                .copy_from_slice(&self.whitening_buffer);
        }
    }
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

fn build_trace(
    t_seconds: f64,
    notes: &[crate::types::NoteCandidate],
    raw_scores: &[(usize, f32)],
    relative_scores: &[f32],
    best_idx: usize,
    best_score: f32,
    top_n_note_scores: Option<usize>,
) -> FrameTrace {
    let mut note_scores = raw_scores
        .iter()
        .map(|(index, score)| FrameNoteScore {
            note_id: notes[*index].id.clone(),
            midi: notes[*index].midi,
            score: *score,
            raw_score: *score,
            relative_score: *relative_scores.get(*index).unwrap_or(&0.0),
        })
        .collect::<Vec<_>>();

    if let Some(limit) = top_n_note_scores {
        note_scores.sort_by(|a, b| b.score.total_cmp(&a.score));
        note_scores.truncate(limit.max(1));
    }

    FrameTrace {
        t_seconds,
        best_note_id: Some(notes[best_idx].id.clone()),
        best_note_midi: Some(notes[best_idx].midi),
        best_note_score: Some(best_score),
        note_scores,
        chord_scores: Vec::new(),
    }
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
    let mut weighted_sum = 0.0f32;
    let mut weight_sum = 0.0f32;
    let fallback_weight = weights.last().copied().unwrap_or(0.16);

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
    for (idx, value) in input.iter().enumerate() {
        prefix[idx + 1] = prefix[idx] + value.max(0.0);
    }

    for idx in 0..input.len() {
        let lo = idx.saturating_sub(radius_bins);
        let hi = (idx + radius_bins).min(input.len() - 1);
        let window_len = (hi - lo + 1) as f32;
        let local_sum = prefix[hi + 1] - prefix[lo];
        let local_mean = (local_sum / window_len).max(1e-12);
        output[idx] = input[idx] / local_mean;
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

fn build_hann_window(size: usize) -> Vec<f32> {
    if size <= 1 {
        return vec![1.0; size.max(1)];
    }
    let denom = (size - 1) as f32;
    (0..size)
        .map(|index| {
            let phase = std::f32::consts::TAU * index as f32 / denom;
            0.5 - 0.5 * phase.cos()
        })
        .collect()
}

fn best_note(raw_scores: &[(usize, f32)]) -> (usize, f32) {
    let mut best_idx = 0usize;
    let mut best_score = f32::NEG_INFINITY;
    for (idx, score) in raw_scores {
        if *score > best_score {
            best_score = *score;
            best_idx = *idx;
        }
    }
    (best_idx, best_score)
}

fn second_best_score(raw_scores: &[(usize, f32)], best_idx: usize) -> Option<f32> {
    let mut second = f32::NEG_INFINITY;
    for (idx, score) in raw_scores {
        if *idx != best_idx && *score > second {
            second = *score;
        }
    }
    if second.is_finite() {
        Some(second)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CandidateModel, CandidateSpec, ChordCandidate, NoteCandidate, SourceMeta};
    use std::collections::BTreeMap;

    fn sine_wave(freq_hz: f32, sample_rate: u32, seconds: f32) -> Vec<f32> {
        let len = (sample_rate as f32 * seconds) as usize;
        (0..len)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (std::f32::consts::TAU * freq_hz * t).sin() * 0.6
            })
            .collect()
    }

    fn model() -> CandidateModel {
        CandidateModel {
            notes: vec![
                NoteCandidate {
                    id: "a3".to_owned(),
                    guitar_string: 3,
                    fret: 2,
                    midi: 57.0,
                    frequency_hz: 220.0,
                },
                NoteCandidate {
                    id: "e4".to_owned(),
                    guitar_string: 1,
                    fret: 0,
                    midi: 64.0,
                    frequency_hz: 329.62756,
                },
                NoteCandidate {
                    id: "a4".to_owned(),
                    guitar_string: 1,
                    fret: 5,
                    midi: 69.0,
                    frequency_hz: 440.0,
                },
            ],
            chords: Vec::<ChordCandidate>::new(),
        }
    }

    fn spec() -> CandidateSpec {
        CandidateSpec {
            id: "spec_harm".to_owned(),
            label: None,
            algorithm: crate::types::AlgorithmKind::SpectralHarmonic,
            params: BTreeMap::from([
                ("max_harmonics".to_owned(), 6.0),
                ("fft_size".to_owned(), 4096.0),
                ("use_local_whitening".to_owned(), 1.0),
                ("use_harmonic_penalty".to_owned(), 1.0),
            ]),
            source: SourceMeta::default(),
        }
    }

    #[test]
    fn spectral_prefers_true_note_for_mono() {
        let sample_rate = 44_100u32;
        let signal = sine_wave(329.62756, sample_rate, 0.25);
        let mut backend = SpectralHarmonicBackend::from_spec(&spec(), &model(), signal.len());
        let frame = backend.process_window(&signal, sample_rate, 0.25);
        assert_eq!(frame.midi_estimate, Some(64.0));
        assert!(frame.confidence > 0.1);
    }

    #[test]
    fn spectral_trace_includes_raw_and_relative_scores() {
        let sample_rate = 44_100u32;
        let signal = sine_wave(220.0, sample_rate, 0.25);
        let mut backend = SpectralHarmonicBackend::from_spec(&spec(), &model(), signal.len());
        let frame = backend.process_window(&signal, sample_rate, 0.25);
        let trace = frame.frame_trace.expect("trace expected");
        assert_eq!(trace.note_scores.len(), 3);
        for score in &trace.note_scores {
            assert!(score.raw_score.is_finite());
            assert!(score.relative_score.is_finite());
            assert!((0.0..=1.0).contains(&score.relative_score));
        }
    }

    #[test]
    fn spectral_uses_max_harmonic_frequency_limit() {
        let sample_rate = 44_100u32;
        let signal = sine_wave(440.0, sample_rate, 0.25);

        let mut low_limit = spec();
        low_limit
            .params
            .insert("max_harmonic_freq_hz".to_owned(), 2000.0);
        let mut high_limit = spec();
        high_limit
            .params
            .insert("max_harmonic_freq_hz".to_owned(), 5000.0);

        let mut backend_low =
            SpectralHarmonicBackend::from_spec(&low_limit, &model(), signal.len());
        let mut backend_high =
            SpectralHarmonicBackend::from_spec(&high_limit, &model(), signal.len());

        let low_trace = backend_low
            .process_window(&signal, sample_rate, 0.25)
            .frame_trace
            .expect("trace expected");
        let high_trace = backend_high
            .process_window(&signal, sample_rate, 0.25)
            .frame_trace
            .expect("trace expected");

        let low_a4 = low_trace
            .note_scores
            .iter()
            .find(|item| item.note_id == "a4")
            .expect("a4 score");
        let high_a4 = high_trace
            .note_scores
            .iter()
            .find(|item| item.note_id == "a4")
            .expect("a4 score");
        assert!(low_a4.raw_score.is_finite());
        assert!(high_a4.raw_score.is_finite());
        assert!((high_a4.raw_score - low_a4.raw_score).abs() > 1e-6);
    }
}
