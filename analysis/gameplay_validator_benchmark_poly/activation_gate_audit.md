# Activation Gate Audit Note

## Insertion Point

- Gate is applied after note-set validation evidence is computed in `evaluateNoteSetWindow`.
- Temporal hysteresis (if enabled) is applied in `evaluatePolyphonicTelemetryForConfig` as a post-pass over per-file window order.

## Policy Family

- Empty-window suppression: quiet requirement + max validated notes + max extra notes + max raw confidence.
- Transition-window suppression: min stability, max overlap, min note ratio, optional exact-only and superset restrictions.
- Stable non-empty behavior: preserve permissive superset acceptance when configured.
- Optional temporal smoothing: `hysteresisFrames`.

## Chosen Config (This Run)

- id: post_validator_activation_gate_v1
- enabled: true
- empty_window_must_be_quiet: true
- gate_empty_window_max_validated_notes: 0
- gate_empty_window_max_extra_notes: 0
- gate_empty_window_max_confidence: 0.45
- gate_transition_min_stable_ratio: 0.86
- gate_transition_max_overlap_ratio: 0.22
- gate_transition_min_note_ratio: 0.8
- gate_transition_allow_superset: false
- gate_stable_allow_superset_if_expected_covered: true
- gate_min_expected_note_ratio_for_activation: 0.6
- gate_require_exact_on_transition: false
- gate_hysteresis_frames: 1

## Main Effect by Window Type (Combined)

| Algorithm | Empty FAR pre | Empty FAR post | Transition accept pre | Transition accept post | Stable recall pre | Stable recall post | Gate suppressed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | 76.2% | 0.0% | 0.5% | 0.0% | 1.1% | 1.1% | 10.0% |
| spectral_game_runtime_unified_v3 | 100.0% | 0.0% | 99.4% | 0.0% | 98.7% | 98.7% | 77.8% |
