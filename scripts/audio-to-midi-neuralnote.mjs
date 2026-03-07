import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudioToMidiConverter } from '../tools/audio-midi-converter/src/neuralnote.mjs';

function resolveProjectRoot() {
  const envRoot = String(process.env.GH_PROJECT_ROOT || '').trim();
  if (envRoot.length > 0) {
    return path.resolve(envRoot);
  }

  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptsDir, '..');
}

function resolveCliBaseName() {
  return process.platform === 'win32' ? 'nn_transcriber_cli.exe' : 'nn_transcriber_cli';
}

function resolveOnnxRuntimeSubdir() {
  return process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
}

const projectRoot = resolveProjectRoot();

const converter = createAudioToMidiConverter({
  modelDir: path.resolve(projectRoot, 'third_party/neuralnote_core/modeldata'),
  modelDirLabel: 'third_party/neuralnote_core/modeldata',
  cliBinaryPath: path.resolve(projectRoot, 'third_party/neuralnote_core/bin', resolveCliBaseName()),
  onnxLibDir: path.resolve(projectRoot, 'third_party/onnxruntime', resolveOnnxRuntimeSubdir(), 'lib')
});

export const {
  assertModelReady,
  buildUniqueMidiFileName,
  convertAudioBufferToMidiBuffer,
  convertUploadToMidi,
  detectUploadSourceType
} = converter;

export default converter;
