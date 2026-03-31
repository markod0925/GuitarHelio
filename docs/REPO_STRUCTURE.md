# Repository Structure Guide

This document is a quick map of the repository to:
- find files quickly;
- understand where responsibilities live;
- reduce onboarding time for feature work.

## 1) Top-level map

```text
.
|-- src/                    # TypeScript runtime code (web game + platform adapters)
|-- test/                   # Vitest unit tests
|-- public/                 # static assets served by Vite (songs, UI, public assets)
|-- assets/                 # source assets and models used by runtime/build
|-- electron/               # Electron desktop entry and desktop runtime wiring
|-- android/                # Capacitor Android project + native plugin/JNI bridge
|-- tools/                  # local tools (converter, DSP, offline pitch labs/bench)
|-- scripts/                # utility/ops scripts
|-- third_party/            # vendored native dependencies and runtimes
|-- docs/                   # project planning docs
|-- samples/                # sample inputs/outputs for manual checks
|-- skills/                 # project-local Codex skills
|-- dist/                   # Vite web build output (generated)
|-- release/                # electron-builder outputs for Windows (generated)
|-- README.md               # setup and usage guide
|-- GDD.md                  # gameplay/product specification
|-- REPO_STRUCTURE.md       # this repository map
|-- AGENTS.md               # project automation/agent rules
|-- package.json            # scripts, dependencies, electron-builder config
|-- vite.config.ts          # Vite config + server/plugin wiring
|-- capacitor.config.ts     # Capacitor config
|-- tsconfig.json           # TypeScript config (typecheck/lint baseline)
```

## 2) Main entry points

- `index.html`: web shell loaded by Vite.
- `src/app/main.ts`: app bootstrap and Phaser scene registration.
- `src/ui/BootScene.ts`: initial preload and transition logic.
- `src/ui/SongSelectScene.ts`: song catalog/import/settings entry UI.
- `src/ui/PlayScene.ts`: core gameplay loop and controllers.
- `src/ui/PracticeScene.ts`: dedicated practice flow.
- `electron/main.mjs`: desktop app entry; starts preview server and BrowserWindow.
- `electron/preload.cjs`: sandbox-safe renderer bridge for Electron IPC.
- `electron/native/`: Windows native pitch addon (`cmake-js`, PortAudio, Rust staticlib bridge).

## 3) `src/` structure by domain

- `src/app/`: app boot/config/session persistence.
- `src/audio/`: microphone capture, pitch detection, scheduling, playback helpers, DSP bridge.
- `src/game/`: gameplay state and scoring logic.
- `src/guitar/`: guitar mapping/tuning/target generation.
- `src/midi/`: MIDI parsing/loading and tempo map handling.
- `src/platform/`: web/native platform adapters and converter mode integration.
- `src/server/`: import/conversion handlers used by Vite/Electron runtime bridge.
- `src/tab-converter/`: tablature conversion logic.
- `src/types/`: shared domain/app type declarations.
- `src/ui/`: scenes, overlays, and UI modules.
- `src/ui/play/`: PlayScene-specific controllers/components.
- `src/ui/song-select/`: Song Select helpers/components.

## 4) Platform and packaging areas

Desktop (Windows):
- `electron/main.mjs`: Electron main process.
- `electron/native-host.mjs`: main-process native pitch addon host + IPC registration.
- `package.json` (`build` + `build:windows`): electron-builder config and packaging script.
- `release/`: generated Windows artifacts (`.exe`, metadata, unpacked app).

Android:
- `android/app/src/main/java/com/guitarhelio/app/MainActivity.java`: Android host activity.
- `android/app/src/main/java/com/guitarhelio/app/converter/NeuralNoteConverterPlugin.java`: Capacitor native plugin bridge.
- `android/app/src/main/cpp/`: JNI/native converter bridge and CMake config.
- `android/app/src/main/assets/public/`: synced web bundle included in APK (generated via Capacitor sync).
- `android/app/build/outputs/apk/debug/app-debug.apk`: debug APK output (generated).

## 5) Tests, tooling, and automation

Tests:
- `test/*.test.ts`: Vitest suite (gameplay, audio, persistence, converter mode, UI behavior).

Scripts:
- `scripts/benchmark-startup.mjs`: startup performance benchmark.
- `scripts/audio-to-midi-neuralnote.mjs`: audio->MIDI conversion helper.
- `scripts/audio-cover-extractor.mjs`: cover extraction utility.
- `scripts/cli-midi-player.mjs`: local MIDI CLI player.
- `scripts/generate-sample-midi.mjs`: sample MIDI generation.

Tools:
- `tools/audio-midi-converter/`: converter wrappers/build scripts.
- `tools/gh_dsp_core/`: DSP wasm workspace.
- `tools/pitch-offline-bench/`: offline pitch benchmark pipeline.
- `tools/pitch-agent-lab/`: pitch experimentation workspace.

CI workflows:
- `.github/workflows/pages.yml`: static site build/deploy workflow.
- `.github/workflows/android-release.yml`: tagged Android + Windows artifact release workflow.

## 6) Assets and content

- `public/songs/manifest.json`: song catalog manifest.
- `public/songs/<song-id>/`: per-song files (`song.mid`, optional audio, covers).
- `public/ui/`: UI images and placeholders.
- `public/assets/`: public static assets.
- `assets/models/basic-pitch/`: basic-pitch model assets.
- `android/app/src/main/assets/`: Android-packaged runtime assets.

## 7) Third-party native dependencies

- `third_party/neuralnote_core/`: note transcription engine binaries/models.
- `third_party/tempocnn_core/`: tempo estimation native binaries.
- `third_party/tempo_cnn/`: tempo model assets (including ONNX model files).
- `third_party/onnxruntime/`: ONNX runtime libraries by platform.

## 8) Guide documents in this repo

- `README.md`: setup, commands, and usage.
- `GDD.md`: functional/gameplay spec (update when specifications change).
- `REPO_STRUCTURE.md`: this structure guide.
- `AGENTS.md`: project instructions for agents/tooling.
- `docs/plans/PLAN.md`: project plan document.

## 9) Generated outputs (not source of truth)

- `node_modules/`
- `dist/`
- `release/`
- `android/app/build/`
- `android/app/.cxx/`
- `android/app/src/main/assets/public/` (synced web bundle)

Prefer editing source locations under `src/`, `public/`, `assets/`, `scripts/`, `tools/`, and config files, then regenerate artifacts.

## 10) Quick navigation/search commands

```bash
# list tracked files, excluding heavy generated folders
rg --files -g "!node_modules" -g "!dist" -g "!release" -g "!android/app/build" -g "!android/app/.cxx"

# find major gameplay scenes and scene references
rg "BootScene|SongSelectScene|PlayScene|PracticeScene" src test

# find converter/native integration touchpoints
rg "convert|neuralnote|tempo|onnx|jni|capacitor" src tools scripts android

# find persistence/config paths
rg "session|localStorage|settings|highScore" src
```
