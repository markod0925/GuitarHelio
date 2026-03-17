use crate::types::{
    ChordSummary, FrameNoteScore, FrameTrace, GatesConfig, ManifestEvent, NoteSummary, PitchFrame,
    PolyphonySummary, TakeMetrics,
};
use std::collections::HashSet;

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
    let mut chord_summaries = Vec::new();
    let mut chord_total_frames = 0u32;
    let mut chord_detect_frames = 0u32;
    let mut chord_coverage_sum = 0.0f32;

    for event in events {
        if event_is_polyphonic(event) {
            let summary = evaluate_chord_event(event, frames, gates);
            total_frames += summary.total_frames;
            valid_frames += summary.valid_frames;
            // Keep legacy aggregate semantics monotonic for strict pass charts.
            in_tune_frames += summary.valid_frames;
            chord_total_frames += summary.total_frames;
            chord_detect_frames += summary.valid_frames;
            chord_coverage_sum += summary.coverage_rate * summary.total_frames as f32;
            chord_summaries.push(summary);
            continue;
        }

        let (start_s, end_s) = adaptive_trim_window(event, gates);
        let start_idx = lower_bound(frames, start_s);
        let end_idx = lower_bound(frames, end_s);
        let mut note_total = 0u32;
        let mut note_valid = 0u32;
        let mut note_in_tune = 0u32;
        let mut abs_cents = Vec::new();

        for frame in &frames[start_idx..end_idx] {
            note_total += 1;
            if frame.confidence < gates.min_confidence {
                continue;
            }
            if let Some(abs) = frame_abs_cents_for_target(frame, event.midi) {
                note_valid += 1;
                abs_cents.push(abs);
                if abs <= IN_TUNE_CENTS {
                    note_in_tune += 1;
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

    let has_any_summary = !note_summaries.is_empty() || !chord_summaries.is_empty();
    let note_pass = note_summaries.iter().all(|item| item.pass);
    let chord_pass = chord_summaries.iter().all(|item| item.pass);
    let strict_pass = has_any_summary && note_pass && chord_pass;
    let chord_detect_rate = if chord_total_frames == 0 {
        None
    } else {
        Some(ratio(chord_detect_frames, chord_total_frames))
    };
    let chord_coverage_rate = if chord_total_frames == 0 {
        None
    } else {
        Some(chord_coverage_sum / chord_total_frames as f32)
    };
    let polyphony = evaluate_polyphony(frames, events, gates);
    TakeMetrics {
        take_id: take_id.to_owned(),
        total_frames,
        valid_frames,
        detect_rate: ratio(valid_frames, total_frames),
        in_tune_rate: ratio(in_tune_frames, total_frames),
        strict_pass,
        note_summaries,
        chord_summaries,
        chord_detect_rate,
        chord_coverage_rate,
        polyphony,
    }
}

fn event_is_polyphonic(event: &ManifestEvent) -> bool {
    !event.member_note_ids.is_empty() || !event.member_midis.is_empty()
}

fn evaluate_chord_event(
    event: &ManifestEvent,
    frames: &[PitchFrame],
    gates: &GatesConfig,
) -> ChordSummary {
    let (start_s, end_s) = adaptive_trim_window(event, gates);
    let start_idx = lower_bound(frames, start_s);
    let end_idx = lower_bound(frames, end_s);
    let expected_note_ids = event.member_note_ids.clone();
    let expected_midis = event.member_midis.clone();
    let expected_notes = expected_note_ids.len().max(expected_midis.len()).max(1) as u32;

    let mut total = 0u32;
    let mut valid = 0u32;
    let mut coverage_sum = 0.0f32;

    for frame in &frames[start_idx..end_idx] {
        total += 1;
        if frame.confidence < gates.min_confidence {
            continue;
        }
        let (detected_ids, detected_midis) = collect_detected_notes(frame);
        let matched = if !expected_note_ids.is_empty() {
            expected_note_ids
                .iter()
                .filter(|note_id| detected_ids.contains(*note_id))
                .count() as u32
        } else {
            expected_midis
                .iter()
                .filter(|expected_midi| {
                    detected_midis
                        .iter()
                        .any(|detected_midi| midi_match(**expected_midi, *detected_midi))
                })
                .count() as u32
        };
        let coverage = matched as f32 / expected_notes as f32;
        coverage_sum += coverage;
        if matched >= expected_notes {
            valid += 1;
        }
    }

    let detect_rate = ratio(valid, total);
    let coverage_rate = if total == 0 {
        0.0
    } else {
        coverage_sum / total as f32
    };
    ChordSummary {
        note_order: event.note_order,
        chord_id: event.chord_id.clone().or_else(|| event.note.clone()),
        expected_notes,
        detect_rate,
        coverage_rate,
        total_frames: total,
        valid_frames: valid,
        pass: total > 0 && detect_rate + 1e-6 >= gates.required_detect_rate,
    }
}

fn evaluate_polyphony(
    frames: &[PitchFrame],
    events: &[ManifestEvent],
    gates: &GatesConfig,
) -> Option<PolyphonySummary> {
    let mut expected_windows = Vec::<(f64, f64, Vec<f32>)>::with_capacity(events.len());
    for event in events {
        let (start_s, end_s) = adaptive_trim_window(event, gates);
        if end_s <= start_s {
            continue;
        }
        let mut expected_midis = expected_midis_for_event(event);
        dedupe_midis(&mut expected_midis);
        if expected_midis.is_empty() {
            continue;
        }
        expected_windows.push((start_s, end_s, expected_midis));
    }
    if expected_windows.is_empty() {
        return None;
    }

    let mut total_frames = 0u32;
    let mut valid_frames = 0u32;
    let mut detect_frames = 0u32;
    let mut coverage_sum = 0.0f32;
    let mut tp = 0u32;
    let mut fp = 0u32;
    let mut fn_ = 0u32;

    for frame in frames {
        let mut expected_midis = Vec::<f32>::new();
        for (start_s, end_s, window_midis) in &expected_windows {
            if frame.t_seconds >= *start_s && frame.t_seconds < *end_s {
                expected_midis.extend(window_midis.iter().copied());
            }
        }
        if expected_midis.is_empty() {
            continue;
        }
        dedupe_midis(&mut expected_midis);
        total_frames += 1;

        let mut detected_midis = if frame.confidence >= gates.min_confidence {
            valid_frames += 1;
            let (_, mids) = collect_detected_notes(frame);
            mids
        } else {
            Vec::new()
        };
        dedupe_midis(&mut detected_midis);

        let (matched, unmatched_expected, unmatched_detected) =
            match_midis(&expected_midis, &detected_midis);
        if matched == expected_midis.len() as u32 {
            detect_frames += 1;
        }
        coverage_sum += matched as f32 / expected_midis.len() as f32;
        tp += matched;
        fn_ += unmatched_expected;
        fp += unmatched_detected;
    }
    if total_frames == 0 {
        return None;
    }

    let precision = ratio(tp, tp + fp);
    let recall = ratio(tp, tp + fn_);
    let f1 = if precision <= 0.0 || recall <= 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    };

    Some(PolyphonySummary {
        total_frames,
        valid_frames,
        detect_rate: ratio(detect_frames, total_frames),
        coverage_rate: coverage_sum / total_frames as f32,
        precision,
        recall,
        f1,
    })
}

fn expected_midis_for_event(event: &ManifestEvent) -> Vec<f32> {
    if !event.member_midis.is_empty() {
        return event.member_midis.clone();
    }
    vec![event.midi]
}

fn collect_detected_notes(frame: &PitchFrame) -> (HashSet<String>, Vec<f32>) {
    if let Some(trace) = &frame.frame_trace {
        let selected = if trace.selected_notes.is_empty() {
            fallback_selected_from_trace(frame, trace)
        } else {
            trace.selected_notes.clone()
        };
        let mut ids = HashSet::<String>::with_capacity(selected.len());
        let mut midis = Vec::with_capacity(selected.len());
        for note in &selected {
            ids.insert(note.note_id.clone());
            midis.push(note.midi);
        }
        return (ids, midis);
    }

    let ids = HashSet::<String>::new();
    let mut midis = Vec::new();
    if let Some(midi) = frame.midi_estimate {
        midis.push(midi);
    }
    (ids, midis)
}

fn dedupe_midis(midis: &mut Vec<f32>) {
    if midis.len() <= 1 {
        return;
    }
    midis.sort_by(|a, b| a.total_cmp(b));
    midis.dedup_by(|a, b| ((*a - *b) * 100.0).abs() < 1.0);
}

fn match_midis(expected_midis: &[f32], detected_midis: &[f32]) -> (u32, u32, u32) {
    if expected_midis.is_empty() {
        return (0, 0, detected_midis.len() as u32);
    }
    if detected_midis.is_empty() {
        return (0, expected_midis.len() as u32, 0);
    }

    let mut candidate_pairs = Vec::<(f32, usize, usize)>::new();
    for (exp_idx, expected) in expected_midis.iter().enumerate() {
        for (det_idx, detected) in detected_midis.iter().enumerate() {
            let abs_cents = ((*expected - *detected) * 100.0).abs();
            if abs_cents <= IN_TUNE_CENTS {
                candidate_pairs.push((abs_cents, exp_idx, det_idx));
            }
        }
    }
    candidate_pairs.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut expected_used = vec![false; expected_midis.len()];
    let mut detected_used = vec![false; detected_midis.len()];
    let mut matched = 0u32;

    for (_, exp_idx, det_idx) in candidate_pairs {
        if expected_used[exp_idx] || detected_used[det_idx] {
            continue;
        }
        expected_used[exp_idx] = true;
        detected_used[det_idx] = true;
        matched += 1;
    }

    (
        matched,
        expected_midis.len() as u32 - matched,
        detected_midis.len() as u32 - matched,
    )
}

fn fallback_selected_from_trace(frame: &PitchFrame, trace: &FrameTrace) -> Vec<FrameNoteScore> {
    if let (Some(note_id), Some(midi), Some(score)) = (
        &trace.best_note_id,
        trace.best_note_midi,
        trace.best_note_score,
    ) {
        return vec![FrameNoteScore {
            note_id: note_id.clone(),
            midi,
            score,
            raw_score: score,
            relative_score: 1.0,
        }];
    }
    if let Some(midi) = frame.midi_estimate {
        return vec![FrameNoteScore {
            note_id: "midi_only".to_owned(),
            midi,
            score: 1.0,
            raw_score: 1.0,
            relative_score: 1.0,
        }];
    }
    Vec::new()
}

fn midi_match(expected_midi: f32, detected_midi: f32) -> bool {
    ((expected_midi - detected_midi) * 100.0).abs() <= IN_TUNE_CENTS
}

fn frame_abs_cents_for_target(frame: &PitchFrame, target_midi: f32) -> Option<f32> {
    let mut candidates = Vec::<f32>::new();
    if let Some(trace) = &frame.frame_trace {
        if !trace.selected_notes.is_empty() {
            candidates.extend(trace.selected_notes.iter().map(|item| item.midi));
        } else if let Some(best_midi) = trace.best_note_midi {
            candidates.push(best_midi);
        }
    }
    if candidates.is_empty() {
        if let Some(midi) = frame.midi_estimate {
            candidates.push(midi);
        }
    }
    if candidates.is_empty() {
        return None;
    }

    candidates
        .into_iter()
        .map(|midi| ((midi - target_midi) * 100.0).abs())
        .min_by(|a, b| a.total_cmp(b))
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
            chord_id: None,
            member_note_ids: Vec::new(),
            member_midis: Vec::new(),
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
            chord_id: None,
            member_note_ids: Vec::new(),
            member_midis: Vec::new(),
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

    #[test]
    fn chord_event_uses_selected_notes_for_detection() {
        let gates = GatesConfig {
            required_detect_rate: 1.0,
            min_confidence: 0.7,
            adaptive_trim: false,
            ..GatesConfig::default()
        };
        let event = ManifestEvent {
            note_order: 1,
            note: Some("A5".to_owned()),
            midi: 45.0,
            start_s: 0.0,
            end_s: 0.3,
            string: None,
            fret: None,
            chord_id: Some("a5_power".to_owned()),
            member_note_ids: Vec::new(),
            member_midis: vec![45.0, 52.0],
        };
        let frames = vec![
            PitchFrame {
                t_seconds: 0.1,
                midi_estimate: Some(45.0),
                confidence: 0.9,
                frame_trace: Some(FrameTrace {
                    t_seconds: 0.1,
                    best_note_id: Some("n014_a2_s5_f0".to_owned()),
                    best_note_midi: Some(45.0),
                    best_note_score: Some(1.0),
                    note_scores: Vec::new(),
                    selected_notes: vec![
                        FrameNoteScore {
                            note_id: "n014_a2_s5_f0".to_owned(),
                            midi: 45.0,
                            score: 1.0,
                            raw_score: 1.0,
                            relative_score: 1.0,
                        },
                        FrameNoteScore {
                            note_id: "n029_e3_s4_f2".to_owned(),
                            midi: 52.0,
                            score: 0.8,
                            raw_score: 0.8,
                            relative_score: 0.8,
                        },
                    ],
                    chord_scores: Vec::new(),
                }),
            },
            PitchFrame {
                t_seconds: 0.2,
                midi_estimate: Some(45.0),
                confidence: 0.9,
                frame_trace: Some(FrameTrace {
                    t_seconds: 0.2,
                    best_note_id: Some("n014_a2_s5_f0".to_owned()),
                    best_note_midi: Some(45.0),
                    best_note_score: Some(1.0),
                    note_scores: Vec::new(),
                    selected_notes: vec![
                        FrameNoteScore {
                            note_id: "n014_a2_s5_f0".to_owned(),
                            midi: 45.0,
                            score: 1.0,
                            raw_score: 1.0,
                            relative_score: 1.0,
                        },
                        FrameNoteScore {
                            note_id: "n029_e3_s4_f2".to_owned(),
                            midi: 52.0,
                            score: 0.8,
                            raw_score: 0.8,
                            relative_score: 0.8,
                        },
                    ],
                    chord_scores: Vec::new(),
                }),
            },
        ];
        let metrics = evaluate_take("takeChord", &frames, &[event], &gates);
        assert!(metrics.strict_pass);
        assert!(metrics.note_summaries.is_empty());
        assert_eq!(metrics.chord_summaries.len(), 1);
        assert_eq!(metrics.chord_summaries[0].detect_rate, 1.0);
        assert_eq!(metrics.chord_summaries[0].coverage_rate, 1.0);
        assert_eq!(metrics.chord_detect_rate, Some(1.0));
        assert_eq!(metrics.chord_coverage_rate, Some(1.0));
    }

    #[test]
    fn polyphony_summary_scores_overlap_frames() {
        let gates = GatesConfig {
            required_detect_rate: 1.0,
            min_confidence: 0.7,
            adaptive_trim: false,
            ..GatesConfig::default()
        };
        let events = vec![
            ManifestEvent {
                note_order: 1,
                note: Some("A2".to_owned()),
                midi: 45.0,
                start_s: 0.0,
                end_s: 0.3,
                string: None,
                fret: None,
                chord_id: None,
                member_note_ids: Vec::new(),
                member_midis: Vec::new(),
            },
            ManifestEvent {
                note_order: 2,
                note: Some("E3".to_owned()),
                midi: 52.0,
                start_s: 0.0,
                end_s: 0.3,
                string: None,
                fret: None,
                chord_id: None,
                member_note_ids: Vec::new(),
                member_midis: Vec::new(),
            },
        ];
        let frames = vec![
            PitchFrame {
                t_seconds: 0.1,
                midi_estimate: Some(45.0),
                confidence: 0.9,
                frame_trace: Some(FrameTrace {
                    t_seconds: 0.1,
                    best_note_id: Some("a2".to_owned()),
                    best_note_midi: Some(45.0),
                    best_note_score: Some(1.0),
                    note_scores: Vec::new(),
                    selected_notes: vec![
                        FrameNoteScore {
                            note_id: "a2".to_owned(),
                            midi: 45.0,
                            score: 1.0,
                            raw_score: 1.0,
                            relative_score: 1.0,
                        },
                        FrameNoteScore {
                            note_id: "e3".to_owned(),
                            midi: 52.0,
                            score: 0.9,
                            raw_score: 0.9,
                            relative_score: 0.9,
                        },
                    ],
                    chord_scores: Vec::new(),
                }),
            },
            PitchFrame {
                t_seconds: 0.2,
                midi_estimate: Some(45.0),
                confidence: 0.9,
                frame_trace: Some(FrameTrace {
                    t_seconds: 0.2,
                    best_note_id: Some("a2".to_owned()),
                    best_note_midi: Some(45.0),
                    best_note_score: Some(1.0),
                    note_scores: Vec::new(),
                    selected_notes: vec![
                        FrameNoteScore {
                            note_id: "a2".to_owned(),
                            midi: 45.0,
                            score: 1.0,
                            raw_score: 1.0,
                            relative_score: 1.0,
                        },
                        FrameNoteScore {
                            note_id: "e3".to_owned(),
                            midi: 52.0,
                            score: 0.9,
                            raw_score: 0.9,
                            relative_score: 0.9,
                        },
                    ],
                    chord_scores: Vec::new(),
                }),
            },
        ];
        let metrics = evaluate_take("takePoly", &frames, &events, &gates);
        let poly = metrics.polyphony.expect("polyphony summary");
        assert_eq!(poly.total_frames, 2);
        assert_eq!(poly.valid_frames, 2);
        assert_eq!(poly.detect_rate, 1.0);
        assert_eq!(poly.coverage_rate, 1.0);
        assert_eq!(poly.precision, 1.0);
        assert_eq!(poly.recall, 1.0);
        assert_eq!(poly.f1, 1.0);
    }

    #[test]
    fn polyphony_summary_penalizes_missing_note() {
        let gates = GatesConfig {
            required_detect_rate: 1.0,
            min_confidence: 0.7,
            adaptive_trim: false,
            ..GatesConfig::default()
        };
        let events = vec![
            ManifestEvent {
                note_order: 1,
                note: Some("A2".to_owned()),
                midi: 45.0,
                start_s: 0.0,
                end_s: 0.3,
                string: None,
                fret: None,
                chord_id: None,
                member_note_ids: Vec::new(),
                member_midis: Vec::new(),
            },
            ManifestEvent {
                note_order: 2,
                note: Some("E3".to_owned()),
                midi: 52.0,
                start_s: 0.0,
                end_s: 0.3,
                string: None,
                fret: None,
                chord_id: None,
                member_note_ids: Vec::new(),
                member_midis: Vec::new(),
            },
        ];
        let frames = vec![PitchFrame {
            t_seconds: 0.1,
            midi_estimate: Some(45.0),
            confidence: 0.9,
            frame_trace: Some(FrameTrace {
                t_seconds: 0.1,
                best_note_id: Some("a2".to_owned()),
                best_note_midi: Some(45.0),
                best_note_score: Some(1.0),
                note_scores: Vec::new(),
                selected_notes: vec![FrameNoteScore {
                    note_id: "a2".to_owned(),
                    midi: 45.0,
                    score: 1.0,
                    raw_score: 1.0,
                    relative_score: 1.0,
                }],
                chord_scores: Vec::new(),
            }),
        }];
        let metrics = evaluate_take("takePoly", &frames, &events, &gates);
        let poly = metrics.polyphony.expect("polyphony summary");
        assert_eq!(poly.total_frames, 1);
        assert_eq!(poly.detect_rate, 0.0);
        assert!((poly.coverage_rate - 0.5).abs() < 1e-6);
        assert!((poly.recall - 0.5).abs() < 1e-6);
        assert!((poly.precision - 1.0).abs() < 1e-6);
        assert!((poly.f1 - (2.0 / 3.0)).abs() < 1e-6);
    }
}
