# Practice Benchmark Suite

## Scope

- Task: note/string/fret recognition for Practice feedback.
- Algorithms: `spectral_game_runtime_unified_v3`, `FRETNET`.
- Input policy: RAW only headline metrics.
- Dataset path: `assets\session_20260403_174852`.
- WAV files analyzed: 234.

## Main Metrics (RAW/full_take)

| Algorithm | Note Acc | Pitch Acc (±50c) | String Acc | Fret Acc | No-Detect | Octave Err | Harmonic Err | Median Abs Cents | Runtime avg / p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| spectral_game_runtime_unified_v3 | 88.0% | 88.0% | 0.3% | 0.2% | 0.0% | 1.7% | 6.0% | 0.00c | 10.490 / 15.122 |
| FRETNET | 87.2% | 87.2% | 0.2% | 0.2% | 0.0% | 0.4% | 2.6% | 0.00c | 10.181 / 11.837 |

## Low/Mid/High String Note Accuracy

| Algorithm | Low | Mid | High |
| --- | ---: | ---: | ---: |
| spectral_game_runtime_unified_v3 | 66.7% | 97.4% | 100.0% |
| FRETNET | 85.9% | 85.9% | 89.7% |

## Quality vs Deployability

- Quality winner (recognition): spectral_game_runtime_unified_v3.
- Deployability winner (runtime-weighted): FRETNET.
- FRETNET runtime note: avg 10.181 ms per analyzed frame window in this offline run; Android integration needs dedicated on-device profiling before shipping decisions.

## Low-Note Failures (Top examples)

| Algorithm | File | String/Fret | Error Type | Abs Cents |
| --- | --- | --- | --- | ---: |
| spectral_game_runtime_unified_v3 | s05_f00_t01 | s5f0 | large_error | 2102.9c |
| spectral_game_runtime_unified_v3 | s06_f01_t01 | s6f1 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f01_t02 | s6f1 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f01_t03 | s6f1 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f02_t01 | s6f2 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f02_t02 | s6f2 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f02_t03 | s6f2 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f03_t02 | s6f3 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f04_t01 | s6f4 | harmonic_error | 2000.0c |
| spectral_game_runtime_unified_v3 | s06_f04_t02 | s6f4 | harmonic_error | 2000.0c |

## Unstable Takes (Top)

| Algorithm | String | Fret | Note Acc | Std Cents | No-Detect | Unstable Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FRETNET | 1 | 6 | 66.7% | 1131.37c | 0 | 11.65 |
| FRETNET | 1 | 10 | 33.3% | 1007.53c | 0 | 10.74 |
| FRETNET | 1 | 11 | 0.0% | 968.44c | 0 | 10.68 |
| spectral_game_runtime_unified_v3 | 5 | 0 | 33.3% | 937.54c | 0 | 10.04 |
| FRETNET | 4 | 10 | 66.7% | 942.81c | 0 | 9.76 |
| FRETNET | 4 | 9 | 66.7% | 895.67c | 0 | 9.29 |
| FRETNET | 4 | 8 | 66.7% | 848.53c | 0 | 8.82 |
| FRETNET | 3 | 0 | 66.7% | 707.11c | 0 | 7.40 |
| spectral_game_runtime_unified_v3 | 5 | 2 | 33.3% | 543.65c | 0 | 6.10 |
| FRETNET | 4 | 12 | 66.7% | 565.68c | 0 | 5.99 |

## Interpretation Notes

- This suite is Practice-specific and must not be mixed with Tuner or Gameplay validator rankings.
- Time-window sensitivity is included as diagnostics; full_take remains the headline view for this suite.
- Fundamental-vs-harmonic diagnostics are retained to investigate low-note confusion behavior.

## Output Files

- `results.json`
- `results.csv`
- `summary.md`
- `plots/`
