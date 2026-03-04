# GuitarHelio Refactoring — Implementation Plan

Refactoring all 10 items from the code review, organized in 4 phases from safest to most invasive.

## Proposed Changes

### Phase 1 — Quick Wins (zero-risk, mechanical)

---

#### [NEW] [noteKey.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/noteKey.ts)

Extract the [noteKey()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158) utility into a shared module. Currently duplicated in [synth.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/synth.ts), [jzzTinySynth.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/jzzTinySynth.ts), and [midiScrubPlayer.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts).

#### [MODIFY] [synth.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/synth.ts)

- Remove local [noteKey()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158) function
- Import from [./noteKey](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158)

#### [MODIFY] [jzzTinySynth.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/jzzTinySynth.ts)

- Remove local [noteKey()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158) function
- Import from [./noteKey](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158)

#### [MODIFY] [midiScrubPlayer.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts)

- Remove local [noteKey()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158) function
- Import from [./noteKey](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#155-158)

#### [MODIFY] [package.json](file:///c:/Dati/Marco/GameDev/GuitarHelio/package.json)

- Move `@tensorflow/tfjs-node` from `dependencies` to `devDependencies`

#### [MODIFY] [main.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/app/main.ts)

- Change `type: Phaser.AUTO` to `type: Phaser.WEBGL` with Canvas fallback log

---

### Phase 2 — Audio & Resource Fixes

---

#### [MODIFY] [PlayScene.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts) — Mic stream release

- Store the `MediaStream` reference from [createMicNode()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/micInput.ts#1-5)
- Stop all tracks in [cleanup()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2315-2424) via `stream.getTracks().forEach(t => t.stop())`

#### [MODIFY] [PlayScene.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts) — Layout cache

- Add `private cachedLayout?: Layout` member
- In [layout()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2144-2166), return cached value if present
- Invalidate cache on `resize` event handler

---

### Phase 3 — PlayScene Decomposition (the big one)

Split the 2924-line [PlayScene.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts) into focused sub-modules. The orchestrator [PlayScene.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts) will shrink to ~400 lines and delegate to:

#### [NEW] [playSceneTypes.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/playSceneTypes.ts)

All shared types: [SceneData](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#40-49), [Layout](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#50-60), [PlaybackMode](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#61-62), [HitDebugSnapshot](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#63-78), [HeldHitAnalysis](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#79-86), [TopStar](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#87-95), [SongMinimapLayout](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#96-108), [AudioSeekDebugInfo](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#109-120).

#### [NEW] [playSceneDebug.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/playSceneDebug.ts)

All standalone utility functions currently at the bottom of PlayScene.ts:
- [sanitizeSelection()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2784-2797), [isBackingTrackAudioUrl()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2798-2801), [filterSourceNotesByOnsetSeconds()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2802-2812)
- [analyzeHeldHit()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2813-2863), [isPitchFrameValid()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2864-2871)
- [formatDebugBool()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2872-2875), [formatDebugNumber()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2876-2880), [formatSignedMs()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2881-2886), [formatDebugPath()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2887-2904)
- [normalizeTopFeedback()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2905-2916), [isGameplayDebugOverlayEnabled()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2917-2924)

#### [NEW] [AudioController.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/AudioController.ts)

All audio stack management extracted from PlayScene:
- [AudioContext](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/jzzTinySynth.ts#111-116) creation & lifecycle
- [startBackingTrackAudio()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2425-2457), [playBackingTrackAudioFrom()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2507-2567), [loadBackingTrackBuffer()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2636-2650)
- [pauseBackingPlayback()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2458-2474), [resumeBackingPlayback()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2475-2492), [stopBackingPlayback()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2493-2498)
- Backing track source management ([ensureBackingTrackGainNode](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2616-2624), [stopBackingTrackSource](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2598-2615), [releaseBackingTrackAudio](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2568-2586))
- Playback clock ([startPlaybackClock](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2658-2664), [pausePlaybackClock](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2665-2681), [getSongSecondsNow](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2682-2695), [getSongSecondsFromClock](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2696-2703))
- [MidiScrubPlayer](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/midiScrubPlayer.ts#9-132) management
- Mic stream tracking + cleanup

#### [NEW] [FretboardRenderer.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/FretboardRenderer.ts)

Static fretboard rendering logic:
- [drawStaticLanes()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1204-1337) — perspective fretboard, strings, hit line
- [drawTopStarfield()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1714-1761) — starfield management with `TopStar[]`
- Fret label pool ([getOrCreateFretLabel](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2730-2745), [hideUnusedFretLabels](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2746-2751), [clearFretLabels](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2723-2729))

#### [NEW] [BallAnimator.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/BallAnimator.ts)

Ball movement and trail rendering:
- [resolveBallPosition()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1960-2018) and all sub-methods ([resolvePrePlaybackBallPosition](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2019-2035), [resolveIntroBallPosition](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2036-2054), etc.)
- [resolveBallArcHeight()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2078-2093), [resolveBallLateralExcursion()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2094-2104)
- Ball trail: [createBallTrail()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2167-2171), [updateBallTrail()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2188-2213), [drawBallDashedTrail()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2220-2282), [pushBallTrailPoint()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2179-2187), [resetBallTrailHistory()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2214-2219)

#### [NEW] [NoteRenderer.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/NoteRenderer.ts)

Target note drawing on the Graphics layer:
- [redrawTargetsAndBall()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1903-1959) (the target iteration and fret label part)

#### [NEW] [MinimapRenderer.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/MinimapRenderer.ts)

Song minimap:
- [layoutSongMinimap()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1338-1389), [redrawSongMinimapStatic()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1633-1666), [updateSongMinimapProgress()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1667-1691)
- [getSongMinimapNoteRect()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1692-1713)

#### [NEW] [UIOverlays.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/UIOverlays.ts)

Pause menu, results screen, speed slider, debug overlay:
- [openPauseMenu()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#884-985), [closePauseMenu()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#986-1006), [relayoutPauseOverlay()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1071-1077)
- [finishSong()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#665-783) results overlay creation
- [createPlaybackSpeedSlider()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1421-1472), [layoutPlaybackSpeedSlider()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1473-1511), speed adjustment methods
- [createDebugOverlay()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1104-1126), [updateDebugOverlay()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1152-1203), [toggleDebugOverlay()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1143-1151)
- [layoutPauseButton()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1390-1420), [syncPauseButtonIcon()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#1629-1632)
- [updateHud()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2105-2124), [resolveTopFeedbackMessage()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2125-2143)

#### [MODIFY] [PlayScene.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts)

Will be reduced to an **orchestrator** (~400 lines) that:
- Imports and coordinates the sub-modules
- Contains [create()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#228-405), [tickRuntime()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#513-607), [handleTransition()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#608-654), [cleanup()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#2315-2424)
- Delegates rendering, audio, and UI to the sub-modules

> [!IMPORTANT]
> **Strategy**: Sub-modules will be plain classes (not Phaser Scenes), instantiated by PlayScene and receiving the Phaser.Scene reference. This avoids Phaser lifecycle complexity while enabling testability.

---

### Phase 4 — GC Pressure Reduction

---

#### [MODIFY] [PlayScene.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts) (or new sub-modules)

- Pre-allocate [HitDebugSnapshot](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#63-78) object, mutate in-place instead of recreating each frame
- Replace `ballTrailHistory: Array<{x,y}>` with a fixed-size ring buffer class to avoid `splice()` and array growth
- Cache `this.runtime` mutations in-place where safe (e.g., `current_tick` update)

> [!WARNING]
> The AudioWorklet migration (replacing `ScriptProcessorNode`) is **not included** in this plan because it requires creating a separate worker bundle, modifying the WASM `aubiojs` initialization to work inside a worklet, and testing microphone latency on real Android devices. I recommend tackling it as a separate task after these refactorings are stable.

---

## Verification Plan

### Automated Tests

1. **Existing tests pass** — All 11 test files must continue to pass:
```
npx vitest run
```

2. **TypeScript compilation** — No type errors introduced:
```
npx tsc --noEmit
```

3. **Vite build** — Production bundle builds successfully:
```
npx vite build
```

### Manual Verification

Since this is primarily a structural refactoring (no behavior changes), verification should focus on:

1. **Dev server runs**: `npx vite` starts without errors
2. **Game loads**: Navigate to localhost, select a song, start a session
3. **Playback works**: MIDI synth plays notes, backing track (if available) plays
4. **Pause/Resume**: Pause menu opens/closes, speed slider works
5. **Song minimap**: Minimap renders, progress bar moves
6. **Ball animation**: Ball bounces between strings, trail renders
7. **Debug overlay**: F3 toggles debug overlay
8. **Pitch detection**: Microphone icon appears, pitch detection responds

> [!NOTE]
> I will test via `npx tsc --noEmit` and `npx vitest run` after each phase. I will ask you to test manually on your Android device once all phases are complete.
