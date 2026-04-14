# MASP vs Spectral Evidence Audit

This audit documents evidence asymmetry before threshold tuning. Shared decision logic consumes the same conceptual fields, with `null` where evidence is unavailable.

| Algorithm | Expected-note evidence | Nearby-note competitor evidence | Octave competitor evidence | Same-pitch-alt-string evidence | Independent position evidence | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| MASP | Expected score + expected rank/top-K frame evidence. | Nearby-note competitor score available (shared field: neighborScore). | Octave competitor score available (shared field: bestOctaveScore). | No independent same-pitch-alt score; only proxy/implicit evidence. | Unavailable or ambiguous (no stable independent string/fret evidence). | same_pitch_alt_score_not_independent_for_masp_midi_only; pairwise_competitor_outcomes_are_proxy_not_explicit_probe; position_evidence_not_independent |
| spectral_game_runtime_unified_v3 | Expected score + expected rank/top-K frame evidence. | Nearby-note competitor score available (shared field: neighborScore). | Octave competitor score available (shared field: bestOctaveScore). | Direct same-pitch-alt competitor score available. | Unavailable or ambiguous (no stable independent string/fret evidence). | same_pitch_alt_probe_candidates_absent; source_actual_probe_candidate_absent; octave_probe_candidates_absent |

## Evidence Asymmetry

- Spectral probe exposes explicit pairwise competitor outcomes and direct same-pitch-alt competitor classes.
- MASP path remains midi-score centric; same-pitch alternate string evidence is not independently observable and is explicitly marked unavailable.
- Both algorithms now expose shared comparator fields used by the same decision semantics; unavailable fields remain `null` and are not fabricated.

## Directly Comparable Shared Fields

- expected_target_score
- best_competitor_score
- best_octave_score
- nearby_competitor_score
- expected_rank/top-K (now present for both, but MASP rank is midi-only)
- expected_vs_source outcome (spectral probe direct, MASP proxy)
