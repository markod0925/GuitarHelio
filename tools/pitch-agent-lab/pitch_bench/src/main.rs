use anyhow::{Context, Result};
use clap::Parser;
use pitch_core::{run_benchmark, RunMetadata};
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
}

fn main() -> Result<()> {
    let args = Args::parse();
    let metadata = build_metadata(std::env::args().collect());
    let result = run_benchmark(&args.dataset, &args.candidates, &args.gates, metadata)?;

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
    println!("Output: {}", args.out.display());
    Ok(())
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
