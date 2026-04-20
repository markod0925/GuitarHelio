# Live Gameplay Validation Overlay Log

When the gameplay validation debug overlay is visible, PlayScene accumulates a persistent in-memory event log for the active play session.
The session dump is written once when the overlay is hidden or the scene ends.

## Location

- Android native path: `Cache/GuitarHelio/debug-overlay-logs/playscene-debug-overlay-<timestamp>-<ordinal>/session.json`
- The session directory is created inside the app cache directory so it can be copied off-device later.

## What the file contains

The `session.json` file contains one object with an `entries` array. Each entry uses one of these kinds:

- `session-start`
- `session-open`
- `snapshot`
- `session-end`
- `error`

The `snapshot` entries include the live overlay text plus the full gameplay validation snapshot, so the final session dump can be inspected after the session without relying on offline benchmark semantics.

## Scope

This log is for live target-confirmation debugging only.
It does not recreate the offline canonical competitor graph used by the benchmark suite.
