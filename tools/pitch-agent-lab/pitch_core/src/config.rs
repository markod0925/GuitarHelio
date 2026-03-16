use crate::types::{
    CandidateListConfig, CandidateSpec, DatasetConfig, GatesConfig, SearchSpaceConfig,
    WebResearchRecord,
};
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub fn load_dataset_config(path: &Path) -> Result<DatasetConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read dataset config {:?}", path))?;
    let cfg: DatasetConfig = toml::from_str(&raw)
        .with_context(|| format!("failed to parse dataset config {:?}", path))?;
    Ok(cfg)
}

pub fn load_candidates_config(path: &Path) -> Result<CandidateListConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read candidates config {:?}", path))?;
    let cfg: CandidateListConfig = toml::from_str(&raw)
        .with_context(|| format!("failed to parse candidates config {:?}", path))?;
    Ok(cfg)
}

pub fn write_candidates_config(path: &Path, candidates: &[CandidateSpec]) -> Result<()> {
    let payload = CandidateListConfig {
        candidates: candidates.to_vec(),
    };
    let raw = toml::to_string_pretty(&payload).context("failed to serialize candidates config")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("failed to create {:?}", parent))?;
    }
    fs::write(path, raw)
        .with_context(|| format!("failed to write candidates config {:?}", path))?;
    Ok(())
}

pub fn load_gates_config(path: &Path) -> Result<GatesConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read gates config {:?}", path))?;
    let cfg: GatesConfig =
        toml::from_str(&raw).with_context(|| format!("failed to parse gates config {:?}", path))?;
    Ok(cfg)
}

pub fn load_search_space_config(path: &Path) -> Result<SearchSpaceConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read search space config {:?}", path))?;
    let cfg: SearchSpaceConfig = toml::from_str(&raw)
        .with_context(|| format!("failed to parse search space config {:?}", path))?;
    Ok(cfg)
}

pub fn load_web_research_records(path: &Path) -> Result<Vec<WebResearchRecord>> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read web research file {:?}", path))?;
    let records: Vec<WebResearchRecord> = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse web research file {:?}", path))?;
    Ok(records)
}

pub fn resolve_from_config_dir(config_path: &Path, raw_path: &str) -> PathBuf {
    let candidate = Path::new(raw_path);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    let base = config_path.parent().unwrap_or_else(|| Path::new("."));
    base.join(candidate)
}
