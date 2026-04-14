# Gameplay Validation Debug Overlay

This overlay is a live diagnosis panel for the Gameplay validation pipeline in `PlayScene`.
It is meant to answer one question quickly: what is the validator doing right now, and why is the note or chord not advancing the game?

It reflects the live gameplay path, not an offline benchmark path.

## How To Enable

Choose any of the following:

1. Start `PlayScene` with `showGameplayValidationDebug: true` in the scene data.
2. Set the preference/query flag `debugGameplayOverlay=1`.
3. Tap the on-screen `Overlay` button in `PlayScene`.
4. On desktop builds, press `F3`.

The preference is stored in `gh_debug_gameplay_overlay` in `localStorage`.

## What The Lines Mean

The overlay is intentionally compact, but each line maps to a different stage of the validator stack.

### 1. Title

`Gameplay Validation Debug [GOOD|WARN|DANGER]`

- `GOOD` means the runtime validator has accepted the target.
- `WARN` means the system is armed and plausibly working, but the evidence is still incomplete or weak.
- `DANGER` means the current state is not producing a useful validation path, for example because the window is idle, expired, or the gate is rejecting.

### 2. Timing

Example:

`Timing: phase=armed dead=N activeWindow=Y song=10.700s target=10.000s dt=+700ms early=0.500s late=0.500s`

This line tells you whether the system is currently able to validate.

- `phase`
  - `idle`: the window is not armed yet.
  - `armed`: the window is live and should accept detection evidence.
  - `accepted`: the target was accepted and the scene has moved on logically.
  - `expired`: the window timed out.
- `dead`
  - `Y`: validation is intentionally suppressed.
  - `N`: validation is live.
- `activeWindow`
  - `Y`: the current playback time is inside the tolerance range and validation should be usable.
  - `N`: the system is outside the active window.
- `song`
  - current playback time in seconds.
- `target`
  - expected target onset in seconds.
- `dt`
  - signed delta between playback time and target time.
  - negative means early, positive means late.
- `early` / `late`
  - tolerance bounds for the window.

Important:
- In `WaitingForHit`, the overlay should still show `phase=armed`, `dead=N`, `activeWindow=Y`.
- That means the game is waiting for the player to hit the note, but detection is still active.
- If `WaitingForHit` shows `expired` or `dead=Y`, the validation flow is broken and the game can stall.

### 3. Target

Example:

`Target: mode=mono armed=tab-target-78-0-20475 key=tab-target-78-0-20475 expected=50 D3 ranks=D3@2 agg=runtime_mono_all_notes_required_v1 gate=runtime_mono_activation_gate_off_v1 noteCfg=runtime_shared_note_only_v1`

This line describes what the runtime expects.

- `mode`
  - `mono` means a single note.
  - `poly` means a chord or multi-note target.
- `armed`
  - the currently armed target id, if any.
- `key`
  - the identity hash/key for the active target group.
- `expected`
  - expected MIDI notes plus human-readable note names.
- `ranks`
  - the rank of the expected note(s) in the current live candidate list.
  - For example, `D3@2` means the expected note is currently ranked second.
- `agg`
  - aggregation policy id.
- `gate`
  - activation gate policy id.
- `noteCfg`
  - note decision config id.

How to use it:
- If the target is correct but `armed` is missing, the runtime is not holding the window open.
- If the target is correct and `armed` is present, but the note never validates, inspect the spectral and runtime lines next.

### 4. Spectral

Example:

`Spectral: top5=1:64 E4 0.91 | 2:60 C4 0.82 | 3:67 G4 0.14`

This is the live evidence coming from the spectral detector path.

- `top5`
  - the five strongest candidate notes for the current frame.
  - Each entry includes:
    - rank
    - MIDI number
    - note name
    - candidate score
- `bestComp`
  - the strongest competitor note that is not the expected note.
- `octave`
  - an octave-related competitor, if one exists.
- `rawMax`
  - the raw maximum confidence for the frame.
- `frameRatio`
  - a coarse ratio showing whether the frame has usable detection evidence.
- `expectedPresent`
  - whether the expected note is present among the live candidates.
- `bestNote`
  - the detector's current best note id, if known.

How to read it:
- If the expected note is not in `top5`, the detector is probably not locking onto the right pitch.
- If the expected note is in `top5` but low-ranked, the detector is seeing the note but a competitor is stronger.
- If `top5` is empty, the validation stack has no useful spectral evidence to work with.

### 5. Runtime

Example:

`Runtime: pre=Y post=N ratio=0.50 conf=0.83 validated=[50 D3] missing=[] extra=[64 E4] stage=gate`

This is the decision made by the runtime validator.

- `pre`
  - the note evidence passed before the activation gate.
- `post`
  - the note evidence passed after the activation gate.
- `ratio`
  - note validation ratio.
  - For mono targets, this is usually `1.00` when the note is validated and `0.00` when it is not.
- `conf`
  - summary confidence score from the runtime note decisions.
- `validated`
  - notes accepted by the runtime validator.
- `missing`
  - expected notes that were not validated.
- `extra`
  - notes detected that are not part of the expected target.
- `stage`
  - where the rejection happened:
    - `note_level`
    - `aggregation`
    - `gate`
    - `no_target`
    - `none`

How to use it:
- `pre=Y` and `post=N` means the note was good enough before the gate, but the gate suppressed acceptance.
- `pre=N` means the note never became valid enough even before the gate.
- `stage=gate` usually points to a policy or timing issue, not a raw pitch detection failure.

### 6. Runtime Gate

Example:

`Runtime: gate=activation_window_closed reasons=gate:activation_window_closed summary=pre=Y post=N stage=gate`

This line explains the reject reason in a compact form.

- `gate`
  - the explicit gate reject reason, if present.
- `reasons`
  - the detailed reject reasons from the runtime validator.
- `summary`
  - a short readable summary of the current runtime outcome.

How to use it:
- If this line mentions a gate reason, the pitch detector may be working correctly and the problem is the acceptance policy.
- If it says `no runtime output`, the validator is not producing a meaningful frame result yet.

### 7. Reset

Example:

`Reset: changed=N setTarget=2 reset=1 arm=1 lastSet=+6226ms lastReset=+6226ms changeAt=+6226ms`

This is the churn and re-arming diagnostics line.

- `changed`
  - whether the target changed this frame.
- `setTarget`
  - how many times `setTarget()` has been called for the current window.
- `reset`
  - how many times the runtime validator was reset for the current window.
- `arm`
  - how many times the current target was armed.
- `lastSet`
  - how long ago `setTarget()` was last called.
- `lastReset`
  - how long ago the validator was last reset.
- `changeAt`
  - how long ago the target identity last changed.

How to use it:
- Rising `setTarget` or `reset` counts during one target usually means the window is thrashing.
- If the counts stay stable, the bug is probably not target churn.

### 8. Retained Snapshots

The overlay can also keep the last meaningful event visible briefly:

- `Last accepted`
- `Last expired`
- `Last rejected`

These retained lines help when the live frame changes too quickly to read.

For example:
- `Last accepted` tells you the exact target that last succeeded.
- `Last expired` tells you which target timed out and what the runtime state looked like at expiry.
- `Last rejected` shows the most recent explicit reject, including gate or note-level reasons.

## Most Likely Failure Patterns

- `phase=idle`, `dead=Y`
  - the system is outside the live validation window.
- `phase=expired`, `dead=Y` during `WaitingForHit`
  - this is a bug. The game can stall because detection is being shut off too early.
- `top5` is empty
  - the detector is not providing usable live candidates.
- expected note is not in `top5`
  - the player may be hitting the wrong pitch, or the detector is misaligned.
- `pre=Y`, `post=N`
  - the gate is suppressing an otherwise valid hit.
- repeated `setTarget` / `reset`
  - target churn or unintended re-arming.
- `no runtime output`
  - the validator has not yet produced a meaningful decision for the frame.

## Notes

- The overlay is debug-only and does not change gameplay scoring.
- It is designed for Android device debugging, so the line order is optimized for quick visual scanning.
- The retained snapshots are intentionally small so the last meaningful failure state stays readable for a short time after the live frame changes.
