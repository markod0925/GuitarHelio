# Guitar Helio

Current GitHub tag: `v0.1.3`

## Overview

Guitar Helio is a guitar trainer with:

- A **Start Screen** with song catalog, `MIDI/MP3/OGG` import, tuner, and session settings.
- A **Play Scene** with simplified target notes, beat-gated progression, scoring, and timeline minimap.
- A **Hybrid playback mode**: uses backing audio (`mp3/wav/ogg`) when available, otherwise falls back to MIDI synth playback.
- **Local persistence**: best score per song plus saved difficulty/string/finger/fret settings.

## Repository Structure Documentation

- Structural map of the codebase and file search guide: `REPO_STRUCTURE.md`

## Main Commands

```bash
npm run install:linux-android # install dipendenze per server Linux + Android flow
npm run install:windows # install dipendenze in ambiente Windows (include fix Rollup Win-only)
npm run dev            # local web development
npm run dev:mobile     # LAN development (phone on the same network)
npm run build          # typecheck + production build
npm run preview        # preview production build
npm run desktop:start  # run desktop app via Electron (local)
npm run build:windows  # build Windows installer (.exe) + portable package
npm run build:windows:clean # force clean locked win-unpacked folder, then build Windows artifacts
npm run test           # unit tests (Vitest)
npm run lint           # TypeScript typecheck without emit
```

## Packages and References

Direct npm packages used by this repository.

### Runtime Dependencies (`dependencies`)

| Package | Role | Official reference |
| --- | --- | --- |
| `@capacitor/core` | Capacitor runtime bridge | https://capacitorjs.com/docs |
| `@capacitor/filesystem` | Cross-platform file persistence APIs | https://capacitorjs.com/docs/apis/filesystem |
| `@fontsource/montserrat` | Embedded Montserrat font files | https://fontsource.org/fonts/montserrat |
| `@tonejs/midi` | MIDI parsing/writing utilities | https://github.com/Tonejs/Midi |
| `aubiojs` | WASM pitch detection backend | https://github.com/qiuxiang/aubiojs |
| `audio-decode` | Browser/Node audio decode helper | https://github.com/audiojs/audio-decode |
| `jzz` | MIDI I/O and routing toolkit | https://jazz-soft.net/doc/JZZ/ |
| `jzz-synth-tiny` | Tiny synth used for MIDI playback | https://github.com/jazz-soft/JZZ-synth-Tiny |
| `phaser` | 2D game framework used for UI/gameplay scenes | https://docs.phaser.io/ |
| `vite` | Dev server, production bundler, and embedded preview runtime for desktop packaging | https://vite.dev/guide/ |

### Development Dependencies (`devDependencies`)

| Package | Role | Official reference |
| --- | --- | --- |
| `@capacitor/android` | Android platform package for Capacitor | https://capacitorjs.com/docs/android |
| `@capacitor/cli` | Capacitor CLI tooling | https://capacitorjs.com/docs/cli |
| `electron` | Desktop runtime wrapper for packaged Windows builds | https://www.electronjs.org/docs/latest |
| `electron-builder` | Windows installer/portable package generation | https://www.electron.build/ |
| `typescript` | TypeScript compiler and type system | https://www.typescriptlang.org/docs/ |
| `vitest` | Unit test runner | https://vitest.dev/guide/ |

### Local Converter Tool (`tools/audio-midi-converter`)

| Package | Role | Official reference |
| --- | --- | --- |
| `@tonejs/midi` | MIDI generation in converter workflow | https://github.com/Tonejs/Midi |
| `audio-decode` | Audio decoding in converter workflow | https://github.com/audiojs/audio-decode |

### Native/Vendored Audio-to-MIDI Dependencies

| Dependency | Role | Official reference |
| --- | --- | --- |
| `AUDIO-to-MIDI` workflow | End-to-end audio-to-MIDI conversion workflow integrated in this repo | https://github.com/markod0925/AUDIO-to-MIDI |
| `TempoCNN` | Tempo estimation model/runtime used to enrich MIDI tempo metadata | https://github.com/hendriks73/tempo-cnn |
| `NeuralNote` | Core note transcription backend used by the native converter pipeline | https://github.com/tiborvass/NeuralNote |

## Quick Start (PC + Smartphone on LAN)

1. Install Node.js 20+ on your computer.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the C++/ONNX converters (NeuralNote + Tempo-CNN):
   ```bash
   npm run build:nn:cli
   npm run build:tempo:cli
   ```
4. Start LAN mode:
   ```bash
   npm run dev:mobile
   ```
5. Open the URL shown as `Network` from your phone (same Wi-Fi), for example:
   `http://192.168.1.10:5173`

## Gameplay Controls

- `Esc` or `Back` key (mobile): open/close the pause menu (`Continue`, `Reset`, `Back to Start`).
- Bottom-left pause button: pause/resume gameplay directly without opening the menu.
- Top speed slider: `25%` -> `125%` (default `100%`), synchronized with timeline and backing audio.
- `Debug Note` button: play the current target note.
- `F3` (debug/dev): toggle central diagnostics overlay.

## Audio -> MIDI Converter (NeuralNote + Tempo-CNN C++/ONNX)

The project uses a vendored C++/ONNX pipeline in:

- `third_party/neuralnote_core` (note transcription)
- `third_party/tempocnn_core` (ONNX tempo estimation)
- `third_party/tempo_cnn/tempocnn/models/fcn.onnx` (Tempo-CNN model)
- `third_party/onnxruntime/<platform>/lib` (shared ONNX runtime)

Node wrapper used by the Vite API:

- `tools/audio-midi-converter/src/neuralnote.mjs`

Mode compatibility:
- `legacy` and `neuralnote` are aliases of the same C++/ONNX backend.
- `ab` is disabled (explicit error on server/native side).

Active preset: `balanced`.

## Android Standalone (No Always-On PC Server)

Yes, this is supported. The project is ready for **Capacitor** packaging.

### What Is Already Included

- Capacitor dependencies in `package.json` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/filesystem`).
- `capacitor.config.ts` with:
  - `appId: com.guitarhelio.app`
  - `appName: GuitarHelio`
  - `webDir: dist`
- Dedicated npm scripts for init/sync/open Android Studio/debug APK build.
- `NeuralNoteConverter` Capacitor plugin (Java + JNI C++) for native audio import with NeuralNote + Tempo-CNN.
- NeuralNote model files included in Android assets (`android/app/src/main/assets/neuralnote-model/`).
- Tempo-CNN model included in Android assets (`android/app/src/main/assets/tempo-model/fcn.onnx`).

### First-Time Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the web app:
   ```bash
   npm run build
   ```
3. Add the Android platform:
   ```bash
   npm run cap:add:android
   ```
4. Sync web assets into the Android project:
   ```bash
   npm run cap:sync
   ```
5. Open Android Studio:
   ```bash
   npm run cap:open:android
   ```

Note: Android build requires NDK/CMake toolchains installed in Android Studio to compile the converter JNI bridge.

### Build Debug APK from Terminal

```bash
npm run android:apk:debug
```

Expected APK location:
`android/app/build/outputs/apk/debug/app-debug.apk`

### Microphone Permission (Important)

The app uses the microphone, so Android must include `RECORD_AUDIO` in:
`android/app/src/main/AndroidManifest.xml`

Expected snippet:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

The permission must also be requested at runtime (Capacitor/Android) before pitch detection starts.

## Windows Desktop Build (Compiled `.exe`)

The project can be packaged as a Windows desktop app via Electron.

### Build artifacts

```bash
npm install
npm run build:windows
```

Artifacts are generated in:
`release/`

Expected outputs:
- NSIS installer (`.exe`)
- Portable executable (`.exe`)

Notes:
- The desktop app runs an embedded local preview server internally (no manual terminal server required).
- Runtime imported songs are stored in the Electron user-data folder (`.../AppData/Roaming/GuitarHelio/songs`) instead of the installation directory.
- If `electron-builder` reports "Access is denied" while removing `release/win-unpacked/*`, run `npm run build:windows:clean`.

## QA

- GDD implementation compliance checklist: `IMPLEMENTATION_QA_CHECKLIST.md`
- Runtime manual test suite (Desktop + Android): `MANUAL_QA_RUNTIME_SUITE.md`
- Automated tests: `npm run test`
- Full build verification: `npm run build`

### Quick Audio -> MIDI Smoke Test (Server + Android)

Minimum prerequisites:
- `Node.js 20+`
- Local C++ toolchain (`cmake`, `g++`, `make`) for NeuralNote/Tempo-CNN CLIs
- Android SDK/NDK installed (for APK build)
- JDK 21 active for Gradle/Capacitor Android

Server checklist (Node wrapper + C++/ONNX CLI):
1. Build C++ converters:
   ```bash
   npm run build:nn:cli
   npm run build:tempo:cli
   ```
2. Verify binaries:
   ```bash
   ls -la third_party/neuralnote_core/bin/nn_transcriber_cli
   ls -la third_party/tempocnn_core/bin/tempo_cnn_cli
   ```
3. Run quick conversion on an audio file:
   ```bash
   node tools/audio-midi-converter/bin/convert-audio-to-midi.mjs --input /path/to/audio.wav --output /tmp/smoke.mid
   ```
4. Expected result:
   - progress output reaches `Conversion complete`
   - `/tmp/smoke.mid` is created and non-empty
   - tempo metadata exists in MIDI (base tempo + tempo map when available)

Native Android checklist (Capacitor plugin + JNI):
1. Build web + sync:
   ```bash
   npm run build
   npm run cap:sync
   ```
2. Build debug APK:
   ```bash
   npm run android:apk:debug
   ```
3. Expected result:
   - `BUILD SUCCESSFUL`
   - APK exists at `android/app/build/outputs/apk/debug/app-debug.apk`
4. Functional smoke test on device/emulator:
   - open app and go to `Import MP3/OGG`
   - import a short audio file (5-15s)
   - verify progress reaches `Conversion complete`
   - verify a new song with usable `song.mid` appears in gameplay catalog

## Song Catalog (`public/songs`)

Each song lives in a dedicated folder under `public/songs/<song-id>/`.

Manifest data structure (`public/songs/manifest.json`):

```json
{
  "songs": [
    {
      "id": "example",
      "name": "Example Song",
      "folder": "example",
      "cover": "cover.svg",
      "midi": "song.mid",
      "audio": "song.mp3"
    }
  ]
}
```

Fallback rules:
- If `midi` is missing in manifest: the song is not shown in Start Screen.
- If `midi` exists but file is unreachable: session start fails with explicit error, without blocking Start Screen.
- If `cover` is missing/invalid: uses `public/ui/song-cover-placeholder-neon.png`.
- If `audio` is missing/invalid: uses MIDI as audio reference.
- In gameplay: if `audio` points to a valid WAV/MP3/OGG, it is used as backing track; otherwise MIDI playback is used.

Web startup policy:
- Start Screen is shown immediately (without waiting for full asset validation).
- Song list updates in background.
- Covers are lazy-loaded (visible first, then the rest).

## Song Import from Start Screen

The Start Screen includes an `Import MIDI/MP3/OGG` button.

Flow:
- select a `.mid`/`.midi` or `.mp3`/`.ogg` file
- a song folder is created using the filename (without extension)
- for MP3/OGG input: original audio is saved as `song.mp3` or `song.ogg`
- for MP3/OGG input: audio -> MIDI conversion starts with progress bar
- for MIDI input: file is saved directly as `song.mid` (no audio conversion)
- for MP3/OGG input: if embedded cover art exists in metadata, it is extracted and saved as `cover.*`
- song catalog is updated and Start Screen list reloads automatically

Persistence by platform:
- Web/Vite dev/preview: files and manifest are written to `public/songs/` (`public/songs/manifest.json`).
- Android standalone (Capacitor): files and manifest are stored in app storage (`Directory.Data/songs/manifest.json`) via `@capacitor/filesystem`.

Import source debug selector:
- In debug/dev builds, the `Import Source` selector (`Auto`, `Server`, `Native`) is visible below the import button.
- `Auto` uses the correct path by platform (server on web, native on Capacitor).
- On Capacitor Android native import, debug file-log instrumentation is available but disabled by default (`IMPORT_DEBUG_LOG_ENABLED = false` in TS + Android plugin).
- When debug logging is re-enabled, a persistent debug file log is written during conversion:
  - primary path: `<external-files>/import-debug/song-import-debug.log`
  - fallback path: `<internal-files>/import-debug/song-import-debug.log`
  - file contains JS pre-native checkpoints (`decode/downmix/resample/base64/temp-write`) plus native stage transitions.
  - file also contains watchdog heartbeats, resolved input/model paths, and full stack traces on failure.
- Start Screen includes a native-only `Share Log` action next to import controls when debug logging is enabled:
  - opens Android share sheet (`ACTION_SEND`) to share the latest import debug log
  - Quick Share can be selected directly from the standard Android chooser
  - fallback order: `song-import-debug.log` -> `song-import-debug.prev.log`

## Startup Benchmark CLI

To measure catalog startup cost:

```bash
npm run perf:startup
```

Useful options:

```bash
node scripts/benchmark-startup.mjs --mode current --repeat 20
node scripts/benchmark-startup.mjs --mode optimized --repeat 20
node scripts/benchmark-startup.mjs --mode both --manifest public/songs/manifest.json --repeat 30
```

Output:
- console summary with `avg/p50/p95/max`
- full JSON saved at `/tmp/guitarhelio-startup-benchmark.json`

## Performance and Stability Notes

- Fret labels in gameplay use **pooling** (object reuse) to avoid per-frame creation/destruction.
- HUD score and streak are updated **incrementally** on scoring events, reducing work in the runtime loop.
- Pause menu actions are clickable both on button and text (desktop/touch).
- Native import/conversion features (**NeuralNote + Tempo-CNN**, native song catalog, native high-score persistence) are loaded **on-demand** via `import()` only when needed from Start Screen or at end of session.

### Large Chunk Warnings (Vite)

- Vite warning `Some chunks are larger than 500 kB` flags **any chunk** above threshold, including lazy chunks, not only the initial bootstrap.
- In the current build, a large **core** chunk remains (Phaser runtime + gameplay/audio required by app).
- The previously very large lazy chunk tied to WASM audio decoders is no longer in the frontend bundle: decoding now uses runtime-native WebAudio.

## Content Usage Notice

- This repository includes MP3 files generated with Suno.
- Suno-generated MP3 assets in this repository are provided for development/testing context and are **not licensed for commercial use**.
