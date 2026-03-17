use crate::types::{GatesConfig, ManifestEvent, NoteSummary, PitchFrame, TakeMetrics};

const IN_TUNE_CENTS: f32 = 35.0;

pub fn evaluate_take(
    take_id: &str,
    frames: &[PitchFrame],
    events: &[ManifestEvent],
    gates: &GatesConfig,
) -> TakeMetrics {
    let mut total_frames = 0u32;
    let mut valid_frames = 0u32;
    let mut in_tune_frames = 0u32;
    let mut note_summaries = Vec::with_capacity(events.len());

    for event in events {
        let (start_s, end_s) = adaptive_trim_window(event, gates);
        let start_idx = lower_bound(frames, start_s);
        let end_idx = lower_bound(frames, end_s);
        let mut note_total = 0u32;
        let mut note_valid = 0u32;
        let mut note_in_tune = 0u32;
        let mut abs_cents = Vec::new();

        for frame in &frames[start_idx..end_idx] {
            note_total += 1;
            if let Some(midi) = frame.midi_estimate {
                if frame.confidence >= gates.min_confidence {
                    note_valid += 1;
                    let cents = (midi - event.midi) * 100.0;
                    let abs = cents.abs();
                    abs_cents.push(abs);
                    if abs <= IN_TUNE_CENTS {
                        note_in_tune += 1;
                    }
                }
            }
        }

        total_frames += note_total;
        valid_frames += note_valid;
        in_tune_frames += note_in_tune;
        let detect_rate = ratio(note_valid, note_total);
        let in_tune_rate = ratio(note_in_tune, note_total);
        let pass = note_total > 0 && detect_rate + 1e-6 >= gates.required_detect_rate;
        let median_abs_cents = median(&mut abs_cents);

        note_summaries.push(NoteSummary {
            note_order: event.note_order,
            note: event.note.clone(),
            midi: event.midi,
            detect_rate,
            total_frames: note_total,
            valid_frames: note_valid,
            in_tune_rate,
            median_abs_cents,
            pass,
        });
    }

    let strict_pass = !note_summaries.is_empty() && note_summaries.iter().all(|item| item.pass);
    TakeMetrics {
        take_id: take_id.to_owned(),
        total_frames,
        valid_frames,
        detect_rate: ratio(valid_frames, total_frames),
        in_tune_rate: ratio(in_tune_frames, total_frames),
        strict_pass,
        note_summaries,
    }
}

pub fn adaptive_trim_window(event: &ManifestEvent, gates: &GatesConfig) -> (f64, f64) {
    let start = event.start_s.max(0.0);
    let end = event.end_s.max(start);
    if !gates.adaptive_trim {
        return (start, end);
    }

    let duration = (end - start).max(0.0);
    if duration <= 0.0 {
        return (start, end);
    }

    let mut attack = (duration * gates.trim_attack_ratio).clamp(
        gates.trim_attack_min_ms / 1000.0,
        gates.trim_attack_max_ms / 1000.0,
    );
    let mut release = (duration * gates.trim_release_ratio).clamp(
        gates.trim_release_min_ms / 1000.0,
        gates.trim_release_max_ms / 1000.0,
    );

    let max_trim = duration * 0.6;
    let sum = attack + release;
    if sum > max_trim && sum > 0.0 {
        let scale = max_trim / sum;
        attack *= scale;
        release *= scale;
    }

    let trimmed_start = (start + attack).min(end);
    let trimmed_end = (end - release).max(trimmed_start);
    (trimmed_start, trimmed_end)
}

fn ratio(num: u32, den: u32) -> f32 {
    if den == 0 {
        return 0.0;
    }
    num as f32 / den as f32
}

fn lower_bound(frames: &[PitchFrame], target_time: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = frames.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if frames[mid].t_seconds < target_time {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn median(values: &mut [f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        Some((values[mid - 1] + values[mid]) / 2.0)
    } else {
        Some(values[mid])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_trim_scales_on_short_notes() {
        let gates = GatesConfig {
            adaptive_trim: true,
            ..GatesConfig::default()
        };
        let event = ManifestEvent {
            note_order: 1,
            note: Some("E2".to_owned()),
            midi: 40.0,
            start_s: 0.0,
            end_s: 0.1,
            string: None,
            fret: None,
        };
        let (start, end) = adaptive_trim_window(&event, &gates);
        assert!(start >= 0.0);
        assert!(end <= 0.1);
        assert!(end >= start);
        assert!(end - start >= 0.03);
    }

    #[test]
    fn strict_pass_requires_full_detection() {
        let gates = GatesConfig {
            required_detect_rate: 1.0,
            min_confidence: 0.7,
            adaptive_trim: false,
            ..GatesConfig::default()
        };
        let event = ManifestEvent {
            note_order: 1,
            note: Some("A2".to_owned()),
            midi: 45.0,
            start_s: 0.0,
            end_s: 0.3,
            string: None,
            fret: None,
        };
        let frames = vec![
            PitchFrame {
                t_seconds: 0.1,
                midi_estimate: Some(45.0),
                confidence: 0.8,
                frame_trace: None,
            },
            PitchFrame {
                t_seconds: 0.2,
                midi_estimate: None,
                confidence: 0.0,
                frame_trace: None,
            },
        ];
        let metrics = evaluate_take("takeX", &frames, &[event], &gates);
        assert!(!metrics.strict_pass);
        assert_eq!(metrics.note_summaries.len(), 1);
        assert!(!metrics.note_summaries[0].pass);
    }
}
