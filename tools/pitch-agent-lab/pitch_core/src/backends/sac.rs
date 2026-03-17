use crate::types::{CandidateModel, CandidateSpec, FrameNoteScore, FrameTrace, PitchFrame};

use super::{clamp01, compute_rms, harmonic_weights};

pub struct SacBackend {
    notes: Vec<crate::types::NoteCandidate>,
    harmonic_count: usize,
    weights: Vec<f32>,
    normalized_acf: bool,
    min_rms: f32,
    emit_frame_traces: bool,
    top_n_note_scores: Option<usize>,
}

impl SacBackend {
    pub fn from_spec(spec: &CandidateSpec, candidate_model: &CandidateModel) -> Self {
        let harmonic_count = spec.param_u32("harmonic_count", 6).max(1) as usize;
        let top_n = spec.param_u32("top_n_note_scores", 0);
        Self {
            notes: candidate_model.notes.clone(),
            harmonic_count,
            weights: harmonic_weights(harmonic_count),
            normalized_acf: spec.param_bool("normalized_acf", false),
            min_rms: spec.param_f64("min_rms", 0.0008) as f32,
            emit_frame_traces: spec.param_bool("emit_frame_traces", true),
            top_n_note_scores: if top_n == 0 {
                None
            } else {
                Some(top_n as usize)
            },
        }
    }

    pub fn process_window(
        &mut self,
        window: &[f32],
        sample_rate: u32,
        t_seconds: f64,
    ) -> PitchFrame {
        let rms = compute_rms(window);
        if self.notes.is_empty() || window.len() < 3 || sample_rate == 0 {
            return PitchFrame {
                t_seconds,
                midi_estimate: None,
                confidence: 0.0,
                frame_trace: self.emit_empty_trace(t_seconds),
            };
        }

        let acf = compute_autocorrelation(window, self.normalized_acf);
        let mut raw_scores = Vec::<(usize, f32)>::with_capacity(self.notes.len());
        for (index, note) in self.notes.iter().enumerate() {
            let score = note_sac_score(
                note.frequency_hz,
                sample_rate as f32,
                &acf,
                self.harmonic_count,
                &self.weights,
            );
            raw_scores.push((index, score));
        }

        let (best_idx, best_score) = best_note(&raw_scores);
        let second_score = second_best_score(&raw_scores, best_idx).unwrap_or(best_score);
        let confidence = if rms < self.min_rms || !best_score.is_finite() {
            0.0
        } else {
            let spread = (best_score - second_score).max(0.0);
            let contrast = spread / (best_score.abs() + second_score.abs() + 1e-6);
            let energy = clamp01((rms - self.min_rms) / (self.min_rms * 10.0).max(1e-6));
            clamp01(0.65 * contrast + 0.35 * energy)
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
}

fn build_trace(
    t_seconds: f64,
    notes: &[crate::types::NoteCandidate],
    raw_scores: &[(usize, f32)],
    best_idx: usize,
    best_score: f32,
    top_n_note_scores: Option<usize>,
) -> FrameTrace {
    let max_score = raw_scores
        .iter()
        .map(|(_, score)| *score)
        .filter(|score| score.is_finite())
        .fold(0.0f32, f32::max);
    let mut note_scores = raw_scores
        .iter()
        .map(|(index, score)| FrameNoteScore {
            note_id: notes[*index].id.clone(),
            midi: notes[*index].midi,
            score: *score,
            raw_score: *score,
            relative_score: if max_score > 1e-12 {
                (*score / max_score).clamp(0.0, 1.0)
            } else {
                0.0
            },
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

fn compute_autocorrelation(samples: &[f32], normalized: bool) -> Vec<f32> {
    let mean = samples.iter().copied().sum::<f32>() / samples.len().max(1) as f32;
    let centered = samples
        .iter()
        .map(|sample| *sample - mean)
        .collect::<Vec<_>>();
    let max_lag = centered.len().saturating_sub(2);
    let mut out = vec![0.0f32; max_lag + 1];

    for lag in 0..=max_lag {
        let upper = centered.len() - lag;
        let mut cross = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for i in 0..upper {
            let a = centered[i];
            let b = centered[i + lag];
            cross += a * b;
            if normalized {
                norm_a += a * a;
                norm_b += b * b;
            }
        }
        out[lag] = if normalized {
            let denom = norm_a + norm_b;
            if denom > 1e-8 {
                (2.0 * cross) / denom
            } else {
                0.0
            }
        } else {
            cross
        };
    }

    out
}

fn note_sac_score(
    frequency_hz: f32,
    sample_rate_hz: f32,
    acf: &[f32],
    harmonic_count: usize,
    weights: &[f32],
) -> f32 {
    if !frequency_hz.is_finite() || frequency_hz <= 0.0 || sample_rate_hz <= 0.0 || acf.len() < 2 {
        return f32::NEG_INFINITY;
    }
    let period = sample_rate_hz / frequency_hz;
    if !period.is_finite() || period <= 0.0 {
        return f32::NEG_INFINITY;
    }

    let mut weighted_sum = 0.0f32;
    let mut weight_sum = 0.0f32;
    let max_tau = (acf.len() - 1) as f32;
    for harmonic_index in 0..harmonic_count {
        let tau = period * (harmonic_index as f32 + 1.0);
        if tau >= max_tau {
            break;
        }
        if let Some(value) = sample_linear(acf, tau) {
            let weight = weights.get(harmonic_index).copied().unwrap_or(0.25);
            weighted_sum += weight * value;
            weight_sum += weight;
        }
    }

    if weight_sum <= 1e-8 {
        f32::NEG_INFINITY
    } else {
        weighted_sum / weight_sum
    }
}

fn sample_linear(values: &[f32], tau: f32) -> Option<f32> {
    if values.len() < 2 || !tau.is_finite() || tau < 0.0 {
        return None;
    }
    let max_index = values.len() - 1;
    if tau >= max_index as f32 {
        return None;
    }
    let left = tau.floor() as usize;
    let right = left + 1;
    let frac = tau - left as f32;
    Some(values[left] * (1.0 - frac) + values[right] * frac)
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
                    id: "a4".to_owned(),
                    guitar_string: 1,
                    fret: 5,
                    midi: 69.0,
                    frequency_hz: 440.0,
                },
                NoteCandidate {
                    id: "e4".to_owned(),
                    guitar_string: 1,
                    fret: 0,
                    midi: 64.0,
                    frequency_hz: 329.62756,
                },
            ],
            chords: Vec::<ChordCandidate>::new(),
        }
    }

    fn spec() -> CandidateSpec {
        CandidateSpec {
            id: "sac_test".to_owned(),
            label: None,
            algorithm: crate::types::AlgorithmKind::Sac,
            params: BTreeMap::from([("harmonic_count".to_owned(), 6.0)]),
            source: SourceMeta::default(),
        }
    }

    #[test]
    fn sac_prefers_true_note_for_mono() {
        let sample_rate = 44_100u32;
        let signal = sine_wave(220.0, sample_rate, 0.25);
        let mut backend = SacBackend::from_spec(&spec(), &model());
        let frame = backend.process_window(&signal, sample_rate, 0.25);
        assert_eq!(frame.midi_estimate, Some(57.0));
        assert!(frame.confidence > 0.1);
    }

    #[test]
    fn sac_tracks_dyad_members_with_high_scores() {
        let sample_rate = 44_100u32;
        let len = (sample_rate as f32 * 0.25) as usize;
        let mut signal = vec![0.0f32; len];
        for (index, sample) in signal.iter_mut().enumerate() {
            let t = index as f32 / sample_rate as f32;
            *sample = 0.4 * (std::f32::consts::TAU * 220.0 * t).sin()
                + 0.4 * (std::f32::consts::TAU * 329.62756 * t).sin();
        }

        let mut backend = SacBackend::from_spec(&spec(), &model());
        let frame = backend.process_window(&signal, sample_rate, 0.25);
        let trace = frame.frame_trace.expect("trace expected");
        let mut by_id = trace
            .note_scores
            .iter()
            .map(|item| (item.note_id.as_str(), item.score))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert!(by_id.remove("a3").unwrap_or(f32::NEG_INFINITY).is_finite());
        assert!(by_id.remove("e4").unwrap_or(f32::NEG_INFINITY).is_finite());
    }
}
