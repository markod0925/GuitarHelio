# Audio → MIDI Converter Workflow (Standalone-ready)

This folder isolates the complete WAV/MP3/OGG → MIDI conversion pipeline so it can be moved to another GitHub repository with minimal effort.

## Included

- `src/index.mjs`: reusable conversion factory (`createAudioToMidiConverter`).
- `bin/convert-audio-to-midi.mjs`: CLI entrypoint.
- `package.json`: minimal dependency manifest for the conversion workflow.

## CLI usage

```bash
node ./bin/convert-audio-to-midi.mjs \
  --input ./track.wav \
  --output ./track.mid \
  --model-dir ../assets/models/basic-pitch
```

## Library usage

```js
import { createAudioToMidiConverter } from './src/index.mjs';

const converter = createAudioToMidiConverter({
  modelDir: '/absolute/path/to/basic-pitch-model-dir',
  modelDirLabel: 'assets/models/basic-pitch'
});

const midiBuffer = await converter.convertAudioBufferToMidiBuffer(audioBuffer, '.wav');
```

## Export to a new repository

Copy this folder with the model assets it references (`model.json` and all weight files), then run `npm install` in the destination repo.
