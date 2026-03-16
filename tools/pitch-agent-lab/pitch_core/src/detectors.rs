use crate::types::{AlgorithmKind, CandidateSpec, PitchFrame};

pub trait PitchDetector {
    fn reset(&mut self);
    fn process_window(
        &mut self,
        window: &[f32],
        chunk_rms: f32,
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame;
}

pub fn create_detector(spec: &CandidateSpec, window_size: usize) -> Box<dyn PitchDetector> {
    match spec.algorithm {
        AlgorithmKind::Yin => Box::new(YinDetector::from_spec(spec, window_size)),
        AlgorithmKind::Autocorr => Box::new(AutocorrDetector::from_spec(spec)),
        AlgorithmKind::Mpm => Box::new(MpmDetector::from_spec(spec, window_size)),
        AlgorithmKind::Hybrid => Box::new(HybridDetector::from_spec(spec, window_size)),
    }
}

struct YinDetector {
    min_freq_hz: f32,
    max_freq_hz: f32,
    threshold_default: f32,
    threshold_noisy: f32,
    max_pitch_dev: f32,
    rms_gap: f32,
    adaptive: bool,
    min_rms: f32,
    scratch: Vec<f32>,
    pitch_history: [f32; 3],
    rms_history: [f32; 3],
    previous_midi: Option<f32>,
}

impl YinDetector {
    fn from_spec(spec: &CandidateSpec, window_size: usize) -> Self {
        Self {
            min_freq_hz: spec.param_f64("min_freq_hz", 30.0) as f32,
            max_freq_hz: spec.param_f64("max_freq_hz", 500.0) as f32,
            threshold_default: spec.param_f64("threshold_default", 0.15) as f32,
            threshold_noisy: spec.param_f64("threshold_noisy", 0.60) as f32,
            max_pitch_dev: spec.param_f64("max_pitch_dev", 0.20) as f32,
            rms_gap: spec.param_f64("rms_gap", 1.1) as f32,
            adaptive: spec.param_bool("adaptive", true),
            min_rms: spec.param_f64("min_rms", 0.0008) as f32,
            scratch: vec![0.0; window_size.max(128)],
            pitch_history: [-1.0, -1.0, -1.0],
            rms_history: [0.0, 0.0, 0.0],
            previous_midi: None,
        }
    }
}

impl PitchDetector for YinDetector {
    fn reset(&mut self) {
        self.pitch_history = [-1.0, -1.0, -1.0];
        self.rms_history = [0.0, 0.0, 0.0];
        self.previous_midi = None;
    }

    fn process_window(
        &mut self,
        window: &[f32],
        chunk_rms: f32,
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame {
        if self.scratch.len() < window.len() {
            self.scratch.resize(window.len(), 0.0);
        }
        push_history(&mut self.rms_history, chunk_rms);

        let mut min_freq = self.min_freq_hz;
        let mut max_freq = self.max_freq_hz;
        let mut threshold = self.threshold_default;

        let previous_pitch = self.pitch_history[2];
        let second_previous_pitch = self.pitch_history[1];
        let previous_rms = self.rms_history[2];
        let second_previous_rms = self.rms_history[1];
        let restrict = self.adaptive
            && previous_pitch > 0.0
            && previous_rms < second_previous_rms * self.rms_gap
            && relative_diff(previous_pitch, second_previous_pitch) <= self.max_pitch_dev;
        if restrict {
            min_freq = previous_pitch * (1.0 - self.max_pitch_dev);
            max_freq = previous_pitch * (1.0 + self.max_pitch_dev);
            threshold = self.threshold_noisy;
        }

        if !chunk_rms.is_finite() || chunk_rms < self.min_rms {
            push_history(&mut self.pitch_history, -1.0);
            self.previous_midi = None;
            return PitchFrame {
                t_seconds,
                midi_estimate: None,
                confidence: 0.0,
            };
        }

        let yin = detect_pitch_yin(
            window,
            sample_rate as f32,
            min_freq,
            max_freq,
            threshold,
            &mut self.scratch,
        );
        if let Some((frequency_hz, cmnd)) = yin {
            push_history(&mut self.pitch_history, frequency_hz);
            let midi = midi_from_hz(frequency_hz);
            let yin_score = clamp01(1.0 - cmnd / threshold.max(1e-4));
            let energy_score =
                clamp01((chunk_rms - self.min_rms) / (self.min_rms * 10.0).max(1e-5));
            let stability = if let Some(prev) = self.previous_midi {
                clamp01(1.0 - ((midi - prev).abs() / 2.5))
            } else {
                0.7
            };
            self.previous_midi = Some(midi);
            let confidence =
                clamp01(0.45 + 0.35 * yin_score + 0.15 * energy_score + 0.05 * stability);
            return PitchFrame {
                t_seconds,
                midi_estimate: Some(midi),
                confidence,
            };
        }

        push_history(&mut self.pitch_history, -1.0);
        self.previous_midi = None;
        PitchFrame {
            t_seconds,
            midi_estimate: None,
            confidence: 0.0,
        }
    }
}

struct AutocorrDetector {
    min_freq_hz: f32,
    max_freq_hz: f32,
    energy_threshold: f32,
    correlation_threshold: f32,
    decay_grace_frames: u32,
    decay_energy_factor: f32,
    decay_correlation_threshold: f32,
    decay_frames_remaining: u32,
}

impl AutocorrDetector {
    fn from_spec(spec: &CandidateSpec) -> Self {
        Self {
            min_freq_hz: spec.param_f64("min_freq_hz", 65.0) as f32,
            max_freq_hz: spec.param_f64("max_freq_hz", 1200.0) as f32,
            energy_threshold: spec.param_f64("energy_threshold", 0.0032) as f32,
            correlation_threshold: spec.param_f64("correlation_threshold", 0.58) as f32,
            decay_grace_frames: spec.param_u32("decay_grace_frames", 8),
            decay_energy_factor: spec.param_f64("decay_energy_factor", 0.55) as f32,
            decay_correlation_threshold: spec.param_f64("decay_correlation_threshold", 0.52) as f32,
            decay_frames_remaining: 0,
        }
    }
}

impl PitchDetector for AutocorrDetector {
    fn reset(&mut self) {
        self.decay_frames_remaining = 0;
    }

    fn process_window(
        &mut self,
        window: &[f32],
        _chunk_rms: f32,
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame {
        let decay_active = self.decay_frames_remaining > 0;
        let energy_threshold = if decay_active {
            self.energy_threshold * self.decay_energy_factor
        } else {
            self.energy_threshold
        };
        let correlation_threshold = if decay_active {
            self.decay_correlation_threshold
                .min(self.correlation_threshold)
        } else {
            self.correlation_threshold
        };

        let result = detect_pitch_autocorr(
            window,
            sample_rate as f32,
            self.min_freq_hz,
            self.max_freq_hz,
            energy_threshold,
            correlation_threshold,
        );

        if let Some((frequency_hz, correlation)) = result.frequency_hz.zip(Some(result.correlation))
        {
            if self.decay_grace_frames > 0 {
                self.decay_frames_remaining = self.decay_grace_frames;
            }
            return PitchFrame {
                t_seconds,
                midi_estimate: Some(midi_from_hz(frequency_hz)),
                confidence: clamp01((correlation - 0.45) / 0.5),
            };
        }

        if self.decay_frames_remaining > 0 {
            self.decay_frames_remaining -= 1;
        }
        PitchFrame {
            t_seconds,
            midi_estimate: None,
            confidence: clamp01(result.correlation),
        }
    }
}

struct MpmDetector {
    min_freq_hz: f32,
    max_freq_hz: f32,
    min_rms: f32,
    nsdf_threshold: f32,
    scratch: Vec<f32>,
}

impl MpmDetector {
    fn from_spec(spec: &CandidateSpec, window_size: usize) -> Self {
        Self {
            min_freq_hz: spec.param_f64("min_freq_hz", 65.0) as f32,
            max_freq_hz: spec.param_f64("max_freq_hz", 1200.0) as f32,
            min_rms: spec.param_f64("min_rms", 0.0025) as f32,
            nsdf_threshold: spec.param_f64("nsdf_threshold", 0.60) as f32,
            scratch: vec![0.0; window_size.max(128)],
        }
    }
}

impl PitchDetector for MpmDetector {
    fn reset(&mut self) {}

    fn process_window(
        &mut self,
        window: &[f32],
        _chunk_rms: f32,
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame {
        if self.scratch.len() < window.len() {
            self.scratch.resize(window.len(), 0.0);
        }
        let rms = compute_rms(window);
        if !rms.is_finite() || rms < self.min_rms {
            return PitchFrame {
                t_seconds,
                midi_estimate: None,
                confidence: 0.0,
            };
        }

        let result = detect_pitch_mpm(
            window,
            sample_rate as f32,
            self.min_freq_hz,
            self.max_freq_hz,
            self.nsdf_threshold,
            &mut self.scratch,
        );

        if let Some((frequency_hz, nsdf_peak)) = result {
            return PitchFrame {
                t_seconds,
                midi_estimate: Some(midi_from_hz(frequency_hz)),
                confidence: clamp01(
                    (nsdf_peak - self.nsdf_threshold) / (1.0 - self.nsdf_threshold).max(1e-4),
                ),
            };
        }
        PitchFrame {
            t_seconds,
            midi_estimate: None,
            confidence: 0.0,
        }
    }
}

struct HybridDetector {
    yin: YinDetector,
    mpm: MpmDetector,
}

impl HybridDetector {
    fn from_spec(spec: &CandidateSpec, window_size: usize) -> Self {
        Self {
            yin: YinDetector::from_spec(spec, window_size),
            mpm: MpmDetector::from_spec(spec, window_size),
        }
    }
}

impl PitchDetector for HybridDetector {
    fn reset(&mut self) {
        self.yin.reset();
        self.mpm.reset();
    }

    fn process_window(
        &mut self,
        window: &[f32],
        chunk_rms: f32,
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame {
        let yin_frame = self
            .yin
            .process_window(window, chunk_rms, sample_rate, t_seconds);
        let mpm_frame = self
            .mpm
            .process_window(window, chunk_rms, sample_rate, t_seconds);
        match (yin_frame.midi_estimate, mpm_frame.midi_estimate) {
            (Some(yin_midi), Some(mpm_midi)) => {
                let midi = if (yin_midi - mpm_midi).abs() <= 0.5 {
                    (yin_midi + mpm_midi) * 0.5
                } else if yin_frame.confidence >= mpm_frame.confidence {
                    yin_midi
                } else {
                    mpm_midi
                };
                let confidence = yin_frame.confidence.max(mpm_frame.confidence);
                PitchFrame {
                    t_seconds,
                    midi_estimate: Some(midi),
                    confidence,
                }
            }
            (Some(_), None) => yin_frame,
            (None, Some(_)) => mpm_frame,
            (None, None) => PitchFrame {
                t_seconds,
                midi_estimate: None,
                confidence: yin_frame.confidence.max(mpm_frame.confidence),
            },
        }
    }
}

struct AutocorrPitchResult {
    frequency_hz: Option<f32>,
    correlation: f32,
}

fn detect_pitch_autocorr(
    samples: &[f32],
    sample_rate: f32,
    min_freq_hz: f32,
    max_freq_hz: f32,
    energy_threshold: f32,
    correlation_threshold: f32,
) -> AutocorrPitchResult {
    let mean = samples.iter().copied().sum::<f32>() / samples.len().max(1) as f32;
    let mut energy = 0.0f32;
    for sample in samples {
        let centered = *sample - mean;
        energy += centered * centered;
    }
    let rms = (energy / samples.len().max(1) as f32).sqrt();
    if !rms.is_finite() || rms < energy_threshold {
        return AutocorrPitchResult {
            frequency_hz: None,
            correlation: 0.0,
        };
    }

    let min_lag = (sample_rate / max_freq_hz.max(1.0)).floor().max(1.0) as usize;
    let max_lag = (sample_rate / min_freq_hz.max(1.0))
        .floor()
        .max((min_lag + 1) as f32) as usize;
    let safe_max_lag = max_lag.min(samples.len().saturating_sub(2));
    if safe_max_lag <= min_lag + 2 {
        return AutocorrPitchResult {
            frequency_hz: None,
            correlation: 0.0,
        };
    }

    let mut corr_by_lag = vec![0.0f32; safe_max_lag + 1];
    let mut best_corr = -1.0f32;
    for lag in min_lag..=safe_max_lag {
        let mut cross = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for i in 0..samples.len().saturating_sub(lag) {
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
        let corr = cross / denom;
        corr_by_lag[lag] = corr;
        if corr > best_corr {
            best_corr = corr;
        }
    }

    let mut chosen_lag = 0usize;
    for lag in (min_lag + 1)..safe_max_lag {
        let corr = corr_by_lag[lag];
        if corr >= correlation_threshold
            && corr >= corr_by_lag[lag - 1]
            && corr >= corr_by_lag[lag + 1]
        {
            chosen_lag = lag;
            break;
        }
    }
    if chosen_lag == 0 {
        let mut lag = 0usize;
        let mut corr = -1.0f32;
        for (idx, value) in corr_by_lag
            .iter()
            .enumerate()
            .skip(min_lag)
            .take(safe_max_lag - min_lag + 1)
        {
            if *value > corr {
                corr = *value;
                lag = idx;
            }
        }
        chosen_lag = lag;
    }

    if chosen_lag == 0 || best_corr < correlation_threshold {
        return AutocorrPitchResult {
            frequency_hz: None,
            correlation: clamp01(best_corr),
        };
    }
    AutocorrPitchResult {
        frequency_hz: Some(sample_rate / chosen_lag as f32),
        correlation: best_corr,
    }
}

fn detect_pitch_yin(
    samples: &[f32],
    sample_rate: f32,
    min_freq_hz: f32,
    max_freq_hz: f32,
    threshold: f32,
    scratch: &mut [f32],
) -> Option<(f32, f32)> {
    let tau_min = (sample_rate / max_freq_hz.max(1.0)).floor().max(2.0) as usize;
    let tau_max = (sample_rate / min_freq_hz.max(1.0)).floor() as usize;
    let safe_tau_max = tau_max.min(samples.len().saturating_sub(1));
    if safe_tau_max <= tau_min + 2 {
        return None;
    }
    for item in scratch.iter_mut().take(safe_tau_max + 1).skip(tau_min) {
        *item = 0.0;
    }

    for tau in tau_min..safe_tau_max {
        let mut sum = 0.0f32;
        for j in 0..samples.len().saturating_sub(tau) {
            let diff = samples[j] - samples[j + tau];
            sum += diff * diff;
        }
        scratch[tau] = sum;
    }

    let mut acc = 0.0f32;
    for tau in tau_min..safe_tau_max {
        acc += scratch[tau];
        if acc <= 1e-12 {
            scratch[tau] = 1.0;
        } else {
            scratch[tau] = (scratch[tau] * (tau + 1 - tau_min) as f32) / acc;
        }
    }

    let mut min_tau = None::<f32>;
    let mut min_cmnd = 1.0f32;
    for tau in (tau_min + 1)..(safe_tau_max.saturating_sub(1)) {
        if scratch[tau] < threshold && scratch[tau] < scratch[tau + 1] {
            min_tau = Some(parabolic_interp(
                tau as f32,
                scratch[tau - 1],
                scratch[tau],
                scratch[tau + 1],
            ));
            min_cmnd = scratch[tau];
            break;
        }
    }

    let tau = min_tau?;
    if !tau.is_finite() || tau <= 0.0 {
        return None;
    }
    Some((sample_rate / tau, clamp01(min_cmnd)))
}

fn detect_pitch_mpm(
    samples: &[f32],
    sample_rate: f32,
    min_freq_hz: f32,
    max_freq_hz: f32,
    threshold: f32,
    scratch: &mut [f32],
) -> Option<(f32, f32)> {
    let mean = samples.iter().copied().sum::<f32>() / samples.len().max(1) as f32;
    let min_lag = (sample_rate / max_freq_hz.max(1.0)).floor().max(1.0) as usize;
    let max_lag = (sample_rate / min_freq_hz.max(1.0))
        .floor()
        .max((min_lag + 1) as f32) as usize;
    let safe_max_lag = max_lag.min(samples.len().saturating_sub(2));
    if safe_max_lag <= min_lag + 2 {
        return None;
    }

    for value in scratch.iter_mut().take(safe_max_lag + 1) {
        *value = 0.0;
    }

    let mut max_peak = -1.0f32;
    for tau in min_lag..=safe_max_lag {
        let mut acf = 0.0f32;
        let mut m = 0.0f32;
        for i in 0..samples.len().saturating_sub(tau) {
            let x = samples[i] - mean;
            let y = samples[i + tau] - mean;
            acf += x * y;
            m += x * x + y * y;
        }
        if m > 1e-8 {
            scratch[tau] = (2.0 * acf) / m;
        }
    }

    for tau in (min_lag + 1)..safe_max_lag {
        let value = scratch[tau];
        if value > threshold
            && value > scratch[tau - 1]
            && value >= scratch[tau + 1]
            && value > max_peak
        {
            max_peak = value;
        }
    }

    let mut best_tau = 0usize;
    let mut best_peak = -1.0f32;
    let early_threshold = (max_peak * 0.9).max(threshold);
    for tau in (min_lag + 1)..safe_max_lag {
        let value = scratch[tau];
        if value >= early_threshold && value > scratch[tau - 1] && value >= scratch[tau + 1] {
            best_tau = tau;
            best_peak = value;
            break;
        }
    }
    if best_tau == 0 {
        for tau in (min_lag + 1)..safe_max_lag {
            let value = scratch[tau];
            if value > threshold
                && value > scratch[tau - 1]
                && value >= scratch[tau + 1]
                && value > best_peak
            {
                best_peak = value;
                best_tau = tau;
            }
        }
    }
    if best_tau == 0 {
        return None;
    }

    let refined_tau = parabolic_interp(
        best_tau as f32,
        scratch[best_tau - 1],
        scratch[best_tau],
        scratch[best_tau + 1],
    );
    if !refined_tau.is_finite() || refined_tau <= 0.0 {
        return None;
    }
    Some((sample_rate / refined_tau, clamp01(best_peak)))
}

fn parabolic_interp(n: f32, y_left: f32, y_center: f32, y_right: f32) -> f32 {
    let nom = -4.0 * n * y_center + (2.0 * n - 1.0) * y_right + (2.0 * n + 1.0) * y_left;
    let denom = 2.0 * (y_left - 2.0 * y_center + y_right);
    if !denom.is_finite() || denom.abs() < 1e-12 {
        return n;
    }
    let estimate = nom / denom;
    if !estimate.is_finite() || estimate < n - 1.0 || estimate > n + 1.0 {
        return n;
    }
    estimate
}

fn push_history(history: &mut [f32; 3], value: f32) {
    history[0] = history[1];
    history[1] = history[2];
    history[2] = value;
}

fn relative_diff(a: f32, b: f32) -> f32 {
    let denom = b.abs().max(1e-6);
    (a - b).abs() / denom
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for sample in samples {
        sum += sample * sample;
    }
    (sum / samples.len() as f32).sqrt()
}

fn midi_from_hz(freq_hz: f32) -> f32 {
    69.0 + 12.0 * (freq_hz / 440.0).log2()
}

fn clamp01(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn sine_wave(freq_hz: f32, sample_rate: u32, seconds: f32) -> Vec<f32> {
        let len = (sample_rate as f32 * seconds) as usize;
        (0..len)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (std::f32::consts::TAU * freq_hz * t).sin() * 0.5
            })
            .collect()
    }

    fn candidate(id: &str, algorithm: AlgorithmKind) -> CandidateSpec {
        CandidateSpec {
            id: id.to_owned(),
            label: None,
            algorithm,
            params: BTreeMap::new(),
            source: Default::default(),
        }
    }

    #[test]
    fn yin_detector_tracks_a4() {
        let sample_rate = 44100u32;
        let signal = sine_wave(440.0, sample_rate, 0.25);
        let chunk_rms = compute_rms(&signal);
        let mut detector = create_detector(&candidate("yin", AlgorithmKind::Yin), signal.len());
        let frame = detector.process_window(&signal, chunk_rms, sample_rate, 0.25);
        assert!(frame.midi_estimate.is_some());
        assert!(frame.confidence > 0.5);
        let midi = frame.midi_estimate.unwrap_or_default();
        assert!((midi - 69.0).abs() < 0.5);
    }

    #[test]
    fn autocorr_detector_tracks_a3() {
        let sample_rate = 44100u32;
        let signal = sine_wave(220.0, sample_rate, 0.20);
        let mut detector = create_detector(&candidate("ac", AlgorithmKind::Autocorr), signal.len());
        let frame = detector.process_window(&signal, compute_rms(&signal), sample_rate, 0.2);
        assert!(frame.midi_estimate.is_some());
        let midi = frame.midi_estimate.unwrap_or_default();
        assert!((midi - 57.0).abs() < 0.7);
    }

    #[test]
    fn mpm_detector_tracks_e4() {
        let sample_rate = 44100u32;
        let signal = sine_wave(329.63, sample_rate, 0.20);
        let mut detector = create_detector(&candidate("mpm", AlgorithmKind::Mpm), signal.len());
        let frame = detector.process_window(&signal, compute_rms(&signal), sample_rate, 0.2);
        assert!(frame.midi_estimate.is_some());
        let midi = frame.midi_estimate.unwrap_or_default();
        assert!((midi - 64.0).abs() < 0.8);
    }
}
