use anyhow::{Context, Result};
use clap::Parser;
use pitch_agent::{
    generate_candidates, resolve_workspace_root, run_compile_gate, run_live_web_search,
    web_records_from_live_report,
};
use pitch_core::benchmark::run_benchmark;
use pitch_core::config::{
    load_search_space_config, load_web_research_records, write_candidates_config,
};
use pitch_core::{CandidateSpec, RunMetadata};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Parser)]
#[command(
    about = "Run AI-driven Rust pitch detector search with compile gate and strict benchmark gates."
)]
struct Args {
    #[arg(long, default_value = "config/dataset.toml")]
    dataset: PathBuf,
    #[arg(long, default_value = "config/search-space.toml")]
    search_space: PathBuf,
    #[arg(long, default_value = "config/gates.toml")]
    gates: PathBuf,
    #[arg(long, default_value = "output/agent-results.json")]
    out: PathBuf,
    #[arg(long, default_value_t = 100)]
    budget: usize,
    #[arg(long)]
    web_research: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    live_web_search: bool,
    #[arg(
        long,
        default_value = "real-time guitar pitch detection algorithm YIN MPM autocorrelation"
    )]
    live_web_query: String,
    #[arg(long, default_value_t = 12)]
    live_web_max_results: usize,
    #[arg(long, default_value_t = 12)]
    live_web_timeout_seconds: u64,
    #[arg(long, default_value = ".")]
    workspace_root: PathBuf,
    #[arg(long, default_value_t = 42)]
    seed: u64,
}

#[derive(Debug, Serialize)]
struct AgentCandidateRun {
    id: String,
    label: String,
    candidate_file: String,
    benchmark_file: Option<String>,
    compile_success: bool,
    compile_status_code: Option<i32>,
    compile_stderr_excerpt: Option<String>,
    benchmark_error: Option<String>,
    global_detect_rate: Option<f32>,
    global_in_tune_rate: Option<f32>,
    realtime_factor: Option<f64>,
    full_pass: bool,
}

#[derive(Debug, Serialize)]
struct AgentRunOutput {
    generated_at_utc: String,
    command_line: Vec<String>,
    budget: usize,
    attempted_candidates: usize,
    winner_id: Option<String>,
    found_full_pass: bool,
    generated_candidates_path: String,
    live_web_search_enabled: bool,
    live_web_query: Option<String>,
    live_web_report_path: Option<String>,
    live_web_result_count: usize,
    runs: Vec<AgentCandidateRun>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let command_line: Vec<String> = std::env::args().collect();
    let workspace_root = resolve_workspace_root(&args.workspace_root)
        .with_context(|| format!("invalid workspace root {:?}", args.workspace_root))?;

    let out_parent = args
        .out
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&out_parent)
        .with_context(|| format!("failed to create output dir {:?}", out_parent))?;

    let search_space = load_search_space_config(&args.search_space)?;
    let mut web_records = if let Some(path) = &args.web_research {
        load_web_research_records(path)?
    } else {
        Vec::new()
    };
    let mut live_web_report_path = None::<PathBuf>;
    let mut live_web_result_count = 0usize;
    if args.live_web_search {
        let live_report = run_live_web_search(
            &args.live_web_query,
            args.live_web_max_results,
            args.live_web_timeout_seconds,
        );
        live_web_result_count = live_report.results.len();
        let inferred = web_records_from_live_report(&live_report);
        web_records.extend(inferred);
        let path = out_parent.join("live-web-search.json");
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&live_report)?),
        )
        .with_context(|| format!("failed to write {:?}", path))?;
        live_web_report_path = Some(path);
    }

    let candidates = generate_candidates(&search_space, &web_records, args.budget, args.seed);
    if candidates.is_empty() {
        anyhow::bail!("no candidates generated from search-space and budget");
    }

    let runs_dir = out_parent.join("runs");
    fs::create_dir_all(&runs_dir).with_context(|| format!("failed to create {:?}", runs_dir))?;
    let generated_candidates_path = out_parent.join("generated-candidates.toml");
    write_candidates_config(&generated_candidates_path, &candidates)?;

    let mut runs = Vec::new();
    let mut winner_id = None::<String>;

    for candidate in candidates {
        let candidate_file = runs_dir.join(format!("{}.candidate.toml", candidate.id));
        write_candidates_config(&candidate_file, std::slice::from_ref(&candidate))?;

        let compile_result = run_compile_gate(&workspace_root);
        if !compile_result.success {
            runs.push(AgentCandidateRun {
                id: candidate.id.clone(),
                label: candidate.label_or_id().to_owned(),
                candidate_file: candidate_file.to_string_lossy().to_string(),
                benchmark_file: None,
                compile_success: false,
                compile_status_code: compile_result.status_code,
                compile_stderr_excerpt: Some(truncate(&compile_result.stderr, 2000)),
                benchmark_error: None,
                global_detect_rate: None,
                global_in_tune_rate: None,
                realtime_factor: None,
                full_pass: false,
            });
            continue;
        }

        let benchmark_file = runs_dir.join(format!("{}.benchmark.json", candidate.id));
        let metadata = build_metadata_for_candidate(&command_line, &candidate);
        match run_benchmark(&args.dataset, &candidate_file, &args.gates, metadata) {
            Ok(bench_result) => {
                fs::write(
                    &benchmark_file,
                    format!("{}\n", serde_json::to_string_pretty(&bench_result)?),
                )
                .with_context(|| format!("failed to write {:?}", benchmark_file))?;
                let row = bench_result
                    .candidates
                    .first()
                    .context("benchmark result has no candidate row")?;
                let full_pass = row.full_pass;
                let id = row.id.clone();
                runs.push(AgentCandidateRun {
                    id: id.clone(),
                    label: row.label.clone(),
                    candidate_file: candidate_file.to_string_lossy().to_string(),
                    benchmark_file: Some(benchmark_file.to_string_lossy().to_string()),
                    compile_success: true,
                    compile_status_code: compile_result.status_code,
                    compile_stderr_excerpt: None,
                    benchmark_error: None,
                    global_detect_rate: Some(row.global_detect_rate),
                    global_in_tune_rate: Some(row.global_in_tune_rate),
                    realtime_factor: Some(row.realtime_factor),
                    full_pass,
                });
                if full_pass {
                    winner_id = Some(id);
                    break;
                }
            }
            Err(error) => {
                runs.push(AgentCandidateRun {
                    id: candidate.id.clone(),
                    label: candidate.label_or_id().to_owned(),
                    candidate_file: candidate_file.to_string_lossy().to_string(),
                    benchmark_file: None,
                    compile_success: true,
                    compile_status_code: compile_result.status_code,
                    compile_stderr_excerpt: None,
                    benchmark_error: Some(error.to_string()),
                    global_detect_rate: None,
                    global_in_tune_rate: None,
                    realtime_factor: None,
                    full_pass: false,
                });
            }
        }
    }

    let report = AgentRunOutput {
        generated_at_utc: iso_utc_now(),
        command_line,
        budget: args.budget,
        attempted_candidates: runs.len(),
        winner_id: winner_id.clone(),
        found_full_pass: winner_id.is_some(),
        generated_candidates_path: generated_candidates_path.to_string_lossy().to_string(),
        live_web_search_enabled: args.live_web_search,
        live_web_query: if args.live_web_search {
            Some(args.live_web_query.clone())
        } else {
            None
        },
        live_web_report_path: live_web_report_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        live_web_result_count,
        runs,
    };

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent).with_context(|| format!("failed to create {:?}", parent))?;
    }
    fs::write(
        &args.out,
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )
    .with_context(|| format!("failed to write {:?}", args.out))?;

    println!(
        "Agent finished: found_full_pass={} attempted={} winner={}",
        report.found_full_pass,
        report.attempted_candidates,
        report.winner_id.as_deref().unwrap_or("none")
    );
    if report.live_web_search_enabled {
        println!(
            "Live web search: query=\"{}\" results={} report={}",
            report.live_web_query.as_deref().unwrap_or(""),
            report.live_web_result_count,
            report.live_web_report_path.as_deref().unwrap_or("none")
        );
    }
    println!("Output: {}", args.out.display());
    Ok(())
}

fn build_metadata_for_candidate(command_line: &[String], candidate: &CandidateSpec) -> RunMetadata {
    let mut cmd = command_line.to_vec();
    cmd.push(format!("candidate={}", candidate.id));
    RunMetadata {
        generated_at_utc: iso_utc_now(),
        command_line: cmd,
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

fn truncate(raw: &str, max: usize) -> String {
    if raw.len() <= max {
        return raw.to_owned();
    }
    raw.chars().take(max).collect()
}
