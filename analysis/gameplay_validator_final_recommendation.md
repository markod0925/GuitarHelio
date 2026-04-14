# Gameplay Stack Final Recommendation

## Final Stack Evaluated

- Poly gameplay stack: `poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30` + `poly_policy_gameplay_ratio_0p5_superset` + `gate_default_v1`
- Canonical Android mono config: `sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1`

## A. Polyphonic Note-Centric Gameplay

- Stable non-empty recall (post-gate, combined): 99.1%
- Empty-window FAR pre -> post: 100.0% -> 0.0%
- Transition accept pre -> post: 99.9% -> 0.0%
- Extra-note rate pre -> post: 60.6% -> 47.0%
- Gate benefit signal: positive suppression with retained recall trend

## B. Android Mono-Note Realism (234 Takes)

- TAR canonical -> poly-derived final: 100.0% -> 100.0% (0.0%)
- Strict FAR canonical -> poly-derived final: 25.8% -> 100.0% (+74.2%)
- Low-string TAR canonical -> poly-derived final: 100.0% -> 100.0% (0.0%)
- Gate mono-regression risk: no material TAR regression observed (TAR-focused); FAR impact still depends on mono-specific policy selection.

## C. Runtime / Real-Time Feasibility

- Poly detector avg/p95/max frame cost (ms): 10.0262 / 13.1370 / 82.7124
- Poly validator avg/p95/max case cost (ms): 0.0312 / 0.0462 / 2.1608
- Poly gate overhead avg/p95/max window delta (ms): 0.0003 / 0.0001 / 0.0761
- Mono detector avg/p95/max frame cost (ms): 9.3732 / 9.8832 / 32.9602

## D. Recommendation

- Recommended default stack: YES, enable final stack for gameplay mode.
- Suggested default scope: gameplay note-centric mode where empty/transition suppression is prioritized over strict symbolic exactness.
- Canonical Android mono path should remain decision-only unless the gate is separately validated on mono and explicitly accepted as part of that benchmark family.
