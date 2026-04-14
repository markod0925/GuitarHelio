# Polyphonic Benchmark Audit (Current Decision Flow)

Date: 2026-04-11

## Scope audited

- `tools/benchmark_suites/run_gameplay_validator_poly_benchmark.ts`
- `tools/benchmark_suites/gameplay_validator_polyphonic.ts`
- `tools/benchmark_suites/run_gameplay_validator_poly_sweep.ts`

## Current flow

1. Raw detector / telemetry evidence
- Per-frame detector evidence is produced in `run_gameplay_validator_poly_benchmark.ts`.
- Raw window-level activation proxies are collected before validator aggregation:
  - `rawDetectedMidis`
  - `rawDetectionMaxConfidence`
  - `rawDetectionFrameRatio`
- Per-note frame telemetry is retained in `perNoteTelemetry`.

2. Per-note competitor-aware validation
- Each note telemetry stream is evaluated with `evaluateCaseTelemetry(...)`.
- This yields per-note decision outcomes (accept/reject) plus note-level evidence summaries.

3. Note-set aggregation
- `evaluateNoteSetWindow(...)` aggregates validated notes vs expected set.
- It computes:
  - `validatedNoteCount`, `expectedNoteCount`, `noteValidationRatio`
  - set relation (`exact`, `superset`, `subset`, `partial_overlap`, `disjoint`, `empty_*`)
  - `missingExpectedNotes`, `extraDetectedNotes`
  - window diagnostics (`windowCategory`, `stableSetRatio`, `transitionOverlapRatio`, etc.)
- Policy-level acceptance (`policyAccept`) is computed first.

4. Final window accept decision
- Pre-gate activation view: `preGateAccept`.
  - Non-empty windows: `preGateAccept = policyAccept`
  - Empty windows: `preGateAccept = activationDetected`
- Post-validator gate layer: `evaluateActivationGateDecision(...)` returns `gateCoreAccept` + reject reason.
- Optional temporal smoothing: `applyTemporalGateHysteresis(...)` produces final `postGateAccept`.

5. Metrics and reporting
- Aggregation computes both pre-gate and post-gate metrics via `buildAcceptanceViewMetrics(...)`.
- Output artifacts (`results.json`, `diagnostics.json`, `summary.md`, CSV, interpretation report) keep both views.
- Sweep ranking now evaluates post-gate outcomes and can include activation-gate policy variants.

## Gate insertion point and signals

- Candidate insertion point: immediately after note-set policy acceptance is known in `evaluateNoteSetWindow(...)`.
- Available gate signals:
  - `windowCategory`, `isStableWindow`
  - `stableSetRatio`, `transitionOverlapRatio`, `noteSetChangeCount`
  - `validatedNoteCount`, `expectedNoteCount`, `noteValidationRatio`
  - set relation / expected coverage / extra-note count
  - `activationDetected`, `rawDetectionMaxConfidence`, `rawDetectionFrameRatio`
  - `minValidatedSupportFrames`
- Missing but desirable signals:
  - richer raw activity envelope (energy/noise-floor/SNR style proxy)
  - stronger onset/offset continuity signal from raw detector stream

## Layering decision

- The activation gate should remain a separate explicit layer (current implementation), not hidden inside detector internals.
- Benchmark-first gating is appropriate and currently implemented in the poly benchmark path; detector cores are unchanged.
