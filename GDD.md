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

Optional timeout:

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
* the completion menu MUST show 3 neutral stars that fill in yellow (with a brief scale animation) based on played-note ratio:
  * >= 30% played notes: 1 star
  * >= 60% played notes: 2 stars
  * >= 90% played notes: 3 stars

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
* when note duration is longer, the shape MUST extend horizontally as a capsule/pill from that circular minimum
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
* must be vertically anchored to the string of the first incoming TargetNote (active target), at the hit line
* bounce amplitude must be configurable via app constants/settings and default to a visibly pronounced jump
* must render a visible ghost trail behind the ball; the trail must remain clearly readable even on sudden jumps between different strings
* freezes during WaitingForHit
* resumes afterward
* must be hidden when runtime enters `Finished` (no post-song ball rendering)

---

## 11.5 In-session back/escape menu

During active gameplay (Playing or WaitingForHit), pressing:

* `Esc` (desktop keyboard)
* hardware/software `Back` on smartphone

MUST open a pause menu with exactly two actions:

The gameplay HUD MUST also include a bottom-left pause button that shows icon-only controls (no text):
* while gameplay is active: classic pause icon (`||`)
* while pause menu is open: classic play icon (right-pointing triangle)
Pressing this button MUST open/close the same pause menu.

* `Reset` → restart the current session with the same song and difficulty
* `Back to Start` → leave gameplay and return to `SongSelectScene`

While this menu is open, runtime progression and playback MUST remain paused.

---

## 11.6 Waiting HUD text

During `WaitingForHit`, the HUD MUST NOT show `Play MIDI xx`.
It may show only generic waiting text and optional remaining timeout.

---

## 11.7 Start screen settings menu

The difficulty selector in start screen MUST be a segmented control (`Easy`, `Medium`, `Hard`) styled as a pill group.
The default selected difficulty on start screen MUST be `Medium`.
The start screen MUST provide a `Settings` button under the difficulty selector.
Pressing this button MUST open a modal settings panel with a dimmed background overlay.
All start-screen buttons and toggle controls MUST be fully clickable across their full visual button area (not limited to text/icon glyph bounds).
The song list in start screen MUST be rendered inside an invisible scrollable viewport (mouse wheel + drag/touch scroll) so users can browse and select songs beyond the initially visible rows.
Song titles in song cards MUST always stay inside their fixed label box; if a title is too long, UI MUST reduce title font size until it fits.

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

The tuner must update in real time while active.

---

## 11.12 Global visual theme

The app visual style (start screen, gameplay scene, modal overlays) MUST follow a coherent neon-blue "glass" UI direction:

* deep blue gradient background with subtle glow lines/circle accents
* glass-like panels/cards with translucent dark-blue fill and soft cyan/blue borders
* emphasized primary CTA (`Start Session`) in warm orange gradient look with glow
* typography with bold, high-contrast labels readable on dark background
* gameplay overlays (pause/results) styled consistently with the same panel language

Start-screen layout constraints:

* the title logo asset (`logoGuitarHelio`) MUST be rendered with its displayed height reduced by 30% and shifted upward by 40px
* the primary CTA `Start Session` MUST be increased by about 100% in visual area versus baseline (roughly +41% per side), preserving full clickability of background + label/icon

---

## 11.13 Song catalog structure and fallback rules

Each song entry in `public/songs/manifest.json` MUST include:

* cover image reference (`cover`)
* MIDI reference file (`midi`)
* WAV/MP3/OGG reference file (`audio`)
* optional high-score seed (`highScore`, integer >= 0)

Songs MUST be organized in dedicated folders under `public/songs/<song-folder>/`.

For Capacitor native runtime, the same catalog structure MUST also be supported in app-local storage under `Directory.Data/songs/<song-folder>/`, with a dedicated local manifest at `Directory.Data/songs/manifest.json`.

Fallback behavior:

* if `midi` is missing or not found, that song MUST NOT be shown in song selection
* if `cover` is missing or not found, use default asset `public/ui/song-cover-default.svg`
* if `audio` is missing or not found, use the song MIDI reference as fallback audio source
* if `audio` falls back to MIDI, the song-select button thumbnail MUST show fallback cover art
* during gameplay playback, if a valid WAV/MP3/OGG file is available it MUST be used as backing track; otherwise playback MUST use MIDI synth rendering

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

* `modelConfidenceThreshold`: `0.355`
* `noteSegmentationThreshold`: `0.31`
* `minNoteLengthMs`: `24`
* `melodiaTrick`: `false`
* `minPitchHz`: `1`
* `maxPitchHz`: `3000`
* `midiTempo`: `120`

Runtime strategy constraints:

* production/default mode MUST use the C++/ONNX converter
* debug converter labels `legacy` and `neuralnote` MUST remain accepted for backward compatibility, but both MUST map to the same C++/ONNX backend
* debug converter mode `ab` MUST be rejected explicitly with a clear user-facing error
* import conversion MUST estimate tempo via Tempo-CNN ONNX and apply both:
  * `tempoBpm` global value
  * optional local `tempoMap` points when available
* for all conversion modes, exported MIDI end-of-track time MUST match input audio duration (MP3/OGG/WAV), including trailing silence up to audio end

---

## 11.15 Start-screen audio import workflow

The start screen MUST include an `Import MP3/OGG` action that allows uploading a local audio file (`.mp3` or `.ogg`).

When an audio file is selected:

* create a dedicated song folder using the uploaded filename without extension
* save the original uploaded audio as song backing track in that folder
* convert the uploaded audio into MIDI (`song.mid`) using the local converter
* show a conversion progress bar in start screen while the job is running
* inspect embedded metadata artwork and, when available, extract and save it as the song cover in the same folder
* append/update the song manifest with the new song entry (`id`, `name`, `folder`, `midi`, `audio`, optional `cover`)
* refresh the start-screen song list automatically so the new song appears immediately after import

Manifest/storage target by platform:

* web dev/preview mode: `public/songs/manifest.json`
* Capacitor native mode (Android standalone): `Directory.Data/songs/manifest.json`

Implementation constraints for import paths:

* web dev/preview import default MUST run through the C++/ONNX converter wrapper
* Capacitor Android import default MUST run through the native C++/ONNX plugin bridge
* server/native import MUST estimate tempo via Tempo-CNN ONNX and inject MIDI tempo metadata (`tempoBpm` + local `tempoMap` when present)
* debug converter labels `legacy` and `neuralnote` MUST remain accepted as aliases for the same backend
* debug converter mode `ab` MUST be rejected explicitly (server HTTP `400`, native import error)

Debug/testing support:

* in debug builds, the start screen MUST expose an `Import Source` selector (`Auto`, `Server`, `Native`) to force the import path for validation
* the debug `Import Source` selector MUST be positioned in the top-left zone of the start screen, above the `Song` section
* the debug `Import Source` selector MUST NOT overlap song cards/thumbnails
* debug converter mode selector MUST keep backward-compatible labels (`legacy` / `neuralnote` / `ab`)
* `legacy` and `neuralnote` labels MUST execute the same C++/ONNX pipeline
* selecting `ab` MUST fail immediately with an explicit message
* default mode is `Auto`:
  * `Server` on web dev/preview
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
* include timeline progression feedback (playhead/current position)
* progression MUST remain synchronized with gameplay timeline (`runtime.current_tick`)
* minimap bounds MUST keep a clear gap from the bottom-right hand reminder widget (no overlap)
* minimap height MUST be doubled versus previous baseline sizing

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
