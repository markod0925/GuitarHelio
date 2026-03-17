use anyhow::{Context, Result};
use clap::Parser;
use pitch_core::config::write_candidates_config;
use pitch_core::{run_benchmark, AlgorithmKind, CandidateSpec, RunMetadata, SourceMeta};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Parser)]
#[command(about = "Run Rust pitch detector benchmarks on paired manifests/WAV takes.")]
struct Args {
    #[arg(long, default_value = "config/dataset.toml")]
    dataset: PathBuf,
    #[arg(long, default_value = "config/candidates.baseline.toml")]
    candidates: PathBuf,
    #[arg(long, default_value = "config/gates.toml")]
    gates: PathBuf,
    #[arg(long, default_value = "output/bench-results.json")]
    out: PathBuf,

    #[arg(long, default_value_t = false)]
    spectral_grid: bool,
    #[arg(long)]
    grid_candidates_out: Option<PathBuf>,
    #[arg(long, default_value_t = 384)]
    grid_max_candidates: usize,
    #[arg(long, value_delimiter = ',', default_value = "0.0928798186")]
    grid_window_seconds: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0.0116099773")]
    grid_chunk_seconds: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "4096")]
    grid_fft_size: Vec<u32>,
    #[arg(long, value_delimiter = ',', default_value = "75")]
    grid_min_freq_hz: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "4000,5000")]
    grid_max_harmonic_freq_hz: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "6,8")]
    grid_max_harmonics: Vec<u32>,
    #[arg(long, value_delimiter = ',', default_value = "18")]
    grid_base_bandwidth_hz: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0.015")]
    grid_relative_bandwidth: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0.5,0.75,1.0")]
    grid_magnitude_compression_gamma: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0")]
    grid_use_log_magnitude: Vec<u8>,
    #[arg(long, value_delimiter = ',', default_value = "0,1")]
    grid_use_local_whitening: Vec<u8>,
    #[arg(long, value_delimiter = ',', default_value = "8")]
    grid_whitening_radius_bins: Vec<u32>,
    #[arg(long, value_delimiter = ',', default_value = "0,1")]
    grid_use_harmonic_penalty: Vec<u8>,
    #[arg(long, value_delimiter = ',', default_value = "0.2,0.35")]
    grid_subharmonic_penalty_alpha: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "1")]
    grid_normalize_by_weight_sum: Vec<u8>,
    #[arg(long, value_delimiter = ',', default_value = "0")]
    grid_normalize_by_band_energy: Vec<u8>,
    #[arg(long, value_delimiter = ',', default_value = "1")]
    grid_dc_remove: Vec<u8>,
    #[arg(long, value_delimiter = ',', default_value = "0.0008")]
    grid_min_rms: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0.7")]
    grid_confidence_contrast_weight: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0.3")]
    grid_confidence_energy_weight: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "1.0,1.6")]
    grid_confidence_gain: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0.0,0.15")]
    grid_confidence_bias: Vec<f64>,
    #[arg(long, value_delimiter = ',', default_value = "0")]
    grid_emit_frame_traces: Vec<u8>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let metadata = build_metadata(std::env::args().collect());

    let candidates_path = if args.spectral_grid {
        let generated = build_spectral_grid_candidates(&args)?;
        let path = args.grid_candidates_out.clone().unwrap_or_else(|| {
            args.out
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("generated-candidates.spectral-grid.toml")
        });
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("failed to create {:?}", parent))?;
        }
        write_candidates_config(&path, &generated)?;
        println!(
            "Generated spectral grid candidates: {} (saved to {})",
            generated.len(),
            path.display()
        );
        path
    } else {
        args.candidates.clone()
    };

    let result = run_benchmark(&args.dataset, &candidates_path, &args.gates, metadata)?;

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent).with_context(|| format!("failed to create {:?}", parent))?;
    }
    fs::write(
        &args.out,
        format!("{}\n", serde_json::to_string_pretty(&result)?),
    )
    .with_context(|| format!("failed to write {:?}", args.out))?;

    println!("Ranking:");
    for row in &result.ranking {
        println!(
            "{}. {} | full_pass={} | detect={:.2}% | realtime x{:.2}",
            row.rank,
            row.label,
            row.full_pass,
            row.global_detect_rate * 100.0,
            row.realtime_factor
        );
    }
    if args.spectral_grid {
        println!("Top 5 spectral grid candidates by detect rate:");
        for row in result.ranking.iter().take(5) {
            println!(
                "  {} | detect={:.2}% in_tune={:.2}% rt=x{:.2}",
                row.id,
                row.global_detect_rate * 100.0,
                row.global_in_tune_rate * 100.0,
                row.realtime_factor
            );
        }
    }
    println!("Output: {}", args.out.display());
    Ok(())
}

fn build_spectral_grid_candidates(args: &Args) -> Result<Vec<CandidateSpec>> {
    if args.grid_max_candidates == 0 {
        anyhow::bail!("grid_max_candidates must be greater than 0");
    }

    let window_seconds = dedup_f64(&args.grid_window_seconds);
    let chunk_seconds = dedup_f64(&args.grid_chunk_seconds);
    let fft_size = dedup_u32(&args.grid_fft_size);
    let min_freq_hz = dedup_f64(&args.grid_min_freq_hz);
    let max_harmonic_freq_hz = dedup_f64(&args.grid_max_harmonic_freq_hz);
    let max_harmonics = dedup_u32(&args.grid_max_harmonics);
    let base_bandwidth_hz = dedup_f64(&args.grid_base_bandwidth_hz);
    let relative_bandwidth = dedup_f64(&args.grid_relative_bandwidth);
    let magnitude_compression_gamma = dedup_f64(&args.grid_magnitude_compression_gamma);
    let use_log_magnitude = dedup_bool(&args.grid_use_log_magnitude);
    let use_local_whitening = dedup_bool(&args.grid_use_local_whitening);
    let whitening_radius_bins = dedup_u32(&args.grid_whitening_radius_bins);
    let use_harmonic_penalty = dedup_bool(&args.grid_use_harmonic_penalty);
    let subharmonic_penalty_alpha = dedup_f64(&args.grid_subharmonic_penalty_alpha);
    let normalize_by_weight_sum = dedup_bool(&args.grid_normalize_by_weight_sum);
    let normalize_by_band_energy = dedup_bool(&args.grid_normalize_by_band_energy);
    let dc_remove = dedup_bool(&args.grid_dc_remove);
    let min_rms = dedup_f64(&args.grid_min_rms);
    let confidence_contrast_weight = dedup_f64(&args.grid_confidence_contrast_weight);
    let confidence_energy_weight = dedup_f64(&args.grid_confidence_energy_weight);
    let confidence_gain = dedup_f64(&args.grid_confidence_gain);
    let confidence_bias = dedup_f64(&args.grid_confidence_bias);
    let emit_frame_traces = dedup_bool(&args.grid_emit_frame_traces);

    let mut out = Vec::new();
    let mut idx = 0usize;
    'outer: for value_window_seconds in &window_seconds {
        for value_chunk_seconds in &chunk_seconds {
            for value_fft_size in &fft_size {
                for value_min_freq_hz in &min_freq_hz {
                    for value_max_harmonic_freq_hz in &max_harmonic_freq_hz {
                        for value_max_harmonics in &max_harmonics {
                            for value_base_bandwidth_hz in &base_bandwidth_hz {
                                for value_relative_bandwidth in &relative_bandwidth {
                                    for value_magnitude_gamma in &magnitude_compression_gamma {
                                        for value_use_log in &use_log_magnitude {
                                            for value_use_whitening in &use_local_whitening {
                                                for value_whitening_radius in &whitening_radius_bins
                                                {
                                                    for value_use_penalty in &use_harmonic_penalty {
                                                        for value_penalty_alpha in
                                                            &subharmonic_penalty_alpha
                                                        {
                                                            for value_norm_weight_sum in
                                                                &normalize_by_weight_sum
                                                            {
                                                                for value_norm_band_energy in
                                                                    &normalize_by_band_energy
                                                                {
                                                                    for value_dc_remove in
                                                                        &dc_remove
                                                                    {
                                                                        for value_min_rms in
                                                                            &min_rms
                                                                        {
                                                                            for value_confidence_contrast_weight in
                                                                                &confidence_contrast_weight
                                                                            {
                                                                                for value_confidence_energy_weight in
                                                                                    &confidence_energy_weight
                                                                                {
                                                                                    for value_confidence_gain in
                                                                                        &confidence_gain
                                                                                    {
                                                                                        for value_confidence_bias in
                                                                                            &confidence_bias
                                                                                        {
                                                                                            for value_emit_traces in
                                                                                                &emit_frame_traces
                                                                                            {
                                                                                                idx += 1;
                                                                                                let id = format!(
                                                                                                    "grid_spectral_{idx:04}"
                                                                                                );
                                                                                                let mut params =
                                                                                                    BTreeMap::new();
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "window_seconds",
                                                                                                    *value_window_seconds,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "chunk_seconds",
                                                                                                    *value_chunk_seconds,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "fft_size",
                                                                                                    *value_fft_size
                                                                                                        as f64,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "min_freq_hz",
                                                                                                    *value_min_freq_hz,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "max_harmonic_freq_hz",
                                                                                                    *value_max_harmonic_freq_hz,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "max_harmonics",
                                                                                                    *value_max_harmonics as f64,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "base_bandwidth_hz",
                                                                                                    *value_base_bandwidth_hz,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "relative_bandwidth",
                                                                                                    *value_relative_bandwidth,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "magnitude_compression_gamma",
                                                                                                    *value_magnitude_gamma,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "use_log_magnitude",
                                                                                                    bool_to_f64(*value_use_log),
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "use_local_whitening",
                                                                                                    bool_to_f64(
                                                                                                        *value_use_whitening,
                                                                                                    ),
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "whitening_radius_bins",
                                                                                                    *value_whitening_radius as f64,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "use_harmonic_penalty",
                                                                                                    bool_to_f64(
                                                                                                        *value_use_penalty,
                                                                                                    ),
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "subharmonic_penalty_alpha",
                                                                                                    *value_penalty_alpha,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "normalize_by_weight_sum",
                                                                                                    bool_to_f64(
                                                                                                        *value_norm_weight_sum,
                                                                                                    ),
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "normalize_by_band_energy",
                                                                                                    bool_to_f64(
                                                                                                        *value_norm_band_energy,
                                                                                                    ),
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "dc_remove",
                                                                                                    bool_to_f64(
                                                                                                        *value_dc_remove,
                                                                                                    ),
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "min_rms",
                                                                                                    *value_min_rms,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "confidence_contrast_weight",
                                                                                                    *value_confidence_contrast_weight,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "confidence_energy_weight",
                                                                                                    *value_confidence_energy_weight,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "confidence_gain",
                                                                                                    *value_confidence_gain,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "confidence_bias",
                                                                                                    *value_confidence_bias,
                                                                                                );
                                                                                                insert_param(
                                                                                                    &mut params,
                                                                                                    "emit_frame_traces",
                                                                                                    bool_to_f64(
                                                                                                        *value_emit_traces,
                                                                                                    ),
                                                                                                );

                                                                                                out.push(CandidateSpec {
                                                                                                    id: id.clone(),
                                                                                                    label: Some(format!(
                                                                                                        "Spectral grid #{}",
                                                                                                        idx
                                                                                                    )),
                                                                                                    algorithm:
                                                                                                        AlgorithmKind::SpectralHarmonic,
                                                                                                    params,
                                                                                                    source: SourceMeta {
                                                                                                        kind: "internal".to_owned(),
                                                                                                        reference: Some(
                                                                                                            "Spectral harmonic grid search"
                                                                                                                .to_owned(),
                                                                                                        ),
                                                                                                        source_url: None,
                                                                                                        license: Some("MIT".to_owned()),
                                                                                                        vendored: false,
                                                                                                        notes: Some(format!(
                                                                                                            "Grid-search candidate auto-generated by pitch_bench ({id})"
                                                                                                        )),
                                                                                                    },
                                                                                                });

                                                                                                if out.len()
                                                                                                    >= args.grid_max_candidates
                                                                                                {
                                                                                                    break 'outer;
                                                                                                }
                                                                                            }
                                                                                        }
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if out.is_empty() {
        anyhow::bail!("spectral grid produced no candidates");
    }
    Ok(out)
}

fn dedup_f64(values: &[f64]) -> Vec<f64> {
    let mut out = Vec::new();
    for value in values.iter().copied().filter(|item| item.is_finite()) {
        if !out
            .iter()
            .any(|existing: &f64| (*existing - value).abs() < 1e-9)
        {
            out.push(value);
        }
    }
    if out.is_empty() {
        out.push(0.0);
    }
    out
}

fn dedup_u32(values: &[u32]) -> Vec<u32> {
    let mut out = Vec::new();
    for value in values {
        if !out.contains(value) {
            out.push(*value);
        }
    }
    if out.is_empty() {
        out.push(0);
    }
    out
}

fn dedup_bool(values: &[u8]) -> Vec<bool> {
    let mut out = Vec::new();
    for value in values {
        let as_bool = *value >= 1;
        if !out.contains(&as_bool) {
            out.push(as_bool);
        }
    }
    if out.is_empty() {
        out.push(false);
    }
    out
}

fn insert_param(params: &mut BTreeMap<String, f64>, key: &str, value: f64) {
    params.insert(key.to_owned(), value);
}

fn bool_to_f64(value: bool) -> f64 {
    if value {
        1.0
    } else {
        0.0
    }
}

fn build_metadata(command_line: Vec<String>) -> RunMetadata {
    RunMetadata {
        generated_at_utc: iso_utc_now(),
        command_line,
        git_commit: read_command_line("git", &["rev-parse", "HEAD"]),
        rustc_version: read_command_line("rustc", &["--version"]),
        cargo_version: read_command_line("cargo", &["--version"]),
    }
}

fn read_command_line(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|raw| raw.trim().to_owned())
}

fn iso_utc_now() -> String {
    match Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }
        _ => "unknown".to_owned(),
    }
}
