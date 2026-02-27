import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEMPO_BPM_MIN = 20;
const TEMPO_BPM_MAX = 300;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TARGET_SAMPLE_RATE = 11025;
const TEMPO_MAP_MAX_POINTS = 4096;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function parseJsonFromStdout(stdoutText) {
  const lines = String(stdoutText || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error('tempo-cnn ONNX CLI did not produce any JSON output.');
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    try {
      return JSON.parse(line);
    } catch {
      // Continue scanning backwards in case logs were printed before JSON.
    }
  }

  throw new Error(`Invalid JSON output from tempo-cnn ONNX CLI: ${lines[lines.length - 1]}`);
}

function normalizeTempoMapEntries(rawTempoMap) {
  if (!Array.isArray(rawTempoMap)) return [];

  const parsed = [];
  for (const entry of rawTempoMap) {
    if (!entry || typeof entry !== 'object') continue;
    const rawTime = Number(entry.time ?? entry.timeSeconds ?? entry.seconds);
    const rawBpm = Number(entry.bpm);
    if (!Number.isFinite(rawTime) || rawTime < 0) continue;
    if (!Number.isFinite(rawBpm) || rawBpm <= 0) continue;
    parsed.push({
      timeSeconds: rawTime,
      bpm: clamp(rawBpm, TEMPO_BPM_MIN, TEMPO_BPM_MAX)
    });
  }

  if (parsed.length === 0) return [];

  parsed.sort((left, right) => left.timeSeconds - right.timeSeconds);

  const deduped = [];
  for (const point of parsed) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(point.timeSeconds - last.timeSeconds) < 1e-6) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    if (!last || Math.abs(point.bpm - last.bpm) >= 0.05 || point.timeSeconds - last.timeSeconds >= 0.2) {
      deduped.push(point);
    }
  }

  return deduped.slice(0, TEMPO_MAP_MAX_POINTS);
}

function parseTempoEstimatePayload(payload) {
  const rawBpm = Number(payload?.bpm);
  if (!Number.isFinite(rawBpm) || rawBpm <= 0) {
    throw new Error('tempo-cnn ONNX helper returned an invalid BPM value.');
  }
  return {
    bpm: clamp(rawBpm, TEMPO_BPM_MIN, TEMPO_BPM_MAX),
    tempoMap: normalizeTempoMapEntries(payload?.tempo_map ?? payload?.tempoMap)
  };
}

function downmixToMono(audioBuffer) {
  const channels = Math.max(0, Number(audioBuffer?.numberOfChannels) || 0);
  const length = Math.max(0, Number(audioBuffer?.length) || 0);
  if (channels <= 0 || length <= 0) throw new Error('Input audio is empty.');

  if (channels === 1) {
    return new Float32Array(audioBuffer.getChannelData(0));
  }

  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mono[i] += channelData[i] / channels;
    }
  }
  return mono;
}

function resampleMonoSignal(samples, sourceSampleRate, targetSampleRate = TARGET_SAMPLE_RATE) {
  const inputLength = Math.max(0, Number(samples?.length) || 0);
  if (inputLength <= 0) return new Float32Array(0);

  const srcRate = Math.max(1, Math.round(Number(sourceSampleRate) || targetSampleRate));
  const dstRate = Math.max(1, Math.round(Number(targetSampleRate) || TARGET_SAMPLE_RATE));
  if (srcRate === dstRate) return samples;

  const outputLength = Math.max(1, Math.round((inputLength * dstRate) / srcRate));
  const out = new Float32Array(outputLength);
  const lastSourceIndex = inputLength - 1;

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = (i * srcRate) / dstRate;
    const left = Math.floor(sourcePosition);
    const right = Math.min(lastSourceIndex, left + 1);
    const frac = sourcePosition - left;
    const leftSample = Number.isFinite(samples[left]) ? samples[left] : 0;
    const rightSample = Number.isFinite(samples[right]) ? samples[right] : 0;
    out[i] = leftSample + (rightSample - leftSample) * frac;
  }

  return out;
}

function resolveProjectRoot() {
  return path.resolve(process.cwd());
}

function resolveTempoCliBaseName() {
  return process.platform === 'win32' ? 'tempo_cnn_cli.exe' : 'tempo_cnn_cli';
}

function resolveOnnxRuntimeSubdir() {
  return process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
}

function resolveOnnxRuntimeLibFileName() {
  return process.platform === 'win32' ? 'onnxruntime.dll' : 'libonnxruntime.so';
}

function resolveTempoCliPath(projectRoot, options = {}) {
  return path.resolve(
    normalizeText(options.tempoCliBin) || path.join(projectRoot, 'third_party', 'tempocnn_core', 'bin', resolveTempoCliBaseName())
  );
}

function resolveTempoModelPath(projectRoot, options = {}) {
  return path.resolve(
    normalizeText(options.tempoModelOnnxPath)
      || path.join(projectRoot, 'third_party', 'tempo_cnn', 'tempocnn', 'models', 'fcn.onnx')
  );
}

function resolveOnnxLibDir(projectRoot, options = {}) {
  return path.resolve(
    normalizeText(options.onnxLibDir)
      || path.join(projectRoot, 'third_party', 'onnxruntime', resolveOnnxRuntimeSubdir(), 'lib')
  );
}

async function ensurePathExists(targetPath, label) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

async function ensureFilesExist(cliPath, modelPath, onnxLibDir) {
  await ensurePathExists(cliPath, 'tempo ONNX CLI');
  await ensurePathExists(modelPath, 'tempo ONNX model');
  await ensurePathExists(onnxLibDir, 'ONNX runtime library directory');
  await ensurePathExists(path.join(onnxLibDir, resolveOnnxRuntimeLibFileName()), 'ONNX runtime shared library');
}

async function decodeAudioToF32leTempFile(inputFilePath, tempDir) {
  const [{ default: decodeAudio }, sourceBuffer] = await Promise.all([
    import('audio-decode'),
    fs.readFile(inputFilePath)
  ]);

  const decoded = await decodeAudio(Buffer.from(sourceBuffer));
  const sourceSampleRate = Math.max(1, Number(decoded?.sampleRate) || TARGET_SAMPLE_RATE);
  const mono = downmixToMono(decoded);
  const resampled = resampleMonoSignal(mono, sourceSampleRate, TARGET_SAMPLE_RATE);
  const pcmPath = path.join(tempDir, 'tempo-input.f32');

  const pcmBuffer = Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
  await fs.writeFile(pcmPath, pcmBuffer);
  return pcmPath;
}

async function decodeAudioToF32leWithFfmpeg(inputFilePath, tempDir) {
  const pcmPath = path.join(tempDir, 'tempo-input.f32');
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-i',
    inputFilePath,
    '-ac',
    '1',
    '-ar',
    `${TARGET_SAMPLE_RATE}`,
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    pcmPath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ffmpeg: ${toErrorMessage(error)}`));
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        const details = normalizeText(stderr) || `ffmpeg exited with code ${code}.`;
        reject(new Error(details));
        return;
      }

      try {
        const stats = await fs.stat(pcmPath);
        if (!stats.isFile() || Number(stats.size) <= 0) {
          reject(new Error('ffmpeg produced an empty PCM output.'));
          return;
        }
      } catch (error) {
        reject(new Error(`ffmpeg output validation failed: ${toErrorMessage(error)}`));
        return;
      }

      resolve(pcmPath);
    });
  });
}

async function preparePcmInputFile(inputFilePath, tempDir, options = {}) {
  const useFfmpegOption = options.useFfmpeg !== false;
  const envUseFfmpeg = String(process.env.TEMPO_CNN_ONNX_USE_FFMPEG ?? '1') !== '0';
  const useFfmpeg = useFfmpegOption && envUseFfmpeg;

  if (useFfmpeg) {
    try {
      return await decodeAudioToF32leWithFfmpeg(inputFilePath, tempDir);
    } catch {
      // Fallback to JS decode path when ffmpeg is unavailable/fails.
    }
  }

  return decodeAudioToF32leTempFile(inputFilePath, tempDir);
}

async function runTempoCli({
  cliPath,
  modelPath,
  onnxLibDir,
  inputF32lePath,
  interpolate,
  localTempo,
  timeoutMs
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--input-f32le',
      inputF32lePath,
      '--model-onnx',
      modelPath,
      '--interpolate',
      interpolate ? '1' : '0',
      '--local-tempo',
      localTempo ? '1' : '0'
    ];

    const env = { ...process.env };
    if (onnxLibDir) {
      if (process.platform === 'win32') {
        const current = typeof env.PATH === 'string' && env.PATH.length > 0 ? env.PATH : '';
        env.PATH = current ? `${onnxLibDir}${path.delimiter}${current}` : onnxLibDir;
      } else {
        const current = typeof env.LD_LIBRARY_PATH === 'string' && env.LD_LIBRARY_PATH.length > 0 ? env.LD_LIBRARY_PATH : '';
        env.LD_LIBRARY_PATH = current ? `${onnxLibDir}${path.delimiter}${current}` : onnxLibDir;
      }
    }

    const child = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`tempo-cnn ONNX estimation timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const finish = (error = null, payload = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(payload);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish(new Error(`Failed to start tempo-cnn ONNX CLI (${cliPath}): ${toErrorMessage(error)}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const details = normalizeText(stderr) || `tempo-cnn ONNX CLI exited with code ${code}.`;
        finish(new Error(details));
        return;
      }

      let parsed;
      try {
        parsed = parseJsonFromStdout(stdout);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(toErrorMessage(error)));
        return;
      }

      try {
        finish(null, parseTempoEstimatePayload(parsed));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(toErrorMessage(error)));
      }
    });
  });
}

export async function estimateTempoFromAudioFile(inputFilePath, options = {}) {
  const sourcePath = path.resolve(inputFilePath);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.round(Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const interpolate = options.interpolate !== false;
  const localTempo = options.localTempo === true;

  const projectRoot = resolveProjectRoot();
  const cliPath = resolveTempoCliPath(projectRoot, options);
  const modelPath = resolveTempoModelPath(projectRoot, options);
  const onnxLibDir = resolveOnnxLibDir(projectRoot, options);

  await ensureFilesExist(cliPath, modelPath, onnxLibDir);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tempo-cnn-onnx-'));
  try {
    const inputF32lePath = await preparePcmInputFile(sourcePath, tempDir, options);
    return await runTempoCli({
      cliPath,
      modelPath,
      onnxLibDir,
      inputF32lePath,
      interpolate,
      localTempo,
      timeoutMs
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function estimateTempoBpmFromAudioFile(inputFilePath, options = {}) {
  const result = await estimateTempoFromAudioFile(inputFilePath, options);
  return result.bpm;
}

export function shutdownTempoBpmDaemon() {
  // ONNX backend is one-shot only (no daemon process).
}
