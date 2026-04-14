# Gameplay Validator Polyphonic Sweep

## Ranking Modes

### Mode 1: strict symbolic
1. maximize expected-note recall (post-gate)
2. minimize empty-window false activation (post-gate)
3. minimize transition-window over-acceptance (post-gate)
4. minimize extra-note rate (post-gate)
5. improve exact-set behavior (post-gate)
6. runtime secondary

### Mode 2: gameplay note-centric (legacy lexicographic)
1. maximize stable non-empty expected-note recall (post-gate)
2. minimize empty-window false activation (post-gate)
3. minimize transition-window accept rate when unstable (post-gate)
4. minimize extra-note rate (post-gate)
5. preserve stable-window superset acceptance when expected notes are covered
6. runtime secondary

### Mode 3: gameplay note-centric (recall-epsilon, eps=0.0100)
1. treat stable non-empty recall as equivalent when delta <= 0.0100
2. within equivalent recall: minimize empty-window false activation (post-gate)
3. then minimize transition-window over-acceptance (post-gate)
4. then minimize extra-note rate (post-gate)
5. then minimize set-mismatch proxy (maximize exact-set rate)
6. runtime secondary

## Strict Mode Best Per Algorithm

| Algorithm | Decision config | Note-set policy | Activation gate | Recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) | Score |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 4.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 | 30.20 |
| spectral_game_runtime_unified_v3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 99.7% | 100.0% | 99.9% | 60.6% | 25.0% | 9.950 | 33.19 |

## Gameplay Legacy Lexicographic Best Per Algorithm

| Algorithm | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Stable superset accept | Runtime (ms) | Score |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 35.7% | 0.000 | 36.10 |
| spectral_game_runtime_unified_v3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 99.2% | 100.0% | 99.9% | 60.6% | 100.0% | 9.950 | 40.78 |

## Gameplay Recall-Epsilon Best Per Algorithm (eps=0.0100)

| Algorithm | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) | Score |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MASP | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 6.9% | 76.2% | 9.1% | 70.6% | 0.4% | 0.000 | 35.42 |
| spectral_game_runtime_unified_v3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_default_v1 | 99.1% | 0.0% | 0.0% | 47.0% | 11.1% | 9.950 | 71.98 |

## Strict Combined Best

- Decision config: `poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30`
- Note-set policy: `poly_policy_gameplay_ratio_0p5_superset`
- Activation gate: `gate_disabled_passthrough`
- Avg post-gate recall: 50.4%
- Avg post-gate empty FAR: 88.1%
- Avg post-gate transition accept: 51.1%
- Avg post-gate extra-note rate: 74.3%
- Avg post-gate exact-set rate: 12.7%

## Gameplay Legacy Lexicographic Combined Best

- Decision config: `poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30`
- Note-set policy: `poly_policy_gameplay_ratio_0p5_superset`
- Activation gate: `gate_disabled_passthrough`
- Avg stable post-gate recall: 50.8%
- Avg post-gate empty FAR: 88.1%
- Avg post-gate transition accept: 51.1%
- Avg post-gate extra-note rate: 74.3%
- Avg stable superset accept: 100.0%

## Gameplay Recall-Epsilon Combined Best (eps=0.0100)

- Decision config: `poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30`
- Note-set policy: `poly_policy_gameplay_ratio_0p5_superset`
- Activation gate: `gate_default_v1`
- Avg stable post-gate recall: 50.4%
- Avg post-gate empty FAR: 0.0%
- Avg post-gate transition accept: 0.0%
- Avg post-gate extra-note rate: 51.4%
- Avg post-gate exact-set rate: 5.6%

## Strict Top 10 Combined

| Rank | Decision config | Note-set policy | Activation gate | Avg recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg exact rate | Avg runtime (ms) | Score |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 50.4% | 88.1% | 51.1% | 74.3% | 12.7% | 4.975 | 33.19 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_disabled_passthrough | 50.0% | 88.1% | 50.1% | 76.9% | 12.7% | 4.975 | 32.87 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_disabled_passthrough | 50.0% | 88.1% | 50.1% | 76.9% | 12.7% | 4.975 | 32.87 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_1_superset | gate_disabled_passthrough | 50.0% | 88.1% | 50.1% | 76.9% | 12.7% | 4.975 | 32.86 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 45.8% | 88.1% | 50.7% | 74.3% | 10.8% | 4.975 | 31.59 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_gameplay_ratio_0p67_superset | gate_disabled_passthrough | 42.0% | 88.1% | 44.0% | 77.2% | 10.8% | 4.975 | 31.19 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_gameplay_ratio_0p75_superset | gate_disabled_passthrough | 41.8% | 88.1% | 43.7% | 77.2% | 10.8% | 4.975 | 31.14 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 41.4% | 88.1% | 49.8% | 74.2% | 10.1% | 4.975 | 30.29 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_disabled_passthrough | 35.5% | 88.1% | 42.2% | 76.9% | 10.1% | 4.975 | 29.38 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_disabled_passthrough | 35.3% | 88.1% | 42.1% | 76.9% | 10.1% | 4.975 | 29.35 |

## Gameplay Legacy Lexicographic Top 10 Combined

| Rank | Decision config | Note-set policy | Activation gate | Avg stable recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg stable superset accept | Avg runtime (ms) | Score |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 50.8% | 88.1% | 51.1% | 74.3% | 100.0% | 4.975 | 40.78 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_default_v1 | 50.4% | 0.0% | 0.0% | 51.4% | 100.0% | 4.975 | 71.98 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_empty_strict_transition_strict | 50.4% | 0.0% | 0.0% | 51.4% | 100.0% | 4.975 | 71.98 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_transition_exact | 50.4% | 0.0% | 0.0% | 51.4% | 100.0% | 4.975 | 71.98 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_empty_strict_transition_mild | 50.4% | 0.0% | 0.5% | 50.8% | 100.0% | 4.975 | 71.95 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_gameplay_superset_friendly | 50.4% | 0.0% | 0.6% | 51.6% | 100.0% | 4.975 | 71.86 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_default_v1 | 50.2% | 0.0% | 0.0% | 51.5% | 100.0% | 4.975 | 71.91 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_empty_strict_transition_strict | 50.2% | 0.0% | 0.0% | 51.5% | 100.0% | 4.975 | 71.91 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_transition_exact | 50.2% | 0.0% | 0.0% | 51.5% | 100.0% | 4.975 | 71.91 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_default_v1 | 50.2% | 0.0% | 0.0% | 51.5% | 100.0% | 4.975 | 71.91 |

## Gameplay Recall-Epsilon Top 10 Combined (eps=0.0100)

| Rank | Decision config | Note-set policy | Activation gate | Avg stable recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg exact rate | Avg runtime (ms) | Score |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_default_v1 | 50.4% | 0.0% | 0.0% | 51.4% | 5.6% | 4.975 | 71.98 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_empty_strict_transition_strict | 50.4% | 0.0% | 0.0% | 51.4% | 5.6% | 4.975 | 71.98 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_transition_exact | 50.4% | 0.0% | 0.0% | 51.4% | 5.6% | 4.975 | 71.98 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_default_v1 | 50.2% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.91 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_empty_strict_transition_strict | 50.2% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.91 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_transition_exact | 50.2% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.91 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_default_v1 | 50.2% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.91 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_empty_strict_transition_strict | 50.2% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.91 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_transition_exact | 50.2% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.91 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_1_superset | gate_default_v1 | 50.1% | 0.0% | 0.0% | 51.5% | 5.6% | 4.975 | 71.86 |

## MASP Strict Top 10

| Rank | Decision config | Note-set policy | Activation gate | Recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 4.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 4.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 4.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 3.9% | 76.2% | 9.1% | 70.6% | 0.4% | 0.000 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30p4 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 3.9% | 76.2% | 9.1% | 70.6% | 0.4% | 0.000 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 1.6% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 1.6% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 1.6% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 1.6% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30p4 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 1.6% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |

## spectral_game_runtime_unified_v3 Strict Top 10

| Rank | Decision config | Note-set policy | Activation gate | Recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 99.7% | 100.0% | 99.9% | 60.6% | 25.0% | 9.950 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_disabled_passthrough | 99.4% | 100.0% | 99.4% | 60.5% | 25.0% | 9.950 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_disabled_passthrough | 99.4% | 100.0% | 99.4% | 60.5% | 25.0% | 9.950 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_1_superset | gate_disabled_passthrough | 99.4% | 100.0% | 99.4% | 60.6% | 25.0% | 9.950 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 90.5% | 100.0% | 99.2% | 60.5% | 21.2% | 9.950 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_gameplay_ratio_0p67_superset | gate_disabled_passthrough | 83.5% | 100.0% | 87.1% | 61.1% | 21.2% | 9.950 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_gameplay_ratio_0p75_superset | gate_disabled_passthrough | 82.9% | 100.0% | 86.7% | 61.1% | 21.2% | 9.950 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 81.6% | 100.0% | 97.2% | 60.3% | 19.8% | 9.950 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_disabled_passthrough | 70.4% | 100.0% | 83.7% | 60.5% | 19.8% | 9.950 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_disabled_passthrough | 70.0% | 100.0% | 83.4% | 60.5% | 19.8% | 9.950 |

## MASP Gameplay Legacy Lexicographic Top 10

| Rank | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Stable superset accept | Runtime (ms) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 35.7% | 0.000 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 35.7% | 0.000 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 35.7% | 0.000 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 6.9% | 76.2% | 9.1% | 70.6% | 45.5% | 0.000 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30p4 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 6.9% | 76.2% | 9.1% | 70.6% | 45.5% | 0.000 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.0% | 0.000 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.0% | 0.000 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.0% | 0.000 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.0% | 0.000 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30p4 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.0% | 0.000 |

## spectral_game_runtime_unified_v3 Gameplay Legacy Lexicographic Top 10

| Rank | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Stable superset accept | Runtime (ms) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_disabled_passthrough | 99.2% | 100.0% | 99.9% | 60.6% | 100.0% | 9.950 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_default_v1 | 99.1% | 0.0% | 0.0% | 47.0% | 100.0% | 9.950 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_empty_strict_transition_strict | 99.1% | 0.0% | 0.0% | 47.0% | 100.0% | 9.950 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_transition_exact | 99.1% | 0.0% | 0.0% | 47.0% | 100.0% | 9.950 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_empty_strict_transition_mild | 99.1% | 0.0% | 1.1% | 45.8% | 100.0% | 9.950 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_gameplay_superset_friendly | 99.1% | 0.0% | 1.1% | 47.3% | 100.0% | 9.950 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_default_v1 | 98.7% | 0.0% | 0.0% | 47.1% | 100.0% | 9.950 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_empty_strict_transition_strict | 98.7% | 0.0% | 0.0% | 47.1% | 100.0% | 9.950 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_transition_exact | 98.7% | 0.0% | 0.0% | 47.1% | 100.0% | 9.950 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_default_v1 | 98.7% | 0.0% | 0.0% | 47.1% | 100.0% | 9.950 |

## MASP Gameplay Recall-Epsilon Top 10

| Rank | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 6.9% | 76.2% | 9.1% | 70.6% | 0.4% | 0.000 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30p4 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 6.9% | 76.2% | 9.1% | 70.6% | 0.4% | 0.000 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_min_count_1_gameplay | gate_disabled_passthrough | 7.0% | 76.2% | 9.5% | 70.2% | 0.4% | 0.000 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mo0_t10_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30p4 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10p2_t30p4 | poly_policy_min_count_1_strict_extra0 | gate_disabled_passthrough | 4.1% | 76.2% | 2.5% | 82.4% | 0.4% | 0.000 |

## spectral_game_runtime_unified_v3 Gameplay Recall-Epsilon Top 10

| Rank | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_default_v1 | 99.1% | 0.0% | 0.0% | 47.0% | 11.1% | 9.950 |
| 2 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_empty_strict_transition_strict | 99.1% | 0.0% | 0.0% | 47.0% | 11.1% | 9.950 |
| 3 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p5_superset | gate_transition_exact | 99.1% | 0.0% | 0.0% | 47.0% | 11.1% | 9.950 |
| 4 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_default_v1 | 98.7% | 0.0% | 0.0% | 47.1% | 11.1% | 9.950 |
| 5 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_empty_strict_transition_strict | 98.7% | 0.0% | 0.0% | 47.1% | 11.1% | 9.950 |
| 6 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p67_superset | gate_transition_exact | 98.7% | 0.0% | 0.0% | 47.1% | 11.1% | 9.950 |
| 7 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_default_v1 | 98.7% | 0.0% | 0.0% | 47.1% | 11.1% | 9.950 |
| 8 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_empty_strict_transition_strict | 98.7% | 0.0% | 0.0% | 47.1% | 11.1% | 9.950 |
| 9 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_0p75_superset | gate_transition_exact | 98.7% | 0.0% | 0.0% | 47.1% | 11.1% | 9.950 |
| 10 | poly_sweep_note_only_fr0p04_ce1_cf0p2_mbm1000000_mom1000000_t10_t30 | poly_policy_gameplay_ratio_1_superset | gate_default_v1 | 98.4% | 0.0% | 0.0% | 47.2% | 11.1% | 9.950 |
