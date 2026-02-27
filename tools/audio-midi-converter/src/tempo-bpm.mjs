import {
  estimateTempoFromAudioFile as estimateTempoFromAudioFileOnnx,
  estimateTempoBpmFromAudioFile as estimateTempoBpmFromAudioFileOnnx
} from './tempo-bpm-onnx.mjs';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeTempoBackend(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized || normalized === 'onnx' || normalized === 'cpp') return 'onnx';
  throw new Error(`Unsupported tempo backend "${normalized}". Only "onnx" is available.`);
}

function resolveTempoBackend(options = {}) {
  const requested = options.backend ?? process.env.TEMPO_CNN_BACKEND ?? 'onnx';
  return normalizeTempoBackend(requested);
}

export async function estimateTempoFromAudioFile(inputFilePath, options = {}) {
  resolveTempoBackend(options);
  return estimateTempoFromAudioFileOnnx(inputFilePath, options);
}

export async function estimateTempoBpmFromAudioFile(inputFilePath, options = {}) {
  resolveTempoBackend(options);
  return estimateTempoBpmFromAudioFileOnnx(inputFilePath, options);
}

export function shutdownTempoBpmDaemon() {}

export { normalizeTempoBackend, resolveTempoBackend };
