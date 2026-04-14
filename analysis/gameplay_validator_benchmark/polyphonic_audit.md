# Gameplay Validator Polyphonic Extension Audit

## Scope audited
- Benchmark entrypoint: `tools/benchmark_suites/run_gameplay_validator_benchmark.ts`
- Validator core: `tools/benchmark_suites/gameplay_validator_core.ts`
- Shared plumbing: `tools/benchmark_suites/shared.ts`
- Sweep entrypoint: `tools/benchmark_suites/run_gameplay_validator_sweep.ts`
- MASP path: `src/pitch/adapters/MASPAdapter.ts`, `src/audio/maspCore.ts`
- Spectral path: `src/pitch/adapters/SpectralGameRuntimeUnifiedV3Adapter.ts`
- Offline bench/JAMS assets: `tools/pitch-offline-bench/input/wav/*`
- Existing JAMS parser reference: `tools/pitch-agent-lab/pitch_core/src/benchmark.rs`

## Reusable components
- `evaluateCaseTelemetry` in `gameplay_validator_core.ts` already implements target-aware per-note competitor-aware decision semantics.
- `evaluateRowsForConfig` and `aggregateValidatorRows` already support config-driven comparison between MASP and spectral for per-note cases.
- `run_gameplay_validator_benchmark.ts` already provides:
  - MASP per-frame competitor evidence extraction (`computeMaspEvidence`)
  - spectral probe candidate/competitor evidence extraction (`analyzeSpectralProbeFrame`)
  - harmonized telemetry schema (`FrameTelemetry` / `ValidatorCaseTelemetry`)
- `shared.ts` already provides:
  - detector wrappers (`createMaspDetector`, `DspCoreDetector`)
  - frame extraction/decode utilities (`decodeMonoAudio`, `readFrame`, frame start builders)
  - target-conditioned feature context helper (`buildFeatureContextWithTarget`)
- `tools/pitch-agent-lab/pitch_core/src/benchmark.rs` contains a robust `note_midi` JAMS parsing strategy that can be mirrored in TypeScript.

## New components needed
- New polyphonic shared module for:
  - WAV/JAMS pair discovery in `tools/pitch-offline-bench/input/wav`
  - robust `note_midi` extraction from JAMS annotations
  - expected active note-set window extraction over time
  - note-set aggregation policies:
    - `all_notes_required`
    - `min_ratio_required`
    - `min_count_required`
  - window-level + note-level metric aggregation by subset (`_solo`, `_comp`, combined)
- New poly benchmark runner to evaluate per-note competitor-aware decisions and aggregate them at window/chord level.
- New poly sweep runner to tune both note thresholds and note-set aggregation policy under a shared policy family across MASP and spectral.

## JAMS parsing location and field choice
- Recommended location: new reusable TypeScript utility in `tools/benchmark_suites` (shared by benchmark + sweep tests).
- Chosen source-of-truth namespace: `note_midi` annotations in `.jams` files.
- Required fields:
  - `annotations[*].namespace === "note_midi"`
  - `annotations[*].annotation_metadata.data_source` (track/source id, optional)
  - `annotations[*].data[*].time`
  - `annotations[*].data[*].duration`
  - `annotations[*].data[*].value` (midi float, rounded to nearest integer)
- Notes:
  - Files include multiple `note_midi` tracks (data_source `0..5`) and should be flattened into event intervals.
  - Other namespaces (`pitch_contour`, `chord`, `tempo`, etc.) are not the primary source for note-set truth in this benchmark.

## Multi-note hook-in points
- Per-note decision remains in existing core (`evaluateCaseTelemetry`) and is reused per expected note `ei` in each window.
- New note-set aggregation layer consumes per-note `ValidatorRow` outputs per window to produce:
  - `expected_note_count`
  - `validated_note_count`
  - `note_validation_ratio`
  - `missing_expected_notes`
  - optional `extra_detected_notes`
  - final window accept/reject decision by policy
- MASP and spectral both feed this same aggregation layer, preserving harmonized acceptance semantics while allowing algorithm-specific evidence availability.

## Backward compatibility
- Existing single-note benchmark/sweep path (`run_gameplay_validator_benchmark.ts`, `run_gameplay_validator_sweep.ts`) remains intact.
- Polyphonic support is added as a separate benchmark/sweep path sharing the same per-note core semantics.
