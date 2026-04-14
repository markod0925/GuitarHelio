# Gameplay Validator Harmonized Sweep

## Shared Ranking Policy

1. TAR=100% is a hard pass gate.
2. Then TAR descending.
3. Then strict FAR ascending.
4. Then note-mismatch FAR ascending.
5. Then same-pitch-alt FAR ascending.
6. Then runtime ascending.

## Mode A: Fixed Policy Comparison

| Mode | Config | MASP TAR / strict FAR / note FAR / position FAR | Spectral TAR / strict FAR / note FAR / position FAR |
| --- | --- | --- | --- |
| note_only | fixed_shared_policy_note_only_v1 | 100.0% / 98.5% / 98.0% / 100.0% | 100.0% / 100.0% / 100.0% / 100.0% |
| exact_position | fixed_shared_policy_exact_position_v1 | 100.0% / 98.5% / 98.0% / 100.0% | 100.0% / 100.0% / 100.0% / 100.0% |

## Mode B (note_only): Best Under Constraint

| Algorithm | Best config (TAR=100 hard pass) | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| MASP | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| spectral_game_runtime_unified_v3 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |

### Per-Algorithm Leaderboard (Top 10)

#### MASP

| Rank | Config | TAR=100 pass | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 2 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 3 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 4 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 5 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 6 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 7 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 8 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 9 | sweep_note_only_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 10 | sweep_note_only_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |

#### spectral_game_runtime_unified_v3

| Rank | Config | TAR=100 pass | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 2 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 3 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 4 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 5 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0p6_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 6 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0p6_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 7 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0p6_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 8 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mo0_t10_t30_pw0p6_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 9 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 10 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |

### Combined Leaderboard (Top 10)

| Rank | Config | Both TAR=100 pass | Min TAR | Avg strict FAR | Avg note FAR | Avg position FAR | Avg runtime (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 2 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 3 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 4 | sweep_note_only_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 5 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 6 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 7 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 8 | sweep_note_only_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 9 | sweep_note_only_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 10 | sweep_note_only_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |

## Mode B (exact_position): Best Under Constraint

| Algorithm | Best config (TAR=100 hard pass) | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| MASP | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| spectral_game_runtime_unified_v3 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |

### Per-Algorithm Leaderboard (Top 10)

#### MASP

| Rank | Config | TAR=100 pass | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 2 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 3 | sweep_exact_position_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 4 | sweep_exact_position_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 5 | sweep_exact_position_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 6 | sweep_exact_position_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 7 | sweep_exact_position_s0_r0p1_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 8 | sweep_exact_position_s0_r0p1_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 39.6% | 22.1% | 100.0% | 0.458 |
| 9 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0_rp0p3_cp1 | yes | 100.0% | 98.5% | 98.0% | 100.0% | 0.458 |
| 10 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0_rp0p3_cp2 | yes | 100.0% | 98.5% | 98.0% | 100.0% | 0.458 |

#### spectral_game_runtime_unified_v3

| Rank | Config | TAR=100 pass | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 2 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 3 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 4 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 5 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0p6_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 6 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0p6_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 7 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0p6_oc1_vs0p6_rp0p45_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 8 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0p6_oc1_vs0p6_rp0p45_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 9 | sweep_exact_position_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |
| 10 | sweep_exact_position_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 25.8% | 4.3% | 100.0% | 10.470 |

### Combined Leaderboard (Top 10)

| Rank | Config | Both TAR=100 pass | Min TAR | Avg strict FAR | Avg note FAR | Avg position FAR | Avg runtime (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 2 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 3 | sweep_exact_position_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 4 | sweep_exact_position_s0_r0p05_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 5 | sweep_exact_position_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 6 | sweep_exact_position_s0_r0p1_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 7 | sweep_exact_position_s0_r0p1_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp1 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 8 | sweep_exact_position_s0_r0p1_ce2_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0p6_rp0p3_cp2 | yes | 100.0% | 32.7% | 13.2% | 100.0% | 5.464 |
| 9 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0_rp0p3_cp1 | yes | 100.0% | 99.2% | 99.0% | 100.0% | 5.464 |
| 10 | sweep_exact_position_s0_r0p05_ce1_mbm1000000_rb0_mom1000000_t10_t30_pw0_oc1_vs0_rp0p3_cp2 | yes | 100.0% | 99.2% | 99.0% | 100.0% | 5.464 |
