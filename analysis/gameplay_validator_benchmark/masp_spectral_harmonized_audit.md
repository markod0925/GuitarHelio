# MASP vs Spectral Harmonized Evidence Audit

## Phase 0: Evidence Side-by-Side

| Algorithm | Expected-note evidence | Nearby-note competitor evidence | Octave competitor evidence | Same-pitch-alt-string evidence | Independent position evidence | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| MASP | Frame-level expected MIDI score from full MASP midi spectrum; expected rank/top-K derived from same spectrum. | Available as max semitone-neighbor midi score proxy (`neighborScore`). | Available as max octave-up/down midi score proxy (`bestOctaveScore`). | Not independently observable in midi-only MASP spectrum; stored as unavailable (`null`). | Not independently observable from MASP score map; only post-detector string/fret match exists. | No explicit pairwise probes by note-position class; same-pitch-alt discrimination is missing as independent evidence. |
| spectral_game_runtime_unified_v3 | Expected-target score/rank from benchmark probe candidate list and top-K ordering. | Explicit probe competitors (`neighbor`/`nearby_note`) with per-frame scores and pairwise expected-vs-competitor outcomes. | Explicit octave competitors with pairwise outcomes and confusion flag. | Explicit same-pitch-alt competitor class and pairwise outcomes in probe telemetry. | Partial: probe can expose ambiguous/non-ambiguous same-midi position outcomes, but this remains unstable for robust exact-position acceptance. | Runtime production path is target-conditioned; benchmark probe is required to expose unconstrained competitor evidence. |

## Directly Comparable Shared Inputs

- `expectedScore`
- `bestCompetitorScore`
- `bestOctaveScore`
- `neighborScore`
- `expectedRank` / top-K derived ratios
- `expectedVsSourceWon` (direct probe for spectral, proxy for MASP)
- `expectedPairwiseWinRate` (direct probe for spectral, proxy aggregate for MASP)

## Explicit Asymmetry Rules

- Missing evidence is represented as `null` and surfaced in `sharedEvidenceLimitations`.
- MASP and spectral share the same final decision semantics; only evidence availability differs.
- No synthetic same-pitch-alt precision is fabricated for MASP.
