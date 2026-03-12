# Guitar Trainer (Working Title)
## Codex-Ready Technical Specification

---

# 1. Project Overview

## 1.1 Purpose

The goal of this project is to build a **child-friendly interactive guitar training game** inspired by Yousician.

The system must:

- Play a full MIDI arrangement (complete music)
- Ask the player to perform only a simplified subset of notes
- Visually guide the player with lanes, finger colors, and a bouncing ball
- Pause progression until the correct note is played
- Score the player based on rhythmic accuracy

The product prioritizes:

- pedagogical clarity over musical fidelity  
- robustness over perfect pitch detection  
- simplicity for young beginners  

---

## 1.2 Core Design Principles

### Dual-layer music model

The system strictly separates:

- **Audio Layer** → plays ALL MIDI notes  
- **Gameplay Layer** → selects subset (TargetNotes)

Rule:

> All MIDI notes must be audible, but only some are player-interactive.

---

### Educational simplification

Difficulty settings can:

- reduce note density  
- constrain strings/frets/fingers  
- allow pitch tolerance  
- simplify musical content  

The generated exercise does **not need to perfectly match the MIDI**.

---

### Beat-gated progression

Like Yousician:

- the playhead stops at each required note  
- the ball waits for the player  
- playback resumes only after a valid hit  

---

# 2. Technology Stack

## 2.1 Platform

- Web application (desktop first)
- Static deployable
- Real-time audio
- Electron Windows desktop packaging (compiled `.exe`) is supported
- Capacitor Android runtime MUST be locked to landscape orientation (`sensorLandscape`)

## 2.2 Required stack

- Phaser 3
- TypeScript
- Vite
- WebAudio API
- JZZ + jzz-synth-tiny (MIDI synth playback engine)
- WASM pitch detection

## 2.3 Pitch detection library (MANDATORY)

**Option A (selected):**

- aubiojs (WASM)

The system MUST use a JS/WASM pitch detector and MUST NOT rely on naive autocorrelation for MVP.

---

# 3. Repository Structure

```

/src
/app
main.ts
config.ts
/midi
midiLoader.ts
tempoMap.ts
sourceNotes.ts
/guitar
tuning.ts
fingeringMap.ts
targetGenerator.ts
/audio
synth.ts
scheduler.ts
micInput.ts
pitchDetector.ts
/game
stateMachine.ts
scoring.ts
/ui
BootScene.ts
SongSelectScene.ts
PlayScene.ts
hud.ts
/public
/songs
manifest.json
example/
song.mid

```

---

# 4. Core Data Model

## 4.1 SourceNote (full music)

Represents ALL MIDI playback events.

```ts
type SourceNote = {
  tick_on: number
  tick_off: number
  midi_note: number
  velocity: number
  channel: number
  track: number
}
```

These MUST always be scheduled in audio playback.

---

## 4.2 TargetNote (player task)

Subset derived from SourceNotes.

```ts
type TargetNote = {
  id: string
  tick: number
  duration_ticks: number
  string: number
  fret: number
  finger: number
  expected_midi: number
  source_midi?: number
}
```

Only TargetNotes:

* are rendered as colored bars
* trigger gating
* contribute to scoring

---

## 4.3 DifficultyProfile

```ts
type DifficultyProfile = {
  allowed_strings: number[]
  allowed_frets: { min: number; max: number }
  allowed_fret_list?: number[]
  allowed_fingers: number[]
  avg_seconds_per_note?: number
  target_notes_per_minute?: number
  pitch_tolerance_semitones: number
  prefer_open_strings?: boolean
  max_simultaneous_notes: 1 | 2
  gating_timeout_seconds?: number | null
}
```

If `gating_timeout_seconds` is omitted, runtime MUST use a default timeout of `2.5` seconds.

If `gating_timeout_seconds` is explicitly set to `null`, runtime MUST use an infinite wait (no auto-timeout).

---

# 5. MIDI Processing Pipeline

## 5.1 MIDI parsing requirements

The system MUST extract:

* ticks per quarter note
* tempo changes
* NoteOn / NoteOff events

The system MUST ignore:

* Program Change
* Control Change
* Aftertouch

---

## 5.2 Tempo map

Tempo changes MUST be respected.

Provide conversion utilities:

* tick → seconds
* seconds → tick

These MUST be cumulative and tempo-aware.

---

# 6. Target Note Generation

Pipeline:

```
MIDI ArrayBuffer
  → MIDI-to-TAB conversion (difficulty + fretboard constraints)
  → TAB events flattening
  → TargetNotes
```

The project MUST use the MIDI-to-TAB converter flow for gameplay targets when entering `PlayScene`.

---

## 6.1 TAB conversion input constraints

The converter input MUST include:

* selected difficulty (`easy`/`medium`/`hard`) using the original MIDI-to-TAB difficulty presets
* selected `allowed_strings`
* selected `allowed_frets` (explicit list)

The converter output MUST be treated as the authoritative source for gameplay note positions (`string`, `fret`).

---

## 6.2 TAB event to gameplay target mapping

For each converted TAB event:

* event tick MUST map directly to `TargetNote.tick`
* `TargetNote.expected_midi` MUST be computed from standard tuning + `(string, fret)`
* `TargetNote.string` MUST use GuitarHelio 1-based indexing
* `TargetNote.duration_ticks` SHOULD come from source MIDI note matching (same pitch near event onset)
* if no source match is available, duration SHOULD fallback to next-event delta (or a PPQ-based default)

Current runtime requirement:

* gameplay targets MUST preserve full TAB chord events (multi-note prompts on same tick)
* state progression MUST advance per chord-event group (not per single note inside the same group)

---

## 6.3 Finger assignment

Because the converter output does not include finger IDs:

* open-string notes (`fret = 0`) MUST use finger `0`
* fretted notes MUST be assigned using selected `allowed_fingers` with deterministic runtime mapping

## 6.4 Difficulty preset behavior

Gameplay target extraction MUST honor the original MIDI-to-TAB difficulty presets (`Easy`, `Medium`, `Hard`), including their soft-mode behavior (for example note dropping, per-event caps, and filtering thresholds).

GuitarHelio UI selections MUST still be enforced through converter parameters:

* `allowed_strings`
* `allowed_frets`
* derived `maxReachFret` from selected fret constraints

## 6.5 Constraint-aware playability adaptation

To reduce unsustainable note overlap after strict string/fret filtering, gameplay extraction MUST apply a constraint-aware adaptation layer on top of original MIDI-to-TAB presets:

* `maxNotesPerEvent` MUST be capped by the number of selected playable strings
* `onsetMergeWindowTicks` MUST be increased adaptively when selected string/fret sets are restrictive
* post-conversion target groups MUST be density-limited with a minimum time gap that depends on selected difficulty and constraint restrictiveness
* minimum group gap MUST be computed as:
  * Easy: `1.5 + 0.5 * restriction` seconds
  * Medium: `0.5 + 0.2 * restriction` seconds
  * Hard: `0.2 + 0.1 * restriction` seconds
* adaptation MUST preserve the selected base difficulty (`Easy`/`Medium`/`Hard`) and only relax density where required for playability

---

# 7. Audio Layer

## 7.1 Requirements

Audio engine MUST:

* play ALL SourceNotes
* be independent from gating
* remain tempo-accurate

## 7.2 Scheduler

Use WebAudio scheduling with lookahead.

Recommended:

* scheduling horizon ≈ 100–200 ms
* update every ≈ 25 ms

## 7.3 Anti-click synth mode

Gameplay playback MUST run with anti-click behavior enabled.

Requirements:

* prevent note starts in the past by clamping start times to a small future safety window
* apply non-zero attack and release envelopes on every note
* avoid hard cuts on pause/resume/scrub by releasing all active voices smoothly
* enforce `All Notes Off` / controller reset on stop or transport discontinuities
* apply clean-playback filtering before scheduling:
  * mute MIDI percussion channel (channel 10 / index 9)
  * discard ultra-short notes
  * discard out-of-range extreme notes for the playback synth
  * cap notes started on the same tick to reduce burst noise and overload

## 7.4 Playback synth engine

For MIDI backing-track playback, the project MUST use the JZZ synth stack:

* `jzz`
* `jzz-synth-tiny`

The runtime audio voice for scheduled SourceNotes must be provided by a JZZ Tiny synth adapter compatible with the existing scrub player (`noteOn`, `noteOff`, `stopAll`).

---

# 8. Gameplay State Machine

## 8.1 States

```ts
enum PlayState {
  Playing,
  WaitingForHit,
  Finished
}
```

---

## 8.2 Runtime state

```ts
type RuntimeState = {
  state: PlayState
  current_tick: number
  active_target_index: number
  waiting_target_id?: string
  waiting_started_at_s?: number
}
```

---

## 8.3 Transition rules

### Playing → WaitingForHit

When:

```
target not hit AND now_seconds >= target_time_seconds + late_hit_window_seconds
```

Actions:

* freeze current_tick at current transport position
* record waiting_started_at_s
* highlight note

---

### WaitingForHit → Playing

When valid pitch hit detected.

Also allowed:

### Playing → Playing (Target Validated)

When valid pitch hit is detected inside the live timing window:

```
target_time_seconds - pre_hit_window_seconds <= now_seconds <= target_time_seconds + late_hit_window_seconds
```

Default for both windows:

```
pre_hit_window_seconds = 0.5
late_hit_window_seconds = 0.5
```

In this case, target index advances without pausing transport.

Timeout:

`WaitingForHit` timeout resolution MUST be:

* infinite timeout when `profile.gating_timeout_seconds` is `null`
* `profile.gating_timeout_seconds` when it is a finite number
* otherwise default `2.5s`

If exceeded:

* mark miss
* resume playback

---

### Playing → Finished

When there is no active target left (`active_target_index` past the last target), gameplay MUST transition to `Finished`.

---

# 9. Pitch Detection (aubiojs)

## 9.1 Input

Microphone via WebAudio.

Pitch analysis MUST run on a residual signal produced by a DSP stage:

`mic + reference -> delay estimate -> NLMS echo suppression -> residual -> pitch detector`

The DSP stage MUST use the shared Rust/WASM core (`gh_dsp_core`) as primary backend on runtime targets.
Generated WASM artifacts MUST be synchronized to both:
- `src/audio/dsp-core` (runtime import source)
- `public/assets/dsp-core` (bundled static assets for worklet module loading)

When WASM core initialization fails, runtime MUST fall back to the legacy JS DSP path without blocking session startup.

The `reference` stream SHOULD come from the active backing playback path:
- backing audio tap when audio file playback is active
- synthetic MIDI-aligned reference when MIDI fallback playback is active

## 9.2 Required output

```ts
type PitchFrame = {
  t_seconds: number
  midi_estimate: number | null
  confidence: number
  reference_midi?: number | null
  reference_correlation?: number
  energy_ratio_db?: number
  onset_strength?: number
  contamination_score?: number
  rejected_as_reference_bleed?: boolean
}
```

Runtime confidence estimation MUST be derived from normalized autocorrelation:

```
bestCorrelation = max_lag corr(samples, lag)
```

with:

```
corr = cross / sqrt(normA * normB)
```

and confidence mapping:

```
if rms < 0.0035 -> confidence = 0, midi_estimate = null
else if bestCorrelation < 0.58 -> confidence = clamp01(bestCorrelation), midi_estimate = null
else -> confidence = clamp01((bestCorrelation - 0.45) / 0.5)
```

where:

```
clamp01(x) = min(1, max(0, x))
```

---

## 9.3 Anti-contamination policy

The system MUST NOT reject a frame only because detected pitch equals current backing pitch.

For `speaker` mode, hard reject is allowed only when all conditions are true:
- `pitch_match` (`abs(mic_midi - reference_midi) <= 0.25`)
- `reference_correlation >= 0.86`
- `energy_ratio_db <= -10`
- `onset_strength < 0.22`
- `energy_ratio_db < +4`

For `headphones` mode, hard reject MUST be more permissive and apply only when:
- `pitch_match`
- `reference_correlation >= 0.94`
- `energy_ratio_db <= -14`

In ambiguous pitch-match cases that are not hard-rejected, confidence MUST be penalized instead of nulling pitch:
- `speaker`: `confidence' = confidence * (1 - 0.45 * contamination_score)`
- `headphones`: lighter penalty

## 9.4 Hit validation

A hit is valid if for at least `hold_ms` continuous:

* confidence ≥ min_confidence
* pitch within tolerance

Per-frame validity MUST be:

```
valid_frame_i =
  (midi_estimate_i !== null) &&
  (confidence_i >= min_confidence) &&
  (abs(midi_estimate_i - expected_midi) <= pitch_tolerance_semitones)
```

A target hit MUST be valid iff there exists a continuous streak of valid frames such that:

```
(t_last - t_first) * 1000 >= hold_ms
```

Defaults:

```
headphones: hold_ms = 80, min_confidence = 0.7
speaker: hold_ms = 110, min_confidence = 0.76
```

## 9.5 Temporal stabilization

To reduce frame-to-frame jitter from raw pitch estimation:

* gameplay pitch frames MAY apply a light temporal smoothing on `midi_estimate` before hit validation
* smoothing MUST preserve responsive hit timing (no large extra latency) and MUST keep `confidence`-gated validation semantics

---

# 10. Scoring System

## 10.1 Timing measurement

Primary case (hit while still Playing inside live window):

```
delta_ms = abs(hit_time_seconds - target_time_seconds) * 1000
```

Fallback case (hit after transport is paused in WaitingForHit):

```
delta_ms = performance.now() - waiting_started_at
```

---

## 10.2 Discrete scoring

| Rating  | Threshold |
| ------- | --------- |
| Perfect | ≤ 50 ms   |
| Great   | ≤ 120 ms  |
| OK      | ≤ 250 ms  |
| Miss    | > 250 ms  |

Points:

* Perfect: +100
* Great: +70
* OK: +40
* Miss: +0

HUD/runtime performance constraint:

* displayed score and streak SHOULD be maintained incrementally on score events, avoiding per-frame full-array reductions/scans

---

## 10.3 End-of-song metrics

Compute:

* total score
* hit distribution
* average reaction time
* longest streak

At end-of-song, gameplay MUST show a completion menu with two explicit actions:

* `Restart` → restart the same session/song
* `Back to Start` → return to `SongSelectScene`
* when the last target note is completed, gameplay MUST wait about 2 seconds before opening the completion menu/end screen
* when completion menu is visible, bottom minimap and bottom-right hand reminder MUST be hidden to avoid overlap with end-screen controls
* the completion menu MUST show 3 neutral stars that fill in yellow (with a brief scale animation) based on played-note ratio and selected difficulty:
  * `Easy`:
    - >= 10% played notes: 1 star
    - >= 40% played notes: 2 stars
    - >= 60% played notes: 3 stars
  * `Medium` and `Hard`:
    - >= 30% played notes: 1 star
    - >= 60% played notes: 2 stars
    - >= 90% played notes: 3 stars

---

# 11. Visual System

## 11.1 Lanes

* 6 horizontal lanes (strings)
* string 1 at top, string 6 bottom
* each string line MUST span the full screen width (left and right edges)
* gameplay background MUST NOT include the extra 4 decorative horizontal guide lines above the fretboard
* the gameplay fretboard/tracks MUST use a pronounced perspective tilt (narrower far/top side and wider near/bottom side) to emphasize depth
* gameplay tab area MUST be rendered with about 10% less height than previous baseline and shifted upward to avoid overlap with the bottom-right hand reminder
* string style in PlayScene MUST follow:
  * strings 1-3 (top to bottom): slightly thicker than baseline and light/cool color
  * string 4: yellow and slightly thicker
  * string 5: yellow and slightly thicker than string 4
  * string 6: yellow and slightly thicker than string 5

## 11.2 Note bars

Render ONLY TargetNotes.

Properties:

* width proportional to duration
* each note must have a minimum circular head size: visual width MUST never be smaller than note height (circle-equivalent footprint)
* for mobile readability, target-note circular heads MUST render at approximately 2x the previous baseline diameter
* when note duration is longer, the shape MUST extend horizontally as a capsule/pill from that circular minimum
* color based on finger
* once a TargetNote is played correctly (`Perfect`, `Great`, or `OK`), its bar color MUST turn green
* show the fret number directly on each target bar (no circular background)
* fret number must be visible as soon as the note appears on screen, not only during waiting state
* fret-number labels MUST use reusable pooled text objects (no create/destroy per frame in the runtime loop)

Suggested finger colors:

```
0 (open string) → gray
1 (index) → yellow
2 (middle) → purple
3 (ring) → blue
4 (pinky) → red
```

For mobile readability, the finger-color palette MUST favor brighter/lighter variants of yellow, purple, blue, and red while preserving the same finger-to-color mapping.

---

## 11.3 Hit line

* fixed vertical line
* target-note timing is still referenced to this line
* the ball may leave the hit line while traveling, but it must touch the pad at note timing

---

## 11.4 Ball behavior

* must move with a ballistic trajectory between consecutive TargetNotes (no instant teleport between strings)
* trajectory must evolve on both axes (`x` + `y`) during flight; impacts happen on-pad only at note timing
* lateral (`x`) excursion must remain visually discreet and MUST never move the ball beyond the left half of the screen
* must touch the target pad exactly when the note has to be played
* after touching a note, it must bounce toward the next note location
* at song start, before the first impact, the ball must appear already in motion: launch from string 3 at maximum height and fall into the first timed impact
* bounce amplitude must be configurable via app constants/settings and default to a visibly pronounced jump
* must render a clearly visible dashed trail behind the ball (instead of ghost circles), readable also on sudden jumps between different strings
* freezes during WaitingForHit
* resumes afterward
* must be hidden when runtime enters `Finished` (no post-song ball rendering)

---

## 11.5 In-session back/escape menu

During active gameplay (Playing or WaitingForHit), pressing:

* `Esc` (desktop keyboard)
* hardware/software `Back` on smartphone

MUST open a pause menu with exactly three actions:

The gameplay HUD MUST also include a bottom-left pause button that shows icon-only controls (no text):
* while gameplay is active: classic pause icon (`||`)
* while gameplay is paused by the button itself: classic play icon (right-pointing triangle)
Pressing this button MUST pause/resume gameplay directly (freeze runtime progression and stop backing playback), without opening the pause menu.
The pause menu MUST be opened only by `Esc` or smartphone `Back`.
All pause menu actions MUST be clickable both on button backgrounds and on their text labels.

* `Continue` → close pause menu and resume gameplay from the paused position
* `Reset` → restart the current session with the same song and difficulty
* `Back to Start` → leave gameplay and return to `SongSelectScene`

While this menu is open, runtime progression and playback MUST remain paused.

On `SongSelectScene`, pressing `Esc` (desktop/server/Windows) or smartphone `Back` (Capacitor Android) MUST open a quit confirmation popup with exactly two actions:

* `Cancel` → close the popup and keep the app running
* `Quit` → close the application when runtime supports it (Capacitor native app and Electron desktop app)

On web/server browser runtime, if window closing is not supported by the browser, `Quit` MUST fall back to closing only the popup.

---

## 11.5.1 Session pre-roll

When entering `PlayScene`, actual song playback (audio or MIDI) MUST start with a short pre-roll delay to let the user prepare.

Requirements:

* pre-roll duration MUST be between 3 and 5 seconds (default target: 3.5s)
* during pre-roll, song progression/timeline MUST stay frozen at the song start
* during pre-roll, HUD SHOULD show a clear "get ready" indication with remaining time
* the first playable note timing MUST be evaluated only after pre-roll playback start
* any source note with onset time earlier than 3.0 seconds MUST be ignored/removed only for gameplay target generation; full song playback must remain uncut

---

## 11.6 Waiting HUD text

During `WaitingForHit`, the HUD MUST NOT show `Play MIDI xx`.
It may show only generic waiting text and optional remaining timeout.
Gameplay feedback messages such as `Get Ready`, `Waiting`, `Perfect`, `Too Soon`, `Too Late` MUST be rendered as plain text (no box), horizontally centered below the speed slider (between slider and pad area), with a clearly larger font than regular HUD labels.

---

## 11.7 Start screen settings menu

The difficulty selector in start screen MUST be a single cycle button that rotates difficulty on each tap/click in this order: `Easy` -> `Medium` -> `Hard` -> `Easy`.
The difficulty cycle button MUST be color-coded by current value: `Easy` with green background, `Medium` with blue background, `Hard` with red background.
The default selected difficulty on start screen MUST be `Medium`.
The start screen MUST provide a `Settings` button under the difficulty selector.
The transient status label above `Start Session` MUST stay hidden.
Pressing this button MUST open a modal settings panel with a dimmed background overlay.
The `Session Settings` panel MUST include a top-right red button (same color family used by `Hard` difficulty) labeled to reset all song best scores.
The `Session Settings` panel MUST include a top-left `Input Mode` cycle button that rotates mode on each tap/click between `Speaker` and `Headphones`, while always showing the currently active mode in the same button label.
Pressing the reset button MUST open a confirmation popup with explicit `Cancel` and `Reset` actions before any score data is changed.
Confirming reset MUST clear all persisted best scores for every song in both web/localStorage runtime and Capacitor native song library runtime.
All start-screen buttons and toggle controls MUST be fully clickable across their full visual button area (not limited to text/icon glyph bounds).
The song list in start screen MUST be rendered inside an invisible scrollable viewport (mouse wheel + drag/touch scroll) so users can browse and select songs beyond the initially visible rows.
Song titles in song cards MUST always stay inside their fixed label box; if a title is too long, UI MUST reduce title font size until it fits.
Each song-card cover thumbnail MUST include a visible white rounded frame/mask overlay that slightly overlaps cover edges to hide hard square corners and edge artifacts.
When a custom song cover is loaded lazily, the thumbnail image MUST immediately fill its full thumbnail box (no reduced-size first render, no need to enter/exit `PlayScene`).
Start-screen song cards MUST support long-press (tap/click hold) to open a small `Remove` button anchored to that card.
If the user taps/clicks anywhere outside that `Remove` button, the remove button MUST close.
Pressing `Remove` MUST delete the selected song from filesystem and manifest/catalog (both server/web and native library modes), then refresh the song list.

Inside this panel, the user can choose:

* allowed strings as an explicit list from 1 to 6 (non-contiguous selections allowed)
* allowed fingers as an explicit list from 1 to 4 (non-contiguous selections allowed)
* allowed frets as an explicit list from 0 to 21 (non-contiguous selections allowed)

The number of active fingers is defined by how many fingers are selected.

These settings MUST be applied when generating TargetNotes for the session.
Selected difficulty + strings + fingers + frets MUST persist across app restarts/session reloads (web/server runtime and Capacitor Android runtime).

---

## 11.8 Fingering assignment rules

Fingering MUST follow a position/box model with the rule "one finger per fret" in the active box:

* index (1) on the lowest fret of the box
* middle (2) on next fret
* ring (3) on next fret
* pinky (4) on highest fret of the box

Additional constraints:

* minimize hand movement and box shifts between consecutive notes
* avoid reusing the same finger on consecutive notes when frets differ (except slide-like same-fret reuse)
* open strings use finger `0`

---

## 11.9 Finger color reminder widget

During gameplay, show a small hand/finger reminder in the bottom-right corner.
The widget must display finger colors mapped as:

* 0: gray
* 1: yellow
* 2: purple
* 3: blue
* 4: red

---

## 11.10 Debug play-target button

During gameplay, a debug button must be available to play the current required target note (`expected_midi`) through the app synth.
If pressed while in `WaitingForHit`, it MUST also validate the hit and advance progression as if the correct pitch had been detected.
If pressed outside the valid hit window, gameplay MUST NOT validate the hit and should report that the debug note was out of window.

On Capacitor Android runtime, system back navigation (hardware/gesture back) during `PlayScene` MUST map to pause-menu behavior:

* if pause menu is closed, open `Pause Menu`
* if pause menu is open, close it
* while gameplay is active, back navigation MUST NOT background/exit the app directly

On Capacitor Android runtime, app lifecycle transitions MUST be battery-safe:

* when app goes to background during `PlayScene`, gameplay MUST auto-pause and runtime audio processing MUST be suspended
* when app returns to foreground, gameplay MUST remain paused until explicit user resume
* when app goes to background while tuner is active in `SongSelectScene`, tuner microphone capture MUST stop
* while `PlayScene` is active in foreground, Android runtime MUST keep the screen awake (no automatic dim/standby)
* when leaving `PlayScene`, Android runtime MUST release keep-awake so non-gameplay screens can dim/standby normally

In debug sessions, gameplay MUST also provide a central debug overlay (toggle key: `F3`) showing at least:

* runtime state and last state transition
* active target details (id/string/fret/expected midi)
* current tick vs target tick and current song time vs target time
* detected pitch (`midi_estimate`) + confidence, held-hit progress vs required hold
* hit-gating flags (`within window`, `can validate`, `valid hit`) and waiting timeout progress

---

## 11.11 Start-screen tuner

The start screen MUST include a tuner menu opened by a dedicated button.
Inside this tuner menu, show a tuner panel that:

* lets the user select which string to tune (1–6)
* starts/stops microphone listening
* shows a tuning slider/needle that moves based on cents distance from the target string pitch
* shows a centered green target band representing the in-tune zone `-5c .. +5c`

The tuner must update in real time while active.
The tuner display (detected note + cents + needle) MUST apply temporal stabilization to avoid noisy oscillation:

* confidence gating for unreliable frames
* smoothing/quantization of cents for the needle
* note-label hysteresis (do not flip note name on single-frame boundary crossings)
* short dropout hold before clearing the detected value

The tuner MUST also provide a microphone calibration workflow based on multi-point reference tones:

* calibration MUST sample multiple known notes (at least across guitar range E2→E4)
* each point MUST estimate cents offset using robust statistics (outlier-resistant)
* the final correction MUST be represented as a piecewise-linear cents curve over MIDI pitch
* calibration profile MUST persist locally and be reusable in future sessions
* the same calibration curve SHOULD be applicable to gameplay pitch validation (PlayScene), not only tuner display
* when calibration completes successfully, UI MUST show a popup summary with calibration parameters (points/offsets/quality metrics)
* this summary popup MUST close on any click/tap anywhere on screen
* while tuner is active, if current target string stays inside in-tune green band (`±5c`) for at least `2` continuous seconds:
  - current string toggle MUST be marked as tuned (green)
  - tuner MUST auto-select the next string in tuning sequence and continue until no strings remain

Start screen Session Settings MUST expose an explicit audio input mode toggle via a single cycle button:
- `Speaker` (default): reduced precision but robust against playback bleed
- `Headphones` (recommended): full precision

### 11.11.1 Practice scene

The start screen MUST expose a dedicated `Practice` button (with `icon-guitar-neon.png`) that opens a separate practice scene.

Practice scene requirements:

* show 6 guitar strings and a full fret grid from fret `0` to fret `12`
* draw all note positions for each string/fret intersection
* all note positions MUST be gray by default
* while microphone detection is active, the scene MUST run a direct A/B compare between:
  - detector `A`: current project pitch detector (`PitchDetectorService`)
  - detector `B`: aubiojs pitch detector
* for each detected pitch, the scene MUST highlight all equivalent fretboard positions (same MIDI across strings/frets)
* highlighted positions MUST be color-coded in real time:
  - `A only` -> green
  - `B only` -> amber/orange
  - `A + B` (same detected pitch) -> lime/combined highlight
* include explicit controls for `Start Mic` / `Stop Mic`
* include a metronome with:
  - a BPM scrollbar/slider control
  - an explicit `Start Metronome` / `Stop Metronome` button
* include `Back to Start` to return to `SongSelectScene`
* on Capacitor Android runtime, `Practice` scene MUST keep the screen awake while the scene is active and MUST restore normal screen-timeout behavior when leaving the scene
* the scene SHOULD show per-detector stable note output and A/B semitone delta
* both detectors SHOULD reuse the same microphone input stream in that scene, and SHOULD apply persisted calibration profile when available

---

## 11.12 Global visual theme

The app visual style (start screen, gameplay scene, modal overlays) MUST follow a coherent neon-blue "glass" UI direction:

* deep blue gradient background with subtle glow lines/circle accents
* glass-like panels/cards with translucent dark-blue fill and soft cyan/blue borders
* emphasized primary CTA (`Start Session`) in warm orange gradient look with glow
* typography with bold, high-contrast labels readable on dark background
* typography MUST use `Montserrat` project-wide
* `Montserrat` font assets MUST be bundled locally in the app package; runtime MUST NOT depend on external font CDN/network fetch
* gameplay overlays (pause/results) styled consistently with the same panel language
* on Capacitor Android runtime, app content MUST run in immersive full-screen mode (status bar + navigation bar hidden by default, transient reveal only by system gesture)

Start-screen layout constraints:

* the title logo asset (`logoGuitarHelio`) MUST be rendered with its displayed height reduced by 30% and shifted upward by 40px
* the primary CTA `Start Session` MUST be increased by about 100% in visual area versus baseline (roughly +41% per side), preserving full clickability of background + label/icon
* in landscape/mobile layouts, right-side controls (`Difficulty`, `Import`, `Settings`, `Tuner`, `Practice`) and `Start Session` CTA MUST keep non-overlapping spacing
* in all runtimes (server/web, Windows, Android), right-side action buttons (`Import`, `Settings`, `Tuner`, `Practice`) MUST use equal vertical spacing between consecutive buttons
* in all runtimes (server/web, Windows, Android), right-side action buttons (`Import`, `Settings`, `Tuner`, `Practice`) MUST use a compact height so the top-right control zone stays clear of transient system status bar overlays

### 11.12.1 App icon and startup splash assets

Branding assets MUST be wired consistently across runtime targets:

* Windows desktop packaging MUST use `assets/guitarhelio.ico` as application icon
* Android launcher icon MUST be generated from `assets/ic_launcher_background.png` + `assets/ic_launcher_foreground.png` for adaptive and legacy mipmap assets
* Server/web build MUST expose favicon from `public/favicon.ico` sourced from `assets/favicon.ico`
* all platforms (web/server, Windows desktop, Android) MUST show startup splash `guitarhelio_splash_landscape_bg_1920x1080.png` for about 2 seconds at app launch while the app bootstrap continues in background

---

## 11.13 Song catalog structure and fallback rules

Each song entry in `public/songs/manifest.json` MUST include:

* cover image reference (`cover`)
* MIDI reference file (`midi`)
* optional WAV/MP3/OGG reference file (`audio`)
* optional high-score seed (`highScore`, integer >= 0)

Songs MUST be organized in dedicated folders under `public/songs/<song-folder>/`.

For Capacitor native runtime, the same catalog structure MUST also be supported in app-local storage under `Directory.Data/songs/<song-folder>/`, with a dedicated local manifest at `Directory.Data/songs/manifest.json`.

Fallback behavior:

* if `midi` is missing in manifest entry, that song MUST NOT be shown in song selection
* if `midi` path is present but file is missing/unreachable at runtime, session start MUST fail with a clear user-facing error while keeping start screen usable
* if `cover` is missing or not found, use default asset `public/ui/song-cover-placeholder-neon.png`
* if `audio` is missing or not found, use the song MIDI reference as fallback audio source
* if `audio` falls back to MIDI, the song-select button thumbnail MUST show fallback cover art
* during gameplay playback, if a valid WAV/MP3/OGG file is available it MUST be used as backing track; otherwise playback MUST use MIDI synth rendering

---

## 11.13.2 Start-screen startup loading policy

Start-screen startup MUST prioritize fast first interaction over full upfront validation.

Startup requirements:

* start-screen UI MUST render immediately, without waiting for full song-catalog asset validation
* song catalog entries MUST be parsed/normalized first, then hydrated progressively
* cover images MUST load lazily with visible cards prioritized before off-screen cards
* startup flow MUST NOT perform mass `HEAD/GET` validation for every song asset on web runtime
* hard asset validation MUST happen only when starting a session for the selected song
* if selected song validation fails (missing MIDI or invalid source), runtime MUST show an explicit error and keep start-screen interactive

---

## 11.13.1 Session persistence (settings + high score)

Persistence requirements for both server/web build and Capacitor Android build:

* start-screen settings (`difficulty`, `allowed strings`, `allowed fingers`, `allowed frets`) MUST be restored automatically on next app launch
* each song MUST keep a persistent best score keyed by song id
* at session end, stored best score must update only if the new total score is higher
* when `manifest.json` provides `highScore`, runtime best score MUST use `max(manifest highScore, stored high score)`

---

## 11.14 Audio to MIDI conversion strategy (balanced)

Default conversion path MUST use the C++/ONNX pipeline based on:

* NeuralNote C++ core (`neuralnote_core`)
* Tempo-CNN C++ ONNX core (`tempocnn_core`)

Balanced conversion defaults MUST remain:

* `noteSensitivity`: `0.65` (equivalent to `modelConfidenceThreshold: 0.35`)
* `splitSensitivity`: `0.7` (equivalent to `noteSegmentationThreshold: 0.3`)
* `minNoteLengthMs`: `120`
* `melodiaTrick`: `true`
* `minPitchHz`: `1`
* `maxPitchHz`: `3000`
* `energyTolerance`: `11`
* `midiTempo`: `120`

Runtime strategy constraints:

* production/default mode MUST use the C++/ONNX converter
* debug converter labels `legacy` and `neuralnote` MUST remain accepted for backward compatibility, but both MUST map to the same C++/ONNX backend
* debug converter mode `ab` MUST be rejected explicitly with a clear user-facing error
* import conversion MUST estimate a constant tempo via Tempo-CNN ONNX and apply only:
  * `tempoBpm` global constant value
* for all conversion modes, exported MIDI end-of-track time MUST match input audio duration (MP3/OGG/WAV), including trailing silence up to audio end

---

## 11.15 Start-screen song import workflow

The start screen MUST include an `Import Your Song` action (with `icon-import-neon.png`) that allows uploading a local source file (`.mid`/`.midi`, `.mp3`, `.ogg`).

When a source file is selected:

* create a dedicated song folder using the uploaded filename without extension
* for MP3/OGG input: save the original uploaded audio as song backing track in that folder
* for MP3/OGG input: convert the uploaded audio into MIDI (`song.mid`) using the local converter
* for MIDI input: save the uploaded MIDI as `song.mid` directly (no audio conversion)
* show the original import popup in start screen while the job is running (stage text, progress bar, percentage)
* the import popup MUST close only on tap/click outside the import window (not on tap inside the window)
* in native Android audio import, conversion progress MUST expose distinct stages for `Estimating tempo (Tempo-CNN ONNX)` and `Running NeuralNote transcription`
* native Android conversion stages (`Tempo-CNN` / `NeuralNote`) MUST fail with an explicit timeout error if a single stage exceeds its configured timeout budget (derived from input duration and capped at 20 minutes)
* for MP3/OGG input: inspect embedded metadata artwork and, when available, extract and save it as the song cover in the same folder
* for MIDI input: no audio (`audio`) and no cover (`cover`) are required
* append/update the song manifest with the new song entry (`id`, `name`, `folder`, `midi`, optional `audio`, optional `cover`)
* refresh the start-screen song list automatically so the new song appears immediately after import

Manifest/storage target by platform:

* web dev/preview mode: `public/songs/manifest.json`
* Electron Windows desktop runtime: `%APPDATA%/GuitarHelio/songs/manifest.json`
* Capacitor native mode (Android standalone): `Directory.Data/songs/manifest.json`

Implementation constraints for import paths:

* web dev/preview import default MUST run through the C++/ONNX converter wrapper
* Electron Windows desktop import default MUST run through the same server-side C++/ONNX converter wrapper used by web preview
* Capacitor Android import default MUST run through the native C++/ONNX plugin bridge
* Capacitor Android native converter builds (including debug variants) MUST compile NeuralNote/Tempo-CNN C++ code with optimized native flags (release-grade optimization, debug symbols allowed)
* server/native import MUST estimate constant tempo via Tempo-CNN ONNX and inject MIDI tempo metadata using only `tempoBpm` (no local `tempoMap`) for MP3/OGG sources
* debug converter labels `legacy` and `neuralnote` MUST remain accepted as aliases for the same backend
* debug converter mode `ab` MUST be rejected explicitly (server HTTP `400`, native import error)

### 11.15.1 Runtime chunking constraints (core vs on-demand)

* gameplay-critical modules (scene rendering, runtime state machine, pitch/timing validation, audio playback required to play a session) MUST remain part of core app loading.
* import/conversion modules that are not required to start or play a normal session MUST be loaded on-demand via dynamic import:
  * native import workflow (`nativeSongImport`)
  * native converter bridge (`nativeNeuralNoteConverter`, NeuralNote/Tempo-CNN path)
  * native catalog/library helpers used only by import/remove/persist-native operations
* client-side audio decode for import SHOULD use runtime-native WebAudio decode to avoid bundling heavy optional codec decoder stacks in frontend chunks.
* build chunk-size warnings MUST be interpreted as per-chunk warnings (core and lazy chunks), not as guaranteed startup download size.

Debug/testing support:

* in debug builds, the start screen MUST expose an `Import Source` selector (`Auto`, `Server`, `Native`) to force the import path for validation
* the debug `Import Source` selector MUST be positioned in the top-left zone of the start screen, above the `Song` section
* the debug `Import Source` selector MUST NOT overlap song cards/thumbnails
* Capacitor Android native import MUST keep debug timeline logging instrumentation in code, but it MUST be disabled by default in production builds.
* when debug timeline logging is explicitly enabled, it MUST write a persistent file for each run at:
  * primary: `<external-files>/import-debug/song-import-debug.log`
  * fallback when external files dir is unavailable: `<internal-files>/import-debug/song-import-debug.log`
  * the file MUST include:
    * JS pre-native import checkpoints (`decode`, `downmix`, `resample`, `base64 encode`, temp file write/URI resolution)
    * native stage start/completion markers and watchdog heartbeats
    * resolved paths/sizes and full failure stack traces
* Capacitor Android start screen MUST expose an in-app `Share Log` action near import controls when debug timeline logging is enabled:
  * it MUST open the native Android share sheet (`ACTION_SEND`) so Quick Share or any installed share target can be used
  * it MUST share `song-import-debug.log`; if missing/empty, fallback to `song-import-debug.prev.log`
* debug converter mode selector MUST keep backward-compatible labels (`legacy` / `neuralnote` / `ab`)
* `legacy` and `neuralnote` labels MUST execute the same C++/ONNX pipeline
* selecting `ab` MUST fail immediately with an explicit message
* default mode is `Auto`:
  * `Server` on web dev/preview and Electron Windows desktop runtime
  * `Native` on Capacitor native runtime

---

## 11.16 Play-scene top starfield

The top band of the gameplay scene MUST render a moving star background.

Star movement constraints:

* stars scroll horizontally in lockstep with song progression
* horizontal scroll MUST use the same tick-to-pixel pace used for gameplay motion (`current_tick * pxPerTick`)
* when song progression is paused (e.g., waiting gate/pause menu), star horizontal movement MUST pause as well

---

## 11.17 Play-scene song minimap

The gameplay scene MUST include a bottom minimap of the full song timeline.

Minimap requirements:

* render a compact preview of all target notes across the whole song length
* each minimap note MUST use the same finger color mapping used in gameplay
* minimap notes whose onset is already passed by the current playhead (`target.tick <= runtime.current_tick`) MUST be rendered in green
* include timeline progression feedback (playhead/current position)
* progression MUST remain synchronized with gameplay timeline (`runtime.current_tick`)
* minimap bounds MUST keep a clear gap from the bottom-right hand reminder widget (no overlap)
* minimap height MUST be doubled versus previous baseline sizing

---

## 11.18 Play-scene speed slider

The gameplay scene MUST include a playback speed slider centered at the top of the screen.

Speed control requirements:

* slider range MUST be from `25%` to `125%`
* default value MUST be `100%`
* changing speed MUST affect song progression/timeline pace in real time
* when an audio backing track is active, slider changes MUST also update backing audio playback rate to stay synchronized with gameplay progression
* current selected speed value MUST be visible in the slider HUD

---

# 12. Difficulty Presets (defaults)

## Easy

* strings: [6,5,4]
* frets: 0–3
* fingers: [1]
* avg_seconds_per_note: 2.0
* gating_timeout_seconds: null (infinite WaitingForHit)
* pitch_tolerance: ±3

## Medium

* strings: [6,5,4,3]
* frets: 0–5
* fingers: [1,2,3]
* avg_seconds_per_note: 0.5 (1 note every 0.5s)
* pitch_tolerance: ±1

## Hard

* strings: [1–6]
* frets: 0–12
* fingers: [1–4]
* avg_seconds_per_note: 0.15 (about 1 note every 0.15s)
* pitch_tolerance: ±0.5

---

# 13. Non-Goals (MVP)

The following are explicitly OUT of scope:

* polyphonic pitch detection
* chord gameplay
* automatic fingering optimization across positions
* mobile optimization
* multiplayer
* advanced tone modeling

---

# 14. Acceptance Criteria

The MVP is complete when:

* MIDI loads and plays full music
* TargetNotes are generated per difficulty
* lanes and bars render correctly
* ball follows ballistic transitions between notes and lands on-note at required timing
* microphone pitch triggers progression
* scoring accumulates
* song completes with results screen
* project builds and deploys statically
* Windows desktop package (`.exe`) builds successfully via Electron pipeline
* GitHub Actions tag release pipeline (`v*`) publishes both Android debug APK and Windows desktop release artifacts in the same GitHub Release

---

# End of Specification
