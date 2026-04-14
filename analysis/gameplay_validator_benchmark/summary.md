# Gameplay Validator Benchmark Suite

## Scope

- Task: target-aware gameplay validation (single-note cases; chord-ready structure).
- Canonical mono stack: note decision config + mono note-set cardinality-1 aggregation + gate-off policy.
- Algorithms: `MASP`, `spectral_game_runtime_unified_v3`.
- Input policy: RAW only.
- This suite evaluates validator correctness, not generic detector ranking.
- Dataset path: `assets\session_20260403_174852`.
- WAV files analyzed: 234.

## Decision Configuration

- Baseline config: legacy_hit_ratio_v1 (legacy_hit_ratio).
- Candidate config: target_aware_note_only_v2_conf_gate (note_only).
- Note decision config id: target_aware_note_only_v2_conf_gate.
- Aggregation policy id: mono_note_set_cardinality_1_v1 (mono cardinality-1).
- Activation gate policy id: mono_activation_gate_off_v1 (gate disabled).
- Candidate note thresholds: min score 0, min frame ratio 5.0%, min consecutive 1, max cents 50, min confidence 0.43, margin(best) -1000000, ratio(best) 0, margin(octave) -1000000, ignore attack 0 ms, top-1 ratio 0.0%, top-3 ratio 0.0%, pairwise win-rate 0.0%, max octave confusion 100.0%, expected-vs-source ratio 0.0%.

## Metrics (Candidate)

| Algorithm | TAR | Strict FAR | Note-mismatch FAR | Position-only FAR | Precision | Recall | F1 | Median Decision Latency | Runtime avg / p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 100.0% | 98.5% | 98.0% | 100.0% | 20.8% | 100.0% | 34.4% | 0.0 ms | 0.414 / 0.581 |
| spectral_game_runtime_unified_v3 | 100.0% | 100.0% | 100.0% | 100.0% | 20.5% | 100.0% | 34.1% | 0.0 ms | 9.554 / 10.871 |

## Baseline vs Candidate (TAR/FAR)

| Algorithm | Baseline TAR | Candidate TAR | Baseline Strict FAR | Candidate Strict FAR |
| --- | ---: | ---: | ---: | ---: |
| MASP | 100.0% | 100.0% | 100.0% | 98.5% |
| spectral_game_runtime_unified_v3 | 100.0% | 100.0% | 100.0% | 100.0% |

## FAR by Mismatch Type (Candidate)

| Algorithm | neighbor_fret | octave_distractor | nearby_note_distractor | same_pitch_alt_string |
| --- | ---: | ---: | ---: | ---: |
| MASP | 97.0% | 100.0% | 97.0% | 100.0% |
| spectral_game_runtime_unified_v3 | 100.0% | 100.0% | 100.0% | 100.0% |

## String-Band TAR/FAR (Candidate)

| Algorithm | Low TAR / FAR | Mid TAR / FAR | High TAR / FAR |
| --- | ---: | ---: | ---: |
| MASP | 100.0% / 100.0% | 100.0% / 95.5% | 100.0% / 100.0% |
| spectral_game_runtime_unified_v3 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |

## Fret-Band TAR/FAR (Candidate)

| Algorithm | Low TAR / FAR | Mid TAR / FAR | High TAR / FAR |
| --- | ---: | ---: | ---: |
| MASP | 100.0% / 95.9% | 100.0% / 100.0% | 100.0% / 100.0% |
| spectral_game_runtime_unified_v3 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |

## Output Files

- `results.json`
- `results.csv`
- `diagnostics.json`
- `evidence_audit.json`
- `evidence_audit.md`
- `spectral_probe_report.json`
- `spectral_probe_report.md`
- `summary.md`
- `plots/`
