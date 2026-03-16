use anyhow::Result;
use pitch_core::{
    AlgorithmKind, CandidateSpec, FamilySearchSpace, SearchSpaceConfig, SourceMeta,
    WebResearchRecord,
};
use rand::{rngs::StdRng, Rng, SeedableRng};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileGateResult {
    pub success: bool,
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveWebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
    pub algorithm_hint: Option<AlgorithmKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveWebSearchReport {
    pub provider: String,
    pub query: String,
    pub fetched_at_utc: String,
    pub results: Vec<LiveWebSearchResult>,
    pub errors: Vec<String>,
}

pub fn run_compile_gate(workspace_root: &Path) -> CompileGateResult {
    run_compile_gate_with_extra(workspace_root, &[])
}

pub fn run_compile_gate_with_extra(
    workspace_root: &Path,
    extra_args: &[&str],
) -> CompileGateResult {
    match Command::new("cargo")
        .args(["build", "--release"])
        .args(extra_args)
        .current_dir(workspace_root)
        .output()
    {
        Ok(output) => CompileGateResult {
            success: output.status.success(),
            status_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(error) => CompileGateResult {
            success: false,
            status_code: None,
            stdout: String::new(),
            stderr: error.to_string(),
        },
    }
}

pub fn run_live_web_search(
    query: &str,
    max_results: usize,
    timeout_seconds: u64,
) -> LiveWebSearchReport {
    let mut report = LiveWebSearchReport {
        provider: "duckduckgo_html".to_owned(),
        query: query.to_owned(),
        fetched_at_utc: iso_utc_now(),
        results: Vec::new(),
        errors: Vec::new(),
    };
    if query.trim().is_empty() || max_results == 0 {
        return report;
    }

    let encoded_query = urlencoding::encode(query);
    let url = format!("https://duckduckgo.com/html/?q={}", encoded_query);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout_seconds.max(2)))
        .build();

    let response = agent
        .get(&url)
        .set("User-Agent", "GuitarHelioPitchAgent/0.1")
        .call();

    let html = match response {
        Ok(resp) => match resp.into_string() {
            Ok(raw) => raw,
            Err(error) => {
                report
                    .errors
                    .push(format!("failed to read response body: {error}"));
                return report;
            }
        },
        Err(error) => {
            report
                .errors
                .push(format!("web search request failed: {error}"));
            return report;
        }
    };

    report.results = parse_duckduckgo_html_results(&html, max_results);
    report
}

pub fn web_records_from_live_report(report: &LiveWebSearchReport) -> Vec<WebResearchRecord> {
    let mut out = Vec::new();
    for item in &report.results {
        out.push(WebResearchRecord {
            algorithm: item.algorithm_hint,
            source_url: item.url.clone(),
            license: None,
            vendored: false,
            notes: item.snippet.clone(),
            reference: Some(item.title.clone()),
        });
    }
    out
}

pub fn generate_candidates(
    search_space: &SearchSpaceConfig,
    web_records: &[WebResearchRecord],
    budget: usize,
    seed: u64,
) -> Vec<CandidateSpec> {
    let mut out = Vec::new();
    let mut ids = HashSet::<String>::new();
    let mut rng = StdRng::seed_from_u64(seed);

    for baseline in baseline_candidates() {
        if out.len() >= budget {
            return out;
        }
        ids.insert(baseline.id.clone());
        out.push(baseline);
    }

    let guided_budget = budget.saturating_sub(out.len()).min(24);
    let guided = guided_candidates_from_web(
        web_records,
        guided_budget,
        seed.wrapping_add(1337),
        &mut ids,
    );
    for candidate in guided {
        if out.len() >= budget {
            return out;
        }
        out.push(candidate);
    }

    for family in &search_space.families {
        for index in 0..family.count {
            if out.len() >= budget {
                return out;
            }
            let mut params = family.fixed.clone();
            for (name, range) in &family.ranges {
                let value = if range.min <= range.max {
                    rng.random_range(range.min..=range.max)
                } else {
                    rng.random_range(range.max..=range.min)
                };
                params.insert(name.clone(), value);
            }

            let id_prefix = family
                .id_prefix
                .clone()
                .unwrap_or_else(|| family.name.clone());
            let mut id = format!("{}_{}", id_prefix, index + 1);
            while ids.contains(&id) {
                id.push('x');
            }
            ids.insert(id.clone());

            let source = source_for_algorithm(family.algorithm, web_records);
            out.push(CandidateSpec {
                id,
                label: Some(format!("{} #{}", family.name, index + 1)),
                algorithm: family.algorithm,
                params,
                source,
            });
        }
    }
    out
}

fn baseline_candidates() -> Vec<CandidateSpec> {
    vec![
        CandidateSpec {
            id: "baseline_yin".to_owned(),
            label: Some("Baseline YIN".to_owned()),
            algorithm: AlgorithmKind::Yin,
            params: btreemap(&[
                ("window_seconds", 0.2040816327),
                ("chunk_seconds", 1.0 / 15.0),
                ("min_freq_hz", 30.0),
                ("max_freq_hz", 500.0),
                ("threshold_default", 0.15),
                ("threshold_noisy", 0.60),
                ("max_pitch_dev", 0.20),
                ("rms_gap", 1.10),
                ("adaptive", 1.0),
                ("min_rms", 0.0008),
            ]),
            source: SourceMeta {
                kind: "internal".to_owned(),
                reference: Some("src/audio/tuneoPitchDetector.ts".to_owned()),
                source_url: None,
                license: Some("MIT".to_owned()),
                vendored: false,
                notes: Some("Rust baseline port of Tuneo-like YIN".to_owned()),
            },
        },
        CandidateSpec {
            id: "baseline_autocorr".to_owned(),
            label: Some("Baseline custom autocorr".to_owned()),
            algorithm: AlgorithmKind::Autocorr,
            params: btreemap(&[
                ("window_seconds", 0.0464399093),
                ("chunk_seconds", 0.0232199546),
                ("min_freq_hz", 65.0),
                ("max_freq_hz", 1200.0),
                ("energy_threshold", 0.0032),
                ("correlation_threshold", 0.58),
                ("decay_grace_frames", 8.0),
                ("decay_energy_factor", 0.55),
                ("decay_correlation_threshold", 0.52),
            ]),
            source: SourceMeta {
                kind: "internal".to_owned(),
                reference: Some("src/audio/pitchWorklet.js".to_owned()),
                source_url: None,
                license: Some("MIT".to_owned()),
                vendored: false,
                notes: Some("Rust baseline port of worklet detector".to_owned()),
            },
        },
        CandidateSpec {
            id: "baseline_mpm".to_owned(),
            label: Some("Baseline MPM".to_owned()),
            algorithm: AlgorithmKind::Mpm,
            params: btreemap(&[
                ("window_seconds", 0.065),
                ("chunk_seconds", 0.0232199546),
                ("min_freq_hz", 65.0),
                ("max_freq_hz", 1200.0),
                ("min_rms", 0.0025),
                ("nsdf_threshold", 0.60),
            ]),
            source: SourceMeta {
                kind: "web_research".to_owned(),
                reference: Some("McLeod Pitch Method (NSDF)".to_owned()),
                source_url: Some("https://www.researchgate.net/publication/230554927_A_smarter_way_to_find_pitch".to_owned()),
                license: Some("Algorithm reference".to_owned()),
                vendored: false,
                notes: Some("Reimplemented from paper concepts in Rust".to_owned()),
            },
        },
        CandidateSpec {
            id: "baseline_hybrid".to_owned(),
            label: Some("Baseline Hybrid (YIN+MPM)".to_owned()),
            algorithm: AlgorithmKind::Hybrid,
            params: btreemap(&[
                ("window_seconds", 0.093),
                ("chunk_seconds", 0.0232199546),
                ("min_freq_hz", 65.0),
                ("max_freq_hz", 1200.0),
                ("threshold_default", 0.16),
                ("threshold_noisy", 0.55),
                ("max_pitch_dev", 0.20),
                ("rms_gap", 1.08),
                ("adaptive", 1.0),
                ("min_rms", 0.001),
                ("nsdf_threshold", 0.58),
            ]),
            source: SourceMeta {
                kind: "internal".to_owned(),
                reference: Some("Hybrid arbitration".to_owned()),
                source_url: None,
                license: Some("MIT".to_owned()),
                vendored: false,
                notes: Some("Combines Yin and MPM confidence".to_owned()),
            },
        },
    ]
}

fn source_for_algorithm(algorithm: AlgorithmKind, web_records: &[WebResearchRecord]) -> SourceMeta {
    let best = web_records
        .iter()
        .find(|record| record.algorithm.is_none() || record.algorithm == Some(algorithm));
    if let Some(record) = best {
        return SourceMeta {
            kind: "web_research".to_owned(),
            reference: record.reference.clone(),
            source_url: Some(record.source_url.clone()),
            license: record.license.clone(),
            vendored: record.vendored,
            notes: record.notes.clone(),
        };
    }
    SourceMeta {
        kind: "generated".to_owned(),
        reference: None,
        source_url: None,
        license: None,
        vendored: false,
        notes: None,
    }
}

fn guided_candidates_from_web(
    web_records: &[WebResearchRecord],
    budget: usize,
    seed: u64,
    ids: &mut HashSet<String>,
) -> Vec<CandidateSpec> {
    if budget == 0 || web_records.is_empty() {
        return Vec::new();
    }

    let mut rng = StdRng::seed_from_u64(seed);
    let mut out = Vec::new();
    let mut item_index = 0usize;
    for record in web_records {
        if out.len() >= budget {
            break;
        }
        let algorithm = match infer_algorithm_from_record(record) {
            Some(value) => value,
            None => continue,
        };
        let text = record_context_text(record);
        let low_latency = has_keyword(&text, &["real-time", "realtime", "low latency", "latency"]);
        let noise_robust = has_keyword(&text, &["noise", "noisy", "robust", "denoise"]);
        let sustain_focus = has_keyword(&text, &["sustain", "vibrato", "stability", "stable"]);
        let probabilistic = has_keyword(&text, &["pyin", "probabilistic", "hmm"]);

        let mut params = baseline_params_for(algorithm);
        if low_latency {
            scale_param(&mut params, "window_seconds", 0.75);
            scale_param(&mut params, "chunk_seconds", 0.75);
        }
        if noise_robust {
            adjust_noise_robustness(&mut params, algorithm);
        }
        if sustain_focus {
            adjust_sustain_tracking(&mut params, algorithm);
        }
        if probabilistic {
            adjust_probabilistic_hint(&mut params, algorithm);
        }

        add_jitter(&mut params, algorithm, &mut rng);
        let mut id = format!("web_{algorithm:?}").to_lowercase();
        id.push('_');
        id.push_str(&(item_index + 1).to_string());
        item_index += 1;
        while ids.contains(&id) {
            id.push('x');
        }
        ids.insert(id.clone());
        out.push(CandidateSpec {
            id,
            label: Some(format!(
                "Web-guided {:?} variant #{}",
                algorithm, item_index
            )),
            algorithm,
            params,
            source: SourceMeta {
                kind: "live_web_search".to_owned(),
                reference: record.reference.clone(),
                source_url: Some(record.source_url.clone()),
                license: record.license.clone(),
                vendored: record.vendored,
                notes: Some(format!(
                    "Guided from live web search signals; {}",
                    record
                        .notes
                        .clone()
                        .unwrap_or_else(|| "no notes".to_owned())
                )),
            },
        });
    }
    out
}

fn baseline_params_for(algorithm: AlgorithmKind) -> BTreeMap<String, f64> {
    match algorithm {
        AlgorithmKind::Yin => btreemap(&[
            ("window_seconds", 0.2040816327),
            ("chunk_seconds", 1.0 / 15.0),
            ("min_freq_hz", 30.0),
            ("max_freq_hz", 550.0),
            ("threshold_default", 0.15),
            ("threshold_noisy", 0.60),
            ("max_pitch_dev", 0.20),
            ("rms_gap", 1.10),
            ("adaptive", 1.0),
            ("min_rms", 0.0008),
        ]),
        AlgorithmKind::Autocorr => btreemap(&[
            ("window_seconds", 0.0464399093),
            ("chunk_seconds", 0.0232199546),
            ("min_freq_hz", 65.0),
            ("max_freq_hz", 1200.0),
            ("energy_threshold", 0.0032),
            ("correlation_threshold", 0.58),
            ("decay_grace_frames", 8.0),
            ("decay_energy_factor", 0.55),
            ("decay_correlation_threshold", 0.52),
        ]),
        AlgorithmKind::Mpm => btreemap(&[
            ("window_seconds", 0.065),
            ("chunk_seconds", 0.0232199546),
            ("min_freq_hz", 65.0),
            ("max_freq_hz", 1200.0),
            ("min_rms", 0.0025),
            ("nsdf_threshold", 0.60),
        ]),
        AlgorithmKind::Hybrid => btreemap(&[
            ("window_seconds", 0.093),
            ("chunk_seconds", 0.0232199546),
            ("min_freq_hz", 65.0),
            ("max_freq_hz", 1200.0),
            ("threshold_default", 0.16),
            ("threshold_noisy", 0.55),
            ("max_pitch_dev", 0.20),
            ("rms_gap", 1.08),
            ("adaptive", 1.0),
            ("min_rms", 0.001),
            ("nsdf_threshold", 0.58),
        ]),
    }
}

fn adjust_noise_robustness(params: &mut BTreeMap<String, f64>, algorithm: AlgorithmKind) {
    match algorithm {
        AlgorithmKind::Yin | AlgorithmKind::Hybrid => {
            add_param(params, "threshold_noisy", 0.08, 0.40, 0.90);
            add_param(params, "threshold_default", 0.03, 0.08, 0.30);
            add_param(params, "min_rms", 0.0004, 0.0004, 0.006);
        }
        AlgorithmKind::Autocorr => {
            add_param(params, "correlation_threshold", 0.05, 0.35, 0.90);
            add_param(params, "energy_threshold", 0.0006, 0.0008, 0.008);
        }
        AlgorithmKind::Mpm => {
            add_param(params, "nsdf_threshold", 0.05, 0.40, 0.90);
            add_param(params, "min_rms", 0.0005, 0.0005, 0.008);
        }
    }
}

fn adjust_sustain_tracking(params: &mut BTreeMap<String, f64>, algorithm: AlgorithmKind) {
    match algorithm {
        AlgorithmKind::Autocorr => {
            add_param(params, "decay_grace_frames", 4.0, 2.0, 24.0);
            add_param(params, "decay_energy_factor", -0.08, 0.25, 0.95);
            add_param(params, "decay_correlation_threshold", -0.04, 0.20, 0.85);
        }
        AlgorithmKind::Yin | AlgorithmKind::Hybrid => {
            add_param(params, "max_pitch_dev", -0.04, 0.05, 0.30);
            add_param(params, "rms_gap", -0.03, 1.0, 1.3);
        }
        AlgorithmKind::Mpm => {
            add_param(params, "nsdf_threshold", -0.04, 0.30, 0.90);
        }
    }
}

fn adjust_probabilistic_hint(params: &mut BTreeMap<String, f64>, algorithm: AlgorithmKind) {
    if matches!(algorithm, AlgorithmKind::Yin | AlgorithmKind::Hybrid) {
        add_param(params, "threshold_default", -0.025, 0.06, 0.30);
        add_param(params, "threshold_noisy", -0.05, 0.30, 0.90);
        add_param(params, "max_pitch_dev", -0.02, 0.05, 0.30);
    }
}

fn add_jitter(params: &mut BTreeMap<String, f64>, algorithm: AlgorithmKind, rng: &mut StdRng) {
    let jitter_scale = match algorithm {
        AlgorithmKind::Yin => 0.08,
        AlgorithmKind::Autocorr => 0.10,
        AlgorithmKind::Mpm => 0.12,
        AlgorithmKind::Hybrid => 0.10,
    };
    for key in [
        "window_seconds",
        "chunk_seconds",
        "threshold_default",
        "threshold_noisy",
        "correlation_threshold",
        "energy_threshold",
        "max_pitch_dev",
        "nsdf_threshold",
        "min_rms",
    ] {
        if let Some(value) = params.get_mut(key) {
            let factor = rng.random_range(1.0 - jitter_scale..=1.0 + jitter_scale);
            *value *= factor;
        }
    }
}

fn scale_param(params: &mut BTreeMap<String, f64>, key: &str, factor: f64) {
    if let Some(value) = params.get_mut(key) {
        *value *= factor;
    }
}

fn add_param(params: &mut BTreeMap<String, f64>, key: &str, delta: f64, min: f64, max: f64) {
    if let Some(value) = params.get_mut(key) {
        *value = (*value + delta).clamp(min, max);
    }
}

fn infer_algorithm_from_record(record: &WebResearchRecord) -> Option<AlgorithmKind> {
    if let Some(algorithm) = record.algorithm {
        return Some(algorithm);
    }
    classify_algorithm_hint(&record_context_text(record))
}

fn record_context_text(record: &WebResearchRecord) -> String {
    [
        record.reference.clone().unwrap_or_default(),
        record.source_url.clone(),
        record.notes.clone().unwrap_or_default(),
    ]
    .join(" ")
    .to_lowercase()
}

fn has_keyword(text: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|item| text.contains(item))
}

fn parse_duckduckgo_html_results(html: &str, max_results: usize) -> Vec<LiveWebSearchResult> {
    let anchor_re =
        Regex::new(r#"(?is)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
            .expect("regex compile");
    let snippet_re =
        Regex::new(r#"(?is)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).expect("regex compile");

    let snippets = snippet_re
        .captures_iter(html)
        .map(|capture| strip_tags(capture.get(1).map(|item| item.as_str()).unwrap_or_default()))
        .collect::<Vec<_>>();

    let mut out = Vec::new();
    let mut seen_urls = HashSet::<String>::new();
    for (index, capture) in anchor_re.captures_iter(html).enumerate() {
        if out.len() >= max_results {
            break;
        }
        let raw_url = capture.get(1).map(|item| item.as_str()).unwrap_or_default();
        let title_raw = capture.get(2).map(|item| item.as_str()).unwrap_or_default();
        let title = strip_tags(title_raw);
        if title.is_empty() {
            continue;
        }
        let url = normalize_duckduckgo_link(raw_url);
        if !url.starts_with("http") || seen_urls.contains(&url) {
            continue;
        }
        seen_urls.insert(url.clone());
        let snippet = snippets.get(index).cloned().filter(|item| !item.is_empty());
        let hint_text =
            format!("{} {} {}", title, snippet.clone().unwrap_or_default(), url).to_lowercase();
        let algorithm_hint = classify_algorithm_hint(&hint_text);
        out.push(LiveWebSearchResult {
            title,
            url,
            snippet,
            algorithm_hint,
        });
    }
    out
}

fn normalize_duckduckgo_link(raw: &str) -> String {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_owned();
    }
    if let Some(index) = raw.find("uddg=") {
        let encoded = &raw[index + "uddg=".len()..];
        let tail = encoded.split('&').next().unwrap_or(encoded);
        if let Ok(decoded) = urlencoding::decode(tail) {
            let out = decoded.into_owned();
            if out.starts_with("http://") || out.starts_with("https://") {
                return out;
            }
        }
    }
    raw.to_owned()
}

fn strip_tags(raw: &str) -> String {
    let tag_re = Regex::new(r"(?is)<[^>]+>").expect("regex compile");
    let without_tags = tag_re.replace_all(raw, " ");
    decode_html_entities(without_tags.as_ref())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_html_entities(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn classify_algorithm_hint(text: &str) -> Option<AlgorithmKind> {
    let low = text.to_lowercase();
    if low.contains("mcleod") || low.contains("nsdf") || low.contains("mpm") {
        return Some(AlgorithmKind::Mpm);
    }
    if low.contains("yin") || low.contains("p-yin") || low.contains("pyin") {
        return Some(AlgorithmKind::Yin);
    }
    if low.contains("autocorrelation") || low.contains("acf") || low.contains("correlation") {
        return Some(AlgorithmKind::Autocorr);
    }
    if low.contains("hybrid") || low.contains("ensemble") {
        return Some(AlgorithmKind::Hybrid);
    }
    None
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

fn btreemap(entries: &[(&str, f64)]) -> BTreeMap<String, f64> {
    let mut map = BTreeMap::new();
    for (key, value) in entries {
        map.insert((*key).to_owned(), *value);
    }
    map
}

pub fn resolve_workspace_root(path: &Path) -> Result<std::path::PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    Ok(canonical)
}

pub fn stop_on_first_pass(results: &[bool]) -> Option<usize> {
    results.iter().position(|value| *value)
}

pub fn build_single_candidate_family(candidate: CandidateSpec) -> SearchSpaceConfig {
    let family = FamilySearchSpace {
        name: candidate.id.clone(),
        algorithm: candidate.algorithm,
        count: 1,
        id_prefix: Some(candidate.id.clone()),
        fixed: candidate.params.clone(),
        ranges: BTreeMap::new(),
    };
    SearchSpaceConfig {
        families: vec![family],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitch_core::{ParamRange, SearchSpaceConfig};

    #[test]
    fn stop_rule_finds_first_pass() {
        let found = stop_on_first_pass(&[false, false, true, true]);
        assert_eq!(found, Some(2));
    }

    #[test]
    fn stop_rule_returns_none_without_pass() {
        let found = stop_on_first_pass(&[false, false, false]);
        assert_eq!(found, None);
    }

    #[test]
    fn compile_gate_reports_failure_for_invalid_package() {
        let cwd = Path::new(".");
        let result = run_compile_gate_with_extra(cwd, &["-p", "package_does_not_exist_123"]);
        assert!(!result.success);
    }

    #[test]
    fn candidate_generation_respects_budget() {
        let cfg = SearchSpaceConfig {
            families: vec![FamilySearchSpace {
                name: "yin".to_owned(),
                algorithm: AlgorithmKind::Yin,
                count: 10,
                id_prefix: Some("yin".to_owned()),
                fixed: BTreeMap::new(),
                ranges: BTreeMap::from([(
                    "threshold_default".to_owned(),
                    ParamRange { min: 0.1, max: 0.2 },
                )]),
            }],
        };
        let candidates = generate_candidates(&cfg, &[], 6, 42);
        assert_eq!(candidates.len(), 6);
    }

    #[test]
    fn parse_duckduckgo_html_extracts_link_and_hint() {
        let html = r#"
        <div class="result">
          <a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.org%2Fpyin">pYIN for guitar pitch</a>
          <a class="result__snippet">Probabilistic YIN with low latency.</a>
        </div>
        "#;
        let parsed = parse_duckduckgo_html_results(html, 5);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].url, "https://example.org/pyin");
        assert_eq!(parsed[0].algorithm_hint, Some(AlgorithmKind::Yin));
    }

    #[test]
    fn web_records_convert_from_live_report() {
        let report = LiveWebSearchReport {
            provider: "duckduckgo_html".to_owned(),
            query: "test".to_owned(),
            fetched_at_utc: "2026-01-01T00:00:00Z".to_owned(),
            results: vec![LiveWebSearchResult {
                title: "MPM paper".to_owned(),
                url: "https://example.com/mpm".to_owned(),
                snippet: Some("nsdf approach".to_owned()),
                algorithm_hint: Some(AlgorithmKind::Mpm),
            }],
            errors: vec![],
        };
        let records = web_records_from_live_report(&report);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].algorithm, Some(AlgorithmKind::Mpm));
        assert_eq!(records[0].source_url, "https://example.com/mpm");
    }

    #[test]
    fn guided_candidates_are_generated_from_web_records() {
        let cfg = SearchSpaceConfig { families: vec![] };
        let records = vec![WebResearchRecord {
            algorithm: None,
            source_url: "https://example.org/realtime-yin".to_owned(),
            license: None,
            vendored: false,
            notes: Some("real-time robust pyin".to_owned()),
            reference: Some("pYIN robust".to_owned()),
        }];
        let candidates = generate_candidates(&cfg, &records, 10, 7);
        let guided = candidates
            .iter()
            .filter(|candidate| candidate.id.starts_with("web_"))
            .count();
        assert!(guided >= 1);
    }
}
