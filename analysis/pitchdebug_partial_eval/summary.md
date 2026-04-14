# PitchDebug Partial Evaluation

- Dataset path used: `assets\session_20260403_174852`
- Files analyzed: 79
- Strings covered: 4, 5, 6
- Frets covered: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
- Algorithms successfully run: ac14, spectral_game_runtime_unified_v3, MASP, FRETNET
- Primary baseline: `raw`

## Mapping Used

Standard tuning MIDI roots: string 6 = E2 (40, 82.407 Hz); string 5 = A2 (45, 110.000 Hz); string 4 = D3 (50, 146.832 Hz); string 3 = G3 (55, 195.998 Hz); string 2 = B3 (59, 246.942 Hz); string 1 = E4 (64, 329.628 Hz).

Formula: `midi = STANDARD_TUNING[string] + fret; frequencyHz = 440 * 2^((midi - 69) / 12)`

## Per-Algorithm Metrics (RAW)

| Algorithm | Pitch Accuracy (±50c) | Median | No-Detect | String/Fret Acc | Octave Error |
| --- | ---: | ---: | ---: | ---: | ---: |
| ac14 | 72.2% | 24.2c | 1.3% | - | 11.4% |
| spectral_game_runtime_unified_v3 | 69.6% | 0.0c | 0.0% | 6.3% | 2.5% |
| MASP | 6.3% | 800.0c | 0.0% | 5.1% | 16.5% |
| FRETNET | 87.3% | 0.0c | 0.0% | 11.4% | 0.0% |

## Ranking

| Category | 1st | 2nd | 3rd | 4th |
| --- | --- | --- | --- | --- |
| Best pitch accuracy | FRETNET | ac14 | spectral_game_runtime_unified_v3 | MASP |
| Lowest median error | FRETNET | spectral_game_runtime_unified_v3 | ac14 | MASP |
| Lowest failure rate | FRETNET | spectral_game_runtime_unified_v3 | MASP | ac14 |

## Key Insights

1. FRETNET is the best overall RAW baseline on this partial session, leading the ranking by pitch accuracy and using the aggregate tie-breakers of median absolute cents error and no-detection rate.
2. Low-frequency behavior on strings 5-6 remains the hardest regime. RAW accuracy on those strings is ac14 73.1%, spectral_game_runtime_unified_v3 70.5%, MASP 6.4%, FRETNET 88.5%.
3. Octave errors / harmonic confusion are concentrated in MASP (13), ac14 (9), spectral_game_runtime_unified_v3 (2), FRETNET (0).
4. Detection failures are dominated by ac14 1.3%, spectral_game_runtime_unified_v3 0.0%, MASP 0.0%, FRETNET 0.0%.
5. Issue attribution: the dominant differences are algorithmic on this dataset, because the same raw recordings produce materially different outcomes across detectors and the simple HPF/LPF wrapper does not shift the ranking enough to explain the gap.

## Optional Preprocessing Comparison

The project already exposes a simple HPF/LPF wrapper, so the same evaluation was also run with `hpf50_lpf2000`. The requested low-shelf pipeline was not added because there is no existing project wrapper for it.

| Algorithm | RAW Accuracy | HPF/LPF Accuracy | Delta |
| --- | ---: | ---: | ---: |
| ac14 | 72.2% | 0.0% | -72.2% |
| spectral_game_runtime_unified_v3 | 69.6% | 0.0% | -69.6% |
| MASP | 6.3% | 1.3% | -5.1% |
| FRETNET | 87.3% | 0.0% | -87.3% |

## Plot Files

- `plots/scatter_ac14.svg`
- `plots/scatter_spectral_game_runtime_unified_v3.svg`
- `plots/scatter_MASP.svg`
- `plots/scatter_FRETNET.svg`
- `plots/error_histogram.svg`
- `plots/per_string_accuracy.svg`
- `plots/per_fret_heatmap.svg`
- `plots/failure_vs_frequency.svg`
