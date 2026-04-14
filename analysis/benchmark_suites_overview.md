# Benchmark Suites Overview

The pitch-evaluation benchmark infrastructure is split into three suite-local evaluations aligned to real product tasks. This design intentionally avoids a single global ranking across incompatible tasks.

## Why split suites

Different runtime features solve different problems:

- Tuner: monophonic continuous pitch tracking with low latency and low jitter.
- Practice: note/string/fret recognition for feedback.
- Gameplay validator: expected-target validation (accept/reject), including target-aware negatives.

A single headline table across all algorithms is methodologically misleading, especially for target-aware validators such as MASP.

## Suite taxonomy

| Suite | Output directory | Algorithms | Primary interpretation |
| --- | --- | --- | --- |
| Tuner benchmark | `analysis/tuner_benchmark/` | `ac14`, `pyin` | Continuous pitch quality + stability + runtime feasibility for tuning |
| Practice benchmark | `analysis/practice_benchmark/` | `spectral_game_runtime_unified_v3`, `FRETNET` | Free recognition quality for note/string/fret feedback |
| Gameplay validator benchmark | `analysis/gameplay_validator_benchmark/` | `MASP`, `spectral_game_runtime_unified_v3` (target-aware mode) | Validation correctness under expected-target constraints |

## Output structure (per suite)

Each suite writes:

- `results.json`
- `results.csv`
- `summary.md`
- `plots/`

## Reporting rules

- No cross-suite `best overall algorithm` ranking.
- Rankings are suite-local only.
- MASP appears only as a validator in the Gameplay validator suite, with explicit expected target context.
- `spectral_game_runtime_unified_v3` is evaluated in two separate roles:
  - Practice free-recognition role (Practice suite)
  - Target-aware validator role (Gameplay validator suite)

## Input policy

All suites use RAW audio from PitchDebug dataset recordings as canonical benchmark input.

Legacy filtered (HPF/LPF) frontends are excluded from headline suite outputs. If retained, filtered experiments are developer-only diagnostics and are not part of suite rankings.
