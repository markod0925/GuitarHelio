# Tuner pYIN Optimization Summary

- Dataset: `assets/session_20260403_174852`
- Candidates tested: 7
- Policies tested: `raw`, `hold_120ms`, `hold_240ms`, `hold_120ms_median3`
- Baseline reference: `ac14` from `analysis/tuner_benchmark/results.json`

## 1) What is causing current pYIN weakness in Tuner?

- Current/default profile uses large cadence (block=4096 at 48k => ~85.3ms per runtime call) and sparse event emission.
- Default trace diagnostics show emitted event cadence around 7.40 evt/s with median event interval 170.7 ms.
- Unvoiced decisions remain high in default mode (mean unvoiced rate 47.8%), which drives no-detect and resets lock streaks.
- With sparse/intermittent voiced frames, lock criterion (3 consecutive frames within ±20c) is reached late or missed.

## 2) Which configuration is best for Tuner?

- Best RAW configuration: **b2048 default** (default_b2048).
- Best smoothed output policy result: **b1024 f2048 h512 lowfmin + hold_240ms**.
- Best RAW metrics: ±20c 47.1%, ±50c 57.2%, no-detect 39.4%, octave-error 1.3%, lock 938.7 ms, runtime avg/p95 32.677 / 37.256 ms.
- Best RAW low/high ±50c: low 51.0% vs high 61.4%.

## 3) Does best pYIN now beat ac14 for Tuner?

- Compared to ac14: no-detect +16.0%, lock +245.3 ms, octave-error -13.7%, median abs cents -15.83c, runtime p95 +20.221 ms.
- Verdict: best tested pYIN profile does not yet clear ac14 on continuity/lock enough for replacement.

## 4) If not yet, what still blocks replacement?

- Main blocker remains continuity: no-detect and lock speed are still weaker than ac14 under RAW output.

## 5) Main remaining blocker category

- Combination of no-detect + lock speed (with secondary runtime burden at aggressive cadences).

## Recommendation

- Keep `ac14` as current Tuner production default, continue `pyin` optimization.
- Keep lightweight tuner output policy (`hold_last_120ms` with short median window) as an optional display-layer enhancement; report RAW and smoothed separately.
- Optional next step: test experimental hybrid (`pyin` primary + `ac14` fallback when unvoiced) in a separate appendix benchmark.

