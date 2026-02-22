# GuitarHelio - GDD Implementation QA Checklist

Audit date: 2026-02-22
Reference: `GDD.md`

## 1) Architecture and stack

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Web app with Phaser 3 + TypeScript + Vite | PASS | `package.json`, `src/app/main.ts` | Runtime boot and scene chain present. |
| WASM pitch detection (aubiojs), no naive autocorrelation | PASS | `src/audio/pitchDetector.ts` | Uses `aubiojs` with wasm loader. |
| Repository structure aligned with spec modules | PASS | `src/*` folders | All core modules present. |

## 2) Data contracts

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `SourceNote` contract | PASS | `src/types/models.ts` | Matches fields in GDD. |
| `TargetNote` contract | PASS | `src/types/models.ts` | Matches fields in GDD. |
| `DifficultyProfile` contract | PASS | `src/types/models.ts` | Includes all specified knobs. |
| `PitchFrame`, `PlayState`, `RuntimeState` | PASS | `src/types/models.ts` | Fields and enum aligned. |

## 3) MIDI pipeline

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| MIDI parsing to source notes | PASS | `src/midi/midiLoader.ts` | Extracts note events and timing metadata. |
| Tempo-aware map and conversions | PASS | `src/midi/tempoMap.ts`, `test/tempoMap.test.ts` | Tick<->seconds conversion verified by tests. |
| Full-note audio layer based on all source notes | PASS | `src/audio/scheduler.ts`, `src/ui/PlayScene.ts` | Scheduler always receives full `sourceNotes`. |

## 4) Target generation

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Chord clustering in 30-60ms window | PASS | `src/guitar/targetGenerator.ts` | Default cluster window 45ms. |
| Representative policy configurable, default highest | PASS | `src/guitar/targetGenerator.ts`, `test/targetGenerator.test.ts` | Supports `highest`/`lowest`; default `highest`. |
| Density filter by profile timing knobs | PASS | `src/guitar/targetGenerator.ts` | Uses tempo-aware seconds spacing. |
| Guitar projection constraints respected | PASS | `src/guitar/fingeringMap.ts`, `src/guitar/targetGenerator.ts` | String/fret/finger/tolerance checks active. |
| Cost function with pitch/fret/jump terms | PASS | `src/guitar/targetGenerator.ts` | Includes jump penalty from previous fret. |
| Fallback order: direct -> +12 -> -12 -> skip | PASS | `src/guitar/targetGenerator.ts`, `test/targetGenerator.test.ts` | Order is explicit and tested. |

## 5) Gameplay loop and state machine

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| States `Playing`, `WaitingForHit`, `Finished` | PASS | `src/types/models.ts`, `src/game/stateMachine.ts` | Implemented and exercised in tests. |
| Gate trigger at approach threshold | PASS | `src/game/stateMachine.ts`, `test/stateMachine.test.ts` | `Playing -> WaitingForHit` covered by unit test. |
| Freeze current tick while waiting | PASS | `src/ui/PlayScene.ts` | Tick updates only in `Playing`. |
| Resume on valid hit | PASS | `src/game/stateMachine.ts`, `test/stateMachine.test.ts` | `WaitingForHit -> Playing` covered by test. |
| Optional timeout miss and resume | PASS | `src/game/stateMachine.ts`, `test/stateMachine.test.ts` | Timeout transition implemented and tested. |

## 6) Audio, mic, and hit validation

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Scheduler lookahead/update cadence | PASS | `src/app/config.ts`, `src/audio/scheduler.ts` | 150ms horizon, 25ms update loop. |
| Mic acquisition via WebAudio | PASS | `src/audio/micInput.ts` | `getUserMedia` integration present. |
| Held-hit validation (`hold_ms`, confidence, tolerance) | PASS | `src/audio/pitchDetector.ts`, `test/pitchDetector.test.ts` | Hit rule enforced on contiguous frames. |
| Ignore stale pre-waiting frames | PASS | `src/ui/PlayScene.ts` | Frame buffer reset at waiting entry; collection gated by state. |

## 7) Scoring and results

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Timing buckets and points (Perfect/Great/OK/Miss) | PASS | `src/game/scoring.ts`, `test/scoring.test.ts` | Thresholds and points aligned to GDD. |
| Aggregates: total, distribution, avg reaction, longest streak | PASS | `src/game/scoring.ts`, `src/ui/hud.ts` | End summary formatting present. |
| End-of-song result screen | PASS | `src/ui/PlayScene.ts` | Overlay panel shown on finish. |

## 8) Visual system

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| 6 lanes, string1 top -> string6 bottom | PASS | `src/ui/PlayScene.ts` | Lane and string coordinate mapping aligned. |
| Render only `TargetNote` bars | PASS | `src/ui/PlayScene.ts` | Draw loop iterates only `targets`. |
| Finger-color mapping | PASS | `src/app/config.ts`, `src/ui/PlayScene.ts` | Colors match GDD palette. |
| Fixed hit line | PASS | `src/ui/PlayScene.ts` | Static vertical line rendering. |
| Bouncing ball, freeze on waiting, resume after | PASS | `src/ui/PlayScene.ts` | Beat-based Y animation paused in waiting state. |

## 9) Difficulty presets and content flow

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Easy/Medium/Hard presets as default profile values | PASS | `src/app/config.ts` | Values aligned to GDD defaults. |
| Song selection flow + difficulty selection | PASS | `src/ui/SongSelectScene.ts` | Reads `manifest.json`, starts `PlayScene` with chosen profile. |

## 10) Acceptance criteria summary

| Acceptance criterion from GDD | Status | Evidence |
| --- | --- | --- |
| MIDI loads and full music plays | PASS | `src/midi/midiLoader.ts`, `src/audio/scheduler.ts`, `src/ui/PlayScene.ts` |
| TargetNotes generated per difficulty | PASS | `src/guitar/targetGenerator.ts`, `src/app/config.ts` |
| Lanes and bars render | PASS | `src/ui/PlayScene.ts` |
| Ball stops at each TargetNote (waiting state) | PASS | `src/ui/PlayScene.ts`, `src/game/stateMachine.ts` |
| Mic pitch triggers progression | PASS | `src/audio/pitchDetector.ts`, `src/ui/PlayScene.ts` |
| Scoring accumulates | PASS | `src/game/scoring.ts`, `src/ui/PlayScene.ts` |
| Song completes with results screen | PASS | `src/ui/PlayScene.ts` |
| Project builds for static deploy | PASS | `npm run build` |

## 11) Verification log

- `npm run test`: PASS (13 tests)
- `npm run lint`: PASS
- `npm run build`: PASS

## 12) Residual risk notes

- Manual UX/audio latency tuning on real devices is still recommended (mic quality, room noise, speaker bleed).
- Build emits large bundle warnings (>500kB) from Phaser + audio stack; functional but optimization is pending.
