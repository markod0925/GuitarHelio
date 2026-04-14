# Gameplay Validator Pipeline Audit (Benchmark)

Date: 2026-04-08

## Entrypoints

- Benchmark runner: `tools/benchmark_suites/run_gameplay_validator_benchmark.ts`
- Sweep runner: `tools/benchmark_suites/run_gameplay_validator_sweep.ts`
- Shared benchmark utilities: `tools/benchmark_suites/shared.ts`
- Decision/aggregation core: `tools/benchmark_suites/gameplay_validator_core.ts`

## Dataset and Case Construction

- Dataset root is resolved from `DATASET_ROOT` in `tools/benchmark_suites/shared.ts`.
- Per-source validation cases are built in `buildValidationCases(...)` in `run_gameplay_validator_benchmark.ts`.
- Case types currently include:
  - `correct_target`
  - `neighbor_fret`
  - `octave_distractor`
  - `nearby_note_distractor`
  - `same_pitch_alt_string`

## Target Context Injection

- MASP path:
  - Detector: `createMaspDetector()` (from `shared.ts`, backed by `src/pitch/adapters/MASPAdapter.ts`)
  - Runtime features are built with `buildFeatureContextWithTarget(...)`.
- spectral_game_runtime_unified_v3 path:
  - Detector: `DspCoreDetector` with preset `PitchDetectorPreset.SpectralGameRuntimeUnifiedV3`
  - Per-case spectral model is built by `buildSingleNoteRuntimeModel(...)` and set via `updateSpectralModel(...)`.

## Per-Frame Decision Evidence

`run_gameplay_validator_benchmark.ts` now records per-frame telemetry in `ValidatorCaseTelemetry.frames`, including:

- expected target: string/fret/midi
- detector output: accepted flag, midi, string/fret, confidence
- expected-note error: cents to expected midi
- competitor-aware evidence from MASP score space:
  - expected score
  - best competitor score and midi
  - octave competitor score
  - neighbor-note score
- position evidence:
  - expected position match
  - same-pitch alternate-position detection
- timing/runtime:
  - frame timestamp
  - per-frame runtime

## Final Accept/Reject Flow

Decision logic is centralized in `tools/benchmark_suites/gameplay_validator_core.ts`:

1. Stage A (expected note evidence)
2. Stage B (expected position evidence, only for `exact_position`)

Supported decision modes:

- `legacy_hit_ratio`
- `note_only`
- `exact_position`

The benchmark runner evaluates both:

- baseline (`LEGACY_VALIDATOR_DECISION_CONFIG`)
- candidate (`parseDecisionConfigFromEnv(DEFAULT_VALIDATOR_DECISION_CONFIG)`)

## Result Aggregation and Reporting

- Primary output files:
  - `analysis/gameplay_validator_benchmark/results.json`
  - `analysis/gameplay_validator_benchmark/results.csv`
  - `analysis/gameplay_validator_benchmark/diagnostics.json`
  - `analysis/gameplay_validator_benchmark/summary.md`
  - `analysis/gameplay_validator_benchmark/plots/*`
- Aggregation is computed by `aggregateValidatorRows(...)`.
- Added aggregate breakdowns:
  - FAR by mismatch type
  - TAR/FAR by string band
  - TAR/FAR by fret band
  - baseline vs candidate summary table

## Sweep and TAR Gate

- Sweep utility consumes `diagnostics.json` and evaluates many candidate configs without re-running detectors.
- Ranking policy (implemented in `run_gameplay_validator_sweep.ts`):
  1. TAR descending, with TAR=100% as hard-pass group
  2. FAR ascending
  3. note-mismatch FAR ascending
  4. same-pitch FAR ascending
  5. runtime ascending
- TAR gate helper: `passesTar100Constraint(...)` in `gameplay_validator_core.ts`.
