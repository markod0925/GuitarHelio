# GuitarHelio MVP Implementation Plan

This plan translates the GDD requirements into a practical, incremental delivery roadmap.

## 1) Build order and milestones

1. **Foundation + app shell**
   - Vite + TypeScript + Phaser bootstrapped and runnable.
   - Scene flow scaffold: `BootScene -> SongSelectScene -> PlayScene`.
   - Config and shared type definitions in place.
2. **MIDI ingestion + tempo map**
   - Parse MIDI into `SourceNote[]`.
   - Build tempo-aware conversion helpers (`tickToSeconds`, `secondsToTick`).
   - Validate against single-tempo and tempo-change examples.
3. **Target note generation**
   - Candidate extraction and clustering.
   - Density filter by difficulty profile.
   - Guitar projection with constrained fallback.
4. **Audio playback engine**
   - WebAudio synth + scheduler that always plays full `SourceNote[]`.
   - Verify stable playback independent of gameplay gating.
5. **Gameplay loop + state machine**
   - Implement `Playing`, `WaitingForHit`, `Finished` transitions.
   - Beat-gated freeze/resume behavior around target notes.
6. **Mic + aubiojs pitch detection**
   - Live pitch frames with confidence.
   - Hit validation with hold time and tolerance.
7. **Scoring + HUD + results**
   - Timing windows, points, streaks, distribution metrics.
   - End-of-song summary screen.
8. **Difficulty presets + polish + acceptance checks**
   - Easy/Medium/Hard presets.
   - Tune defaults and verify all acceptance criteria.

---

## 2) Repository implementation map

Use the GDD target structure directly and implement modules in this sequence:

### `/src/app`
- `main.ts`: app bootstrap, scene registration, global services wiring.
- `config.ts`: constants for thresholds (approach window, hold ms, min confidence, scheduler lookahead).

### `/src/midi`
- `midiLoader.ts`: MIDI file decode, NoteOn/NoteOff extraction, normalize into `SourceNote`.
- `tempoMap.ts`: cumulative tempo segments + conversion APIs.
- `sourceNotes.ts`: helpers for sorting, sanitizing, and preparing source events.

### `/src/guitar`
- `tuning.ts`: standard guitar tuning + MIDI utilities.
- `fingeringMap.ts`: string/fret/finger candidate generation.
- `targetGenerator.ts`: candidate extraction, density filtering, projection, fallback policy.

### `/src/audio`
- `synth.ts`: simple synth voice for audible full arrangement.
- `scheduler.ts`: rolling lookahead scheduler (100–200ms horizon, ~25ms tick).
- `micInput.ts`: microphone stream acquisition and buffering.
- `pitchDetector.ts`: aubiojs wrapper -> `PitchFrame` stream.

### `/src/game`
- `stateMachine.ts`: authoritative runtime state transitions.
- `scoring.ts`: rating thresholds, point accumulation, streak + aggregate metrics.

### `/src/ui`
- `BootScene.ts`: preload assets/song metadata.
- `SongSelectScene.ts`: difficulty + song selection.
- `PlayScene.ts`: lanes, bars, ball, hit-line, gameplay orchestration.
- `hud.ts`: score, streak, rating feedback, final results summary.

### `/public/songs`
- `example.mid` and additional QA MIDI fixtures (simple melody + tempo-change case).

---

## 3) Data contracts to define first

Create a shared `types` module early (or colocate near usage) and freeze these interfaces before full feature work:

- `SourceNote`
- `TargetNote`
- `DifficultyProfile`
- `PitchFrame`
- `RuntimeState`
- `PlayState`
- `ScoreEvent`, `ScoreSummary` (project-specific extension for reporting)

Rationale: this minimizes integration churn across audio, gameplay, and UI modules.

---

## 4) Detailed implementation phases

## Phase A — Foundation

- Initialize project and tooling:
  - `vite`, `typescript`, `phaser`, linting/formatting.
- Add deterministic timing helpers:
  - unified clock abstraction for scheduler + gameplay time sampling.
- Add lightweight event bus or explicit orchestrator for scene/service communication.

**Exit criteria**
- App launches and scene transitions work.
- Build passes in CI-like local command.

## Phase B — MIDI + tempo map

- Parse track events and pair NoteOn/NoteOff reliably.
- Preserve tick-level precision.
- Build tempo segment table:
  - each segment stores start tick, start seconds, and microseconds per quarter note.
- Implement bidirectional conversions using segment lookups.

**Tests**
- Unit test: constant tempo tick/second round-trip.
- Unit test: multi-tempo piece conversion accuracy.
- Unit test: missing NoteOff fallback handling.

**Exit criteria**
- Produces complete `SourceNote[]` and correct timing conversions.

## Phase C — Target generator

- Candidate extraction:
  - Gather note-on events, cluster by 30–60ms equivalent in ticks (tempo-aware window), pick representative by policy (highest pitch default).
- Density filtering:
  - Compute `min_gap_seconds` from difficulty knobs.
  - Enforce at most one target in each spacing window.
- Guitar projection:
  - Enumerate playable positions under allowed string/fret/finger constraints.
  - Apply cost function and choose minimum.
  - Fallback to octave shifts ±12, then skip.

**Tests**
- Snapshot/fixture tests per difficulty profile.
- Edge case: no playable mapping -> skip count is reported.

**Exit criteria**
- Deterministic `TargetNote[]` output for the same input + profile.

## Phase D — Audio layer

- Implement synth voice and note scheduling.
- Implement rolling scheduler independent from gameplay state.
- Keep playback running for full arrangement while gameplay gate controls only visual playhead progression.

**Tests/checks**
- Runtime check for scheduler jitter and missed events.
- Manual verification with dense MIDI sections.

**Exit criteria**
- Full arrangement audibly plays with stable timing.

## Phase E — Gameplay state machine + visuals

- Render 6 string lanes and target bars only.
- Implement hit line and bouncing ball.
- Apply transitions:
  - `Playing -> WaitingForHit` near target approach.
  - Freeze tick progression and ball in waiting state.
  - `WaitingForHit -> Playing` on valid hit or optional timeout.
  - Move to `Finished` after final target/song end.

**Tests**
- Unit tests for transition conditions.
- Integration test for freeze/resume around multiple targets.

**Exit criteria**
- Yousician-like gate behavior is reliable.

## Phase F — Mic + pitch detection

- Wire microphone input with permission flow and failure fallback messaging.
- Integrate aubiojs detection loop.
- Produce `PitchFrame` at stable cadence.
- Implement hit validator:
  - confidence threshold
  - pitch tolerance check
  - continuous hold (`hold_ms`, default 80ms)

**Tests**
- Validator unit tests using synthetic pitch-frame sequences.
- Manual test with reference tones for tolerance windows.

**Exit criteria**
- Correct notes progress gameplay consistently.

## Phase G — Scoring + results

- On waiting start, record timestamp.
- On validated hit, compute `delta_ms` and rating bucket.
- Track score totals, streak, hit distribution, average reaction time.
- Build end-of-song results panel.

**Tests**
- Unit tests for threshold boundaries (50/120/250ms).
- Aggregation correctness tests.

**Exit criteria**
- Results screen metrics are accurate and stable.

## Phase H — Difficulty + content + polish

- Encode Easy/Medium/Hard presets exactly as spec.
- Add UX polish: calibration hints, “listening…” state, miss feedback.
- Performance pass: object pooling for note bars, render culling.

**Exit criteria**
- Acceptance criteria checklist passes end-to-end.

---

## 5) Cross-cutting engineering decisions

- **Determinism first**: target generation and scoring should be reproducible for the same inputs.
- **Strict separation**:
  - Audio uses full `SourceNote[]` always.
  - Gameplay/visual/scoring consume only `TargetNote[]`.
- **Observability**:
  - Dev overlay for current state, target index, detected MIDI/confidence, and scheduler lag.
- **Resilience**:
  - Graceful handling for missing mic permissions and unplayable notes.

---

## 6) Testing strategy

- **Unit tests**: tempo map, target generator, state machine, scoring, hit validator.
- **Fixture tests**: fixed MIDI fixtures with expected `TargetNote[]` snapshots by difficulty.
- **Integration tests**: scene orchestration and gating flow.
- **Manual QA script**:
  - run song at each preset
  - verify ball freeze/resume
  - verify valid/invalid pitch behavior
  - verify end metrics sanity.

Suggested commands (once project scaffolding exists):
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run dev` (manual gameplay verification)

---

## 7) Risks and mitigations

- **Pitch detection instability (noise/child voice/instrument overtones)**
  - Mitigate with confidence gating, hold duration, optional smoothing.
- **Timing drift between gameplay tick and audio clock**
  - Use audio clock as source of truth, avoid mixing unsynchronized clocks.
- **Overly sparse or overly dense generated targets**
  - Add profile validation and debug metrics (targets/min, skip ratio).
- **Complex MIDI edge cases**
  - Start with robust parser defaults; log ignored/invalid events.

---

## 8) Definition of Done checklist (MVP)

- [ ] MIDI loads and full arrangement is audible.
- [ ] Difficulty-specific `TargetNote[]` generation is working.
- [ ] Lanes and bars render only target notes.
- [ ] Ball and playhead freeze at required notes.
- [ ] Mic + aubiojs detects pitch and unlocks progression.
- [ ] Scoring/rating/streak/summary metrics work.
- [ ] Song completes and shows results screen.
- [ ] Static production build succeeds.

