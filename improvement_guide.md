# GuitarHelio — Improvement Guide

Prioritized by **impact vs effort**, grouped into phases you can tackle incrementally without breaking anything.

---

## Phase 1: Quick Wins (Low Risk, High Impact)

### 1. Extract [vite.config.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/vite.config.ts) Backend into a Proper Module

**Problem:** 1,080 lines of REST API code living in a bundler config.

**Fix:** Move the song-import API into a dedicated module:

```
src/server/
  songImportApi.ts        # plugin factory + middleware registration
  songImportHandlers.ts   # handleImportStart, handleImportStatus, handleSongRemove
  songManifest.ts         # readSongManifest, writeSongManifest, normalize
  converterLoader.ts      # loadAudioToMidiConverter, estimateTempo
  fileDetection.ts        # detectImportSource, detectAudioExtension, etc.
```

[vite.config.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/vite.config.ts) becomes:

```typescript
import { createSongImportApiPlugin } from './src/server/songImportApi';

export default defineConfig({
  plugins: [createSongImportApiPlugin()],
  server: { host: '0.0.0.0', port: 5173 }
});
```

**Effort:** ~2-3 hours. Pure file moves + re-exports, zero behavior change.

---

### 2. Kill the Dead Code Branch

```typescript
// Before
function getConverterModulePath(mode: ConverterMode): string {
  if (mode === 'legacy' || mode === 'neuralnote') return 'scripts/audio-to-midi-neuralnote.mjs';
  return 'scripts/audio-to-midi-neuralnote.mjs';
}

// After
function getConverterModulePath(_mode: ConverterMode): string {
  return 'scripts/audio-to-midi-neuralnote.mjs';
}
```

**Effort:** 2 minutes.

---

### 3. Extract Layout Constants

Replace inline magic numbers with named constants in [config.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/vite.config.ts):

```typescript
// config.ts
export const LAYOUT = {
  LOGO_ASPECT_RATIO: 0.3125,
  LOGO_COMPRESS_FACTOR: 0.7,
  TITLE_SCALE: 0.058,
  LABEL_SCALE: 0.017,
  SIDE_LAYOUT_REF_HEIGHT: 540,
  SIDE_LAYOUT_SCALE_RANGE: [0.6, 1] as const,
  START_BUTTON_SCALE: Math.SQRT2,
  // ...
} as const;
```

**Effort:** 1-2 hours. Find-and-replace with test runs.

---

## Phase 2: Structural Refactors (Medium Risk, High Impact)

### 4. Break Up `SongSelectScene.create()`

The 685-line [create()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts#43-729) method should delegate to focused builder methods:

```typescript
async create(): Promise<void> {
  const ctx = this.initContext();
  this.buildBackground(ctx);
  this.buildSongGrid(ctx);
  this.buildSidePanel(ctx);
  this.buildStartButton(ctx);
  this.wireInputHandlers(ctx);
  await this.loadSongCatalog(ctx);
  this.wireShutdownCleanup(ctx);
  ctx.refreshSelections();
}
```

Each builder creates its own UI elements and returns only the handles needed by [refreshSelections](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts#360-469). The [refreshSelections](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts#360-469) closure becomes a method on a small context/state object.

**Effort:** 4-6 hours. Incremental — extract one section at a time and run the app after each.

---

### 5. Complete the [PlayScene](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#53-809) Controller Extraction

You already have [GameplayController](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/play/controllers/GameplayController.ts#20-64), `PlaybackController`, `UIController`, etc. — but [PlayScene](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#53-809) still owns all mutable state as **public fields**. The fix:

1. **Create `PlaySceneState`** — a plain data class holding all runtime state
2. **Each controller owns its slice** of state (gameplay state, playback state, UI state)
3. **PlayScene becomes a thin coordinator** that creates controllers, passes events, and calls [update()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#613-616)

```typescript
class PlayScene extends Phaser.Scene {
  private gameplay!: GameplayController;
  private playback!: PlaybackController;
  private ui!: UIController;
  private layout!: PlayLayoutController;

  create(data: SceneData) {
    const ctx = buildContext(this, data);
    this.gameplay = new GameplayController(ctx);
    this.playback = new PlaybackController(ctx);
    // ...
  }

  update(time: number, delta: number) {
    this.gameplay.tick();
    this.playback.tick();
    this.ui.redraw();
  }
}
```

**Effort:** 1-2 days. This is the biggest win — it makes every future change safer.

---

### 6. Create a UI Component Abstraction

Replace repeated button creation + triple event wiring with a reusable component:

```typescript
class UIButton {
  constructor(
    scene: Phaser.Scene,
    x: number, y: number,
    width: number, height: number,
    label: string,
    iconKey?: string,
    onClick?: () => void
  ) {
    // Creates container with background + label + optional icon
    // Single pointerdown handler on the container
  }

  setEnabled(enabled: boolean): void { /* ... */ }
  setActive(active: boolean): void { /* ... */ }
  setSummary(text: string, color: string): void { /* ... */ }
}
```

This eliminates the duplicate event wiring (18+ lines → 1 per button) and makes styling consistent.

**Effort:** 3-4 hours for the component. Then gradual migration in [SongSelectScene](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts#32-927).

---

## Phase 3: Architecture Improvements (Higher Effort, Long-Term)

### 7. Introduce a Layout System

Replace raw arithmetic with a declarative layout helper:

```typescript
const sidebar = new VerticalStack(scene, {
  x: width * 0.79,
  topY: sideTopSafeInset,
  bottomY: startTopY - 14,
  gap: 'distribute', // auto-calculate gaps
});

sidebar.add(difficultyButton);
sidebar.add(importButton);
sidebar.add(settingsButton);
sidebar.add(tunerButton);
sidebar.add(practiceButton);
sidebar.layout(); // positions everything
```

Even a simple `VerticalStack` / `HorizontalStack` utility eliminates hundreds of lines of manual position math.

**Effort:** Half a day for the utility, then gradual adoption.

---

### 8. State Management for UI

[refreshSelections()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts#360-469) manually sets every property of every element. A reactive pattern would be cleaner:

```typescript
// Reactive state store
const store = createStore({
  difficulty: 'Medium',
  settingsOpen: false,
  importing: false,
  // ...
});

// Components auto-update when relevant state changes
difficultyButton.bind(store, (s) => ({
  label: s.difficulty,
  color: DIFFICULTY_COLORS[s.difficulty],
}));
```

This eliminates the monolithic [refreshSelections](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts#360-469) function entirely.

**Effort:** 1-2 days. Framework-level change, but massively reduces future UI work.

---

### 9. Extract Audio Pipeline as Standalone Module

`src/audio/` has 20 files covering pitch detection, WASM DSP, synth, scheduling, calibration, and scrub playback. These could become a self-contained module with a clean public API:

```typescript
// Public API surface
export class AudioEngine {
  startMicInput(options: MicOptions): Promise<void>;
  startPlayback(notes: SourceNote[], tempoMap: TempoMap): void;
  onPitch(listener: PitchListener): Unsubscribe;
  // ...
}
```

This would make the audio layer independently testable and potentially reusable.

**Effort:** 1-2 days. Mainly interface design + wiring.

---

## Priority Ranking

| # | Task | Impact | Effort | Do First? |
|---|---|---|---|---|
| 1 | Extract vite.config backend | 🟢 High | 2-3h | ✅ |
| 2 | Dead code cleanup | 🟡 Low | 2min | ✅ |
| 3 | Layout constants | 🟡 Medium | 1-2h | ✅ |
| 4 | Break up SongSelectScene.create | 🟢 High | 4-6h | ✅ |
| 5 | Complete PlayScene extraction | 🟢 Very High | 1-2d | ✅ |
| 6 | UI component abstraction | 🟢 High | 3-4h | ✅ |
| 7 | Layout system | 🟡 Medium | 4-6h | Later |
| 8 | Reactive UI state | 🟡 Medium | 1-2d | Later |
| 9 | Audio module extraction | 🟡 Medium | 1-2d | Later |

---

## Golden Rule

> **Refactor incrementally. Ship after each step.** Don't try to rewrite everything at once — that's how Codex got you here in the first place.

The codebase works. The goal is to make it *maintainable* while keeping it working. Items 1–6 can each be done in isolation, tested, and merged independently.
