# Live Gameplay Validation Overlay Log

When the gameplay validation debug overlay is visible, PlayScene now writes a persistent JSONL log for the active play session.

## Location

- Android native path: `Documents/GuitarHelio/debug-overlay-logs/playscene-debug-overlay-<timestamp>.jsonl`
- The file is created inside the app Documents directory so it can be copied off-device later.

## What the file contains

Each line is a JSON object with one of these entry kinds:

- `session-start`
- `snapshot`
- `session-end`
- `error`

The `snapshot` entries include the live overlay text plus the full gameplay validation snapshot, so the file can be inspected after the session without relying on offline benchmark semantics.

## Scope

This log is for live target-confirmation debugging only.
It does not recreate the offline canonical competitor graph used by the benchmark suite.
