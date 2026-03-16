use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AlgorithmKind {
    Yin,
    Autocorr,
    Mpm,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceMeta {
    #[serde(default = "default_source_kind")]
    pub kind: String,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub vendored: bool,
    #[serde(default)]
    pub notes: Option<String>,
}

fn default_source_kind() -> String {
    "internal".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateSpec {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    pub algorithm: AlgorithmKind,
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
    #[serde(default)]
    pub source: SourceMeta,
}

impl CandidateSpec {
    pub fn label_or_id(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.id)
    }

    pub fn param_f64(&self, key: &str, default: f64) -> f64 {
        self.params.get(key).copied().unwrap_or(default)
    }

    pub fn param_u32(&self, key: &str, default: u32) -> u32 {
        let value = self.param_f64(key, default as f64);
        if !value.is_finite() {
            return default;
        }
        value.round().max(0.0) as u32
    }

    pub fn param_bool(&self, key: &str, default: bool) -> bool {
        if let Some(value) = self.params.get(key) {
            return *value >= 0.5;
        }
        default
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateListConfig {
    pub candidates: Vec<CandidateSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetTakeConfig {
    pub id: String,
    pub manifest: String,
    pub wav: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetConfig {
    pub takes: Vec<DatasetTakeConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub events: Vec<ManifestEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEvent {
    #[serde(default)]
    pub note_order: i32,
    #[serde(default)]
    pub note: Option<String>,
    pub midi: f32,
    pub start_s: f64,
    pub end_s: f64,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    pub string: Option<String>,
    #[serde(default)]
    pub fret: Option<u32>,
}

fn deserialize_optional_string_like<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    let out = match value {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(raw)) => Some(raw),
        Some(serde_json::Value::Number(num)) => Some(num.to_string()),
        Some(other) => Some(other.to_string()),
    };
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatesConfig {
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f32,
    #[serde(default = "default_required_detect_rate")]
    pub required_detect_rate: f32,
    #[serde(default = "default_min_realtime_factor")]
    pub min_realtime_factor: f64,
    #[serde(default = "default_adaptive_trim")]
    pub adaptive_trim: bool,
    #[serde(default = "default_trim_attack_min_ms")]
    pub trim_attack_min_ms: f64,
    #[serde(default = "default_trim_attack_max_ms")]
    pub trim_attack_max_ms: f64,
    #[serde(default = "default_trim_release_min_ms")]
    pub trim_release_min_ms: f64,
    #[serde(default = "default_trim_release_max_ms")]
    pub trim_release_max_ms: f64,
    #[serde(default = "default_attack_ratio")]
    pub trim_attack_ratio: f64,
    #[serde(default = "default_release_ratio")]
    pub trim_release_ratio: f64,
}

impl Default for GatesConfig {
    fn default() -> Self {
        Self {
            min_confidence: default_min_confidence(),
            required_detect_rate: default_required_detect_rate(),
            min_realtime_factor: default_min_realtime_factor(),
            adaptive_trim: default_adaptive_trim(),
            trim_attack_min_ms: default_trim_attack_min_ms(),
            trim_attack_max_ms: default_trim_attack_max_ms(),
            trim_release_min_ms: default_trim_release_min_ms(),
            trim_release_max_ms: default_trim_release_max_ms(),
            trim_attack_ratio: default_attack_ratio(),
            trim_release_ratio: default_release_ratio(),
        }
    }
}

fn default_min_confidence() -> f32 {
    0.70
}
fn default_required_detect_rate() -> f32 {
    1.0
}
fn default_min_realtime_factor() -> f64 {
    8.0
}
fn default_adaptive_trim() -> bool {
    true
}
fn default_trim_attack_min_ms() -> f64 {
    20.0
}
fn default_trim_attack_max_ms() -> f64 {
    120.0
}
fn default_trim_release_min_ms() -> f64 {
    20.0
}
fn default_trim_release_max_ms() -> f64 {
    100.0
}
fn default_attack_ratio() -> f64 {
    0.08
}
fn default_release_ratio() -> f64 {
    0.06
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitchFrame {
    pub t_seconds: f64,
    pub midi_estimate: Option<f32>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub note_order: i32,
    pub note: Option<String>,
    pub midi: f32,
    pub detect_rate: f32,
    pub total_frames: u32,
    pub valid_frames: u32,
    pub in_tune_rate: f32,
    pub median_abs_cents: Option<f32>,
    pub pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeMetrics {
    pub take_id: String,
    pub total_frames: u32,
    pub valid_frames: u32,
    pub detect_rate: f32,
    pub in_tune_rate: f32,
    pub strict_pass: bool,
    pub note_summaries: Vec<NoteSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrictMatrixEntry {
    pub take_id: String,
    pub note_order: i32,
    pub note: Option<String>,
    pub pass: bool,
    pub detect_rate: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateRunResult {
    pub id: String,
    pub label: String,
    pub algorithm: AlgorithmKind,
    pub params: BTreeMap<String, f64>,
    pub source: SourceMeta,
    pub take_metrics: Vec<TakeMetrics>,
    pub strict_matrix: Vec<StrictMatrixEntry>,
    pub global_detect_rate: f32,
    pub global_in_tune_rate: f32,
    pub runtime_ms_total: f64,
    pub analyzed_duration_s_total: f64,
    pub cpu_ms_per_audio_s: f64,
    pub realtime_factor: f64,
    pub pass_realtime: bool,
    pub full_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingEntry {
    pub rank: usize,
    pub id: String,
    pub label: String,
    pub full_pass: bool,
    pub global_detect_rate: f32,
    pub global_in_tune_rate: f32,
    pub realtime_factor: f64,
    pub cpu_ms_per_audio_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunMetadata {
    pub generated_at_utc: String,
    pub command_line: Vec<String>,
    pub git_commit: Option<String>,
    pub rustc_version: Option<String>,
    pub cargo_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkRunResult {
    pub dataset_path: String,
    pub candidates_path: String,
    pub gates_path: String,
    pub metadata: RunMetadata,
    pub gates: GatesConfig,
    pub ranking: Vec<RankingEntry>,
    pub candidates: Vec<CandidateRunResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamRange {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamilySearchSpace {
    pub name: String,
    pub algorithm: AlgorithmKind,
    pub count: usize,
    #[serde(default)]
    pub id_prefix: Option<String>,
    #[serde(default)]
    pub fixed: BTreeMap<String, f64>,
    #[serde(default)]
    pub ranges: BTreeMap<String, ParamRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSpaceConfig {
    pub families: Vec<FamilySearchSpace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebResearchRecord {
    #[serde(default)]
    pub algorithm: Option<AlgorithmKind>,
    pub source_url: String,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub vendored: bool,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub reference: Option<String>,
}
