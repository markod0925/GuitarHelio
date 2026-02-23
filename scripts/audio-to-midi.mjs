import path from 'node:path';
import { createAudioToMidiConverter } from '../tools/audio-midi-converter/src/index.mjs';

const converter = createAudioToMidiConverter({
  modelDir: path.resolve(process.cwd(), 'assets/models/basic-pitch'),
  modelDirLabel: 'assets/models/basic-pitch'
});

export const {
  assertModelReady,
  buildUniqueMidiFileName,
  convertAudioBufferToMidiBuffer,
  convertUploadToMidi,
  detectUploadSourceType
} = converter;

export default converter;
