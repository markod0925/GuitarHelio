```markdown
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

## 2.2 Required stack

- Phaser 3
- TypeScript
- Vite
- WebAudio API
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
example.mid

````

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
````

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
  gating_timeout_seconds?: number
}
```

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
SourceNotes
  → Candidate extraction
  → Density filter
  → Guitar projection
  → TargetNotes
```

---

## 6.1 Candidate extraction

Rules:

* collect all NoteOn events
* cluster chords within 30–60 ms
* keep one representative note per cluster

Selection policy (configurable):

* prefer highest pitch (default)

---

## 6.2 Density filter

Compute minimum spacing:

If `avg_seconds_per_note`:

```
min_gap_seconds = avg_seconds_per_note
```

If `target_notes_per_minute`:

```
min_gap_seconds = 60 / target_notes_per_minute
```

Convert to ticks via tempo map.

Allow at most one TargetNote per window.

---

## 6.3 Guitar projection

For each candidate pitch:

Find playable (string, fret, finger) such that:

* string ∈ allowed_strings
* fret within allowed range
* finger allowed
* pitch distance constraint:

```
abs(expected_midi - source_midi) <= pitch_tolerance_semitones
```

If multiple solutions:

Minimize cost:

```
cost =
  w1 * pitch_distance +
  w2 * fret_height +
  w3 * large_jump_penalty
```

Fallback order:

1. try octave shift ±12
2. skip note

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
current_tick >= target.tick - approach_threshold
```

Actions:

* freeze current_tick
* record waiting_started_at_s
* highlight note

---

### WaitingForHit → Playing

When valid pitch hit detected.

Optional timeout:

If exceeded:

* mark miss
* resume playback

---

# 9. Pitch Detection (aubiojs)

## 9.1 Input

Microphone via WebAudio.

## 9.2 Required output

```ts
type PitchFrame = {
  t_seconds: number
  midi_estimate: number | null
  confidence: number
}
```

---

## 9.3 Hit validation

A hit is valid if for at least `hold_ms` continuous:

* confidence ≥ min_confidence
* pitch within tolerance

Defaults:

```
hold_ms = 80
min_confidence = 0.7
```

---

# 10. Scoring System

## 10.1 Timing measurement

When entering WaitingForHit:

```
t0 = performance.now()
```

On hit:

```
delta_ms = now - t0
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

---

## 10.3 End-of-song metrics

Compute:

* total score
* hit distribution
* average reaction time
* longest streak

---

# 11. Visual System

## 11.1 Lanes

* 6 horizontal lanes (strings)
* string 1 at top, string 6 bottom

## 11.2 Note bars

Render ONLY TargetNotes.

Properties:

* width proportional to duration
* color based on finger
* show the fret number directly on each target bar (no circular background)
* fret number must be visible as soon as the note appears on screen, not only during waiting state

Suggested finger colors:

```
0 (open string) → gray
1 (index) → yellow
2 (middle) → purple
3 (ring) → blue
4 (pinky) → red
```

---

## 11.3 Hit line

* fixed vertical line
* ball aligned with it

---

## 11.4 Ball behavior

* bounces on beat
* freezes during WaitingForHit
* resumes afterward

---

## 11.5 In-session back/escape menu

During active gameplay (Playing or WaitingForHit), pressing:

* `Esc` (desktop keyboard)
* hardware/software `Back` on smartphone

MUST open a pause menu with exactly two actions:

* `Reset` → restart the current session with the same song and difficulty
* `Back to Start` → leave gameplay and return to `SongSelectScene`

While this menu is open, runtime progression and playback MUST remain paused.

---

## 11.6 Waiting HUD text

During `WaitingForHit`, the HUD MUST NOT show `Play MIDI xx`.
It may show only generic waiting text and optional remaining timeout.

---

## 11.7 Start screen settings menu

The difficulty selector in start screen MUST be a dropdown menu (`Easy`, `Medium`, `Hard`).
The start screen MUST provide a `Settings` button under the difficulty selector.
Pressing this button MUST open a modal settings panel with a dimmed background overlay.

Inside this panel, the user can choose:

* allowed strings as an explicit list from 1 to 6 (non-contiguous selections allowed)
* allowed fingers as an explicit list from 1 to 4 (non-contiguous selections allowed)
* allowed frets as an explicit list from 0 to 21 (non-contiguous selections allowed)

The number of active fingers is defined by how many fingers are selected.

These settings MUST be applied when generating TargetNotes for the session.

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

---

## 11.11 Start-screen tuner

The start screen MUST include a tuner menu opened by a dedicated button.
Inside this tuner menu, show a tuner panel that:

* lets the user select which string to tune (1–6)
* starts/stops microphone listening
* shows a tuning slider/needle that moves based on cents distance from the target string pitch

The tuner must update in real time while active.

---

# 12. Difficulty Presets (defaults)

## Easy

* strings: [6,5,4]
* frets: 0–3
* fingers: [1]
* avg_seconds_per_note: 2.0
* pitch_tolerance: ±2

## Medium

* strings: [6,5,4,3]
* frets: 0–5
* fingers: [1,2,3]
* avg_seconds_per_note: 1.2
* pitch_tolerance: ±1

## Hard

* strings: [1–6]
* frets: 0–12
* fingers: [1–4]
* avg_seconds_per_note: 0.6
* pitch_tolerance: 0

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
* ball stops at each TargetNote
* microphone pitch triggers progression
* scoring accumulates
* song completes with results screen
* project builds and deploys statically

---

# End of Specification

```

::contentReference[oaicite:0]{index=0}
```
