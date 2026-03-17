use crate::config::{
    load_candidate_model_config, load_candidates_config, load_dataset_config, load_gates_config,
    resolve_from_config_dir,
};
use crate::detectors::create_detector;
use crate::evaluation::evaluate_take;
use crate::types::{
    AlgorithmKind, BenchmarkRunResult, CandidateModel, CandidateRunResult, ManifestFile,
    PitchFrame, RankingEntry, RunMetadata, StrictMatrixEntry, TakeFrameTrace,
};
use anyhow::{Context, Result};
use hound::{SampleFormat, WavReader};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::Instant;

struct LoadedTake {
    id: String,
    samples: Vec<f32>,
    sample_rate: u32,
    duration_s: f64,
    events: Vec<crate::types::ManifestEvent>,
}

pub fn run_benchmark(
    dataset_path: &Path,
    candidates_path: &Path,
    gates_path: &Path,
    metadata: RunMetadata,
) -> Result<BenchmarkRunResult> {
    let dataset_cfg = load_dataset_config(dataset_path)?;
    let candidates_cfg = load_candidates_config(candidates_path)?;
    let gates_cfg = load_gates_config(gates_path)?;
    let candidate_model =
        load_candidate_model(dataset_path, dataset_cfg.candidate_model.as_deref())?;
    if dataset_cfg.takes.is_empty() {
        anyhow::bail!("dataset must include at least one take");
    }
    if candidates_cfg.candidates.is_empty() {
        anyhow::bail!("candidates must include at least one candidate");
    }
    if candidates_cfg
        .candidates
        .iter()
        .any(|item| requires_candidate_model(item.algorithm))
        && candidate_model.is_none()
    {
        anyhow::bail!(
            "candidate_model is required in dataset config when using sac/spectral_harmonic algorithms"
        );
    }

    let mut loaded_takes = Vec::with_capacity(dataset_cfg.takes.len());
    for take in &dataset_cfg.takes {
        let wav_path = resolve_from_config_dir(dataset_path, &take.wav);
        let manifest_path = resolve_from_config_dir(dataset_path, &take.manifest);
        let events = load_manifest_events(&manifest_path)?;
        let (samples, sample_rate) = decode_wav_mono(&wav_path)?;
        let duration_s = samples.len() as f64 / sample_rate as f64;
        loaded_takes.push(LoadedTake {
            id: take.id.clone(),
            samples,
            sample_rate,
            duration_s,
            events,
        });
    }

    let mut candidate_results = Vec::with_capacity(candidates_cfg.candidates.len());
    for candidate in &candidates_cfg.candidates {
        let mut take_metrics = Vec::with_capacity(loaded_takes.len());
        let mut strict_matrix = Vec::new();
        let mut frame_traces = Vec::<TakeFrameTrace>::new();
        let mut runtime_ms_total = 0.0f64;
        let mut analyzed_duration_s_total = 0.0f64;
        let mut global_total_frames = 0u32;
        let mut global_valid_frames = 0u32;
        let mut global_in_tune_sum = 0.0f32;

        for take in &loaded_takes {
            let (frames, runtime_ms) =
                run_candidate_on_take(candidate, take, candidate_model.as_ref())?;
            runtime_ms_total += runtime_ms;
            analyzed_duration_s_total += take.duration_s;
            let traced_frames = frames
                .iter()
                .filter_map(|frame| frame.frame_trace.clone())
                .collect::<Vec<_>>();
            if !traced_frames.is_empty() {
                frame_traces.push(TakeFrameTrace {
                    take_id: take.id.clone(),
                    frames: traced_frames,
                });
            }
            let metrics = evaluate_take(&take.id, &frames, &take.events, &gates_cfg);
            global_total_frames += metrics.total_frames;
            global_valid_frames += metrics.valid_frames;
            global_in_tune_sum += metrics.in_tune_rate * metrics.total_frames as f32;
            for note in &metrics.note_summaries {
                strict_matrix.push(StrictMatrixEntry {
                    take_id: take.id.clone(),
                    note_order: note.note_order,
                    note: note.note.clone(),
                    pass: note.pass,
                    detect_rate: note.detect_rate,
                });
            }
            for chord in &metrics.chord_summaries {
                strict_matrix.push(StrictMatrixEntry {
                    take_id: take.id.clone(),
                    note_order: chord.note_order,
                    note: chord
                        .chord_id
                        .as_ref()
                        .map(|value| format!("chord:{value}")),
                    pass: chord.pass,
                    detect_rate: chord.detect_rate,
                });
            }
            take_metrics.push(metrics);
        }

        let global_detect_rate = if global_total_frames == 0 {
            0.0
        } else {
            global_valid_frames as f32 / global_total_frames as f32
        };
        let global_in_tune_rate = if global_total_frames == 0 {
            0.0
        } else {
            global_in_tune_sum / global_total_frames as f32
        };
        let cpu_ms_per_audio_s = runtime_ms_total / analyzed_duration_s_total.max(1e-6) as f64;
        let realtime_factor = analyzed_duration_s_total / (runtime_ms_total / 1000.0).max(1e-6);
        let pass_realtime = realtime_factor >= gates_cfg.min_realtime_factor;
        let full_pass = pass_realtime && take_metrics.iter().all(|item| item.strict_pass);

        candidate_results.push(CandidateRunResult {
            id: candidate.id.clone(),
            label: candidate.label_or_id().to_owned(),
            algorithm: candidate.algorithm,
            params: candidate.params.clone(),
            source: candidate.source.clone(),
            take_metrics,
            strict_matrix,
            global_detect_rate,
            global_in_tune_rate,
            runtime_ms_total,
            analyzed_duration_s_total,
            cpu_ms_per_audio_s,
            realtime_factor,
            pass_realtime,
            full_pass,
            frame_traces: if frame_traces.is_empty() {
                None
            } else {
                Some(frame_traces)
            },
        });
    }

    candidate_results.sort_by(|a, b| {
        b.full_pass
            .cmp(&a.full_pass)
            .then_with(|| b.global_detect_rate.total_cmp(&a.global_detect_rate))
            .then_with(|| b.realtime_factor.total_cmp(&a.realtime_factor))
            .then_with(|| b.global_in_tune_rate.total_cmp(&a.global_in_tune_rate))
            .then_with(|| a.id.cmp(&b.id))
    });

    let ranking = candidate_results
        .iter()
        .enumerate()
        .map(|(index, item)| RankingEntry {
            rank: index + 1,
            id: item.id.clone(),
            label: item.label.clone(),
            full_pass: item.full_pass,
            global_detect_rate: item.global_detect_rate,
            global_in_tune_rate: item.global_in_tune_rate,
            realtime_factor: item.realtime_factor,
            cpu_ms_per_audio_s: item.cpu_ms_per_audio_s,
        })
        .collect::<Vec<_>>();

    Ok(BenchmarkRunResult {
        dataset_path: dataset_path.to_string_lossy().to_string(),
        candidates_path: candidates_path.to_string_lossy().to_string(),
        gates_path: gates_path.to_string_lossy().to_string(),
        metadata,
        gates: gates_cfg,
        ranking,
        candidates: candidate_results,
    })
}

fn load_manifest_events(path: &Path) -> Result<Vec<crate::types::ManifestEvent>> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read manifest {:?}", path))?;
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("jams"))
        .unwrap_or(false)
    {
        return parse_jams_events(&raw, path);
    }

    if let Ok(manifest) = serde_json::from_str::<ManifestFile>(&raw) {
        if manifest.events.is_empty() {
            anyhow::bail!("manifest {:?} has no events", path);
        }
        return Ok(manifest.events);
    }

    // Fallback: accept JAMS content even when extension is not .jams.
    if let Ok(events) = parse_jams_events(&raw, path) {
        return Ok(events);
    }

    anyhow::bail!(
        "failed to parse manifest {:?} as benchmark JSON or JAMS",
        path
    )
}

fn parse_jams_events(raw: &str, path: &Path) -> Result<Vec<crate::types::ManifestEvent>> {
    let root: Value =
        serde_json::from_str(raw).with_context(|| format!("failed to parse JAMS {:?}", path))?;
    let annotations = root
        .get("annotations")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("JAMS {:?} missing annotations array", path))?;

    let mut events = Vec::<crate::types::ManifestEvent>::new();
    for annotation in annotations {
        let namespace = annotation
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if namespace != "note_midi" {
            continue;
        }
        let data_source = annotation
            .get("annotation_metadata")
            .and_then(|meta| meta.get("data_source"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let observations = annotation
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("JAMS {:?} note_midi entry has invalid data", path))?;
        for observation in observations {
            let start_s = observation
                .get("time")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);
            let duration_s = observation
                .get("duration")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);
            let end_s = (start_s + duration_s).max(start_s);
            let midi_value = observation
                .get("value")
                .and_then(Value::as_f64)
                .ok_or_else(|| anyhow::anyhow!("JAMS {:?} note_midi value missing", path))?
                as f32;
            if !midi_value.is_finite() || duration_s <= 0.0 {
                continue;
            }

            let note_label = midi_label(midi_value);
            events.push(crate::types::ManifestEvent {
                note_order: 0,
                note: Some(note_label),
                midi: midi_value,
                start_s,
                end_s,
                string: data_source.clone(),
                fret: None,
                chord_id: None,
                member_note_ids: Vec::new(),
                member_midis: Vec::new(),
            });
        }
    }

    if events.is_empty() {
        anyhow::bail!("JAMS {:?} has no note_midi events", path);
    }

    events.sort_by(|a, b| {
        a.start_s
            .total_cmp(&b.start_s)
            .then_with(|| a.end_s.total_cmp(&b.end_s))
            .then_with(|| a.midi.total_cmp(&b.midi))
    });
    for (index, event) in events.iter_mut().enumerate() {
        event.note_order = index as i32 + 1;
    }
    Ok(events)
}

fn midi_label(midi_value: f32) -> String {
    if !midi_value.is_finite() {
        return "midi_nan".to_owned();
    }
    let rounded = midi_value.round();
    if (midi_value - rounded).abs() <= 0.35 {
        let midi = rounded as i32;
        let names = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        let name = names[midi.rem_euclid(12) as usize];
        let octave = midi / 12 - 1;
        return format!("{name}{octave}");
    }
    format!("midi_{midi_value:.2}")
}

fn run_candidate_on_take(
    candidate: &crate::types::CandidateSpec,
    take: &LoadedTake,
    candidate_model: Option<&CandidateModel>,
) -> Result<(Vec<PitchFrame>, f64)> {
    let window_seconds = candidate.param_f64(
        "window_seconds",
        default_window_seconds(candidate.algorithm),
    );
    let chunk_seconds =
        candidate.param_f64("chunk_seconds", default_chunk_seconds(candidate.algorithm));

    let window_size = ((window_seconds * take.sample_rate as f64).round() as usize).max(128);
    let hop_size = ((chunk_seconds * take.sample_rate as f64).round() as usize).max(16);
    let mut rolling = vec![0.0f32; window_size];
    let mut detector = create_detector(
        candidate,
        window_size,
        candidate_model,
        Some(&take.events),
    )?;
    detector.reset();
    let mut has_filled = false;
    let mut frames = Vec::new();
    let started = Instant::now();

    let mut end = hop_size;
    while end <= take.samples.len() {
        let start = end - hop_size;
        let chunk = &take.samples[start..end];
        if hop_size >= window_size {
            let tail = &chunk[chunk.len() - window_size..];
            rolling.copy_from_slice(tail);
            has_filled = true;
        } else {
            rolling.copy_within(hop_size.., 0);
            rolling[window_size - hop_size..].copy_from_slice(chunk);
            if end >= window_size {
                has_filled = true;
            }
        }
        if has_filled {
            let chunk_rms = compute_rms(chunk);
            let t_seconds = end as f64 / take.sample_rate as f64;
            frames.push(detector.process_window(&rolling, chunk_rms, take.sample_rate, t_seconds));
        }
        end += hop_size;
    }

    let runtime_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok((frames, runtime_ms))
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

fn default_window_seconds(algorithm: crate::types::AlgorithmKind) -> f64 {
    match algorithm {
        crate::types::AlgorithmKind::Yin => 0.2040816327,
        crate::types::AlgorithmKind::Autocorr => 0.0464399093,
        crate::types::AlgorithmKind::Mpm => 0.065,
        crate::types::AlgorithmKind::Hybrid => 0.093,
        crate::types::AlgorithmKind::Sac => 0.093,
        crate::types::AlgorithmKind::SpectralHarmonic => 0.093,
    }
}

fn default_chunk_seconds(algorithm: crate::types::AlgorithmKind) -> f64 {
    match algorithm {
        crate::types::AlgorithmKind::Yin => 1.0 / 15.0,
        crate::types::AlgorithmKind::Autocorr => 0.0232199546,
        crate::types::AlgorithmKind::Mpm => 0.0232199546,
        crate::types::AlgorithmKind::Hybrid => 0.0232199546,
        crate::types::AlgorithmKind::Sac => 0.0232199546,
        crate::types::AlgorithmKind::SpectralHarmonic => 0.0232199546,
    }
}

fn load_candidate_model(
    dataset_path: &Path,
    raw_path: Option<&str>,
) -> Result<Option<CandidateModel>> {
    let Some(path) = raw_path else {
        return Ok(None);
    };
    let resolved = resolve_from_config_dir(dataset_path, path);
    let model = load_candidate_model_config(&resolved)?;
    Ok(Some(model))
}

fn requires_candidate_model(algorithm: AlgorithmKind) -> bool {
    matches!(
        algorithm,
        AlgorithmKind::Sac | AlgorithmKind::SpectralHarmonic
    )
}

fn decode_wav_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let mut reader =
        WavReader::open(path).with_context(|| format!("failed to open wav {:?}", path))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate;
    let mut mono = Vec::<f32>::new();
    let mut frame_sum = 0.0f64;
    let mut channel_idx = 0usize;

    match spec.sample_format {
        SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                let value =
                    sample.with_context(|| format!("invalid float sample in {:?}", path))?;
                frame_sum += value as f64;
                channel_idx += 1;
                if channel_idx == channels {
                    mono.push((frame_sum / channels as f64) as f32);
                    frame_sum = 0.0;
                    channel_idx = 0;
                }
            }
        }
        SampleFormat::Int => {
            let max_int =
                ((1i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) - 1).max(1) as f64;
            for sample in reader.samples::<i32>() {
                let value = sample.with_context(|| format!("invalid int sample in {:?}", path))?;
                frame_sum += value as f64 / max_int;
                channel_idx += 1;
                if channel_idx == channels {
                    mono.push((frame_sum / channels as f64) as f32);
                    frame_sum = 0.0;
                    channel_idx = 0;
                }
            }
        }
    }

    Ok((mono, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AlgorithmKind, CandidateListConfig, CandidateSpec, SourceMeta};
    use std::collections::BTreeMap;
    use std::f32::consts::TAU;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn ranking_prioritizes_full_pass() {
        let a = CandidateRunResult {
            id: "a".to_owned(),
            label: "A".to_owned(),
            algorithm: AlgorithmKind::Autocorr,
            params: BTreeMap::new(),
            source: SourceMeta::default(),
            take_metrics: vec![],
            strict_matrix: vec![],
            global_detect_rate: 0.95,
            global_in_tune_rate: 0.90,
            runtime_ms_total: 1.0,
            analyzed_duration_s_total: 1.0,
            cpu_ms_per_audio_s: 1.0,
            realtime_factor: 20.0,
            pass_realtime: true,
            full_pass: false,
            frame_traces: None,
        };
        let mut b = a.clone();
        b.id = "b".to_owned();
        b.full_pass = true;
        let mut rows = vec![a, b];
        rows.sort_by(|x, y| {
            y.full_pass
                .cmp(&x.full_pass)
                .then_with(|| y.global_detect_rate.total_cmp(&x.global_detect_rate))
                .then_with(|| y.realtime_factor.total_cmp(&x.realtime_factor))
                .then_with(|| y.global_in_tune_rate.total_cmp(&x.global_in_tune_rate))
                .then_with(|| x.id.cmp(&y.id))
        });
        assert_eq!(rows[0].id, "b");
    }

    #[test]
    fn candidate_config_roundtrip_toml() {
        let cfg = CandidateListConfig {
            candidates: vec![CandidateSpec {
                id: "test".to_owned(),
                label: Some("Test".to_owned()),
                algorithm: AlgorithmKind::Yin,
                params: BTreeMap::new(),
                source: SourceMeta::default(),
            }],
        };
        let toml_raw = toml::to_string(&cfg).expect("serialize");
        let parsed: CandidateListConfig = toml::from_str(&toml_raw).expect("parse");
        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].id, "test");
    }

    #[test]
    fn sac_run_emits_frame_traces_and_runtime_fields() {
        let temp_root = create_temp_test_dir("sac_bench");
        let wav_path = temp_root.join("take.wav");
        let manifest_path = temp_root.join("manifest.json");
        let dataset_path = temp_root.join("dataset.toml");
        let candidates_path = temp_root.join("candidates.toml");
        let gates_path = temp_root.join("gates.toml");
        let candidate_model_path = temp_root.join("candidate-model.toml");

        write_sine_wav(&wav_path, 220.0, 44_100, 0.8);
        fs::write(
            &manifest_path,
            r#"{"events":[{"note_order":1,"note":"A3","midi":57.0,"start_s":0.0,"end_s":0.75,"string":3,"fret":2}]}"#,
        )
        .expect("write manifest");
        fs::write(
            &dataset_path,
            r#"candidate_model = "candidate-model.toml"

[[takes]]
id = "t1"
manifest = "manifest.json"
wav = "take.wav"
"#,
        )
        .expect("write dataset");
        fs::write(
            &candidate_model_path,
            r#"[[notes]]
id = "a3"
string = 3
fret = 2
midi = 57.0
frequency_hz = 220.0

[[notes]]
id = "e4"
string = 1
fret = 0
midi = 64.0
frequency_hz = 329.627556
"#,
        )
        .expect("write candidate model");
        fs::write(
            &candidates_path,
            r#"[[candidates]]
id = "sac_test"
label = "SAC test"
algorithm = "sac"
[candidates.params]
window_seconds = 0.093
chunk_seconds = 0.0232199546
harmonic_count = 6.0
emit_frame_traces = 1.0
min_rms = 0.0001
"#,
        )
        .expect("write candidates");
        fs::write(
            &gates_path,
            r#"min_confidence = 0.0
required_detect_rate = 0.0
min_realtime_factor = 0.0
adaptive_trim = false
"#,
        )
        .expect("write gates");

        let result = run_benchmark(
            &dataset_path,
            &candidates_path,
            &gates_path,
            RunMetadata {
                generated_at_utc: "test".to_owned(),
                command_line: vec!["test".to_owned()],
                git_commit: None,
                rustc_version: None,
                cargo_version: None,
            },
        )
        .expect("run benchmark");

        assert_eq!(result.candidates.len(), 1);
        let row = &result.candidates[0];
        assert!(row.runtime_ms_total >= 0.0);
        assert!(row.cpu_ms_per_audio_s >= 0.0);
        let traces = row.frame_traces.as_ref().expect("frame traces");
        assert!(!traces.is_empty());
        assert!(!traces[0].frames.is_empty());
        assert!(!traces[0].frames[0].note_scores.is_empty());

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn jams_manifest_is_parsed_into_events() {
        let temp_root = create_temp_test_dir("jams_parse");
        let jams_path = temp_root.join("example.jams");
        fs::write(
            &jams_path,
            r#"{
  "annotations": [
    {
      "namespace": "note_midi",
      "annotation_metadata": {"data_source": "0"},
      "data": [
        {"time": 0.10, "duration": 0.30, "value": 45.0, "confidence": null},
        {"time": 0.50, "duration": 0.20, "value": 52.1, "confidence": null}
      ]
    }
  ],
  "file_metadata": {"duration": 1.0}
}"#,
        )
        .expect("write jams");

        let events = load_manifest_events(&jams_path).expect("parse jams");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].note_order, 1);
        assert_eq!(events[0].midi, 45.0);
        assert!((events[0].start_s - 0.10).abs() < 1e-6);
        assert!((events[0].end_s - 0.40).abs() < 1e-6);
        assert_eq!(events[0].string.as_deref(), Some("0"));
        assert!(events[1].note.as_ref().is_some());

        let _ = fs::remove_dir_all(temp_root);
    }

    fn create_temp_test_dir(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("duration")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{}_{}", prefix, stamp));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_sine_wav(path: &Path, freq_hz: f32, sample_rate: u32, seconds: f32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        let length = (sample_rate as f32 * seconds) as usize;
        for i in 0..length {
            let t = i as f32 / sample_rate as f32;
            let sample = (TAU * freq_hz * t).sin() * 0.5;
            let q = (sample * i16::MAX as f32).round() as i16;
            writer.write_sample(q).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }
}
