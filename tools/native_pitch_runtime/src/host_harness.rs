use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::{DetectionEvent, NativePitchRuntime, RuntimeConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostExecutionMode {
    Offline,
    Streaming,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRunConfig {
    pub mode: HostExecutionMode,
    pub block_size: usize,
    pub callback_size: usize,
    pub flush_tail: bool,
    pub capture_start_time_sec: f64,
}

impl Default for HostRunConfig {
    fn default() -> Self {
        Self {
            mode: HostExecutionMode::Streaming,
            block_size: 1024,
            callback_size: 1024,
            flush_tail: true,
            capture_start_time_sec: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostFramePrediction {
    pub process_index: usize,
    pub callback_index: Option<usize>,
    pub capture_time_sec: f64,
    pub submitted_samples: usize,
    pub event: DetectionEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRunSummary {
    pub mode: HostExecutionMode,
    pub sample_rate: u32,
    pub total_samples: usize,
    pub audio_duration_sec: f64,
    pub callback_size: usize,
    pub block_size: usize,
    pub callback_count: usize,
    pub runtime_call_count: usize,
    pub emitted_event_count: usize,
    pub wall_time_ms: f64,
    pub mean_wall_time_per_runtime_call_ms: f64,
    pub sum_event_processing_time_ms: f64,
    pub mean_event_processing_time_ms: f64,
    pub realtime_factor: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostRunResult {
    pub summary: HostRunSummary,
    pub frames: Vec<HostFramePrediction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostBenchmarkConfig {
    pub warmup_iterations: usize,
    pub measured_iterations: usize,
}

impl Default for HostBenchmarkConfig {
    fn default() -> Self {
        Self {
            warmup_iterations: 0,
            measured_iterations: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostBenchmarkIteration {
    pub iteration: usize,
    pub wall_time_ms: f64,
    pub runtime_call_count: usize,
    pub emitted_event_count: usize,
    pub realtime_factor: f64,
    pub mean_event_processing_time_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostBenchmarkResult {
    pub warmup_iterations: usize,
    pub measured_iterations: usize,
    pub iterations: Vec<HostBenchmarkIteration>,
    pub mean_wall_time_ms: f64,
    pub min_wall_time_ms: f64,
    pub max_wall_time_ms: f64,
    pub mean_realtime_factor: f64,
}

pub fn run_with_config(
    runtime_config: &RuntimeConfig,
    audio_samples: &[f32],
    sample_rate: u32,
    run_config: &HostRunConfig,
) -> Result<HostRunResult, String> {
    let mut runtime = NativePitchRuntime::new(runtime_config.clone())?;
    run_with_runtime(&mut runtime, audio_samples, sample_rate, run_config)
}

pub fn run_with_runtime(
    runtime: &mut NativePitchRuntime,
    audio_samples: &[f32],
    sample_rate: u32,
    run_config: &HostRunConfig,
) -> Result<HostRunResult, String> {
    if sample_rate == 0 {
        return Err("sample_rate must be greater than zero".to_owned());
    }
    let block_size = run_config.block_size.max(1);
    let callback_size = run_config.callback_size.max(1);

    let started = Instant::now();
    let mut capture_time_sec = run_config.capture_start_time_sec;
    let mut callback_count = 0usize;
    let mut runtime_call_count = 0usize;
    let mut submitted_samples = 0usize;
    let mut frames = Vec::<HostFramePrediction>::new();

    match run_config.mode {
        HostExecutionMode::Offline => {
            for block in audio_samples.chunks(block_size) {
                callback_count += 1;
                capture_time_sec += block.len() as f64 / sample_rate as f64;
                submitted_samples += block.len();
                runtime_call_count += 1;
                if let Some(event) = runtime.process_audio_block(block, capture_time_sec)? {
                    frames.push(HostFramePrediction {
                        process_index: runtime_call_count,
                        callback_index: Some(callback_count),
                        capture_time_sec,
                        submitted_samples,
                        event,
                    });
                }
            }
        }
        HostExecutionMode::Streaming => {
            let mut staged = Vec::<f32>::new();
            let mut staged_offset = 0usize;
            for callback in audio_samples.chunks(callback_size) {
                callback_count += 1;
                capture_time_sec += callback.len() as f64 / sample_rate as f64;
                staged.extend_from_slice(callback);

                while staged.len().saturating_sub(staged_offset) >= block_size {
                    let end = staged_offset + block_size;
                    let block = staged[staged_offset..end].to_vec();
                    staged_offset = end;
                    submitted_samples += block.len();
                    runtime_call_count += 1;
                    if let Some(event) = runtime.process_audio_block(&block, capture_time_sec)? {
                        frames.push(HostFramePrediction {
                            process_index: runtime_call_count,
                            callback_index: Some(callback_count),
                            capture_time_sec,
                            submitted_samples,
                            event,
                        });
                    }
                }

                // Keep memory bounded without per-block front shifting.
                if staged_offset > 0
                    && (staged_offset >= block_size * 8 || staged_offset * 2 >= staged.len())
                {
                    staged.drain(..staged_offset);
                    staged_offset = 0;
                }
            }

            let tail = if staged_offset == 0 {
                staged
            } else {
                staged[staged_offset..].to_vec()
            };
            if run_config.flush_tail && !tail.is_empty() {
                submitted_samples += tail.len();
                runtime_call_count += 1;
                if let Some(event) = runtime.process_audio_block(&tail, capture_time_sec)? {
                    frames.push(HostFramePrediction {
                        process_index: runtime_call_count,
                        callback_index: Some(callback_count.max(1)),
                        capture_time_sec,
                        submitted_samples,
                        event,
                    });
                }
            }
        }
    }

    let wall_time_ms = started.elapsed().as_secs_f64() * 1000.0;
    let audio_duration_sec = audio_samples.len() as f64 / sample_rate as f64;
    let sum_event_processing_time_ms = frames
        .iter()
        .map(|frame| frame.event.processing_time_ms)
        .sum::<f64>();
    let mean_event_processing_time_ms = if frames.is_empty() {
        0.0
    } else {
        sum_event_processing_time_ms / frames.len() as f64
    };

    Ok(HostRunResult {
        summary: HostRunSummary {
            mode: run_config.mode,
            sample_rate,
            total_samples: audio_samples.len(),
            audio_duration_sec,
            callback_size,
            block_size,
            callback_count,
            runtime_call_count,
            emitted_event_count: frames.len(),
            wall_time_ms,
            mean_wall_time_per_runtime_call_ms: if runtime_call_count == 0 {
                0.0
            } else {
                wall_time_ms / runtime_call_count as f64
            },
            sum_event_processing_time_ms,
            mean_event_processing_time_ms,
            realtime_factor: if wall_time_ms <= 0.0 {
                0.0
            } else {
                audio_duration_sec / (wall_time_ms / 1000.0)
            },
        },
        frames,
    })
}

pub fn benchmark_with_config(
    runtime_config: &RuntimeConfig,
    audio_samples: &[f32],
    sample_rate: u32,
    run_config: &HostRunConfig,
    benchmark_config: &HostBenchmarkConfig,
) -> Result<HostBenchmarkResult, String> {
    if benchmark_config.measured_iterations == 0 {
        return Err("measured_iterations must be greater than zero".to_owned());
    }

    for _ in 0..benchmark_config.warmup_iterations {
        let _ = run_with_config(runtime_config, audio_samples, sample_rate, run_config)?;
    }

    let mut iterations = Vec::with_capacity(benchmark_config.measured_iterations);
    for iteration in 0..benchmark_config.measured_iterations {
        let result = run_with_config(runtime_config, audio_samples, sample_rate, run_config)?;
        iterations.push(HostBenchmarkIteration {
            iteration: iteration + 1,
            wall_time_ms: result.summary.wall_time_ms,
            runtime_call_count: result.summary.runtime_call_count,
            emitted_event_count: result.summary.emitted_event_count,
            realtime_factor: result.summary.realtime_factor,
            mean_event_processing_time_ms: result.summary.mean_event_processing_time_ms,
        });
    }

    let mean_wall_time_ms =
        iterations.iter().map(|item| item.wall_time_ms).sum::<f64>() / iterations.len() as f64;
    let min_wall_time_ms = iterations
        .iter()
        .map(|item| item.wall_time_ms)
        .fold(f64::INFINITY, f64::min);
    let max_wall_time_ms = iterations
        .iter()
        .map(|item| item.wall_time_ms)
        .fold(f64::NEG_INFINITY, f64::max);
    let mean_realtime_factor = iterations
        .iter()
        .map(|item| item.realtime_factor)
        .sum::<f64>()
        / iterations.len() as f64;

    Ok(HostBenchmarkResult {
        warmup_iterations: benchmark_config.warmup_iterations,
        measured_iterations: benchmark_config.measured_iterations,
        iterations,
        mean_wall_time_ms,
        min_wall_time_ms: if min_wall_time_ms.is_finite() {
            min_wall_time_ms
        } else {
            0.0
        },
        max_wall_time_ms: if max_wall_time_ms.is_finite() {
            max_wall_time_ms
        } else {
            0.0
        },
        mean_realtime_factor,
    })
}
