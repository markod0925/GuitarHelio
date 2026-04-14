# Gameplay Validator Polyphonic Benchmark

## Scope

- Dataset: `tools/pitch-offline-bench/input/wav` WAV/JAMS pairs.
- Subsets: `_solo`, `_comp`, and combined.
- Validation strategy: per-note competitor-aware validation + note-set aggregation + post-validator activation gate.
- Product objective: note correctness prioritized over exact string/fret position.

## Configuration

- Candidate decision config: target_aware_note_only_v2_conf_gate (note_only).
- Baseline decision config: legacy_hit_ratio_v1 (legacy_hit_ratio).
- Note-set policy: note_set_min_ratio_v1 (min_ratio_required), min ratio 0.67, min count 1, max extra none, allow superset true, empty must be quiet true, extra penalty 0.
- Activation gate: post_validator_activation_gate_v1, enabled true, empty quiet true, empty max validated 0, empty max extra 0, empty max conf 0.45, transition min stable 0.86, transition max overlap 0.22, transition min note ratio 0.8, transition allow superset false, stable allow superset true, min expected ratio 0.6, require exact transition false, min support frames 1, hysteresis 1.
- Windowing: duration 0.45 s, hop 0.225 s, min overlap 0.03 s, stable-window min ratio 0.85, transition-overlap threshold 0.15, include silent windows true, max windows/file 6, max frames/window 10.

## Pre vs Post Gate Metrics (solo)

| Algorithm | Recall pre | Recall post | Precision pre | Precision post | Exact pre | Exact post | Superset pre | Superset post | Extra pre | Extra post |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 0.7% | 0.4% | 3.5% | 58.3% | 0.3% | 0.3% | 1.0% | 0.4% | 96.5% | 41.7% |
| spectral_game_runtime_unified_v3 | 98.2% | 17.3% | 45.6% | 66.7% | 37.2% | 17.0% | 61.1% | 10.2% | 58.5% | 36.8% |

### Activation-Suppression View (solo)

| Algorithm | Empty FAR pre | Empty FAR post | Transition accept pre | Transition accept post | Stable recall pre | Stable recall post | Stable accept pre | Stable accept post | Stable coverage pre | Stable coverage post | Gate suppressed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 79.3% | 0.0% | 0.8% | 0.0% | 2.4% | 2.4% | 2.8% | 2.8% | 2.8% | 2.8% | 14.3% |
| spectral_game_runtime_unified_v3 | 100.0% | 0.0% | 98.8% | 0.0% | 95.9% | 95.9% | 97.2% | 97.2% | 97.2% | 97.2% | 76.1% |

## Pre vs Post Gate Metrics (comp)

| Algorithm | Recall pre | Recall post | Precision pre | Precision post | Exact pre | Exact post | Superset pre | Superset post | Extra pre | Extra post |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 0.2% | 0.1% | 6.2% | 45.5% | 0.2% | 0.1% | 0.5% | 0.4% | 93.8% | 54.5% |
| spectral_game_runtime_unified_v3 | 99.9% | 20.0% | 62.8% | 75.3% | 14.0% | 5.7% | 85.8% | 16.4% | 62.4% | 55.7% |

### Activation-Suppression View (comp)

| Algorithm | Empty FAR pre | Empty FAR post | Transition accept pre | Transition accept post | Stable recall pre | Stable recall post | Stable accept pre | Stable accept post | Stable coverage pre | Stable coverage post | Gate suppressed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 69.4% | 0.0% | 0.3% | 0.0% | 0.6% | 0.6% | 2.3% | 2.3% | 2.3% | 2.3% | 5.6% |
| spectral_game_runtime_unified_v3 | 100.0% | 0.0% | 100.0% | 0.0% | 99.7% | 99.7% | 99.5% | 99.5% | 99.1% | 99.1% | 79.4% |

## Pre vs Post Gate Metrics (combined)

| Algorithm | Recall pre | Recall post | Precision pre | Precision post | Exact pre | Exact post | Superset pre | Superset post | Extra pre | Extra post |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 0.3% | 0.2% | 4.1% | 52.2% | 0.3% | 0.2% | 0.7% | 0.4% | 95.9% | 47.8% |
| spectral_game_runtime_unified_v3 | 99.4% | 19.2% | 56.6% | 72.8% | 25.0% | 11.1% | 74.1% | 13.5% | 60.5% | 47.1% |

### Activation-Suppression View (combined)

| Algorithm | Empty FAR pre | Empty FAR post | Transition accept pre | Transition accept post | Stable recall pre | Stable recall post | Stable accept pre | Stable accept post | Stable coverage pre | Stable coverage post | Gate suppressed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 76.2% | 0.0% | 0.5% | 0.0% | 1.1% | 1.1% | 2.5% | 2.5% | 2.5% | 2.5% | 10.0% |
| spectral_game_runtime_unified_v3 | 100.0% | 0.0% | 99.4% | 0.0% | 98.7% | 98.7% | 98.3% | 98.3% | 98.1% | 98.1% | 77.8% |

## Baseline vs Candidate (Combined, Post-Gate)

| Algorithm | Baseline post recall | Candidate post recall | Baseline post empty FAR | Candidate post empty FAR | Baseline post transition accept | Candidate post transition accept |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 0.3% | 0.2% | 0.0% | 0.0% | 0.0% | 0.0% |
| spectral_game_runtime_unified_v3 | 19.2% | 19.2% | 0.0% | 0.0% | 0.0% | 0.0% |

## Layered View

- Pre-gate = raw validator activation behavior after note-set aggregation (`preGate*`).
- Post-gate = activation decisions after explicit empty/transition suppression (`postGate*`).
- `results_windows.csv` and `results.json` preserve both pre-gate and post-gate fields per window.
- See `activation_gate_audit.md` and `interpretation_report.md` for effect-by-window interpretation.
