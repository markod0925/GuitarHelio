# Polyphonic Benchmark Interpretation Report

This report explicitly distinguishes pre-gate diagnosis from post-gate outcomes.

## Config Interpreted

- Decision config: target_aware_note_only_v2_conf_gate
- Note-set policy: note_set_min_ratio_v1
- Activation gate: post_validator_activation_gate_v1

## Pre-Gate Diagnosis (Combined)

- MASP stable non-empty recall (pre-gate): 1.1%.
- spectral stable non-empty recall (pre-gate): 98.7%.
- spectral empty FAR (pre-gate): 100.0%.
- spectral transition accept (pre-gate): 99.4%.
- spectral extra-note rate (pre-gate): 60.5%.

## Post-Gate Outcome (Combined)

- MASP stable non-empty recall (post-gate): 1.1% (0.0% vs pre-gate).
- spectral stable non-empty recall (post-gate): 98.7% (0.0% vs pre-gate).
- spectral empty FAR (post-gate): 0.0% (-100.0% vs pre-gate).
- spectral transition accept (post-gate): 0.0% (-99.4% vs pre-gate).
- spectral extra-note rate (post-gate): 47.1% (-13.4% vs pre-gate).

## Questions Answered

- MASP: gate material impact = yes on false activation; recall-limited = yes.
- spectral empty-window false activation reduced by -100.0%.
- spectral transition-window over-acceptance reduced by -99.4%.
- spectral stable non-empty recall preserved at 98.7% (0.0% delta).
- spectral remaining dominant issue after gating: extra-note supersets / contamination.
- Is spectral now more credible for note-centric poly gameplay? Yes (based on stable recall retention plus empty/transition suppression).
- Best tradeoff config found in this run: activation gate `post_validator_activation_gate_v1` + note-set policy `note_set_min_ratio_v1`.
- Useful recall sacrificed (spectral stable non-empty): 0.0%.

## Baseline Comparison (Combined, Post-Gate)

| Algorithm | Baseline recall | Candidate recall | Baseline empty FAR | Candidate empty FAR | Baseline transition accept | Candidate transition accept |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 0.3% | 0.2% | 0.0% | 0.0% | 0.0% | 0.0% |
| spectral_game_runtime_unified_v3 | 19.2% | 19.2% | 0.0% | 0.0% | 0.0% | 0.0% |
