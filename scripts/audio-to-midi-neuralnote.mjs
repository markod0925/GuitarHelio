import path from 'node:path';
import { createAudioToMidiConverter } from '../tools/audio-midi-converter/src/neuralnote.mjs';

const converter = createAudioToMidiConverter({
  modelDir: path.resolve(process.cwd(), 'third_party/neuralnote_core/modeldata'),
  modelDirLabel: 'third_party/neuralnote_core/modeldata',
  cliBinaryPath: path.resolve(process.cwd(), 'third_party/neuralnote_core/bin/nn_transcriber_cli'),
  onnxLibDir: path.resolve(process.cwd(), 'third_party/onnxruntime/linux-x64/lib')
});

export const {
  assertModelReady,
  buildUniqueMidiFileName,
  convertAudioBufferToMidiBuffer,
  convertUploadToMidi,
  detectUploadSourceType
} = converter;

export default converter;
