use std::{fs, path::PathBuf};

use clap::{Parser, ValueEnum};
use fretnet_runtime::audio::resample_kaiser_best;
use native_pitch_runtime::{
    current_runtime_init_stage,
    host_harness::{
        benchmark_with_config, run_with_config, HostBenchmarkConfig, HostBenchmarkResult,
        HostExecutionMode, HostFramePrediction, HostRunConfig, HostRunResult,
    },
    resolve_default_fretnet_model_path, PyinConfig, PyinPadModeConfig, RuntimeConfig,
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliMode {
    Offline,
    Streaming,
    Both,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliFormat {
    Json,
    Csv,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliPyinPadMode {
    Constant,
    Reflect,
}

#[derive(Debug, Parser)]
#[command(
    name = "fretnet_host_cli",
    about = "Host-side harness for native_pitch_runtime (offline + streaming simulation)."
)]
struct Args {
    #[arg(long)]
    audio_path: PathBuf,
    #[arg(long, default_value = "fretnet")]
    backend: String,
    #[arg(long)]
    model_path: Option<PathBuf>,
    #[arg(long)]
    spectral_model_json: Option<PathBuf>,
    #[arg(long)]
    masp_assets_dir: Option<PathBuf>,
    #[arg(long)]
    fretnet_ort_library_path: Option<PathBuf>,
    #[arg(long, default_value_t = 1024)]
    block_size: usize,
    #[arg(long)]
    callback_size: Option<usize>,
    #[arg(long)]
    sample_rate: Option<u32>,
    #[arg(long, value_enum, default_value_t = CliMode::Streaming)]
    mode: CliMode,
    #[arg(long, value_enum, default_value_t = CliFormat::Json)]
    format: CliFormat,
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long, default_value_t = 0)]
    warmup_iterations: usize,
    #[arg(long, default_value_t = 0)]
    benchmark_iterations: usize,
    #[arg(long, default_value = "speaker")]
    audio_input_mode: String,
    #[arg(long)]
    pyin_fmin_hz: Option<f64>,
    #[arg(long)]
    pyin_fmax_hz: Option<f64>,
    #[arg(long)]
    pyin_frame_length: Option<usize>,
    #[arg(long)]
    pyin_win_length: Option<usize>,
    #[arg(long)]
    pyin_hop_length: Option<usize>,
    #[arg(long)]
    pyin_resolution: Option<f64>,
    #[arg(long)]
    pyin_fill_unvoiced: Option<f64>,
    #[arg(long)]
    pyin_center: bool,
    #[arg(long, value_enum)]
    pyin_pad_mode: Option<CliPyinPadMode>,
    #[arg(long)]
    no_flush_tail: bool,
    #[arg(long)]
    verbose: bool,
}

#[derive(Debug, Serialize)]
struct CliAudioSummary {
    audio_path: String,
    input_sample_rate: u32,
    runtime_sample_rate: u32,
    input_samples: usize,
    runtime_samples: usize,
    input_duration_sec: f64,
    runtime_duration_sec: f64,
    resampled: bool,
}

#[derive(Debug, Serialize)]
struct CliNoteEvent {
    mode: HostExecutionMode,
    process_index: usize,
    capture_time_sec: f64,
    note_id: Option<String>,
    midi: f32,
    string: Option<u32>,
    fret: Option<u32>,
    score: Option<f32>,
}

#[derive(Debug, Serialize)]
struct CliRunReport {
    mode: HostExecutionMode,
    run: HostRunResult,
    note_events: Vec<CliNoteEvent>,
}

#[derive(Debug, Serialize)]
struct CliBenchmarkReport {
    mode: HostExecutionMode,
    benchmark: HostBenchmarkResult,
}

#[derive(Debug, Serialize)]
struct CliReport {
    backend: String,
    init_stage: String,
    runtime_config: RuntimeConfig,
    audio: CliAudioSummary,
    runs: Vec<CliRunReport>,
    benchmark: Vec<CliBenchmarkReport>,
    warnings: Vec<String>,
}

fn main() -> Result<(), String> {
    let args = Args::parse();
    if matches!(args.format, CliFormat::Csv) && args.benchmark_iterations > 0 {
        return Err(
            "--format csv does not support benchmark output. Use --format json for benchmarks."
                .to_owned(),
        );
    }

    let loaded_audio = fretnet_runtime::load_wav_mono(&args.audio_path).map_err(|error| {
        format!(
            "Failed to load WAV '{}': {error}",
            args.audio_path.display()
        )
    })?;
    let runtime_sample_rate = args
        .sample_rate
        .unwrap_or(loaded_audio.sample_rate)
        .max(8_000);
    let runtime_samples = if loaded_audio.sample_rate == runtime_sample_rate {
        loaded_audio.samples.clone()
    } else {
        resample_kaiser_best(
            &loaded_audio.samples,
            loaded_audio.sample_rate,
            runtime_sample_rate,
        )
        .map_err(|error| format!("Failed to resample input audio for runtime: {error}"))?
    };

    let mut warnings = Vec::<String>::new();
    let runtime_config = build_runtime_config(&args, runtime_sample_rate, &mut warnings)?;
    let callback_size = args.callback_size.unwrap_or(args.block_size.max(1)).max(1);

    if args.verbose {
        eprintln!(
            "Loaded audio={} input_sr={} runtime_sr={} input_samples={} runtime_samples={}",
            args.audio_path.display(),
            loaded_audio.sample_rate,
            runtime_sample_rate,
            loaded_audio.samples.len(),
            runtime_samples.len()
        );
        eprintln!(
            "Runtime backend={} block_size={} callback_size={} mode={:?}",
            runtime_config.backend_name, args.block_size, callback_size, args.mode
        );
    }

    let modes = cli_modes(args.mode);
    let mut runs = Vec::<CliRunReport>::new();
    for mode in &modes {
        let run_cfg = HostRunConfig {
            mode: *mode,
            block_size: args.block_size.max(1),
            callback_size,
            flush_tail: !args.no_flush_tail,
            capture_start_time_sec: 0.0,
        };
        let run = run_with_config(
            &runtime_config,
            &runtime_samples,
            runtime_sample_rate,
            &run_cfg,
        )?;
        let note_events = collect_note_events(*mode, &run.frames);
        runs.push(CliRunReport {
            mode: *mode,
            run,
            note_events,
        });
    }

    let mut benchmark = Vec::<CliBenchmarkReport>::new();
    if args.benchmark_iterations > 0 {
        let benchmark_cfg = HostBenchmarkConfig {
            warmup_iterations: args.warmup_iterations,
            measured_iterations: args.benchmark_iterations,
        };
        for mode in &modes {
            let run_cfg = HostRunConfig {
                mode: *mode,
                block_size: args.block_size.max(1),
                callback_size,
                flush_tail: !args.no_flush_tail,
                capture_start_time_sec: 0.0,
            };
            let result = benchmark_with_config(
                &runtime_config,
                &runtime_samples,
                runtime_sample_rate,
                &run_cfg,
                &benchmark_cfg,
            )?;
            benchmark.push(CliBenchmarkReport {
                mode: *mode,
                benchmark: result,
            });
        }
    }

    let report = CliReport {
        backend: runtime_config.backend_name.clone(),
        init_stage: current_runtime_init_stage(),
        runtime_config,
        audio: CliAudioSummary {
            audio_path: args.audio_path.display().to_string(),
            input_sample_rate: loaded_audio.sample_rate,
            runtime_sample_rate,
            input_samples: loaded_audio.samples.len(),
            runtime_samples: runtime_samples.len(),
            input_duration_sec: loaded_audio.samples.len() as f64 / loaded_audio.sample_rate as f64,
            runtime_duration_sec: runtime_samples.len() as f64 / runtime_sample_rate as f64,
            resampled: loaded_audio.sample_rate != runtime_sample_rate,
        },
        runs,
        benchmark,
        warnings,
    };

    let rendered = match args.format {
        CliFormat::Json => serde_json::to_string_pretty(&report)
            .map_err(|error| format!("Failed to serialize JSON report: {error}"))?,
        CliFormat::Csv => render_csv(&report)?,
    };

    if let Some(path) = args.output.as_ref() {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Failed to create output directory '{}': {error}",
                        parent.display()
                    )
                })?;
            }
        }
        fs::write(path, rendered.as_bytes())
            .map_err(|error| format!("Failed to write output '{}': {error}", path.display()))?;
    } else {
        println!("{rendered}");
    }

    Ok(())
}

fn build_runtime_config(
    args: &Args,
    runtime_sample_rate: u32,
    warnings: &mut Vec<String>,
) -> Result<RuntimeConfig, String> {
    let backend = args.backend.trim().to_lowercase();
    let fretnet_model_path = if backend == "fretnet" {
        if let Some(model_path) = args.model_path.as_ref() {
            Some(model_path.display().to_string())
        } else if let Some(default_model) = resolve_default_fretnet_model_path() {
            warnings.push(format!(
                "Using default FRETNET model path '{}'.",
                default_model.display()
            ));
            Some(default_model.display().to_string())
        } else {
            return Err(
                "FRETNET backend requires --model-path (no default model found).".to_owned(),
            );
        }
    } else {
        args.model_path
            .as_ref()
            .map(|path| path.display().to_string())
    };

    let backend_name = backend;
    let pyin = build_pyin_config(args, backend_name.as_str());

    Ok(RuntimeConfig {
        backend_name,
        sample_rate: runtime_sample_rate,
        block_size: args.block_size.max(1),
        spectral_model_json: args
            .spectral_model_json
            .as_ref()
            .map(|path| path.display().to_string()),
        audio_input_mode: Some(args.audio_input_mode.trim().to_owned()),
        masp_assets_dir: args
            .masp_assets_dir
            .as_ref()
            .map(|path| path.display().to_string()),
        fretnet_model_path,
        fretnet_ort_library_path: args
            .fretnet_ort_library_path
            .as_ref()
            .map(|path| path.display().to_string()),
        max_capture_buffer_seconds: None,
        pyin,
    })
}

fn build_pyin_config(args: &Args, backend_name: &str) -> Option<PyinConfig> {
    if backend_name != "pyin" {
        return None;
    }
    let mut pyin = PyinConfig::default();
    let mut touched = false;
    if let Some(value) = args.pyin_fmin_hz {
        pyin.fmin_hz = value;
        touched = true;
    }
    if let Some(value) = args.pyin_fmax_hz {
        pyin.fmax_hz = value;
        touched = true;
    }
    if let Some(value) = args.pyin_frame_length {
        pyin.frame_length = Some(value);
        touched = true;
    }
    if let Some(value) = args.pyin_win_length {
        pyin.win_length = Some(value);
        touched = true;
    }
    if let Some(value) = args.pyin_hop_length {
        pyin.hop_length = Some(value);
        touched = true;
    }
    if let Some(value) = args.pyin_resolution {
        pyin.resolution = Some(value);
        touched = true;
    }
    if let Some(value) = args.pyin_fill_unvoiced {
        pyin.fill_unvoiced = Some(value);
        touched = true;
    }
    if args.pyin_center {
        pyin.center = true;
        touched = true;
    }
    if let Some(value) = args.pyin_pad_mode {
        pyin.pad_mode = match value {
            CliPyinPadMode::Constant => PyinPadModeConfig::Constant,
            CliPyinPadMode::Reflect => PyinPadModeConfig::Reflect,
        };
        touched = true;
    }

    if touched {
        Some(pyin)
    } else {
        None
    }
}

fn collect_note_events(
    mode: HostExecutionMode,
    frames: &[HostFramePrediction],
) -> Vec<CliNoteEvent> {
    let mut out = Vec::new();
    for frame in frames {
        for note in &frame.event.selected_notes {
            out.push(CliNoteEvent {
                mode,
                process_index: frame.process_index,
                capture_time_sec: frame.capture_time_sec,
                note_id: note.note_id.clone(),
                midi: note.midi,
                string: note.string,
                fret: note.fret,
                score: note.score,
            });
        }
    }
    out
}

fn cli_modes(mode: CliMode) -> Vec<HostExecutionMode> {
    match mode {
        CliMode::Offline => vec![HostExecutionMode::Offline],
        CliMode::Streaming => vec![HostExecutionMode::Streaming],
        CliMode::Both => vec![HostExecutionMode::Offline, HostExecutionMode::Streaming],
    }
}

fn render_csv(report: &CliReport) -> Result<String, String> {
    let mut out = String::new();
    out.push_str(
        "mode,process_index,callback_index,capture_time_sec,submitted_samples,backend_name,midi_estimate,pitch_hz,confidence,detected_string,detected_fret,best_note_id,selected_notes_json\n",
    );
    for run in &report.runs {
        for frame in &run.run.frames {
            let selected_notes_json = serde_json::to_string(&frame.event.selected_notes)
                .map_err(|error| format!("Failed to serialize selected_notes for CSV: {error}"))?;
            out.push_str(&format!(
                "{},{},{},{:.9},{},{},{},{},{},{},{},{},{}\n",
                mode_label(run.mode),
                frame.process_index,
                frame.callback_index.unwrap_or(0),
                frame.capture_time_sec,
                frame.submitted_samples,
                csv_escape(&frame.event.backend_name),
                opt_f32(frame.event.midi_estimate),
                opt_f32(frame.event.pitch_hz),
                frame.event.confidence,
                opt_u32(frame.event.detected_string),
                opt_u32(frame.event.detected_fret),
                csv_escape_opt(frame.event.best_note_id.as_deref()),
                csv_escape(&selected_notes_json),
            ));
        }
    }
    Ok(out)
}

fn mode_label(mode: HostExecutionMode) -> &'static str {
    match mode {
        HostExecutionMode::Offline => "offline",
        HostExecutionMode::Streaming => "streaming",
    }
}

fn opt_f32(value: Option<f32>) -> String {
    value
        .map(|item| format!("{item:.9}"))
        .unwrap_or_else(|| "".to_owned())
}

fn opt_u32(value: Option<u32>) -> String {
    value
        .map(|item| item.to_string())
        .unwrap_or_else(|| "".to_owned())
}

fn csv_escape_opt(value: Option<&str>) -> String {
    csv_escape(value.unwrap_or(""))
}

fn csv_escape(value: &str) -> String {
    let escaped = value.replace('"', "\"\"");
    format!("\"{escaped}\"")
}
