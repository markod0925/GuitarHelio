use native_pitch_runtime::{
    host_harness::{
        benchmark_with_config, run_with_config, HostBenchmarkConfig, HostExecutionMode,
        HostRunConfig,
    },
    resolve_default_fretnet_model_path, RuntimeConfig,
};
use serde_json::json;

fn synthetic_audio(sample_rate: u32, sample_count: usize, frequency_hz: f32) -> Vec<f32> {
    let mut out = Vec::with_capacity(sample_count);
    let dt = 1.0_f32 / sample_rate as f32;
    for index in 0..sample_count {
        let t = index as f32 * dt;
        out.push((2.0 * std::f32::consts::PI * frequency_hz * t).sin() * 0.3);
    }
    out
}

fn normalize_frames(
    frames: &[native_pitch_runtime::host_harness::HostFramePrediction],
) -> serde_json::Value {
    let payload = frames
        .iter()
        .map(|frame| {
            let selected_notes = frame
                .event
                .selected_notes
                .iter()
                .map(|note| {
                    json!({
                        "note_id": note.note_id,
                        "midi": round6(note.midi),
                        "string": note.string,
                        "fret": note.fret,
                        "score": note.score.map(round6),
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "process_index": frame.process_index,
                "capture_time_sec": round6(frame.capture_time_sec as f32),
                "submitted_samples": frame.submitted_samples,
                "backend_name": frame.event.backend_name,
                "midi_estimate": frame.event.midi_estimate.map(round6),
                "pitch_hz": frame.event.pitch_hz.map(round6),
                "confidence": round6(frame.event.confidence),
                "detected_string": frame.event.detected_string,
                "detected_fret": frame.event.detected_fret,
                "best_note_id": frame.event.best_note_id,
                "selected_notes": selected_notes,
            })
        })
        .collect::<Vec<_>>();
    serde_json::Value::Array(payload)
}

fn round6(value: f32) -> f32 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn ac14_runtime_config(sample_rate: u32, block_size: usize) -> RuntimeConfig {
    RuntimeConfig {
        backend_name: "ac14".to_owned(),
        sample_rate,
        block_size,
        spectral_model_json: None,
        audio_input_mode: Some("speaker".to_owned()),
        masp_assets_dir: None,
        fretnet_model_path: None,
        fretnet_ort_library_path: None,
        max_capture_buffer_seconds: None,
    }
}

#[test]
fn host_harness_streaming_is_deterministic_for_same_input() {
    let sample_rate = 44_100_u32;
    let block_size = 1024_usize;
    let audio = synthetic_audio(sample_rate, block_size * 64, 110.0);
    let runtime_cfg = ac14_runtime_config(sample_rate, block_size);
    let run_cfg = HostRunConfig {
        mode: HostExecutionMode::Streaming,
        block_size,
        callback_size: 256,
        flush_tail: true,
        capture_start_time_sec: 0.0,
    };

    let run_a = run_with_config(&runtime_cfg, &audio, sample_rate, &run_cfg).expect("run A");
    let run_b = run_with_config(&runtime_cfg, &audio, sample_rate, &run_cfg).expect("run B");
    assert_eq!(
        normalize_frames(&run_a.frames),
        normalize_frames(&run_b.frames)
    );
}

#[test]
fn host_harness_offline_matches_streaming_when_callback_aligns_to_blocks() {
    let sample_rate = 44_100_u32;
    let block_size = 1024_usize;
    let audio = synthetic_audio(sample_rate, block_size * 80, 196.0);
    let runtime_cfg = ac14_runtime_config(sample_rate, block_size);

    let offline = run_with_config(
        &runtime_cfg,
        &audio,
        sample_rate,
        &HostRunConfig {
            mode: HostExecutionMode::Offline,
            block_size,
            callback_size: block_size,
            flush_tail: true,
            capture_start_time_sec: 0.0,
        },
    )
    .expect("offline run");
    let streaming = run_with_config(
        &runtime_cfg,
        &audio,
        sample_rate,
        &HostRunConfig {
            mode: HostExecutionMode::Streaming,
            block_size,
            callback_size: block_size / 4,
            flush_tail: true,
            capture_start_time_sec: 0.0,
        },
    )
    .expect("streaming run");

    assert_eq!(
        normalize_frames(&offline.frames),
        normalize_frames(&streaming.frames)
    );
}

#[test]
fn host_harness_benchmark_reports_iterations() {
    let sample_rate = 44_100_u32;
    let block_size = 1024_usize;
    let audio = synthetic_audio(sample_rate, block_size * 32, 82.41);
    let runtime_cfg = ac14_runtime_config(sample_rate, block_size);
    let run_cfg = HostRunConfig {
        mode: HostExecutionMode::Streaming,
        block_size,
        callback_size: 256,
        flush_tail: true,
        capture_start_time_sec: 0.0,
    };
    let benchmark = benchmark_with_config(
        &runtime_cfg,
        &audio,
        sample_rate,
        &run_cfg,
        &HostBenchmarkConfig {
            warmup_iterations: 1,
            measured_iterations: 2,
        },
    )
    .expect("benchmark run");

    assert_eq!(benchmark.warmup_iterations, 1);
    assert_eq!(benchmark.measured_iterations, 2);
    assert_eq!(benchmark.iterations.len(), 2);
    assert!(benchmark.mean_wall_time_ms >= 0.0);
}

#[test]
fn fretnet_streaming_repeatability_when_model_is_available() {
    let Some(model_path) = resolve_default_fretnet_model_path() else {
        eprintln!("skipping fretnet repeatability test because no model was found");
        return;
    };

    let sample_rate = 44_100_u32;
    let block_size = 1024_usize;
    let audio = synthetic_audio(sample_rate, block_size * 96, 146.83);
    let runtime_cfg = RuntimeConfig {
        backend_name: "fretnet".to_owned(),
        sample_rate,
        block_size,
        spectral_model_json: None,
        audio_input_mode: Some("speaker".to_owned()),
        masp_assets_dir: None,
        fretnet_model_path: Some(model_path.display().to_string()),
        fretnet_ort_library_path: None,
        max_capture_buffer_seconds: None,
    };
    let run_cfg = HostRunConfig {
        mode: HostExecutionMode::Streaming,
        block_size,
        callback_size: 256,
        flush_tail: true,
        capture_start_time_sec: 0.0,
    };

    let run_a = run_with_config(&runtime_cfg, &audio, sample_rate, &run_cfg).expect("run A");
    let run_b = run_with_config(&runtime_cfg, &audio, sample_rate, &run_cfg).expect("run B");
    assert_eq!(
        normalize_frames(&run_a.frames),
        normalize_frames(&run_b.frames)
    );
}

#[test]
fn fretnet_streaming_tolerates_leading_silence_when_model_is_available() {
    let Some(model_path) = resolve_default_fretnet_model_path() else {
        eprintln!("skipping fretnet leading-silence test because no model was found");
        return;
    };

    let sample_rate = 44_100_u32;
    let block_size = 1024_usize;
    let mut audio = vec![0.0_f32; sample_rate as usize];
    audio.extend(synthetic_audio(sample_rate, block_size * 64, 164.81));
    let runtime_cfg = RuntimeConfig {
        backend_name: "fretnet".to_owned(),
        sample_rate,
        block_size,
        spectral_model_json: None,
        audio_input_mode: Some("speaker".to_owned()),
        masp_assets_dir: None,
        fretnet_model_path: Some(model_path.display().to_string()),
        fretnet_ort_library_path: None,
        max_capture_buffer_seconds: None,
    };
    let run_cfg = HostRunConfig {
        mode: HostExecutionMode::Streaming,
        block_size,
        callback_size: 256,
        flush_tail: true,
        capture_start_time_sec: 0.0,
    };

    let run = run_with_config(&runtime_cfg, &audio, sample_rate, &run_cfg)
        .expect("run must not fail on leading silence");
    assert!(run.summary.runtime_call_count > 0);
}
