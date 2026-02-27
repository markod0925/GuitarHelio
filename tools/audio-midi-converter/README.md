# Audio -> MIDI Converter Workflow

This folder provides the Node wrappers used by GuitarHelio to convert WAV/MP3/OGG audio to MIDI with a C++/ONNX pipeline.

## Converter modes

Supported input labels:

- `legacy`
- `neuralnote`

Both labels are aliases to the same backend:

- NeuralNote C++ core (`third_party/neuralnote_core`)
- Tempo-CNN C++ ONNX core (`third_party/tempocnn_core`)
- ONNX runtime shared libs (`third_party/onnxruntime/<platform>/lib`)

`ab` mode is not available.

## Build C++ converters

```bash
npm run build:nn:cli
npm run build:tempo:cli
```

Expected binaries:

- `third_party/neuralnote_core/bin/nn_transcriber_cli`
- `third_party/tempocnn_core/bin/tempo_cnn_cli`

## CLI usage

```bash
node ./bin/convert-audio-to-midi.mjs \
  --input ./track.wav \
  --output ./track.mid \
  --mode legacy
```

`--mode legacy` and `--mode neuralnote` run the same C++/ONNX converter.

Optional overrides:

- `--model-dir <path>` (default `third_party/neuralnote_core/modeldata`)
- `--cli-bin <path>` (default `third_party/neuralnote_core/bin/nn_transcriber_cli`)
- `--onnx-lib-dir <path>` (default `third_party/onnxruntime/linux-x64/lib`)
- `--diag --diag-watchdog-ms <ms> --diag-stall-ms <ms> --diag-timeout-ms <ms>`
- NeuralNote preset tuning: `--nn-note-sensitivity`, `--nn-model-confidence-threshold`, `--nn-split-sensitivity`, `--nn-note-segmentation-threshold`, `--nn-min-note-ms`, `--nn-melodia-trick`, `--nn-min-pitch-hz`, `--nn-max-pitch-hz`, `--nn-energy-tolerance`

## Tempo metadata

Server/native import pipeline estimates tempo with Tempo-CNN ONNX and passes both:

- `tempoBpm`
- `tempoMap` (local tempo points when available)

The converter applies tempo metadata to the output MIDI via:

- `src/midi-tempo-map.mjs`

## Library usage

```js
import { createAudioToMidiConverter } from './src/neuralnote.mjs';

const converter = createAudioToMidiConverter({
  modelDir: '/abs/path/to/third_party/neuralnote_core/modeldata',
  cliBinaryPath: '/abs/path/to/third_party/neuralnote_core/bin/nn_transcriber_cli',
  onnxLibDir: '/abs/path/to/third_party/onnxruntime/linux-x64/lib'
});

const midiBuffer = await converter.convertAudioBufferToMidiBuffer(audioBuffer, '.wav', {
  conversionPreset: 'balanced',
  tempoBpm: 120,
  tempoMap: [{ timeSeconds: 0, bpm: 120 }]
});
```
