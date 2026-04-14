# Spectral Evidence Audit

## Direct Answers

1. What evidence exists independently of the expected target?
- Probe-model candidate ranks and pairwise expected-vs-competitor outcomes (source, neighbor, octave, same-pitch alt).

2. What evidence is target-conditioned?
- The production spectral benchmark path uses a single-note injected runtime model per case (`buildSingleNoteRuntimeModel`), so baseline detection is conditioned by the expected target context.

3. What evidence is missing for exact-position discrimination?
- Independent same-midi string/fret discrimination remains missing; same-pitch pair probes frequently report ambiguous position instead of robust string/fret separation.

## Probe Metrics

- Frames with probe telemetry: 20520.
- Expected target avg rank: 2.322.
- Expected target top-1/top-3 rate: 32.7% / 84.1%.
- Mean expected pairwise win rate: 0.801.
- Mean expected-vs-best margin: -0.173.
- Octave confusion rate: 27.4%.
- Expected-vs-source win rate: 32.7%.
- Same-pitch-alt ambiguity rate: 61.8%.
- Raw candidate-score availability: 100.0%.

## Exact-Position Verdict

- Verdict: **PARTIAL**.
- Weak position proxies exist, but they are insufficiently stable for robust exact-position gating.
