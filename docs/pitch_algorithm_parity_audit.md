# Pitch Algorithm Parity Audit

Date: 2026-04-02

## Phase 0 - Setup

Languages found:
- GuitarHelio: TypeScript/JavaScript, Rust, C++/JNI, Java (Android plugin)
- GHPitchDetection: Rust, TypeScript/JavaScript, Python tools

Test frameworks / runners:
- GuitarHelio: Vitest (`npm test` via `scripts/run-vitest.mjs`), Rust `cargo test` for native crates
- GHPitchDetection: Rust `cargo test`, JS consistency scripts under `ts/masp/`

Entrypoints inspected:
- GuitarHelio detector runtime path: `tools/native_pitch_runtime/src/lib.rs`
- GuitarHelio DSP/WASM path: `tools/gh_dsp_core/src/lib.rs`
- GHPitchDetection MASP: `src/masp.rs`, `ts/masp/maspCore.ts`
- GHPitchDetection FretNet runtime: `tools/FretNetRust/fretnet_runtime/src/*`

Build/import verification performed:
- `GHPitchDetection`: `cargo test --tests` passed.
- `GuitarHelio/tools/native_pitch_runtime`: `cargo test` passed.
- `GuitarHelio/tools/fretnet_runtime_vendor`: focused tests passed/skipped as expected when model missing.
- `GuitarHelio` Vitest in this environment was blocked by platform-specific Node/Rollup dependency constraints.

## Phase 1 - File Mapping

### ac14
| algorithm | GH files | reference files | entrypoints | configs |
|---|---|---|---|---|
| ac14 | `tools/gh_dsp_core/src/lib.rs`, `src/pitch/adapters/AC14Adapter.ts`, `tools/native_pitch_runtime/src/lib.rs` | GH-native only (no GHPitchDetection dependency by design) | `GhDspCore::process_block_native`, adapter `processFrame` | AC14 constants in `tools/gh_dsp_core/src/lib.rs` |

### spectral_game_runtime_unified_v3
| algorithm | GH files | reference files | entrypoints | configs |
|---|---|---|---|---|
| spectral_game_runtime_unified_v3 | `tools/gh_dsp_core/src/lib.rs`, `src/pitch/adapters/SpectralGameRuntimeUnifiedV3Adapter.ts`, `src/audio/spectralRuntimeModel.ts`, `tools/native_pitch_runtime/src/lib.rs` | GH-native only (as requested) | `GhDspCore::process_block_native` spectral branch | spectral profile/constants in `tools/gh_dsp_core/src/lib.rs`; runtime model JSON from UI/adapter |

### MASP
| algorithm | GH files | reference files | entrypoints | configs |
|---|---|---|---|---|
| MASP | `tools/native_pitch_runtime/src/lib.rs`, `src/audio/maspCore.ts`, `src/audio/maspShared.ts`, `src/pitch/adapters/MASPAdapter.ts` | `GHPitchDetection/src/masp.rs`, `GHPitchDetection/src/config.rs`, `GHPitchDetection/ts/masp/maspCore.ts` | Native: `MaspDetector::process` -> `validate_expected_segment`; TS: `MASPAdapter.processFrame` | manifest assets `android/app/src/main/assets/native-pitch/masp/*`, tuned params in `maspCore.ts` |

### FRETNET
| algorithm | GH files | reference files | entrypoints | configs |
|---|---|---|---|---|
| FRETNET | `tools/native_pitch_runtime/src/lib.rs`, `tools/fretnet_runtime_vendor/src/*`, `src/pitch/adapters/FretNetAdapter.ts`, `tools/gh_dsp_core/src/lib.rs` | `GHPitchDetection/tools/FretNetRust/fretnet_runtime/src/*` | Native: `FretNetDetector::process`; JS/WASM fallback: `GhDspCore::process_block_native` fretnet profile | frontend/model constants in `tools/fretnet_runtime_vendor/src/config.rs`; model asset `android/app/src/main/assets/native-pitch/fretnet/model.onnx` |

## Phase 2 - Pipeline Comparison (Static)

### ac14
Status: **MATCH**
Impact: **NONE**

- Input: mono frame processing through GH DSP core.
- Processing: delay alignment, NLMS reference cancellation, autocorrelation pitch detection.
- Inference/scoring: AC14 thresholds and decay constants.
- Post-process: contamination policy gate for speaker/headphones.
- Output: MIDI estimate, pitch Hz, confidence, bleed-rejection flags.
- No external reference dependency was expected for ac14; implementation is internally coherent across native and adapter paths.

### spectral_game_runtime_unified_v3
Status: **MATCH**
Impact: **NONE**

- Input: frame + optional runtime spectral model JSON.
- Processing: spectral FFT pipeline with profile-specific harmonic scoring and polyphony handling.
- Inference/scoring: selected note set + confidence from spectral contrast/energy weighting.
- Post-process: string/fret resolution and optional chord scoring.
- Output: best MIDI/string/fret + candidate list.
- No external reference dependency was expected for this algorithm; implementation is internally coherent.

### MASP
Status: **MATCH_WITH_INTENTIONAL_DIFFS**
Impact: **LOW** (after fix)

Differences found:
- GH native runtime consumes `masp_manifest.json` and maps into `AppConfig` at startup.
- Previously, GH silently floored several manifest parameters (`strict_sample_rate`, `bins_per_octave`, `max_harmonics`, `rms_window_ms`) via `max(...)`, which could override valid trained values.
- This was corrected to honor non-zero manifest values and only fallback when zero/missing.

Evidence:
- GH mapping: `tools/native_pitch_runtime/src/lib.rs` (`apply_masp_manifest_to_config`).
- Reference behavior source: `GHPitchDetection/src/masp.rs`, `GHPitchDetection/src/config.rs`, `GHPitchDetection/ts/masp/maspCore.ts`.

### FRETNET
Status: **MATCH_WITH_INTENTIONAL_DIFFS**
Impact: **MEDIUM**

- Native path parity:
  - GH uses vendored `fretnet_runtime` with matching HCQT frontend constants and ONNX inference pipeline.
  - Core frontend files (`hcqt.rs`, `postprocess.rs`) match reference byte-for-byte.
  - `config.rs` differs only formatting; constants match.
- Intentional differences:
  - GH native runtime adds game-oriented decode from model tensors (`tablature` / `tablature_rel` + optional `onsets`) to produce direct note/string/fret events.
  - Reference crate decode remains conservative/raw-tensor oriented in `postprocess.rs`.
- Additional architecture difference:
  - Non-native JS/WASM fallback (`GhDspCore` fretnet preset) is a heuristic spectral profile, not ONNX FretNet inference.

## Phase 3 - Config & Assets

Config/assets checks:
- MASP assets present in GH: `android/app/src/main/assets/native-pitch/masp/masp_manifest.json` + signatures.
- FRETNET model present in GH: `android/app/src/main/assets/native-pitch/fretnet/model.onnx`.
- FRETNET frontend constants in vendor crate match reference constants (`sample_rate=22050`, `hop_length=512`, harmonics/n_bins/bins_per_octave).

Config mismatches found:
- Fixed: MASP manifest floor override in GH native runtime (silent override risk).
- No additional hard mismatches found in inspected native FRETNET frontend constants/assets.

## Phase 4 - Tests Added

New tests added in GuitarHelio:
- `tools/native_pitch_runtime/src/lib.rs`:
  - `apply_masp_manifest_honors_non_default_manifest_values`
  - `apply_masp_manifest_uses_safe_defaults_when_manifest_values_are_zero`

Test purpose:
- Contract/regression tests for MASP manifest-to-runtime config mapping.
- Prevents future silent overrides of artifact-configured MASP values.

## Phase 5 - Fixes Applied

Applied low-risk fix:
- File: `tools/native_pitch_runtime/src/lib.rs`
- Change: `apply_masp_manifest_to_config` now:
  - honors non-empty manifest mode;
  - honors non-zero manifest values for `strict_sample_rate`, `bins_per_octave`, `max_harmonics`, `rms_window_ms`;
  - uses explicit safe fallbacks only when manifest values are zero/missing.

Validation:
- `cargo test` in `tools/native_pitch_runtime` passed after change.

## Phase 6 - Final Per-Algorithm Report

### ac14
1. Locations (GH + reference)
- GH: `tools/gh_dsp_core/src/lib.rs`, `src/pitch/adapters/AC14Adapter.ts`, `tools/native_pitch_runtime/src/lib.rs`
- Reference: GH-native baseline (no GHPitchDetection dependency expected)

2. Status
- **MATCH**

3. Differences
- No critical differences identified.

4. Evidence
- AC14 constants and branch logic in `tools/gh_dsp_core/src/lib.rs`.

5. Tests added
- None specific.

6. Recommendation
- no action

### spectral_game_runtime_unified_v3
1. Locations (GH + reference)
- GH: `tools/gh_dsp_core/src/lib.rs`, `src/pitch/adapters/SpectralGameRuntimeUnifiedV3Adapter.ts`, `src/audio/spectralRuntimeModel.ts`
- Reference: GH-native baseline (no GHPitchDetection dependency expected)

2. Status
- **MATCH**

3. Differences
- No critical differences identified.

4. Evidence
- spectral profile config + runtime model ingestion in `tools/gh_dsp_core/src/lib.rs`.

5. Tests added
- None specific.

6. Recommendation
- no action

### MASP
1. Locations (GH + reference)
- GH native: `tools/native_pitch_runtime/src/lib.rs`
- GH TS: `src/audio/maspCore.ts`, `src/audio/maspShared.ts`, `src/pitch/adapters/MASPAdapter.ts`
- Reference: `GHPitchDetection/src/masp.rs`, `GHPitchDetection/src/config.rs`, `GHPitchDetection/ts/masp/maspCore.ts`

2. Status
- **MATCH_WITH_INTENTIONAL_DIFFS**

3. Differences (with impact)
- Fixed mismatch: manifest value floor-override in GH native runtime (impact previously LOW-MEDIUM, now mitigated).
- TS parity module in GH is split (`maspCore.ts` + `maspShared.ts`) versus monolithic reference file (intentional, impact NONE).

4. Evidence
- `tools/native_pitch_runtime/src/lib.rs` (`apply_masp_manifest_to_config`)
- `GHPitchDetection/src/masp.rs` / `ts/masp/maspCore.ts`

5. Tests added
- Two new native runtime manifest mapping tests.

6. Recommendation
- clarify spec: explicitly state whether manifest parameters must be consumed exactly (now implemented as exact non-zero consumption).

### FRETNET
1. Locations (GH + reference)
- GH native: `tools/native_pitch_runtime/src/lib.rs`, `tools/fretnet_runtime_vendor/src/*`
- GH fallback: `tools/gh_dsp_core/src/lib.rs` fretnet spectral profile
- Reference: `GHPitchDetection/tools/FretNetRust/fretnet_runtime/src/*`

2. Status
- **MATCH_WITH_INTENTIONAL_DIFFS**

3. Differences (with impact)
- Native decode layer in GH is task-specific (semantic tablature/relative decode into note events) while reference postprocess is conservative/raw (intentional, LOW).
- JS/WASM fallback fretnet path is heuristic spectral, not ONNX FretNet inference (intentional architectural fallback, MEDIUM).

4. Evidence
- GH decode: `tools/native_pitch_runtime/src/lib.rs` (`decode_fretnet_output` and helpers)
- Reference decode stance: `GHPitchDetection/tools/FretNetRust/fretnet_runtime/src/postprocess.rs`

5. Tests added
- No new FRETNET tests this round; existing decode-shape tests already present in GH native runtime.

6. Recommendation
- clarify spec: define whether fretnet parity requirements apply only to native ONNX path or also to web/worklet fallback.
