use std::any::Any;
use std::collections::VecDeque;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use fretnet_runtime::audio::{resample_kaiser_best, rms_normalize};
use fretnet_runtime::{FeatureExtractor, FretNetRuntime, FrontendConfig, ModelOutput};
use gh_dsp_core::{
    DspMode, GhDspCore, NativePitchFrame, PitchDetectorPreset, SpectralChordScore,
    SpectralSelectedNote,
};
use guitar_pitch::config::{AppConfig, MaspWeightsConfig};
use guitar_pitch::masp::{
    load_pretrain_artifacts, validate_expected_segment, MaspPretrainArtifacts,
};
use guitar_pitch::types::{AudioBuffer, OPEN_MIDI};
use ndarray::IxDyn;
use serde::{Deserialize, Serialize};

const DEFAULT_CAPTURE_BUFFER_SECONDS: f64 = 8.0;
const MASP_SCORE_THRESHOLD: f32 = 0.437_098_2;
const MASP_B_EXPONENT: f32 = 0.772_679_5;
const MASP_CENT_TOLERANCE: f32 = 50.0;
const MASP_RMS_H_RELAX: f32 = 0.25;
const MASP_RMS_WINDOW_MS: u32 = 50;
const MASP_BINS_PER_OCTAVE: usize = 36;
const MASP_MAX_HARMONICS: usize = 8;
const FRETNET_CONTEXT_SECONDS: f64 = 0.5;
const FRETNET_STREAM_TARGET_SAMPLE_RATE: u32 = 44_100;
const FRETNET_MAX_FRAMES: usize = 48;
const FRETNET_STRING_COUNT: usize = 6;
const FRETNET_RELATIVE_SILENCE_CLASS: usize = 0;

fn init_stage_store() -> &'static Mutex<String> {
    static STORE: OnceLock<Mutex<String>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new("idle".to_owned()))
}

fn set_init_stage(value: impl Into<String>) {
    if let Ok(mut stage) = init_stage_store().lock() {
        *stage = value.into();
    }
}

fn current_init_stage() -> String {
    init_stage_store()
        .lock()
        .map(|stage| stage.clone())
        .unwrap_or_else(|_| "stage_lock_poisoned".to_owned())
}

#[derive(Debug, Deserialize)]
struct RuntimeConfig {
    backend_name: String,
    sample_rate: u32,
    block_size: usize,
    #[serde(default)]
    spectral_model_json: Option<String>,
    #[serde(default)]
    audio_input_mode: Option<String>,
    #[serde(default)]
    masp_assets_dir: Option<String>,
    #[serde(default)]
    fretnet_model_path: Option<String>,
    #[serde(default)]
    fretnet_ort_library_path: Option<String>,
    #[serde(default)]
    max_capture_buffer_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct GameplayContextNote {
    note_id: String,
    midi: u8,
    string: u32,
    fret: u32,
    onset_sec: f32,
    offset_sec: f32,
}

#[derive(Debug, Clone, Deserialize)]
struct GameplayContextUpdate {
    playhead_sec: f32,
    start_sec: f32,
    end_sec: f32,
    expected_midis: Vec<u8>,
    expected_notes: Vec<GameplayContextNote>,
    #[serde(default)]
    capture_anchor_time_sec: Option<f64>,
}

#[derive(Debug, Clone)]
struct MappedGameplayContext {
    fingerprint: String,
    capture_start_sec: f64,
    capture_end_sec: f64,
    expected_midis: Vec<u8>,
    expected_notes: Vec<GameplayContextNote>,
}

#[derive(Clone, Debug, Serialize)]
struct ResultNote {
    note_id: Option<String>,
    midi: f32,
    string: Option<u32>,
    fret: Option<u32>,
    score: Option<f32>,
}

#[derive(Debug, Serialize)]
struct ResultChordScore {
    chord_id: String,
    score: f32,
}

#[derive(Debug, Serialize)]
struct DetectionEvent {
    backend_name: String,
    timestamp_sec: f64,
    pitch_hz: Option<f32>,
    midi_estimate: Option<f32>,
    confidence: f32,
    selected_notes: Vec<ResultNote>,
    chord_scores: Vec<ResultChordScore>,
    detected_string: Option<u32>,
    detected_fret: Option<u32>,
    best_note_id: Option<String>,
    rejected_as_reference_bleed: Option<bool>,
    reference_midi: Option<f32>,
    reference_correlation: Option<f32>,
    energy_ratio_db: Option<f32>,
    onset_strength: Option<f32>,
    contamination_score: Option<f32>,
    validation_passed: Option<bool>,
    reason: Option<String>,
    weighted_score: Option<f32>,
    score_threshold: Option<f32>,
    processing_time_ms: f64,
    callback_to_result_latency_ms: f64,
}

struct CaptureBuffer {
    sample_rate: u32,
    max_samples: usize,
    samples: VecDeque<f32>,
    start_time_sec: f64,
    end_time_sec: f64,
    initialized: bool,
}

impl CaptureBuffer {
    fn new(sample_rate: u32, max_seconds: f64) -> Self {
        let safe_sample_rate = sample_rate.max(8_000);
        let max_samples = ((safe_sample_rate as f64) * max_seconds.max(1.0)).round() as usize;
        Self {
            sample_rate: safe_sample_rate,
            max_samples: max_samples.max(safe_sample_rate as usize),
            samples: VecDeque::new(),
            start_time_sec: 0.0,
            end_time_sec: 0.0,
            initialized: false,
        }
    }

    fn clear(&mut self) {
        self.samples.clear();
        self.start_time_sec = 0.0;
        self.end_time_sec = 0.0;
        self.initialized = false;
    }

    fn push_block(&mut self, block: &[f32], capture_end_time_sec: f64) {
        if block.is_empty() {
            return;
        }
        let duration_sec = block.len() as f64 / self.sample_rate as f64;
        let capture_start_time_sec = capture_end_time_sec - duration_sec;
        if !self.initialized {
            self.start_time_sec = capture_start_time_sec;
            self.end_time_sec = capture_end_time_sec;
            self.initialized = true;
        } else {
            self.end_time_sec = capture_end_time_sec;
        }
        self.samples.extend(block.iter().copied());
        while self.samples.len() > self.max_samples {
            self.samples.pop_front();
            self.start_time_sec += 1.0 / self.sample_rate as f64;
        }
        if self.samples.is_empty() {
            self.start_time_sec = self.end_time_sec;
        }
    }

    fn contains_window(&self, start_sec: f64, end_sec: f64) -> bool {
        self.initialized
            && start_sec >= self.start_time_sec
            && end_sec <= self.end_time_sec
            && end_sec > start_sec
    }

    fn extract_window(&self, start_sec: f64, end_sec: f64) -> Option<(Vec<f32>, f64)> {
        if !self.contains_window(start_sec, end_sec) {
            return None;
        }
        let start_index =
            seconds_to_sample_index(start_sec - self.start_time_sec, self.sample_rate);
        let end_index = seconds_to_sample_index(end_sec - self.start_time_sec, self.sample_rate);
        if end_index <= start_index {
            return None;
        }
        let mut out = Vec::with_capacity(end_index.saturating_sub(start_index));
        for (index, sample) in self.samples.iter().enumerate() {
            if index < start_index {
                continue;
            }
            if index >= end_index {
                break;
            }
            out.push(*sample);
        }
        if out.is_empty() {
            None
        } else {
            Some((out, start_sec))
        }
    }

    fn latest_window(&self, duration_sec: f64) -> Option<Vec<f32>> {
        if !self.initialized || self.samples.is_empty() {
            return None;
        }
        let desired_samples = ((duration_sec.max(0.05)) * self.sample_rate as f64).round() as usize;
        let take = desired_samples.min(self.samples.len());
        let start = self.samples.len().saturating_sub(take);
        let mut out = Vec::with_capacity(take);
        for (index, sample) in self.samples.iter().enumerate() {
            if index < start {
                continue;
            }
            out.push(*sample);
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
}

struct DspDetector {
    backend_name: &'static str,
    core: GhDspCore,
}

impl DspDetector {
    fn new(config: &RuntimeConfig, preset: PitchDetectorPreset) -> Result<Self, String> {
        let mut core = GhDspCore::new();
        core.prepare(
            config.sample_rate.max(8_000),
            config.block_size.max(256),
            map_dsp_mode(config.audio_input_mode.as_deref()),
        );
        core.set_pitch_detector_preset(preset);
        if matches!(
            preset,
            PitchDetectorPreset::SpectralGameRuntimeUnifiedV3 | PitchDetectorPreset::Fretnet
        ) {
            core.set_spectral_model_json(config.spectral_model_json.as_deref().ok_or_else(
                || "spectral_model_json is required for spectral backends".to_owned(),
            )?)?;
        }
        Ok(Self {
            backend_name: match preset {
                PitchDetectorPreset::Ac14 => "ac14",
                PitchDetectorPreset::SpectralGameRuntimeUnifiedV3 => {
                    "spectral_game_runtime_unified_v3"
                }
                PitchDetectorPreset::Fretnet => "fretnet",
                PitchDetectorPreset::Baseline => "baseline",
            },
            core,
        })
    }

    fn process(
        &mut self,
        samples: &[f32],
        capture_time_sec: f64,
    ) -> Result<Option<DetectionEvent>, String> {
        let started = Instant::now();
        let frame = self.core.process_block_native(samples);
        Ok(Some(map_native_pitch_frame(
            self.backend_name,
            capture_time_sec,
            frame,
            started.elapsed().as_secs_f64() * 1000.0,
        )))
    }

    fn reset(&mut self) {
        self.core.reset();
    }
}

struct MaspDetector {
    cfg: AppConfig,
    artifacts: MaspPretrainArtifacts,
    capture_buffer: CaptureBuffer,
    pending_context: Option<MappedGameplayContext>,
    last_emitted_fingerprint: Option<String>,
    last_capture_time_sec: f64,
}

impl MaspDetector {
    fn new(config: &RuntimeConfig) -> Result<Self, String> {
        let artifacts_dir = config
            .masp_assets_dir
            .as_ref()
            .ok_or_else(|| "masp_assets_dir is required for MASP".to_owned())?;
        let artifacts = load_pretrain_artifacts(Path::new(artifacts_dir))
            .map_err(|error| format!("Failed to load MASP artifacts: {error:#}"))?;
        let mut cfg = AppConfig::default();
        apply_masp_manifest_to_config(&mut cfg, &artifacts);
        Ok(Self {
            cfg,
            artifacts,
            capture_buffer: CaptureBuffer::new(
                config.sample_rate,
                config
                    .max_capture_buffer_seconds
                    .unwrap_or(DEFAULT_CAPTURE_BUFFER_SECONDS),
            ),
            pending_context: None,
            last_emitted_fingerprint: None,
            last_capture_time_sec: 0.0,
        })
    }

    fn update_context(&mut self, update: GameplayContextUpdate) -> Result<(), String> {
        if update.expected_midis.is_empty() || update.expected_notes.is_empty() {
            self.pending_context = None;
            return Ok(());
        }
        let anchor_capture_time_sec = update
            .capture_anchor_time_sec
            .unwrap_or(self.last_capture_time_sec);
        let capture_start_sec =
            anchor_capture_time_sec + (update.start_sec - update.playhead_sec) as f64;
        let capture_end_sec =
            anchor_capture_time_sec + (update.end_sec - update.playhead_sec) as f64;
        if !capture_start_sec.is_finite()
            || !capture_end_sec.is_finite()
            || capture_end_sec <= capture_start_sec
        {
            return Err("Invalid MASP gameplay context window".to_owned());
        }
        let fingerprint = build_context_fingerprint(&update);
        self.pending_context = Some(MappedGameplayContext {
            fingerprint,
            capture_start_sec,
            capture_end_sec,
            expected_midis: update.expected_midis,
            expected_notes: update.expected_notes,
        });
        Ok(())
    }

    fn process(
        &mut self,
        samples: &[f32],
        capture_time_sec: f64,
    ) -> Result<Option<DetectionEvent>, String> {
        self.last_capture_time_sec = capture_time_sec;
        self.capture_buffer.push_block(samples, capture_time_sec);

        let Some(context) = self.pending_context.clone() else {
            return Ok(None);
        };
        if capture_time_sec + 1e-6 < context.capture_end_sec {
            return Ok(None);
        }
        if self.last_emitted_fingerprint.as_deref() == Some(context.fingerprint.as_str()) {
            return Ok(None);
        }
        let Some((window_samples, base_start_sec)) = self
            .capture_buffer
            .extract_window(context.capture_start_sec, context.capture_end_sec)
        else {
            return Ok(None);
        };

        let started = Instant::now();
        let audio = AudioBuffer {
            sample_rate: self.capture_buffer.sample_rate,
            samples: window_samples,
        };
        let start_sec = (context.capture_start_sec - base_start_sec) as f32;
        let end_sec = (context.capture_end_sec - base_start_sec) as f32;
        let result = validate_expected_segment(
            &audio,
            start_sec,
            end_sec,
            &context.expected_midis,
            &self.cfg,
            &self.artifacts,
        )
        .map_err(|error| format!("MASP validation failed: {error:#}"))?;

        self.last_emitted_fingerprint = Some(context.fingerprint.clone());

        let selected_notes = context
            .expected_notes
            .iter()
            .map(|note| ResultNote {
                note_id: Some(note.note_id.clone()),
                midi: note.midi as f32,
                string: Some(note.string),
                fret: Some(note.fret),
                score: Some(result.weighted_score),
            })
            .collect::<Vec<_>>();
        let best_note = context.expected_notes.first().cloned();
        Ok(Some(DetectionEvent {
            backend_name: "masp".to_owned(),
            timestamp_sec: context.capture_end_sec,
            pitch_hz: result
                .expected_midis
                .first()
                .map(|midi| midi_to_hz(*midi as f32)),
            midi_estimate: if result.pass {
                context
                    .expected_midis
                    .first()
                    .copied()
                    .map(|midi| midi as f32)
            } else {
                None
            },
            confidence: result.weighted_score.clamp(0.0, 1.0),
            selected_notes,
            chord_scores: Vec::new(),
            detected_string: best_note.as_ref().map(|note| note.string),
            detected_fret: best_note.as_ref().map(|note| note.fret),
            best_note_id: best_note.map(|note| note.note_id),
            rejected_as_reference_bleed: None,
            reference_midi: None,
            reference_correlation: None,
            energy_ratio_db: None,
            onset_strength: None,
            contamination_score: None,
            validation_passed: Some(result.pass),
            reason: Some(result.reason),
            weighted_score: Some(result.weighted_score),
            score_threshold: Some(result.score_threshold),
            processing_time_ms: started.elapsed().as_secs_f64() * 1000.0,
            callback_to_result_latency_ms: ((capture_time_sec - context.capture_end_sec) * 1000.0)
                .max(0.0),
        }))
    }

    fn reset(&mut self) {
        self.capture_buffer.clear();
        self.pending_context = None;
        self.last_emitted_fingerprint = None;
        self.last_capture_time_sec = 0.0;
    }
}

struct FretNetDetector {
    runtime: FretNetRuntime,
    extractor: FeatureExtractor,
    capture_buffer: CaptureBuffer,
    min_inference_interval_seconds: f64,
    last_inference_time_sec: f64,
}

impl FretNetDetector {
    fn new(config: &RuntimeConfig) -> Result<Self, String> {
        set_init_stage("fretnet:new:resolve_model_path");
        let model_path = resolve_existing_path(
            config
                .fretnet_model_path
                .as_deref()
                .ok_or_else(|| "fretnet_model_path is required for FRETNET".to_owned())?,
        )?;
        set_init_stage("fretnet:new:create_feature_extractor");
        let frontend_config = FrontendConfig::default();
        let extractor = FeatureExtractor::new(frontend_config)
            .map_err(|error| format!("Failed to create FRETNET extractor: {error}"))?;
        set_init_stage("fretnet:new:load_onnx_runtime");
        let fretnet_ort_library_path =
            config
                .fretnet_ort_library_path
                .as_deref()
                .and_then(|value| {
                    let trimmed = value.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(PathBuf::from(trimmed))
                    }
                });
        let runtime = FretNetRuntime::load_with_stage_callback(
            &model_path,
            fretnet_ort_library_path.as_deref(),
            |stage| {
                set_init_stage(format!("fretnet:new:{stage}"));
            },
        )
        .map_err(|error| format!("Failed to load FRETNET model: {error}"))?;
        set_init_stage("fretnet:new:ready");
        let capture_sample_rate = config.sample_rate.max(8_000);
        let min_inference_interval_seconds = config.block_size.max(256) as f64
            / capture_sample_rate as f64;
        Ok(Self {
            runtime,
            extractor,
            capture_buffer: CaptureBuffer::new(
                capture_sample_rate,
                config
                    .max_capture_buffer_seconds
                    .unwrap_or(DEFAULT_CAPTURE_BUFFER_SECONDS),
            ),
            min_inference_interval_seconds,
            last_inference_time_sec: -min_inference_interval_seconds,
        })
    }

    fn process(
        &mut self,
        samples: &[f32],
        capture_time_sec: f64,
    ) -> Result<Option<DetectionEvent>, String> {
        let input_block_len = samples.len();
        self.capture_buffer.push_block(samples, capture_time_sec);
        if capture_time_sec - self.last_inference_time_sec < self.min_inference_interval_seconds
        {
            return Ok(None);
        }

        let Some(window) = self.capture_buffer.latest_window(FRETNET_CONTEXT_SECONDS) else {
            return Ok(None);
        };

        let started = Instant::now();
        let frontend_sample_rate = self.extractor.config().sample_rate;
        let input_window_len = window.len();
        let (stream_aligned, stream_sample_rate) =
            if self.capture_buffer.sample_rate == 48_000 {
                (
                    resample_kaiser_best(
                        &window,
                        self.capture_buffer.sample_rate,
                        FRETNET_STREAM_TARGET_SAMPLE_RATE,
                    )
                    .map_err(|error| {
                        format!("Failed to resample FRETNET 48k stream to 44.1k: {error}")
                    })?,
                    FRETNET_STREAM_TARGET_SAMPLE_RATE,
                )
            } else {
                (window, self.capture_buffer.sample_rate)
            };
        let mut resampled = if stream_sample_rate == frontend_sample_rate {
            stream_aligned
        } else {
            resample_kaiser_best(
                &stream_aligned,
                stream_sample_rate,
                frontend_sample_rate,
            )
            .map_err(|error| format!("Failed to resample FRETNET audio: {error}"))?
        };
        rms_normalize(&mut resampled)
            .map_err(|error| format!("Failed to normalize FRETNET audio: {error}"))?;
        let hcqt = self
            .extractor
            .extract_hcqt(&resampled, frontend_sample_rate)
            .map_err(|error| format!("Failed to extract FRETNET HCQT: {error}"))?;
        let hcqt_shape = hcqt.shape();
        let batch = self
            .extractor
            .hcqt_to_batch(&hcqt, Some(FRETNET_MAX_FRAMES.min(hcqt.frame_count())))
            .map_err(|error| format!("Failed to build FRETNET batch: {error}"))?;
        let batch_shape = batch.shape();
        if batch_shape[1] == 0 {
            return Err(format!(
                "FRETNET preprocessing produced zero frames; diagnostics: input_block_len={input_block_len}, input_window_len={input_window_len}, resampled_len={}, frontend_sample_rate={}, hcqt_shape={:?}, batch_shape={:?}",
                resampled.len(),
                frontend_sample_rate,
                hcqt_shape,
                batch_shape
            ));
        }
        let output = self
            .runtime
            .infer_features(&batch)
            .map_err(|error| format!("FRETNET inference failed: {error}"))?;
        let output_shapes = fretnet_output_shapes_summary(&output);

        self.last_inference_time_sec = capture_time_sec;
        decode_fretnet_output(
            &output,
            capture_time_sec,
            started.elapsed().as_secs_f64() * 1000.0,
        )
        .map_err(|error| {
            format!(
                "FRETNET decode failed: {error}; diagnostics: input_block_len={input_block_len}, input_window_len={input_window_len}, resampled_len={}, frontend_sample_rate={}, hcqt_shape={:?}, onnx_input_shape={:?}, output_shapes=[{}]",
                resampled.len(),
                frontend_sample_rate,
                hcqt_shape,
                batch_shape,
                output_shapes
            )
        })
    }

    fn reset(&mut self) {
        self.capture_buffer.clear();
        self.last_inference_time_sec = -self.min_inference_interval_seconds;
    }
}

enum DetectorKind {
    Ac14(DspDetector),
    Spectral(DspDetector),
    Masp(MaspDetector),
    FretNet(FretNetDetector),
}

impl DetectorKind {
    fn new(config: RuntimeConfig) -> Result<Self, String> {
        set_init_stage(format!("detector:new:backend={}", config.backend_name));
        match config.backend_name.as_str() {
            "ac14" => Ok(Self::Ac14(DspDetector::new(
                &config,
                PitchDetectorPreset::Ac14,
            )?)),
            "spectral_game_runtime_unified_v3" => Ok(Self::Spectral(DspDetector::new(
                &config,
                PitchDetectorPreset::SpectralGameRuntimeUnifiedV3,
            )?)),
            "masp" | "masp_game_scene_ts_v1" => Ok(Self::Masp(MaspDetector::new(&config)?)),
            "fretnet" => Ok(Self::FretNet(FretNetDetector::new(&config)?)),
            other => Err(format!("Unsupported detector backend: {other}")),
        }
    }

    fn update_gameplay_context(&mut self, context_json: &str) -> Result<(), String> {
        match self {
            Self::Masp(detector) => {
                if context_json.trim().is_empty() || context_json.trim() == "null" {
                    detector.pending_context = None;
                    return Ok(());
                }
                let update: GameplayContextUpdate = serde_json::from_str(context_json)
                    .map_err(|error| format!("Invalid gameplay context JSON: {error}"))?;
                detector.update_context(update)
            }
            _ => Ok(()),
        }
    }

    fn process_audio_block(
        &mut self,
        samples: &[f32],
        capture_time_sec: f64,
    ) -> Result<Option<DetectionEvent>, String> {
        match self {
            Self::Ac14(detector) => detector.process(samples, capture_time_sec),
            Self::Spectral(detector) => detector.process(samples, capture_time_sec),
            Self::Masp(detector) => detector.process(samples, capture_time_sec),
            Self::FretNet(detector) => detector.process(samples, capture_time_sec),
        }
    }

    fn reset(&mut self) {
        match self {
            Self::Ac14(detector) | Self::Spectral(detector) => detector.reset(),
            Self::Masp(detector) => detector.reset(),
            Self::FretNet(detector) => detector.reset(),
        }
    }
}

pub struct NativePitchRuntimeHandle {
    detector: DetectorKind,
}

fn map_dsp_mode(audio_input_mode: Option<&str>) -> DspMode {
    if matches!(audio_input_mode, Some("headphones")) {
        DspMode::Headphones
    } else {
        DspMode::Speaker
    }
}

fn map_native_pitch_frame(
    backend_name: &str,
    capture_time_sec: f64,
    frame: NativePitchFrame,
    processing_time_ms: f64,
) -> DetectionEvent {
    DetectionEvent {
        backend_name: backend_name.to_owned(),
        timestamp_sec: capture_time_sec,
        pitch_hz: frame.pitch_hz,
        midi_estimate: frame.midi_estimate,
        confidence: frame.confidence,
        selected_notes: frame.selected_notes.iter().map(map_selected_note).collect(),
        chord_scores: frame.chord_scores.iter().map(map_chord_score).collect(),
        detected_string: frame.detected_string,
        detected_fret: frame.detected_fret,
        best_note_id: frame.best_note_id,
        rejected_as_reference_bleed: Some(frame.rejected_as_reference_bleed),
        reference_midi: frame.reference_midi,
        reference_correlation: Some(frame.reference_correlation),
        energy_ratio_db: Some(frame.energy_ratio_db),
        onset_strength: Some(frame.onset_strength),
        contamination_score: Some(frame.contamination_score),
        validation_passed: None,
        reason: None,
        weighted_score: None,
        score_threshold: None,
        processing_time_ms,
        callback_to_result_latency_ms: 0.0,
    }
}

fn map_selected_note(note: &SpectralSelectedNote) -> ResultNote {
    ResultNote {
        note_id: Some(note.note_id.clone()),
        midi: note.midi,
        string: Some(note.guitar_string),
        fret: Some(note.fret),
        score: Some(note.score),
    }
}

fn map_chord_score(score: &SpectralChordScore) -> ResultChordScore {
    ResultChordScore {
        chord_id: score.chord_id.clone(),
        score: score.score,
    }
}

fn apply_masp_manifest_to_config(cfg: &mut AppConfig, artifacts: &MaspPretrainArtifacts) {
    cfg.masp.mode = if artifacts.manifest.model_params.mode.trim().is_empty() {
        "strict".to_owned()
    } else {
        artifacts.manifest.model_params.mode.clone()
    };
    cfg.masp.strict_sample_rate = if artifacts.manifest.model_params.strict_sample_rate > 0 {
        artifacts.manifest.model_params.strict_sample_rate
    } else {
        22_050
    };
    cfg.masp.bins_per_octave = if artifacts.manifest.model_params.bins_per_octave > 0 {
        artifacts.manifest.model_params.bins_per_octave
    } else {
        MASP_BINS_PER_OCTAVE
    };
    cfg.masp.max_harmonics = if artifacts.manifest.model_params.max_harmonics > 0 {
        artifacts.manifest.model_params.max_harmonics
    } else {
        MASP_MAX_HARMONICS
    };
    cfg.masp.b_exponent = if artifacts.manifest.model_params.b_exponent > 0.0 {
        artifacts.manifest.model_params.b_exponent
    } else {
        MASP_B_EXPONENT
    };
    cfg.masp.cent_tolerance = if artifacts.manifest.model_params.cent_tolerance > 0.0 {
        artifacts.manifest.model_params.cent_tolerance
    } else {
        MASP_CENT_TOLERANCE
    };
    cfg.masp.rms_window_ms = if artifacts.manifest.model_params.rms_window_ms > 0 {
        artifacts.manifest.model_params.rms_window_ms
    } else {
        MASP_RMS_WINDOW_MS
    };
    cfg.masp.rms_h_relax = if artifacts.manifest.model_params.rms_h_relax > 0.0 {
        artifacts.manifest.model_params.rms_h_relax
    } else {
        MASP_RMS_H_RELAX
    };
    cfg.masp.validation_score_threshold =
        if artifacts.manifest.validation_rule.score_threshold > 0.0 {
            artifacts.manifest.validation_rule.score_threshold
        } else {
            MASP_SCORE_THRESHOLD
        };
    cfg.masp.weights = if artifacts.manifest.validation_rule.score_weights.har > 0.0
        || artifacts.manifest.validation_rule.score_weights.mbw > 0.0
        || artifacts.manifest.validation_rule.score_weights.cent > 0.0
        || artifacts.manifest.validation_rule.score_weights.rms > 0.0
    {
        artifacts.manifest.validation_rule.score_weights.clone()
    } else {
        MaspWeightsConfig {
            har: 0.164_539_95,
            mbw: 0.550_807_9,
            cent: 0.038_484_424,
            rms: 0.246_167_72,
        }
    };
}

fn build_context_fingerprint(update: &GameplayContextUpdate) -> String {
    let notes = update
        .expected_notes
        .iter()
        .map(|note| {
            format!(
                "{}:{}:{}:{:.4}:{:.4}",
                note.note_id, note.midi, note.string, note.onset_sec, note.offset_sec
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    format!(
        "{:.4}:{:.4}:{:.4}:{}:{}",
        update.playhead_sec,
        update.start_sec,
        update.end_sec,
        update
            .expected_midis
            .iter()
            .map(|midi| midi.to_string())
            .collect::<Vec<_>>()
            .join(","),
        notes
    )
}

fn decode_fretnet_output(
    output: &ModelOutput,
    capture_time_sec: f64,
    processing_time_ms: f64,
) -> Result<Option<DetectionEvent>, String> {
    let Some(decoded) = fretnet_decode_notes(output)? else {
        return Ok(None);
    };
    let Some(best) = decoded.first() else {
        return Ok(None);
    };
    Ok(Some(DetectionEvent {
        backend_name: "fretnet".to_owned(),
        timestamp_sec: capture_time_sec,
        pitch_hz: Some(midi_to_hz(best.midi)),
        midi_estimate: Some(best.midi),
        confidence: best.score.unwrap_or(0.0),
        selected_notes: decoded.clone(),
        chord_scores: Vec::new(),
        detected_string: best.string,
        detected_fret: best.fret,
        best_note_id: best.note_id.clone(),
        rejected_as_reference_bleed: None,
        reference_midi: None,
        reference_correlation: None,
        energy_ratio_db: None,
        onset_strength: None,
        contamination_score: None,
        validation_passed: None,
        reason: Some("fretnet_semantic_tablature".to_owned()),
        weighted_score: None,
        score_threshold: None,
        processing_time_ms,
        callback_to_result_latency_ms: 0.0,
    }))
}

fn fretnet_decode_notes(output: &ModelOutput) -> Result<Option<Vec<ResultNote>>, String> {
    if let Some(decoded) = fretnet_decode_from_semantic_tablature(output)? {
        return Ok(Some(decoded));
    }
    fretnet_decode_from_relative_tensor(output)
}

fn fretnet_decode_from_semantic_tablature(
    output: &ModelOutput,
) -> Result<Option<Vec<ResultNote>>, String> {
    let Some(tablature) = output.tensor("tablature") else {
        return Ok(None);
    };
    let last_frame_classes = fretnet_tablature_last_frame(&tablature.data).map_err(|error| {
        format!(
            "{error}; tensor=tablature shape={:?}; outputs={}",
            tablature.data.shape(),
            fretnet_output_shapes_summary(output)
        )
    })?;
    let onset_view = output
        .tensor("onsets")
        .map(|tensor| fretnet_onsets_last_frame(&tensor.data))
        .transpose()
        .map_err(|error| {
            format!(
                "{error}; tensor=onsets shape={:?}; outputs={}",
                output
                    .tensor("onsets")
                    .map(|tensor| tensor.data.shape().to_vec())
                    .unwrap_or_default(),
                fretnet_output_shapes_summary(output)
            )
        })?;
    let mut notes = Vec::new();
    for (string_index, fret_class) in last_frame_classes.iter().copied().enumerate() {
        if fret_class < 0 {
            continue;
        }
        let string = (string_index + 1) as u32;
        let fret = fret_class as u32;
        let Some(open_midi) = OPEN_MIDI.get(string_index).copied() else {
            continue;
        };
        let midi = open_midi as f32 + fret as f32;
        let score = onset_view
            .as_ref()
            .and_then(|values| values.get(string_index))
            .copied()
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        notes.push(ResultNote {
            note_id: Some(format!("fretnet_s{string}_f{fret}_m{}", midi as u32)),
            midi,
            string: Some(string),
            fret: Some(fret),
            score: Some(score),
        });
    }
    if notes.is_empty() {
        Ok(None)
    } else {
        notes.sort_by(|a, b| {
            b.score
                .unwrap_or(0.0)
                .total_cmp(&a.score.unwrap_or(0.0))
                .then_with(|| a.string.unwrap_or(0).cmp(&b.string.unwrap_or(0)))
        });
        Ok(Some(notes))
    }
}

fn fretnet_decode_from_relative_tensor(
    output: &ModelOutput,
) -> Result<Option<Vec<ResultNote>>, String> {
    let Some(tablature) = output
        .tensor("tablature_rel")
        .or_else(|| output.tensor("tablature"))
    else {
        return Ok(None);
    };
    let last_frame_scores =
        fretnet_relative_last_frame_scores(&tablature.data).map_err(|error| {
            format!(
                "{error}; tensor={} shape={:?}; outputs={}",
                tablature.name,
                tablature.data.shape(),
                fretnet_output_shapes_summary(output)
            )
        })?;
    let mut notes = Vec::new();

    for (string_index, class_scores) in last_frame_scores.iter().enumerate() {
        let silence_score = class_scores
            .get(FRETNET_RELATIVE_SILENCE_CLASS)
            .copied()
            .unwrap_or(f32::NEG_INFINITY);
        let Some((class_index, raw_score)) = class_scores
            .iter()
            .copied()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
        else {
            continue;
        };
        if class_index == FRETNET_RELATIVE_SILENCE_CLASS || raw_score <= silence_score {
            continue;
        }

        let fret = (class_index - 1) as u32;
        let string = (string_index + 1) as u32;
        let Some(open_midi) = OPEN_MIDI.get(string_index).copied() else {
            continue;
        };
        let midi = open_midi as f32 + fret as f32;
        let onset_score =
            fretnet_onset_score_for_note(output, string_index, fret).map_err(|error| {
                format!(
                    "{error}; tablature_tensor={} shape={:?}; outputs={}",
                    tablature.name,
                    tablature.data.shape(),
                    fretnet_output_shapes_summary(output)
                )
            })?;
        let confidence = onset_score
            .map(|value| 0.7 * raw_score.max(0.0) + 0.3 * value)
            .unwrap_or_else(|| raw_score.max(0.0))
            .clamp(0.0, 1.0);

        notes.push(ResultNote {
            note_id: Some(format!("fretnet_s{string}_f{fret}_m{}", midi as u32)),
            midi,
            string: Some(string),
            fret: Some(fret),
            score: Some(confidence),
        });
    }

    if notes.is_empty() {
        Ok(None)
    } else {
        notes.sort_by(|a, b| {
            b.score
                .unwrap_or(0.0)
                .total_cmp(&a.score.unwrap_or(0.0))
                .then_with(|| a.string.unwrap_or(0).cmp(&b.string.unwrap_or(0)))
        });
        Ok(Some(notes))
    }
}

fn fretnet_tablature_last_frame(data: &ndarray::ArrayD<f32>) -> Result<Vec<i32>, String> {
    match data.ndim() {
        3 => {
            let shape = data.shape();
            if shape[0] == 0 || shape[1] == 0 || shape[2] == 0 {
                return Err(format!(
                    "fretnet tablature tensor has zero-sized axis in shape {:?}",
                    shape
                ));
            }
            let batch_or_string = shape[0];
            let frame_or_string = shape[1];
            let class_or_frame = shape[2];
            if batch_or_string == 1 && class_or_frame % FRETNET_STRING_COUNT == 0 {
                let class_count = class_or_frame / FRETNET_STRING_COUNT;
                if class_count == 0 {
                    return Err(format!(
                        "fretnet tablature tensor flattened class count is zero for shape {:?}",
                        shape
                    ));
                }
                let last_frame = frame_or_string.saturating_sub(1);
                let mut out = Vec::with_capacity(FRETNET_STRING_COUNT);
                for string_index in 0..FRETNET_STRING_COUNT {
                    let class_offset = string_index * class_count;
                    let value = data
                        .get(IxDyn(&[0, last_frame, class_offset]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet semantic decode out-of-bounds at [0,{last_frame},{class_offset}] for shape {:?}",
                                shape
                            )
                        })?;
                    out.push(value.round() as i32);
                }
                return Ok(out);
            }
            if batch_or_string == 1 {
                let last_frame = class_or_frame.saturating_sub(1);
                let mut out = Vec::with_capacity(frame_or_string);
                for string_index in 0..frame_or_string {
                    let value = data
                        .get(IxDyn(&[0, string_index, last_frame]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet semantic decode out-of-bounds at [0,{string_index},{last_frame}] for shape {:?}",
                                shape
                            )
                        })?;
                    out.push(value.round() as i32);
                }
                return Ok(out);
            }
            let last_frame = class_or_frame.saturating_sub(1);
            let mut out = Vec::with_capacity(batch_or_string);
            for string_index in 0..batch_or_string {
                let value = data
                    .get(IxDyn(&[string_index, 0, last_frame]))
                    .copied()
                    .ok_or_else(|| {
                        format!(
                            "fretnet semantic decode out-of-bounds at [{string_index},0,{last_frame}] for shape {:?}",
                            shape
                        )
                    })?;
                out.push(value.round() as i32);
            }
            Ok(out)
        }
        2 => {
            let shape = data.shape();
            if shape[0] == 0 || shape[1] == 0 {
                return Err(format!(
                    "fretnet tablature tensor has zero-sized axis in shape {:?}",
                    shape
                ));
            }
            let last_frame = shape[1].saturating_sub(1);
            let mut out = Vec::with_capacity(shape[0]);
            for string_index in 0..shape[0] {
                let value = data
                    .get(IxDyn(&[string_index, last_frame]))
                    .copied()
                    .ok_or_else(|| {
                        format!(
                            "fretnet semantic decode out-of-bounds at [{string_index},{last_frame}] for shape {:?}",
                            shape
                        )
                    })?;
                out.push(value.round() as i32);
            }
            Ok(out)
        }
        _ => Err(format!(
            "fretnet semantic tablature tensor rank {} unsupported (shape {:?})",
            data.ndim(),
            data.shape()
        )),
    }
}

fn fretnet_relative_last_frame_scores(
    data: &ndarray::ArrayD<f32>,
) -> Result<Vec<Vec<f32>>, String> {
    match data.ndim() {
        4 => {
            let shape = data.shape();
            if shape[1] == 0 || shape[2] == 0 || shape[3] == 0 {
                return Err(format!(
                    "fretnet relative tablature tensor has zero-sized axis in shape {:?}",
                    shape
                ));
            }
            let last_frame = shape[1].saturating_sub(1);
            let string_count = shape[2];
            let class_count = shape[3];
            let mut per_string = Vec::with_capacity(string_count);
            for string_index in 0..string_count {
                let mut classes = Vec::with_capacity(class_count);
                for class_index in 0..class_count {
                    let value = data
                        .get(IxDyn(&[0, last_frame, string_index, class_index]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet relative decode out-of-bounds at [0,{last_frame},{string_index},{class_index}] for shape {:?}",
                                shape
                            )
                        })?;
                    classes.push(value);
                }
                per_string.push(classes);
            }
            Ok(per_string)
        }
        3 => {
            let shape = data.shape();
            if shape[0] == 0 || shape[1] == 0 || shape[2] == 0 {
                return Err(format!(
                    "fretnet relative tablature tensor has zero-sized axis in shape {:?}",
                    shape
                ));
            }
            if shape[0] == 1 && shape[2] % FRETNET_STRING_COUNT == 0 {
                let frame_count = shape[1];
                let flattened_positions = shape[2];
                let class_count = flattened_positions / FRETNET_STRING_COUNT;
                if class_count == 0 {
                    return Err(format!(
                        "fretnet relative decode flattened class count is zero for shape {:?}",
                        shape
                    ));
                }
                let last_frame = frame_count.saturating_sub(1);
                let mut per_string = Vec::with_capacity(FRETNET_STRING_COUNT);
                for string_index in 0..FRETNET_STRING_COUNT {
                    let row_start = string_index * class_count;
                    let mut classes = Vec::with_capacity(class_count);
                    for class_index in 0..class_count {
                        let flattened_index = row_start + class_index;
                        let value = data
                            .get(IxDyn(&[0, last_frame, flattened_index]))
                            .copied()
                            .ok_or_else(|| {
                                format!(
                                    "fretnet relative decode out-of-bounds at [0,{last_frame},{flattened_index}] for shape {:?}",
                                    shape
                                )
                            })?;
                        classes.push(value);
                    }
                    per_string.push(classes);
                }
                return Ok(per_string);
            }

            let last_frame = shape[0].saturating_sub(1);
            let string_count = shape[1];
            let class_count = shape[2];
            let mut per_string = Vec::with_capacity(string_count);
            for string_index in 0..string_count {
                let mut classes = Vec::with_capacity(class_count);
                for class_index in 0..class_count {
                    let value = data
                        .get(IxDyn(&[last_frame, string_index, class_index]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet relative decode out-of-bounds at [{last_frame},{string_index},{class_index}] for shape {:?}",
                                shape
                            )
                        })?;
                    classes.push(value);
                }
                per_string.push(classes);
            }
            Ok(per_string)
        }
        2 => {
            let shape = data.shape();
            let flattened_positions = shape[0];
            let frame_count = shape[1];
            if flattened_positions == 0
                || frame_count == 0
                || flattened_positions % FRETNET_STRING_COUNT != 0
            {
                return Err(format!(
                    "fretnet relative decode cannot reshape tensor with shape {:?} into (strings={}, classes, frames)",
                    shape,
                    FRETNET_STRING_COUNT
                ));
            }
            let class_count = flattened_positions / FRETNET_STRING_COUNT;
            let last_frame = frame_count.saturating_sub(1);
            let mut per_string = Vec::with_capacity(FRETNET_STRING_COUNT);
            for string_index in 0..FRETNET_STRING_COUNT {
                let row_start = string_index * class_count;
                let mut classes = Vec::with_capacity(class_count);
                for class_index in 0..class_count {
                    let flattened_index = row_start + class_index;
                    let value = data
                        .get(IxDyn(&[flattened_index, last_frame]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet relative decode out-of-bounds at [{flattened_index},{last_frame}] for shape {:?}",
                                shape
                            )
                        })?;
                    classes.push(value);
                }
                per_string.push(classes);
            }
            Ok(per_string)
        }
        _ => Err(format!(
            "fretnet relative tablature tensor rank {} unsupported (shape {:?})",
            data.ndim(),
            data.shape()
        )),
    }
}

fn fretnet_onsets_last_frame(data: &ndarray::ArrayD<f32>) -> Result<Vec<f32>, String> {
    match data.ndim() {
        4 => {
            let shape = data.shape();
            if shape[1] == 0 || shape[2] == 0 || shape[3] == 0 {
                return Err(format!(
                    "fretnet onsets tensor has zero-sized axis in shape {:?}",
                    shape
                ));
            }
            let last_frame = shape[3].saturating_sub(1);
            let mut out = Vec::with_capacity(shape[1]);
            for string_index in 0..shape[1] {
                let mut best = 0.0_f32;
                for pitch_index in 0..shape[2] {
                    let value = data
                        .get(IxDyn(&[0, string_index, pitch_index, last_frame]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet onsets decode out-of-bounds at [0,{string_index},{pitch_index},{last_frame}] for shape {:?}",
                                shape
                            )
                        })?;
                    best = best.max(value);
                }
                out.push(best);
            }
            Ok(out)
        }
        3 => {
            let shape = data.shape();
            if shape[0] == 0 || shape[1] == 0 || shape[2] == 0 {
                return Err(format!(
                    "fretnet onsets tensor has zero-sized axis in shape {:?}",
                    shape
                ));
            }
            if shape[0] == 1 && shape[2] % FRETNET_STRING_COUNT == 0 {
                let frame_count = shape[1];
                let flattened = shape[2];
                let pitch_count = flattened / FRETNET_STRING_COUNT;
                if pitch_count == 0 {
                    return Err(format!(
                        "fretnet onsets flattened pitch count is zero for shape {:?}",
                        shape
                    ));
                }
                let last_frame = frame_count.saturating_sub(1);
                let mut out = Vec::with_capacity(FRETNET_STRING_COUNT);
                for string_index in 0..FRETNET_STRING_COUNT {
                    let base = string_index * pitch_count;
                    let mut best = 0.0_f32;
                    for pitch_index in 0..pitch_count {
                        let flattened_index = base + pitch_index;
                        let value = data
                            .get(IxDyn(&[0, last_frame, flattened_index]))
                            .copied()
                            .ok_or_else(|| {
                                format!(
                                    "fretnet onsets decode out-of-bounds at [0,{last_frame},{flattened_index}] for shape {:?}",
                                    shape
                                )
                            })?;
                        best = best.max(value);
                    }
                    out.push(best);
                }
                return Ok(out);
            }
            let last_frame = shape[2].saturating_sub(1);
            let mut out = Vec::with_capacity(shape[0]);
            for string_index in 0..shape[0] {
                let mut best = 0.0_f32;
                for pitch_index in 0..shape[1] {
                    let value = data
                        .get(IxDyn(&[string_index, pitch_index, last_frame]))
                        .copied()
                        .ok_or_else(|| {
                            format!(
                                "fretnet onsets decode out-of-bounds at [{string_index},{pitch_index},{last_frame}] for shape {:?}",
                                shape
                            )
                        })?;
                    best = best.max(value);
                }
                out.push(best);
            }
            Ok(out)
        }
        _ => Err(format!(
            "fretnet onsets tensor rank {} unsupported (shape {:?})",
            data.ndim(),
            data.shape()
        )),
    }
}

fn fretnet_onset_score_for_note(
    output: &ModelOutput,
    string_index: usize,
    fret: u32,
) -> Result<Option<f32>, String> {
    let Some(onset_tensor) = output.tensor("onsets") else {
        return Ok(None);
    };
    let Some(open_midi) = OPEN_MIDI.get(string_index).copied() else {
        return Ok(None);
    };
    let Some(base_midi) = OPEN_MIDI.first().copied() else {
        return Ok(None);
    };
    let absolute_midi = open_midi as usize + fret as usize;
    let base_midi = base_midi as usize;
    let pitch_index = absolute_midi.saturating_sub(base_midi);

    match onset_tensor.data.ndim() {
        4 => {
            let shape = onset_tensor.data.shape();
            if shape[1] == 0 || shape[2] == 0 || shape[3] == 0 {
                return Ok(None);
            }
            if string_index >= shape[1] {
                return Ok(None);
            }
            let last_frame = shape[3].saturating_sub(1);
            let pitch_limit = shape[2];
            let safe_pitch_index = pitch_index.min(pitch_limit.saturating_sub(1));
            Ok(onset_tensor
                .data
                .get(IxDyn(&[0, string_index, safe_pitch_index, last_frame]))
                .copied()
                .map(|value| value.clamp(0.0, 1.0)))
        }
        3 => {
            let shape = onset_tensor.data.shape();
            if shape[0] == 0 || shape[1] == 0 || shape[2] == 0 {
                return Ok(None);
            }
            if shape[0] == 1 && shape[2] % FRETNET_STRING_COUNT == 0 {
                if string_index >= FRETNET_STRING_COUNT {
                    return Ok(None);
                }
                let frame_count = shape[1];
                let flattened = shape[2];
                let pitch_count = flattened / FRETNET_STRING_COUNT;
                if pitch_count == 0 {
                    return Ok(None);
                }
                let last_frame = frame_count.saturating_sub(1);
                let safe_pitch_index = pitch_index.min(pitch_count.saturating_sub(1));
                let flattened_index = string_index * pitch_count + safe_pitch_index;
                return Ok(onset_tensor
                    .data
                    .get(IxDyn(&[0, last_frame, flattened_index]))
                    .copied()
                    .map(|value| value.clamp(0.0, 1.0)));
            }
            if string_index >= shape[0] {
                return Ok(None);
            }
            let last_frame = shape[2].saturating_sub(1);
            let pitch_limit = shape[1];
            let safe_pitch_index = pitch_index.min(pitch_limit.saturating_sub(1));
            Ok(onset_tensor
                .data
                .get(IxDyn(&[string_index, safe_pitch_index, last_frame]))
                .copied()
                .map(|value| value.clamp(0.0, 1.0)))
        }
        _ => Ok(None),
    }
}

fn fretnet_output_shapes_summary(output: &ModelOutput) -> String {
    output
        .tensors
        .iter()
        .map(|tensor| format!("{}={:?}", tensor.name, tensor.data.shape()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn resolve_existing_path(path: &str) -> Result<PathBuf, String> {
    let resolved = PathBuf::from(path);
    if resolved.exists() {
        Ok(resolved)
    } else {
        Err(format!("Path does not exist: {}", resolved.display()))
    }
}

fn seconds_to_sample_index(offset_sec: f64, sample_rate: u32) -> usize {
    ((offset_sec.max(0.0)) * sample_rate as f64).round() as usize
}

fn midi_to_hz(midi: f32) -> f32 {
    440.0 * (2.0_f32).powf((midi - 69.0) / 12.0)
}

unsafe fn parse_c_string<'a>(ptr: *const c_char, field: &str) -> Result<&'a str, String> {
    if ptr.is_null() {
        return Err(format!("{field} must not be null"));
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map_err(|error| format!("Invalid UTF-8 in {field}: {error}"))
}

fn into_c_string(value: String) -> *mut c_char {
    CString::new(value)
        .unwrap_or_else(|_| CString::new("invalid string").unwrap())
        .into_raw()
}

fn write_optional_string(target: *mut *mut c_char, value: Option<String>) {
    if target.is_null() {
        return;
    }
    unsafe {
        *target = value.map(into_c_string).unwrap_or(std::ptr::null_mut());
    }
}

fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "unknown panic payload".to_owned()
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_new(
    config_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut NativePitchRuntimeHandle {
    set_init_stage("runtime_new:enter");
    write_optional_string(error_out, None);
    let guarded = catch_unwind(AssertUnwindSafe(|| unsafe {
        set_init_stage("runtime_new:parse_config_json");
        parse_c_string(config_json, "config_json").and_then(|text| {
            let config: RuntimeConfig = serde_json::from_str(text)
                .map_err(|error| format!("Invalid runtime config JSON: {error}"))?;
            set_init_stage(format!(
                "runtime_new:create_detector backend={}",
                config.backend_name
            ));
            let detector = DetectorKind::new(config)?;
            set_init_stage("runtime_new:detector_created");
            Ok(NativePitchRuntimeHandle { detector })
        })
    }));

    let result = match guarded {
        Ok(result) => result,
        Err(payload) => {
            set_init_stage("runtime_new:panic");
            write_optional_string(
                error_out,
                Some(format!(
                    "native runtime panic in gh_native_pitch_runtime_new: {}",
                    panic_payload_to_string(payload)
                )),
            );
            return std::ptr::null_mut();
        }
    };

    match result {
        Ok(handle) => {
            set_init_stage("runtime_new:success");
            Box::into_raw(Box::new(handle))
        }
        Err(error) => {
            set_init_stage(format!("runtime_new:error:{error}"));
            write_optional_string(error_out, Some(error));
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_get_last_init_stage() -> *mut c_char {
    into_c_string(current_init_stage())
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_destroy(handle: *mut NativePitchRuntimeHandle) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if handle.is_null() {
            return;
        }
        unsafe {
            drop(Box::from_raw(handle));
        }
    }));
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_reset(handle: *mut NativePitchRuntimeHandle) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if handle.is_null() {
            return;
        }
        unsafe {
            (*handle).detector.reset();
        }
    }));
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_update_gameplay_context(
    handle: *mut NativePitchRuntimeHandle,
    context_json: *const c_char,
) -> *mut c_char {
    let guarded = catch_unwind(AssertUnwindSafe(|| unsafe {
        if handle.is_null() {
            return Err("runtime handle is null".to_owned());
        }
        parse_c_string(context_json, "context_json")
            .and_then(|text| (*handle).detector.update_gameplay_context(text))
    }));

    let result = match guarded {
        Ok(result) => result,
        Err(payload) => Err(format!(
            "native runtime panic in gh_native_pitch_runtime_update_gameplay_context: {}",
            panic_payload_to_string(payload)
        )),
    };

    match result {
        Ok(()) => std::ptr::null_mut(),
        Err(error) => into_c_string(error),
    }
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_process_audio_block(
    handle: *mut NativePitchRuntimeHandle,
    samples: *const c_float,
    sample_count: usize,
    capture_time_sec: f64,
    result_json_out: *mut *mut c_char,
) -> *mut c_char {
    write_optional_string(result_json_out, None);
    let guarded = catch_unwind(AssertUnwindSafe(|| unsafe {
        if handle.is_null() {
            return Err("runtime handle is null".to_owned());
        }
        if samples.is_null() && sample_count > 0 {
            return Err("samples must not be null".to_owned());
        }
        let slice = if sample_count == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(samples, sample_count)
        };
        (*handle)
            .detector
            .process_audio_block(slice, capture_time_sec)
            .and_then(|event| {
                event
                    .map(|payload| {
                        serde_json::to_string(&payload).map_err(|error| {
                            format!("Failed to serialize detector result: {error}")
                        })
                    })
                    .transpose()
            })
    }));

    let result = match guarded {
        Ok(result) => result,
        Err(payload) => Err(format!(
            "native runtime panic in gh_native_pitch_runtime_process_audio_block: {}",
            panic_payload_to_string(payload)
        )),
    };

    match result {
        Ok(Some(json)) => {
            write_optional_string(result_json_out, Some(json));
            std::ptr::null_mut()
        }
        Ok(None) => std::ptr::null_mut(),
        Err(error) => into_c_string(error),
    }
}

#[no_mangle]
pub extern "C" fn gh_native_pitch_runtime_free_string(value: *mut c_char) {
    if value.is_null() {
        return;
    }
    unsafe {
        drop(CString::from_raw(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ndarray::{Array2, Array3};

    fn test_artifacts_with_manifest_overrides(
        mode: &str,
        strict_sample_rate: u32,
        bins_per_octave: usize,
        max_harmonics: usize,
        rms_window_ms: u32,
    ) -> MaspPretrainArtifacts {
        serde_json::from_value(json!({
            "manifest": {
                "version": 1,
                "config_hash": 123,
                "model_params": {
                    "mode": mode,
                    "strict_sample_rate": strict_sample_rate,
                    "bins_per_octave": bins_per_octave,
                    "max_harmonics": max_harmonics,
                    "b_exponent": 0.7726795,
                    "cent_tolerance": 50.0,
                    "rms_window_ms": rms_window_ms,
                    "rms_h_relax": 0.25,
                    "pretrain_trials": 64
                },
                "validation_rule": {
                    "score_threshold": 0.4370982,
                    "score_weights": {
                        "har": 0.16453995,
                        "mbw": 0.5508079,
                        "cent": 0.038484424,
                        "rms": 0.24616772
                    },
                    "target_mono_recall": 0.0,
                    "target_comp_recall": 0.0,
                    "calibrated_precision": null,
                    "calibrated_mono_recall": null,
                    "calibrated_comp_recall": null
                },
                "mode": mode,
                "strict_sample_rate": strict_sample_rate,
                "bins_per_octave": bins_per_octave,
                "max_harmonics": max_harmonics,
                "b_exponent": 0.7726795,
                "cent_tolerance": 50.0,
                "rms_window_ms": rms_window_ms,
                "rms_h_relax": 0.25,
                "validation_score_threshold": 0.4370982,
                "pretrain_trials": 64,
                "target_mono_recall": 0.0,
                "target_comp_recall": 0.0,
                "calibrated_precision": null,
                "calibrated_mono_recall": null,
                "calibrated_comp_recall": null,
                "weights": {
                    "har": 0.16453995,
                    "mbw": 0.5508079,
                    "cent": 0.038484424,
                    "rms": 0.24616772
                }
            },
            "note_signatures": [],
            "joint_signatures": []
        }))
        .expect("valid MASP test artifacts")
    }

    #[test]
    fn fretnet_relative_decoder_reshapes_flattened_string_classes() {
        let mut output = ModelOutput {
            tensors: Vec::new(),
        };
        let mut data = Array2::<f32>::zeros((120, 4));
        data[[41, 3]] = 0.92;
        output.tensors.push(fretnet_runtime::NamedTensorOutput {
            name: "tablature_rel".to_owned(),
            data: data.into_dyn(),
        });

        let decoded = fretnet_decode_from_relative_tensor(&output)
            .expect("decode")
            .expect("notes");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].string, Some(3));
        assert_eq!(decoded[0].fret, Some(0));
        assert!((decoded[0].midi - 50.0).abs() < 1e-6);
    }

    #[test]
    fn fretnet_semantic_decoder_skips_silence_class() {
        let mut output = ModelOutput {
            tensors: Vec::new(),
        };
        let mut data = Array2::<f32>::from_elem((FRETNET_STRING_COUNT, 2), -1.0);
        data[[0, 1]] = -1.0;
        data[[1, 1]] = 0.0;
        output.tensors.push(fretnet_runtime::NamedTensorOutput {
            name: "tablature".to_owned(),
            data: data.into_dyn(),
        });

        let decoded = fretnet_decode_from_semantic_tablature(&output)
            .expect("decode")
            .expect("notes");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].string, Some(2));
        assert_eq!(decoded[0].fret, Some(0));
    }

    #[test]
    fn fretnet_relative_decoder_supports_rank3_flattened_layout() {
        let mut output = ModelOutput {
            tensors: Vec::new(),
        };
        let mut tablature_rel = Array3::<f32>::from_elem((1, 4, 120), -0.5);
        tablature_rel[[0, 3, 41]] = 0.95;
        let mut onsets = Array3::<f32>::zeros((1, 4, 120));
        onsets[[0, 3, 41]] = 0.8;
        output.tensors.push(fretnet_runtime::NamedTensorOutput {
            name: "tablature_rel".to_owned(),
            data: tablature_rel.into_dyn(),
        });
        output.tensors.push(fretnet_runtime::NamedTensorOutput {
            name: "onsets".to_owned(),
            data: onsets.into_dyn(),
        });

        let decoded = fretnet_decode_from_relative_tensor(&output)
            .expect("decode")
            .expect("notes");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].string, Some(3));
        assert_eq!(decoded[0].fret, Some(0));
        assert!(decoded[0].score.unwrap_or_default() > 0.5);
    }

    #[test]
    fn fretnet_relative_decoder_handles_onset_string_axis_mismatch_without_panic() {
        let mut output = ModelOutput {
            tensors: Vec::new(),
        };
        let mut tablature_rel = Array3::<f32>::from_elem((1, 4, 120), -0.5);
        tablature_rel[[0, 3, 41]] = 0.9;
        let onsets_mismatched = Array3::<f32>::zeros((1, 4, 60));
        output.tensors.push(fretnet_runtime::NamedTensorOutput {
            name: "tablature_rel".to_owned(),
            data: tablature_rel.into_dyn(),
        });
        output.tensors.push(fretnet_runtime::NamedTensorOutput {
            name: "onsets".to_owned(),
            data: onsets_mismatched.into_dyn(),
        });

        let decoded = fretnet_decode_from_relative_tensor(&output)
            .expect("decode")
            .expect("notes");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].string, Some(3));
        assert_eq!(decoded[0].fret, Some(0));
    }

    #[test]
    fn capture_buffer_extracts_recent_window() {
        let mut buffer = CaptureBuffer::new(100, 2.0);
        buffer.push_block(&vec![0.0; 100], 1.0);
        buffer.push_block(&vec![1.0; 100], 2.0);
        let (window, _) = buffer.extract_window(1.0, 2.0).expect("window");
        assert_eq!(window.len(), 100);
        assert!(window.iter().all(|sample| (*sample - 1.0).abs() < 1e-6));
    }

    #[test]
    fn apply_masp_manifest_honors_non_default_manifest_values() {
        let artifacts =
            test_artifacts_with_manifest_overrides("compat", 16_000, 24, 6, 25);
        let mut cfg = AppConfig::default();

        apply_masp_manifest_to_config(&mut cfg, &artifacts);

        assert_eq!(cfg.masp.mode, "compat");
        assert_eq!(cfg.masp.strict_sample_rate, 16_000);
        assert_eq!(cfg.masp.bins_per_octave, 24);
        assert_eq!(cfg.masp.max_harmonics, 6);
        assert_eq!(cfg.masp.rms_window_ms, 25);
    }

    #[test]
    fn apply_masp_manifest_uses_safe_defaults_when_manifest_values_are_zero() {
        let artifacts = test_artifacts_with_manifest_overrides("", 0, 0, 0, 0);
        let mut cfg = AppConfig::default();

        apply_masp_manifest_to_config(&mut cfg, &artifacts);

        assert_eq!(cfg.masp.mode, "strict");
        assert_eq!(cfg.masp.strict_sample_rate, 22_050);
        assert_eq!(cfg.masp.bins_per_octave, MASP_BINS_PER_OCTAVE);
        assert_eq!(cfg.masp.max_harmonics, MASP_MAX_HARMONICS);
        assert_eq!(cfg.masp.rms_window_ms, MASP_RMS_WINDOW_MS);
    }
}
