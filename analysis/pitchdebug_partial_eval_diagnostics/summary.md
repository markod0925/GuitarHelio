# PitchDebug Partial Evaluation Diagnostics

## Dataset Recap

- Exact dataset path used: `assets\session_20260403_174852`
- WAV files analyzed: 79
- Strings covered: 4, 5, 6
- Frets covered: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
- Algorithms run: ac14, spectral_game_runtime_unified_v3, MASP, FRETNET

## Baseline Recap

Baseline recap loaded from `analysis/pitchdebug_partial_eval/results.json` so the prior RAW / legacy-HPF results are preserved verbatim.

| Algorithm | Previous RAW ±50c | Previous HPF50/LPF2000 ±50c | New RAW/full_take ±50c | RAW string 5-6 ±50c |
| --- | ---: | ---: | ---: | ---: |
| ac14 | 72.2% | 0.0% | 73.4% | 74.4% |
| spectral_game_runtime_unified_v3 | 69.6% | 0.0% | 65.8% | 66.7% |
| MASP | 6.3% | 1.3% | 7.6% | 7.7% |
| FRETNET | 87.3% | 0.0% | 84.8% | 85.9% |

## Diagnostic Findings

- Harmonic balance is a better predictor than RMS for the classical detectors and for FRETNET. On RAW/full_take, `corr(success, fund/H2 dB)` is stronger than `corr(success, RMS)` for every detector: ac14 `+0.192` vs `+0.159`, spectral `+0.656` vs `+0.290`, MASP `-0.437` vs `-0.140`, FRETNET `+0.318` vs `+0.120`.
- The success/failure split is much clearer on fund/H2 than on RMS. Success vs failure median fund/H2 is ac14 `-1.7 dB` vs `-7.1 dB`, spectral `+1.2 dB` vs `-17.6 dB`, and FRETNET `-2.0 dB` vs `-19.9 dB`. RMS also trends lower on failures, but the separation is smaller.
- Spectral errors on the lowest notes are mostly harmonic-related, not random. RAW/full_take spectral failures contain `5.1%` octave-up and `17.7%` harmonic-related errors, and failure rate is `100%` from `82.4 Hz` through `103.8 Hz` except `110 Hz` where it is still `50%`.
- Time selection is not “skip the attack and you’re done”. `onset_skipped_window` hurts ac14 by `-19.0 pp`, spectral by `-44.3 pp`, and FRETNET by `-43.0 pp`. Longer steady-state helps some detectors instead: `sustain_long_window` lifts FRETNET to `88.6%` and recovers spectral to `69.6%`, while ac14 still prefers the full-take aggregation.
- Conservative frontends do not explain the RAW gap. `dc_remove_only` is identical to RAW for every detector. `hpf_20hz` and the low shelves only move FRETNET by about `+1.3` to `+2.5 pp`, leave spectral unchanged, and slightly hurt ac14. That supports the original interpretation that “simple filtering missing” is not the main RAW issue.
- The legacy `hpf50_lpf2000` collapse is a wrapper bug, but not for the reason suspected earlier. In [debugSignalProcessing.ts](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/audio/debugSignalProcessing.ts#L230), the 50 Hz HPF uses `alpha = 1 / (1 + 1 / (2πfc/fs))`, which is about `0.0065` at 48 kHz. A standard one-pole RC HPF would use about `0.9935` instead. The audit measured about `-83.0 dB` theoretical gain at E2, median low-string fundamental attenuation around `-79.0 dB`, and almost no difference between frame-local and continuous versions (`~0.000003 RMS`). So the collapse is mainly because the implemented HPF removes the useful band, not because of LPF 2 kHz or filter-state resets.
- MASP underperformance is most consistent with wrapper-level sample-rate mismatch. In [MASPAdapter.ts](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/pitch/adapters/MASPAdapter.ts#L57) and [MASPAdapter.ts](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/pitch/adapters/MASPAdapter.ts#L297), every file arrives at `48 kHz`, enters `linear_48000`, and is written into a fixed `4096`-sample buffer that MASP scores with `MASP_STRICT_SAMPLE_RATE = 22050`. That stretches an `85.3 ms` 48 kHz frame into a `185.8 ms` 22.05 kHz interpretation, with an effective frequency scale factor of `0.459`. MASP’s median prediction ratio is `0.630x` ground truth and median signed error is `-800 cents`. MASP also normalizes every frame to target RMS before analysis, so low capture level is unlikely to be the primary MASP issue.

## Correlations (RAW/full_take)

| Algorithm | Corr(success, RMS) | Corr(success, fund/H2 dB) | Corr(abs cents, RMS) | Corr(abs cents, fund/H2 dB) |
| --- | ---: | ---: | ---: | ---: |
| ac14 | +0.159 | +0.192 | -0.192 | +0.114 |
| spectral_game_runtime_unified_v3 | +0.290 | +0.656 | -0.358 | -0.631 |
| MASP | -0.140 | -0.437 | +0.295 | +0.797 |
| FRETNET | +0.120 | +0.318 | -0.216 | -0.108 |

## Variant Comparisons

### Accuracy by time-window variant on RAW

| Variant | ac14 | spectral_game_runtime_unified_v3 | MASP | FRETNET |
| --- | ---: | ---: | ---: | ---: |
| full_take | 73.4% | 65.8% | 7.6% | 84.8% |
| center_window | 57.0% | 68.4% | 2.5% | 81.0% |
| sustain_window | 55.7% | 69.6% | 5.1% | 86.1% |
| onset_skipped_window | 54.4% | 21.5% | 7.6% | 41.8% |
| sustain_long_window | 58.2% | 69.6% | 7.6% | 88.6% |

### Accuracy by frontend variant on full_take

| Frontend | ac14 | spectral_game_runtime_unified_v3 | MASP | FRETNET |
| --- | ---: | ---: | ---: | ---: |
| raw | 73.4% | 65.8% | 7.6% | 84.8% |
| dc_remove_only | 73.4% | 65.8% | 7.6% | 84.8% |
| hpf_20hz | 72.2% | 65.8% | 7.6% | 87.3% |
| low_shelf_plus_3db_100hz | 72.2% | 65.8% | 7.6% | 86.1% |
| low_shelf_plus_6db_100hz | 69.6% | 65.8% | 7.6% | 86.1% |
| hpf_20hz_plus_low_shelf_3db_100hz | 70.9% | 65.8% | 7.6% | 87.3% |

## Root-Cause Ranking

1. Weak fundamentals versus stronger harmonic structure on low notes. This is the strongest cross-detector predictor on the RAW baseline and matches the spectral/ac14/FRETNET error patterns.
2. MASP wrapper mismatch at the 48 kHz -> 22.05 kHz boundary. This explains MASP specifically; it should be fixed before using MASP as evidence about detector quality.
3. Insufficient steady-state accumulation for some wrappers. Longer sustain windows help spectral and FRETNET modestly, while naive onset skipping can make results much worse.
4. Signal level is a secondary contributor. Lower RMS correlates with more failures, but less strongly than fund/H2 balance.
5. Broken `hpf50_lpf2000` preprocessing is the explanation for the legacy wrapper collapse, but it is separate from the RAW baseline problem.

## Recommended Next Actions

1. Fix the 50 Hz HPF implementation in [debugSignalProcessing.ts](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/audio/debugSignalProcessing.ts#L230) before using any HPF/LPF wrapper as evidence. The current coefficient is effectively suppressing the target low-string band.
2. Fix MASP’s 48 kHz path in [MASPAdapter.ts](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/pitch/adapters/MASPAdapter.ts#L297) so resampling preserves time duration before scoring at 22.05 kHz, then rerun the same benchmark unchanged.
3. For ac14 and spectral_game_runtime_unified_v3, focus next on harmonic-disambiguation and sustained-window aggregation on strings 5-6. The data supports that more strongly than generic EQ tweaks.
4. Keep FRETNET as the Android RAW reference while the classical-detector wrappers are audited; it remains the strongest baseline on this partial set.
5. Repeat the same diagnostic suite on a broader, less low-string-heavy session before generalizing beyond this partial dataset.

## Output Files

- `features_per_take.csv`
- `features_per_take.json`
- `detector_diagnostics.csv`
- `detector_diagnostics.json`
- `merged_table.csv`
- `merged_table.json`
- `plots/`
