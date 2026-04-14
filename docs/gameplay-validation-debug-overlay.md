# Gameplay Validation Debug Overlay

The PlayScene overlay is meant for on-device diagnosis of the live gameplay validator pipeline.

## How to enable

Choose any of the following:

1. Start PlayScene with `showGameplayValidationDebug: true` in the scene data.
2. Set the preference/query flag `debugGameplayOverlay=1`.
3. Tap the on-screen `Overlay` button in PlayScene.
4. On desktop builds, press `F3`.

The overlay preference is stored in `gh_debug_gameplay_overlay` in localStorage.

## What it shows

- Timing and tolerance window state
- Expected target, mono/poly mode, and policy ids
- Top detected candidates from the live spectral frame
- Expected-note rank, best competitor, and octave competitor
- Runtime validator pre-gate and post-gate acceptance
- Validation ratio, validated/missing/extra notes, and reject reasons
- Window churn diagnostics such as target resets, re-arms, and last `setTarget()` time
- Retained last accepted, expired, and rejected snapshots

## How to read it

- `idle` or `deadTime=Y` usually means the scene is outside the live tolerance window.
- Repeated `setTarget` or `reset` counts during one target usually indicate churn or re-arming.
- If the expected note is not in the top-5 candidates, the detector evidence is weak or misaligned.
- `acceptedPreGate=Y` but `acceptedPostGate=N` means the activation gate suppressed the hit.
- `expired` with no acceptance usually means the player never produced enough valid evidence before the window closed.

## Notes

- The overlay is debug-only and does not change gameplay scoring.
- The retained snapshots are intentionally small so the last meaningful failure state remains readable for a moment after the live frame changes.
