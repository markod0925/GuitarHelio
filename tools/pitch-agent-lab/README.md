# Pitch Agent Lab Summary (March 17, 2026)

## Scope
This document summarizes the benchmark activity completed in `tools/pitch-agent-lab`, the selected detector profiles, and the current recommendations for gameplay vs tuner usage.

## SOLO/COMP Dataset Reference
- DOI: [10.5281/zenodo.1302059](https://doi.org/10.5281/zenodo.1302059)
- This reference applies to the SOLO/COMP benchmark material used by `dataset.jams.solo.toml` and `dataset.jams.comp.toml`.

## Algorithms Tried (Coverage Summary)
This list is intentionally high-level and does not include full performance details.

Algorithm families tested in this project:
- `yin`
- `autocorr`
- `mpm`
- `hybrid`
- `sac`
- `spectral_harmonic`

Approximate volume tested (from candidate config/run files currently present):
- `spectral_harmonic`: 1166 candidate definitions
- `yin`: 32 candidate definitions
- `autocorr`: 28 candidate definitions
- `mpm`: 25 candidate definitions
- `hybrid`: 18 candidate definitions
- `sac`: 1 candidate definition

Main test campaigns executed:
- Baselines (`baseline_*`) for YIN, autocorr, MPM, hybrid, SAC, spectral harmonic.
- Windowed spectral best sets (`w1024`, `w2048`, `w4096`) across mono/hard/soft contexts.
- Spectral sweeps:
  - `w2048_v000..v179` (first 180-variant sweep, per mode)
  - `w2048b_v000..v179` (second 180-variant local-search sweep, per mode)
- Focused comparisons:
  - promoted `w2048b_v054` vs previous `spectral_best_w2048` on full SOLO/COMP datasets
  - `ac_14` vs `spectral_game_runtime_unified_v3` on SOLO and `take1/2/3`
- Unified runtime profiles (`spectral_game_unified_v1/v2/v3`) to avoid in-game parameter switching.

## Final Recommendations
- Gameplay detector (note/chord detection with expected chart context): `spectral_game_runtime_unified_v3` (`spectral_harmonic`)
- Tuner detector (free monophonic pitch tracking): `ac_14` (`autocorr`)

Reason:
- `spectral_game_runtime_unified_v3` is candidate-guided and tuned for chart-aware gameplay, including sections with occasional chords.
- `ac_14` is better aligned with tuner behavior (free monophonic tracking without chart priors).

## Selected Algorithms and Parameters

### 1) Gameplay Runtime Baseline
File: `config/candidates.spectral.game-runtime.baseline.toml`

```toml
[[candidates]]
id = "spectral_game_runtime_unified_v3"
label = "Spectral game runtime unified v3"
algorithm = "spectral_harmonic"
[candidates.params]
window_seconds = 0.0464399093
chunk_seconds = 0.0116099773
fft_size = 4096.0
min_freq_hz = 75.0
max_harmonic_freq_hz = 3600.0
max_harmonics = 4.0
base_bandwidth_hz = 17.3
relative_bandwidth = 0.0148
magnitude_compression_gamma = 0.24
use_log_magnitude = 0.0
use_local_whitening = 1.0
whitening_radius_bins = 10.0
use_harmonic_penalty = 0.0
subharmonic_penalty_alpha = 0.0
normalize_by_weight_sum = 1.0
normalize_by_band_energy = 0.0
dc_remove = 1.0
min_rms = 0.00005
confidence_contrast_weight = 0.575
confidence_energy_weight = 0.425
confidence_gain = 2.28
confidence_bias = 0.915
emit_frame_traces = 0.0
polyphony_max_notes = 3.0
emit_chord_scores = 1.0
use_expected_polyphony_prior = 1.0
expected_prior_midi_tolerance_cents = 43.0
expected_prior_mode = 1.0
expected_prior_soft_weight = 0.66
expected_prior_soft_bonus = 0.23
expected_prior_soft_offtarget_multiplier = 0.9465
```

### 2) Tuner Candidate
File: `output/runs/ac_14.candidate.toml`

```toml
[[candidates]]
id = "ac_14"
label = "autocorr_explore #14"
algorithm = "autocorr"
[candidates.params]
chunk_seconds = 0.03524227822491771
correlation_threshold = 0.6559736283225794
decay_correlation_threshold = 0.6288579679610562
decay_energy_factor = 0.4157769062463687
decay_grace_frames = 4.110656460792942
energy_threshold = 0.003074202393734413
max_freq_hz = 1200.0
min_freq_hz = 55.0
window_seconds = 0.08534542062883915
```

## Key Benchmark Outcomes

### A) Full-set validation used to promote spectral baseline (all takes)
Comparison: previous `spectral_best_w2048` vs candidate `w2048b_v054`.
Decision rule: promote if detect is not worse and in_tune is higher in all scenarios.
Datasets: `config/dataset.jams.solo.toml` and `config/dataset.jams.comp.toml` (reference DOI above).

Result (`output/bench-results-jams-w2048-full-compare-summary.json`):
- `solo_mono`: in_tune `0.7552419 -> 0.7772209` (detect unchanged at `1.0`)
- `comp_hard`: in_tune `0.31791046 -> 0.31993234` (detect unchanged at `0.9999931`)
- `comp_soft`: in_tune `0.27566287 -> 0.3165352` (detect unchanged at `0.9999931`)
- Promotion decision: `true`

### B) Single-profile runtime validation on original 3 takes
Comparison file: `config/candidates.ac14-vs-unified.toml`
Dataset: `config/dataset.take123.toml`
Output: `output/bench-results-take123-ac14-vs-unified.json`

Global metrics on `take1 + take2 + take3`:
- `ac_14`: detect `0.99554014`, in_tune `0.576561`, realtime_factor `24.4448`
- `spectral_game_runtime_unified_v3`: detect `1.0`, in_tune `0.9929043`, realtime_factor `200.8448`

Per-take metrics:
- `take1`: ac_14 in_tune `0.5866788`, unified_v3 in_tune `0.99879915`
- `take2`: ac_14 in_tune `0.55314374`, unified_v3 in_tune `0.9795818`
- `take3`: ac_14 in_tune `0.5891521`, unified_v3 in_tune `1.0`

### C) SOLO-only comparison (ac_14 vs unified_v3)
Dataset: `config/dataset.jams.solo.toml`
Output: `output/bench-results-solo-ac14-vs-unified.json`

- `ac_14`: detect `0.83326083`, in_tune `0.66917604`, realtime_factor `19.2774`
- `spectral_game_runtime_unified_v3`: detect `1.0`, in_tune `0.8431611`, realtime_factor `206.4896`
- Speedup (`unified_v3 / ac_14`): `10.71x` realtime factor

## Operational Guidance
- Use `spectral_game_runtime_unified_v3` in gameplay detection paths.
- Use `ac_14` for tuner paths.
- Avoid dynamic full-profile switching in-game; the unified runtime profile was introduced to keep behavior stable while handling both mono passages and occasional chords.
