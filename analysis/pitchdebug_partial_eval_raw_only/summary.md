# PitchDebug RAW-Only Evaluation

## Dataset Recap

- Exact dataset path used: `assets\session_20260403_174852`
- WAV files analyzed: 234
- Expected files: 234
- Discovered WAV files: 234
- Strings covered: 1, 2, 3, 4, 5, 6
- Frets covered: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
- Algorithms evaluated: ac14, spectral_game_runtime_unified_v3, MASP, FRETNET, pyin

## Dataset Integrity

- Missing combinations: 0
- Duplicate combinations: 0
- Corrupted WAV files: 0
- Missing list: none
- Duplicate list: none
- Corrupted file list: none

## RAW-Only Benchmark Results

| Algorithm | ±50c Accuracy | Median Abs Cents | No-detection | Octave Up | Octave Down | Harmonic-related |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ac14 | 63.2% | 21.19c | 0.9% | 0.0% | 18.8% | 8.1% |
| spectral_game_runtime_unified_v3 | 88.0% | 0.00c | 0.0% | 1.7% | 0.0% | 6.0% |
| MASP | 2.6% | 1300.00c | 0.0% | 0.0% | 40.2% | 12.4% |
| FRETNET | 87.2% | 0.00c | 0.0% | 0.0% | 0.4% | 2.6% |
| pyin | 92.3% | 10.00c | 1.7% | 1.3% | 0.0% | 0.4% |

## RAW-Only Diagnostics

- Correlation with correctness: RMS is weaker than fund/H2 ratio for spectral_game_runtime_unified_v3, MASP, FRETNET, pyin.
- Time-window delta vs full_take: ac14 center -6.8%, sustain -19.2%, onset-skipped -8.1%, sustain-long -18.8%; spectral_game_runtime_unified_v3 center +0.4%, sustain +1.3%, onset-skipped -51.7%, sustain-long +1.3%; MASP center -1.7%, sustain -0.9%, onset-skipped 0.0%, sustain-long 0.0%; FRETNET center +2.6%, sustain +4.7%, onset-skipped -57.7%, sustain-long +3.8%; pyin center -11.1%, sustain -3.0%, onset-skipped -67.5%, sustain-long -1.7%.
- Low strings (5-6) remain hardest: ac14 74.4% accuracy, 0.0% no-detect; spectral_game_runtime_unified_v3 66.7% accuracy, 0.0% no-detect; MASP 7.7% accuracy, 0.0% no-detect; FRETNET 85.9% accuracy, 0.0% no-detect; pyin 83.3% accuracy, 1.3% no-detect.

## Low/Mid/High String Groups

| Algorithm | Group | Accuracy ±50c | Median Abs Cents | Octave Error | No-detection |
| --- | --- | ---: | ---: | ---: | ---: |
| ac14 | low | 74.4% | 23.09c | 9.0% | 0.0% |
| ac14 | mid | 73.1% | 16.22c | 17.9% | 1.3% |
| ac14 | high | 42.3% | 1188.25c | 29.5% | 1.3% |
| spectral_game_runtime_unified_v3 | low | 66.7% | 0.00c | 3.8% | 0.0% |
| spectral_game_runtime_unified_v3 | mid | 97.4% | 0.00c | 1.3% | 0.0% |
| spectral_game_runtime_unified_v3 | high | 100.0% | 0.00c | 0.0% | 0.0% |
| MASP | low | 7.7% | 750.00c | 29.5% | 0.0% |
| MASP | mid | 0.0% | 1300.00c | 70.5% | 0.0% |
| MASP | high | 0.0% | 2500.00c | 20.5% | 0.0% |
| FRETNET | low | 85.9% | 0.00c | 0.0% | 0.0% |
| FRETNET | mid | 85.9% | 0.00c | 1.3% | 0.0% |
| FRETNET | high | 89.7% | 0.00c | 0.0% | 0.0% |
| pyin | low | 83.3% | 20.00c | 2.6% | 1.3% |
| pyin | mid | 93.6% | 10.00c | 1.3% | 3.8% |
| pyin | high | 100.0% | 0.00c | 0.0% | 0.0% |

## Take Consistency

| Algorithm | String | Fret | Mean Cents | Std Cents | Consistency (0..1) | Same-note Agreement | Same-octave Agreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ac14 | 5 | 0 | 1248.53c | 1769.26c | 0.67 | 0.33 | 0.33 |
| ac14 | 1 | 11 | -1562.38c | 1164.46c | 0.33 | 0.00 | 0.00 |
| FRETNET | 1 | 6 | -800.00c | 1131.37c | 0.67 | 0.33 | 0.33 |
| FRETNET | 1 | 11 | -1135.49c | 968.44c | 0.00 | 0.00 | 0.00 |
| FRETNET | 1 | 10 | -1366.02c | 1007.53c | 0.33 | 0.00 | 0.33 |
| ac14 | 1 | 7 | -1345.41c | 958.36c | 0.33 | 0.00 | 0.33 |
| spectral_game_runtime_unified_v3 | 5 | 0 | 1317.87c | 937.54c | 0.33 | 0.00 | 0.33 |
| pyin | 6 | 1 | 723.33c | 881.68c | 0.00 | 0.33 | 0.33 |
| FRETNET | 4 | 10 | -666.67c | 942.81c | 0.67 | 0.33 | 0.33 |
| ac14 | 3 | 10 | -622.73c | 897.61c | 0.67 | 0.33 | 0.33 |
| FRETNET | 4 | 9 | -633.33c | 895.67c | 0.67 | 0.33 | 0.33 |
| ac14 | 1 | 12 | -1035.87c | 782.38c | 0.33 | 0.00 | 0.00 |

## Correlations (RAW/full_take)

| Algorithm | Corr(success, RMS) | Corr(success, fund/H2 dB) | Corr(abs cents, RMS) | Corr(abs cents, fund/H2 dB) |
| --- | ---: | ---: | ---: | ---: |
| ac14 | +0.124 | -0.023 | -0.186 | +0.165 |
| spectral_game_runtime_unified_v3 | +0.079 | +0.621 | -0.097 | -0.600 |
| MASP | -0.037 | -0.415 | -0.314 | +0.454 |
| FRETNET | +0.072 | +0.124 | -0.086 | +0.088 |
| pyin | +0.053 | +0.439 | +0.070 | -0.254 |

## Integration Audit Notes

- MASP wrapper status: dominant mode is linear_48000, observed sample rates 48000 Hz, effective frequency-scale factor at 48k is 0.459.
- MASP remaining uncertainty: wrapper alignment must be re-verified after duration-preserving resample fix.
- pYIN wrapper status: input sample rates 48000 Hz, runtime sample rates 48000 Hz, resampling applied = false.
- pYIN runtime settings: block/hop=4096/4096 samples, inferred frame length=4096, fmin=82.40689 Hz, fmax=1200.0 Hz.
- pYIN unvoiced handling: `pitch_hz=null`, `midi_estimate=null`, `reason="pyin_unvoiced"`.
- pYIN shared mapping: median over accepted frame-level frequencies per window, then mapped to shared cents-error format.

## Global Ranking

- Overall ranking: pyin > FRETNET > spectral_game_runtime_unified_v3 > ac14 > MASP
- Low-frequency ranking (priority): FRETNET > pyin > ac14 > spectral_game_runtime_unified_v3 > MASP

## Recommendations

1. Prioritize wrapper/integration correctness before detector retuning, especially MASP sample-rate/duration handling.
2. Prioritize low-note harmonic disambiguation (strings 5-6) using RAW-only diagnostics as canonical evidence.
3. Keep RAW-only benchmark as the authoritative comparison for this phase; filtered frontends stay out of headline metrics.
4. After MASP wrapper fix, rerun this exact RAW-only suite unchanged to isolate wrapper effects.

## Output Files

- `results.csv`
- `results.json`
- `features_per_take.csv`
- `features_per_take.json`
- `plots/`
