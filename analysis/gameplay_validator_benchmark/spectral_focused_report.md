# Spectral Focused Validator Report

## Result Statement

FAR improved because new independent competitor-aware evidence was exposed in the benchmark probe path.

## Spectral Evidence Audit (Phase 0)

1. Independent evidence available:
- Probe-model candidate scores/ranks (`candidate_scores`) from spectral runtime.
- Pairwise expected-vs-competitor outcomes for source-actual, neighbor, octave, and same-pitch-alt competitors.

2. Target-conditioned evidence:
- The production validator path injects a single expected-note spectral model per case.
- In that path, note/position outputs can be target-conditioned and do not guarantee independent competitor evidence.

3. Missing exact-position evidence:
- Same-pitch alternate-string discrimination is not robustly independent.
- Probe telemetry shows frequent position ambiguity on same-pitch probes, and same_pitch_alt_string FAR remains 100%.

## What Was Added

- Spectral probe telemetry in gameplay benchmark diagnostics:
  - top candidate scores/ranks per frame
  - expected rank/top-1/top-3
  - expected-vs-source and expected-vs-competitor pairwise outcomes
  - octave confusion and position ambiguity indicators
- New spectral probe outputs:
  - `spectral_probe_report.json`
  - `spectral_probe_report.md`
- Focused spectral sweep policy (TAR=100 hard constraint on spectral only) over 4,098 configs.

## Key Probe Metrics (spectral)

- Frames with probe telemetry: 20,520
- Expected average rank: 2.322
- Expected top-1 rate: 32.7%
- Expected top-3 rate: 84.1%
- Mean expected pairwise win rate: 80.1%
- Octave confusion rate: 27.4%
- Expected-vs-source win rate: 32.7%
- Same-pitch-alt ambiguity rate: 61.8%
- Raw candidate-score availability: 100.0%

## Baseline vs Best TAR=100 Spectral Candidate

- Baseline spectral (legacy_hit_ratio): TAR 100.0%, FAR 100.0%
- Best spectral TAR=100 config:
  - `sweep_exact_position_score0_ratio0p05_consec1_mbm1000000_rb0_mom1000000_atk0_t10_t30_pw0_oc1_vs0p6`
  - Mode: `exact_position`
  - TAR: 100.0%
  - FAR: 25.83%

Mismatch FAR (spectral):
- Baseline:
  - neighbor_fret: 100.0%
  - octave_distractor: 100.0%
  - nearby_note_distractor: 100.0%
  - same_pitch_alt_string: 100.0%
- Best TAR=100 candidate:
  - neighbor_fret: 5.13%
  - octave_distractor: 2.56%
  - nearby_note_distractor: 5.13%
  - same_pitch_alt_string: 100.0%

## Exact-Position Feasibility Verdict

- Verdict: PARTIAL
- Interpretation:
  - Note-level competitor discrimination improved strongly with independent probe evidence.
  - Same-pitch alternate-string rejection did not improve; exact-position FAR remains blocked by missing robust position-discriminative evidence.

## Limiting Factor

Primary remaining limitation is a combination of:
- missing independent position evidence (dominant)
- plus residual competitor ambiguity (octave/source confusion still visible in probe telemetry)

Thresholding alone is not sufficient to solve same_pitch_alt_string false accepts with current spectral evidence.
