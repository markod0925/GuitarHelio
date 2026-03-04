# GuitarHelio - Manual Runtime QA Suite

Scope: end-to-end manual validation of gameplay, audio, microphone input, scoring, and Android packaging.

Related docs:
- `GDD.md`
- `IMPLEMENTATION_QA_CHECKLIST.md`

## 1. Prerequisites

- Node.js 20+
- Dependencies installed: `npm install`
- Valid local build: `npm run build`
- At least one desktop device with recent Chrome/Edge
- At least one Android device (for Android section)
- A way to produce notes (real guitar, keyboard, tone generator app)

## 2. Result Rules

- `PASS`: behavior matches expected result
- `FAIL`: behavior diverges, reproducible bug
- `BLOCKED`: test cannot run due to missing prerequisites

## 3. Quick Test Environment Setup

### Desktop/LAN

1. Start:
   ```bash
   npm run dev:mobile
   ```
2. Open local URL in desktop browser.
3. Verify `public/songs/example/song.mid` is available in Song Select.

### Android Debug

1. Build + sync:
   ```bash
   npm run build
   npm run cap:sync
   ```
2. Build APK:
   ```bash
   npm run android:apk:debug
   ```
3. Install `android/app/build/outputs/apk/debug/app-debug.apk`.

## 4. Desktop Test Cases

### DSK-01 - Boot and Song Select

- Objective: verify scene startup and song/difficulty selection.
- Steps:
  1. Open app.
  2. Verify Song Select screen is shown.
  3. Change song with click or left/right arrows.
  4. Change difficulty with click or up/down arrows.
  5. Press `Start Session`.
- Expected:
  - `PlayScene` starts.
  - Selected song and difficulty are applied.

### DSK-02 - Audio Synchronized with Gating

- Objective: confirm playhead/audio synchronization during gating.
- Steps:
  1. Start a session.
  2. Do not play any note when first target arrives.
  3. Observe playhead/target and listen to audio.
- Expected:
  - Visual progression stops in `WaitingForHit` on target.
  - Audio stops together with playhead.
  - After valid hit (or timeout), audio and playhead resume aligned.

### DSK-03 - Progression on Valid Hit

- Objective: validate `WaitingForHit -> Playing` transition.
- Steps:
  1. During `WaitingForHit`, play a correct note (within difficulty tolerance).
  2. Hold briefly (>= hold time).
- Expected:
  - Target is validated.
  - Session progression resumes.
  - HUD shows feedback (`Perfect/Great/OK`) and score increase.

### DSK-04 - No Progression on Invalid Hit

- Objective: prevent false positives.
- Steps:
  1. Reach `WaitingForHit`.
  2. Play wrong note or unpitched noise.
- Expected:
  - No progression to next target.
  - State stays waiting until valid note arrives (or timeout if configured).

### DSK-05 - Timeout Miss (Mic Fallback)

- Objective: verify optional timeout behavior.
- Steps:
  1. Block microphone permission for the site.
  2. Reload and start session.
  3. Wait at first target in waiting state.
- Expected:
  - Mic unavailable message is shown.
  - After timeout fallback, target is marked `Miss`.
  - Progression resumes automatically.

### DSK-06 - Scoring and Streak

- Objective: validate score accumulation and streak reset.
- Steps:
  1. Perform at least 3 consecutive valid targets.
  2. Force at least one `Miss` (timeout or sustained invalid hit).
- Expected:
  - Total score increases on valid targets.
  - Streak increases on valid hits and resets on `Miss`.
  - End-of-song hit distribution is coherent.

### DSK-07 - End of Song and Results Panel

- Objective: validate `Finished` state and summary.
- Steps:
  1. Complete session until final target.
  2. Verify results panel.
  3. Press tap/Enter to return to selection.
- Expected:
  - App shows score, hit distribution, average reaction, longest streak.
  - Returns to Song Select without crash.

### DSK-08 - Resize / Minimum Responsiveness

- Objective: verify layout across different sizes.
- Steps:
  1. Resize desktop window (wide -> narrow).
  2. Observe lanes, hit line, bars, HUD.
- Expected:
  - Elements remain visible and readable.
  - No critical overlap or broken canvas.

### DSK-09 - Backing Track Audio Priority

- Objective: verify WAV/MP3 playback priority over MIDI.
- Steps:
  1. Configure a song with valid `audio` (`.mp3`/`.wav`) and valid `midi`.
  2. Start session and listen to playback.
  3. Temporarily rename/remove same song audio file.
  4. Restart session.
- Expected:
  - With audio present: WAV/MP3 backing track is used.
  - Without audio: playback falls back to MIDI without blocking session.

## 5. Android Test Cases

### AND-01 - App Startup and Mic Permission

- Objective: validate Android bootstrap and runtime permission prompt.
- Steps:
  1. Install/open debug APK.
  2. Start session.
  3. When prompted, grant microphone permission.
- Expected:
  - No crash on startup.
  - Permission is requested correctly.
  - Session starts with active audio and UI.

### AND-02 - Core Gameplay with Mic Enabled

- Objective: verify gating and hit detection on device.
- Steps:
  1. Reach `WaitingForHit`.
  2. Play a valid note.
  3. Repeat with an invalid note.
- Expected:
  - Valid note advances progression.
  - Invalid note keeps waiting state.

### AND-03 - Mic Denied and Resilient Fallback

- Objective: validate controlled degradation.
- Steps:
  1. Revoke app mic permission in Android settings.
  2. Restart app and session.
- Expected:
  - App does not crash.
  - Mic error message is shown.
  - Progression remains possible via timeout fallback.

### AND-04 - Background/Foreground Stability

- Objective: verify baseline lifecycle stability.
- Steps:
  1. Start session.
  2. Send app to background for 5-10 seconds.
  3. Return to foreground.
- Expected:
  - App remains stable (no crash, no black screen).
  - Session remains usable (including manual restart if needed).

## 6. Test Run Template

Fill this table for each run:

| Field | Value |
| --- | --- |
| Date |  |
| Tester |  |
| Commit/Branch |  |
| Desktop Device |  |
| Desktop Browser |  |
| Android Device |  |
| App Build |  |

Test results:

| Test ID | Status (PASS/FAIL/BLOCKED) | Notes | Evidence (screenshot/video/log) |
| --- | --- | --- | --- |
| DSK-01 |  |  |  |
| DSK-02 |  |  |  |
| DSK-03 |  |  |  |
| DSK-04 |  |  |  |
| DSK-05 |  |  |  |
| DSK-06 |  |  |  |
| DSK-07 |  |  |  |
| DSK-08 |  |  |  |
| DSK-09 |  |  |  |
| AND-01 |  |  |  |
| AND-02 |  |  |  |
| AND-03 |  |  |  |
| AND-04 |  |  |  |

## 7. Suggested Exit Criteria

- No `FAIL` in critical tests: `DSK-02`, `DSK-03`, `DSK-07`, `AND-01`, `AND-02`.
- At least one complete run on desktop and one complete run on Android.
- All regressions documented with reproduction steps and evidence.
