# Tuner Benchmark Suite

## Scope

- Task: monophonic continuous pitch tracking for tuner behavior.
- Algorithms: `ac14`, `pyin`.
- Input policy: RAW only (no HPF/LPF headline variants).
- Dataset path: `assets\session_20260403_174852`.
- WAV files analyzed: 234.
- Approximation note: this is an offline take-based approximation of live continuous tuning using frame-level tracking over each take.

## Main Metrics

| Algorithm | ±10c | ±20c | ±50c | Median Abs Cents | No-Detect | Octave Error | Jitter Δc | Time-to-lock | Sustain Std (c) | Runtime avg / p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ac14 | 21.7% | 32.5% | 44.9% | 25.83c | 23.4% | 15.0% | 0.00c | 693.3 ms | 601.42c | 12.577 / 17.036 |
| pyin | 28.7% | 40.5% | 49.4% | 10.00c | 47.5% | 1.0% | 0.00c | 1194.7 ms | 0.00c | 36.503 / 39.781 |

## Low vs High Strings (±50c)

| Algorithm | Low strings (5-6) | High strings (1-2) |
| --- | ---: | ---: |
| ac14 | 49.3% | 33.9% |
| pyin | 43.6% | 53.5% |

## Candidate Assessment

- Quality verdict vs current tuner baseline (`ac14`): `pyin` looks quality-competitive or better on this dataset.
- Runtime feasibility verdict: `pyin` needs runtime optimization/validation before claiming low-latency tuner feasibility.
- Separation note: this suite only answers tuner questions and must not be merged into cross-task detector rankings.

## Output Files

- `results.json`
- `results.csv`
- `summary.md`
- `plots/`
