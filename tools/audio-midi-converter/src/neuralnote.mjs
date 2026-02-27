import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyTempoMetadataToMidi } from './midi-tempo-map.mjs';

const MIDI_EXTENSIONS = new Set(['.mid', '.midi']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg']);
const BASIC_PITCH_MODEL_SAMPLE_RATE = 22050;

const BALANCED_PRESET = {
  modelConfidenceThreshold: 0.355,
  noteSegmentationThreshold: 0.31,
  minNoteLengthMs: 24,
  melodiaTrick: false,
  minPitchHz: 1,
  maxPitchHz: 3000,
  midiTempo: 120,
  energyTolerance: 11,
  normalizeInput: false,
  useModelAmplitudeVelocity: true,
  targetPeak: 0.92,
  targetRms: 0.09,
  velocityBase: 0.5,
  velocityRange: 0.5,
  amplitudeExponent: 0.42,
  volumeBoost: 1.5,
  velocityFloor: 0.6
};

const NEURALNOTE_CLI_PRESET_DEFAULTS = {
  noteSensitivity: 0.671,
  splitSensitivity: 0.825,
  minNoteDurationMs: 8,
  melodiaTrick: false,
  minPitchHz: 1,
  maxPitchHz: 3000,
  energyTolerance: 21
};

const NEURALNOTE_CLI_ARG_NAMES = {
  noteSensitivity: '--note-sensitivity',
  splitSensitivity: '--split-sensitivity',
  minNoteDurationMs: '--min-note-ms',
  melodiaTrick: '--melodia-trick',
  minPitchHz: '--min-pitch-hz',
  maxPitchHz: '--max-pitch-hz',
  energyTolerance: '--energy-tolerance'
};

const DEFAULT_NEURALNOTE_PROGRESS_START = 0.58;
const DEFAULT_NEURALNOTE_PROGRESS_SPAN = 0.32;
const DEFAULT_DIAGNOSTIC_WATCHDOG_INTERVAL_MS = 5000;
const DEFAULT_DIAGNOSTIC_STALL_WARNING_MS = 15000;

function normalizeText(value) {
  return String(value || '').trim();
}

function getExtension(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('.')) return raw;

  const fromPath = path.extname(raw);
  if (fromPath) return fromPath;

  if (raw.includes('audio/mpeg') || raw.includes('audio/mp3')) return '.mp3';
  if (raw.includes('audio/wav') || raw.includes('audio/wave') || raw.includes('audio/x-wav')) return '.wav';
  if (raw.includes('audio/ogg') || raw.includes('audio/x-ogg')) return '.ogg';
  if (raw.includes('audio/midi') || raw.includes('audio/x-midi')) return '.mid';
  return '';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value, fallback = 0) {
  const safe = Number(value);
  return Number.isFinite(safe) ? safe : fallback;
}

function resolveMidiTempoBpm(options, fallbackTempoBpm = 120) {
  const override = Number(options?.tempoBpm);
  if (Number.isFinite(override) && override > 0) {
    return clamp(override, 20, 300);
  }
  return clamp(toFiniteNumber(fallbackTempoBpm, 120), 20, 300);
}

function safeProgressHandler(options) {
  return typeof options?.onProgress === 'function' ? options.onProgress : null;
}

function reportProgress(options, stage, progress) {
  const handler = safeProgressHandler(options);
  if (!handler) return;

  handler({
    stage: String(stage || '').trim() || 'Working...',
    progress: clamp(toFiniteNumber(progress, 0), 0, 1)
  });
}

function toSafeInteger(value, fallback = 0) {
  const safe = Number(value);
  if (!Number.isFinite(safe)) return fallback;
  return Math.max(0, Math.round(safe));
}

function envFlagEnabled(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function toOptionalNumber(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid NeuralNote preset value for ${label}.`);
  }
  return parsed;
}

function toOptionalBoolean(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === '') return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`Invalid NeuralNote preset value for ${label}.`);
}

function firstDefined(entries = []) {
  for (const entry of entries) {
    if (entry !== undefined && entry !== null) return entry;
  }
  return undefined;
}

function normalizeNeuralNotePresetOverrides(rawPreset) {
  const source = rawPreset && typeof rawPreset === 'object' ? rawPreset : {};

  const normalized = {};

  let noteSensitivity = toOptionalNumber(source.noteSensitivity, 'noteSensitivity');
  if (noteSensitivity === undefined) {
    const modelConfidenceThreshold = toOptionalNumber(source.modelConfidenceThreshold, 'modelConfidenceThreshold');
    if (modelConfidenceThreshold !== undefined) {
      noteSensitivity = 1 - modelConfidenceThreshold;
    }
  }
  if (noteSensitivity !== undefined) normalized.noteSensitivity = noteSensitivity;

  let splitSensitivity = toOptionalNumber(source.splitSensitivity, 'splitSensitivity');
  if (splitSensitivity === undefined) {
    const noteSegmentationThreshold = toOptionalNumber(
      source.noteSegmentationThreshold,
      'noteSegmentationThreshold'
    );
    if (noteSegmentationThreshold !== undefined) {
      splitSensitivity = 1 - noteSegmentationThreshold;
    }
  }
  if (splitSensitivity !== undefined) normalized.splitSensitivity = splitSensitivity;

  const minNoteDurationMs = toOptionalNumber(
    firstDefined([source.minNoteDurationMs, source.minNoteLengthMs, source.minNoteMs]),
    'minNoteDurationMs/minNoteLengthMs'
  );
  if (minNoteDurationMs !== undefined) normalized.minNoteDurationMs = minNoteDurationMs;

  const melodiaTrick = toOptionalBoolean(source.melodiaTrick, 'melodiaTrick');
  if (melodiaTrick !== undefined) normalized.melodiaTrick = melodiaTrick;

  const minPitchHz = toOptionalNumber(source.minPitchHz, 'minPitchHz');
  if (minPitchHz !== undefined) normalized.minPitchHz = minPitchHz;

  const maxPitchHz = toOptionalNumber(source.maxPitchHz, 'maxPitchHz');
  if (maxPitchHz !== undefined) normalized.maxPitchHz = maxPitchHz;

  const energyTolerance = toOptionalNumber(source.energyTolerance, 'energyTolerance');
  if (energyTolerance !== undefined) normalized.energyTolerance = Math.round(energyTolerance);

  if (normalized.noteSensitivity !== undefined && (normalized.noteSensitivity < 0 || normalized.noteSensitivity > 1)) {
    throw new Error('NeuralNote preset noteSensitivity must be in [0,1].');
  }
  if (normalized.splitSensitivity !== undefined && (normalized.splitSensitivity < 0 || normalized.splitSensitivity > 1)) {
    throw new Error('NeuralNote preset splitSensitivity must be in [0,1].');
  }
  if (normalized.minNoteDurationMs !== undefined && normalized.minNoteDurationMs <= 0) {
    throw new Error('NeuralNote preset minNoteDurationMs must be > 0.');
  }
  if (normalized.minPitchHz !== undefined && normalized.minPitchHz < 0) {
    throw new Error('NeuralNote preset minPitchHz must be >= 0.');
  }
  if (normalized.maxPitchHz !== undefined && normalized.maxPitchHz < 0) {
    throw new Error('NeuralNote preset maxPitchHz must be >= 0.');
  }
  if (
    normalized.minPitchHz !== undefined &&
    normalized.maxPitchHz !== undefined &&
    normalized.maxPitchHz > 0 &&
    normalized.minPitchHz > 0 &&
    normalized.maxPitchHz < normalized.minPitchHz
  ) {
    throw new Error('NeuralNote preset maxPitchHz must be >= minPitchHz.');
  }
  if (normalized.energyTolerance !== undefined && normalized.energyTolerance < 1) {
    throw new Error('NeuralNote preset energyTolerance must be >= 1.');
  }

  return normalized;
}

function buildNeuralNotePresetCliArgs(preset = {}) {
  const args = [];
  const noteSensitivity = toOptionalNumber(preset.noteSensitivity, 'noteSensitivity');
  if (noteSensitivity !== undefined) args.push(NEURALNOTE_CLI_ARG_NAMES.noteSensitivity, `${noteSensitivity}`);

  const splitSensitivity = toOptionalNumber(preset.splitSensitivity, 'splitSensitivity');
  if (splitSensitivity !== undefined) args.push(NEURALNOTE_CLI_ARG_NAMES.splitSensitivity, `${splitSensitivity}`);

  const minNoteDurationMs = toOptionalNumber(preset.minNoteDurationMs, 'minNoteDurationMs');
  if (minNoteDurationMs !== undefined) args.push(NEURALNOTE_CLI_ARG_NAMES.minNoteDurationMs, `${minNoteDurationMs}`);

  const melodiaTrick = toOptionalBoolean(preset.melodiaTrick, 'melodiaTrick');
  if (melodiaTrick !== undefined) args.push(NEURALNOTE_CLI_ARG_NAMES.melodiaTrick, melodiaTrick ? '1' : '0');

  const minPitchHz = toOptionalNumber(preset.minPitchHz, 'minPitchHz');
  if (minPitchHz !== undefined) args.push(NEURALNOTE_CLI_ARG_NAMES.minPitchHz, `${minPitchHz}`);

  const maxPitchHz = toOptionalNumber(preset.maxPitchHz, 'maxPitchHz');
  if (maxPitchHz !== undefined) args.push(NEURALNOTE_CLI_ARG_NAMES.maxPitchHz, `${maxPitchHz}`);

  const energyTolerance = toOptionalNumber(preset.energyTolerance, 'energyTolerance');
  if (energyTolerance !== undefined) {
    args.push(NEURALNOTE_CLI_ARG_NAMES.energyTolerance, `${Math.round(energyTolerance)}`);
  }

  return args;
}

function createNeuralNoteDiagnostics(config = {}, options = {}) {
  const configDiagnostics = config?.diagnostics && typeof config.diagnostics === 'object' ? config.diagnostics : {};
  const optionDiagnostics = options?.diagnostics && typeof options.diagnostics === 'object' ? options.diagnostics : {};
  const optionDiagnosticsEnabled = options?.diagnostics === true || optionDiagnostics.enabled === true;
  const configDiagnosticsEnabled = config?.enableDiagnostics === true || configDiagnostics.enabled === true;
  const envDiagnosticsEnabled = envFlagEnabled(process.env.GH_NEURALNOTE_DIAGNOSTICS);
  const enabled = optionDiagnosticsEnabled || configDiagnosticsEnabled || envDiagnosticsEnabled;

  const watchdogIntervalMs = Math.max(
    1000,
    toSafeInteger(
      optionDiagnostics.watchdogIntervalMs ?? configDiagnostics.watchdogIntervalMs,
      DEFAULT_DIAGNOSTIC_WATCHDOG_INTERVAL_MS
    )
  );
  const stallWarningMs = Math.max(
    watchdogIntervalMs,
    toSafeInteger(
      optionDiagnostics.stallWarningMs ?? configDiagnostics.stallWarningMs,
      DEFAULT_DIAGNOSTIC_STALL_WARNING_MS
    )
  );
  const maxRuntimeMs = toSafeInteger(optionDiagnostics.maxRuntimeMs ?? configDiagnostics.maxRuntimeMs, 0);

  const logger =
    (typeof optionDiagnostics.logger === 'function' && optionDiagnostics.logger) ||
    (typeof configDiagnostics.logger === 'function' && configDiagnostics.logger) ||
    null;

  const log = (event, payload = {}) => {
    if (!enabled) return;
    if (logger) {
      try {
        logger(event, payload);
      } catch {
        // Keep conversion running if external logger throws.
      }
      return;
    }

    const serialized = JSON.stringify(payload);
    process.stderr.write(`[neuralnote-diag] ${event} ${serialized}\n`);
  };

  return {
    enabled,
    log,
    watchdogIntervalMs,
    stallWarningMs,
    maxRuntimeMs
  };
}

function downmixToMono(audioBuffer) {
  const channels = Math.max(0, Number(audioBuffer?.numberOfChannels) || 0);
  const length = Math.max(0, Number(audioBuffer?.length) || 0);
  if (channels <= 0 || length <= 0) throw new Error('Uploaded audio is empty.');

  if (channels === 1) {
    return new Float32Array(audioBuffer.getChannelData(0));
  }

  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }
  return mono;
}

function resampleMonoSignal(samples, sourceSampleRate, targetSampleRate = BASIC_PITCH_MODEL_SAMPLE_RATE) {
  const inputLength = Math.max(0, Number(samples?.length) || 0);
  if (inputLength <= 0) return new Float32Array(0);

  const srcRate = Math.max(1, Math.round(toFiniteNumber(sourceSampleRate, targetSampleRate)));
  const dstRate = Math.max(1, Math.round(toFiniteNumber(targetSampleRate, BASIC_PITCH_MODEL_SAMPLE_RATE)));
  if (srcRate === dstRate) return samples;

  const outputLength = Math.max(1, Math.round((inputLength * dstRate) / srcRate));
  const out = new Float32Array(outputLength);
  const lastSourceIndex = inputLength - 1;

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = (i * srcRate) / dstRate;
    const left = Math.floor(sourcePosition);
    const right = Math.min(lastSourceIndex, left + 1);
    const frac = sourcePosition - left;
    const leftSample = toFiniteNumber(samples[left], 0);
    const rightSample = toFiniteNumber(samples[right], 0);
    out[i] = leftSample + (rightSample - leftSample) * frac;
  }

  return out;
}

function analyzeSignalLevels(samples) {
  const length = Math.max(0, Number(samples?.length) || 0);
  if (length <= 0) return { peak: 0, rms: 0 };

  let peak = 0;
  let sumSquares = 0;

  for (let i = 0; i < length; i += 1) {
    const sample = toFiniteNumber(samples[i], 0);
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumSquares += sample * sample;
  }

  return {
    peak,
    rms: Math.sqrt(sumSquares / length)
  };
}

function normalizeMonoSignal(samples, settings, stats = analyzeSignalLevels(samples)) {
  const length = Math.max(0, Number(samples?.length) || 0);
  if (length <= 0 || stats.peak <= 1e-6) return samples;

  const targetPeak = clamp(toFiniteNumber(settings?.targetPeak, 0.92), 0.2, 0.99);
  const targetRms = clamp(toFiniteNumber(settings?.targetRms, 0.09), 0.01, 0.3);

  let gain = targetPeak / stats.peak;
  if (stats.rms > 1e-6) {
    gain = Math.max(gain, targetRms / stats.rms);
  }

  gain = clamp(gain, 1, 8);
  if (Math.abs(gain - 1) < 1e-4) return samples;

  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = clamp(toFiniteNumber(samples[i], 0) * gain, -1, 1);
  }
  return out;
}

function parseCoreEvents(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('NeuralNote converter produced invalid JSON output.');
  }

  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  return events
    .map((value) => {
      if (!value || typeof value !== 'object') return null;
      const data = value;
      const start = Math.max(0, toFiniteNumber(data.startTimeSeconds, 0));
      const duration = Math.max(0.02, toFiniteNumber(data.durationSeconds, 0.02));
      const pitch = clamp(Math.round(toFiniteNumber(data.pitchMidi, 0)), 0, 127);
      const amplitude = clamp(toFiniteNumber(data.amplitude, 0.4), 0, 1);
      return { startTimeSeconds: start, durationSeconds: duration, pitchMidi: pitch, amplitude };
    })
    .filter((entry) => entry !== null);
}

async function readProcessSnapshot(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    const statusPath = `/proc/${pid}/status`;
    const content = await fs.readFile(statusPath, 'utf8');
    const lines = content.split('\n');
    const findValue = (prefix) => {
      const line = lines.find((entry) => entry.startsWith(prefix));
      if (!line) return '';
      const [, value] = line.split(':');
      return String(value || '').trim();
    };
    return {
      state: findValue('State'),
      vmRss: findValue('VmRSS'),
      threads: findValue('Threads')
    };
  } catch {
    return null;
  }
}

async function readFileSnapshot(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return {
      bytes: Number(stats.size) || 0,
      mtimeMs: Number(stats.mtimeMs) || 0
    };
  } catch {
    return null;
  }
}

function toSeconds(ms) {
  return Math.max(0, Math.round(ms / 1000));
}

function truncateText(value, maxLength = 220) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function resolveNeuralNoteCliBaseName() {
  return process.platform === 'win32' ? 'nn_transcriber_cli.exe' : 'nn_transcriber_cli';
}

function resolveOnnxRuntimeSubdir() {
  return process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
}

function resolveOnnxRuntimeLibFileName() {
  return process.platform === 'win32' ? 'onnxruntime.dll' : 'libonnxruntime.so';
}

function runNeuralNoteCli({ cliBinaryPath, modelDir, onnxLibDir, inputPath, outputPath, options, diagnostics, preset }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--input-f32le',
      inputPath,
      '--output-json',
      outputPath,
      '--model-dir',
      modelDir,
      '--preset',
      'balanced',
      ...buildNeuralNotePresetCliArgs(preset)
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
    if (diagnostics?.enabled) {
      env.GH_NEURALNOTE_CPP_DIAG = '1';
    }

    const child = spawn(cliBinaryPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    let lastActivityMs = Date.now();
    let lastProgressMs = lastActivityMs;
    let lastScaledProgress = clamp(DEFAULT_NEURALNOTE_PROGRESS_START, 0, 1);
    let lastProgressStage = 'Launching NeuralNote CLI...';
    let stdoutLineCount = 0;
    let progressLineCount = 0;
    let watchdogLastReportedMs = 0;
    const startedAtMs = Date.now();
    let watchdogTimer = null;
    let runtimeTimer = null;

    diagnostics?.log('spawn', {
      cliBinaryPath,
      pid: child.pid ?? null,
      args,
      inputPath,
      outputPath,
      modelDir,
      preset
    });

    const clearTimers = () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (runtimeTimer) {
        clearTimeout(runtimeTimer);
        runtimeTimer = null;
      }
    };

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const flushStdoutLine = (rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) return;

      stdoutLineCount += 1;
      const now = Date.now();
      lastActivityMs = now;

      try {
        const payload = JSON.parse(line);
        if (payload?.type === 'progress') {
          const normalizedProgress = clamp(toFiniteNumber(payload.progress, 0), 0, 1);
          const scaledProgress = clamp(
            DEFAULT_NEURALNOTE_PROGRESS_START + normalizedProgress * DEFAULT_NEURALNOTE_PROGRESS_SPAN,
            0,
            1
          );
          const stage = normalizeText(payload.stage) || 'Running NeuralNote model...';

          lastScaledProgress = scaledProgress;
          lastProgressMs = now;
          lastProgressStage = stage;
          progressLineCount += 1;

          reportProgress(options, stage, scaledProgress);
          diagnostics?.log('progress', {
            stage,
            normalizedProgress,
            scaledProgress
          });
          return;
        }

        if (payload?.type === 'diag') {
          const component = normalizeText(payload.component) || 'core';
          const event = normalizeText(payload.event) || 'event';
          const diagProgress = toFiniteNumber(payload.progress, -1);
          if (diagProgress >= 0) {
            lastScaledProgress = clamp(diagProgress, 0, 1);
            lastProgressMs = now;
            lastProgressStage = `${component}:${event}`;
          }
          diagnostics?.log('stdout-diag', payload);
          return;
        }

        diagnostics?.log('stdout-json', payload);
      } catch {
        diagnostics?.log('stdout-text', { line: truncateText(line, 320) });
      }
    };

    const runWatchdogCheck = async () => {
      if (settled) return;

      const now = Date.now();
      const sinceActivityMs = now - lastActivityMs;
      const sinceProgressMs = now - lastProgressMs;
      if (sinceActivityMs < diagnostics.stallWarningMs && sinceProgressMs < diagnostics.stallWarningMs) {
        return;
      }
      if (now - watchdogLastReportedMs < diagnostics.watchdogIntervalMs) return;
      watchdogLastReportedMs = now;

      const processSnapshot = await readProcessSnapshot(child.pid ?? -1);
      const outputSnapshot = await readFileSnapshot(outputPath);
      const stage = `NeuralNote running (idle ${toSeconds(sinceActivityMs)}s, pid ${child.pid ?? '?'})`;
      reportProgress(options, stage, lastScaledProgress);

      diagnostics?.log('watchdog-stall', {
        pid: child.pid ?? null,
        elapsedSeconds: toSeconds(now - startedAtMs),
        idleSeconds: toSeconds(sinceActivityMs),
        noProgressSeconds: toSeconds(sinceProgressMs),
        lastProgressStage,
        lastScaledProgress,
        outputSnapshot,
        processSnapshot
      });
    };

    if (diagnostics?.enabled) {
      watchdogTimer = setInterval(() => {
        void runWatchdogCheck();
      }, diagnostics.watchdogIntervalMs);
      watchdogTimer.unref?.();
    }

    if (diagnostics?.enabled && diagnostics.maxRuntimeMs > 0) {
      runtimeTimer = setTimeout(() => {
        if (settled) return;
        const timeoutMessage = `NeuralNote converter exceeded diagnostic timeout (${toSeconds(
          diagnostics.maxRuntimeMs
        )}s).`;
        diagnostics?.log('timeout', {
          pid: child.pid ?? null,
          elapsedSeconds: toSeconds(Date.now() - startedAtMs),
          lastProgressStage,
          lastScaledProgress
        });
        child.kill('SIGKILL');
        finish(new Error(timeoutMessage));
      }, diagnostics.maxRuntimeMs);
      runtimeTimer.unref?.();
    }

    child.stdout.on('data', (chunk) => {
      lastActivityMs = Date.now();
      stdoutBuffer += chunk.toString('utf8');

      while (true) {
        const lineBreak = stdoutBuffer.indexOf('\n');
        if (lineBreak < 0) break;

        const line = stdoutBuffer.slice(0, lineBreak);
        stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
        flushStdoutLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      lastActivityMs = Date.now();
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      diagnostics?.log('process-error', {
        message: toErrorMessage(error)
      });
      finish(error);
    });

    child.on('close', (code) => {
      if (stdoutBuffer.trim().length > 0) {
        flushStdoutLine(stdoutBuffer);
      }
      stdoutBuffer = '';

      const elapsedMs = Date.now() - startedAtMs;
      diagnostics?.log('close', {
        code,
        elapsedSeconds: toSeconds(elapsedMs),
        stdoutLineCount,
        progressLineCount,
        stderrLength: stderr.length,
        lastProgressStage,
        lastScaledProgress
      });

      if (code === 0) {
        finish();
        return;
      }

      const message = stderr.trim() || `NeuralNote converter exited with code ${code}.`;
      finish(new Error(message));
    });
  });
}

export function createAudioToMidiConverter(config = {}) {
  const cliBinaryPath = path.resolve(
    normalizeText(config.cliBinaryPath)
      || path.resolve(process.cwd(), 'third_party/neuralnote_core/bin', resolveNeuralNoteCliBaseName())
  );
  const modelDir = path.resolve(
    normalizeText(config.modelDir) || path.resolve(process.cwd(), 'third_party/neuralnote_core/modeldata')
  );
  const modelDirLabel = normalizeText(config.modelDirLabel) || 'third_party/neuralnote_core/modeldata';
  const onnxLibDir = path.resolve(
    normalizeText(config.onnxLibDir)
      || path.resolve(process.cwd(), 'third_party/onnxruntime', resolveOnnxRuntimeSubdir(), 'lib')
  );

  const fallbackMidiBaseName = normalizeText(config.fallbackMidiBaseName) || 'upload';
  const converterDiagnosticsConfig = config?.diagnostics && typeof config.diagnostics === 'object' ? config.diagnostics : {};

  function sanitizeMidiBaseName(baseName, fallback = fallbackMidiBaseName) {
    const safe = normalizeText(baseName)
      .replace(/\.[^/.]+$/g, '')
      .replace(/[^\w.-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^\.+/, '')
      .replace(/^_+/, '')
      .replace(/[._-]+$/, '');
    return safe || fallback;
  }

  function detectUploadSourceType(fileNameOrExt) {
    const ext = getExtension(fileNameOrExt);
    if (MIDI_EXTENSIONS.has(ext)) return 'midi';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    return null;
  }

  function buildUniqueMidiFileName(baseName, existingNamesSet = new Set()) {
    const existing = new Set(
      Array.from(existingNamesSet || [])
        .map((entry) => normalizeText(entry).toLowerCase())
        .filter(Boolean)
    );

    const safeBase = sanitizeMidiBaseName(baseName);
    let candidate = `${safeBase}.mid`;
    if (!existing.has(candidate.toLowerCase())) return candidate;

    let index = 1;
    while (true) {
      candidate = `${safeBase}_${index}.mid`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
      index += 1;
    }
  }

  async function assertModelReady() {
    const requiredModelFiles = [
      'features_model.onnx',
      'cnn_contour_model.json',
      'cnn_note_model.json',
      'cnn_onset_1_model.json',
      'cnn_onset_2_model.json'
    ];

    await fs.access(cliBinaryPath);
    await Promise.all(requiredModelFiles.map((fileName) => fs.access(path.join(modelDir, fileName))));
    await fs.access(path.join(onnxLibDir, resolveOnnxRuntimeLibFileName()));

    return {
      modelDir,
      relativeModelDir: modelDirLabel,
      cliBinaryPath
    };
  }

  async function convertAudioBufferToMidiBuffer(inputBuffer, mimeOrExt = '', options = {}) {
    if (!inputBuffer || Number(inputBuffer.length || inputBuffer.byteLength || 0) <= 0) {
      throw new Error('Uploaded audio is empty.');
    }

    const sourceType = detectUploadSourceType(mimeOrExt);
    if (sourceType && sourceType !== 'audio') {
      throw new Error('Only WAV, MP3, and OGG can be converted to MIDI.');
    }

    const requestedPreset = normalizeText(options?.conversionPreset || 'balanced').toLowerCase();
    if (requestedPreset && requestedPreset !== 'balanced') {
      throw new Error("Only the 'balanced' conversion preset is supported by the NeuralNote C++ converter.");
    }
    const neuralNotePresetOverrides = normalizeNeuralNotePresetOverrides(options?.neuralnotePreset);
    const neuralNotePreset = {
      ...NEURALNOTE_CLI_PRESET_DEFAULTS,
      ...neuralNotePresetOverrides
    };
    const diagnostics = createNeuralNoteDiagnostics(
      {
        diagnostics: converterDiagnosticsConfig,
        enableDiagnostics: config?.enableDiagnostics === true
      },
      options
    );
    diagnostics.log('convert-start', {
      inputBytes: Number(inputBuffer.length || inputBuffer.byteLength || 0),
      sourceType: sourceType ?? 'audio',
      sourceExt: getExtension(mimeOrExt) || null,
      preset: requestedPreset || 'balanced',
      neuralNotePreset
    });

    await assertModelReady();
    reportProgress(options, 'Loading conversion model...', 0.04);

    const [{ default: decodeAudio }, toneMidiModule] = await Promise.all([import('audio-decode'), import('@tonejs/midi')]);

    const toneMidiExports =
      toneMidiModule?.default && typeof toneMidiModule.default === 'object' ? toneMidiModule.default : toneMidiModule;
    const Midi = toneMidiExports?.Midi;

    if (typeof Midi !== 'function') {
      throw new Error('MIDI conversion dependencies are not available.');
    }

    reportProgress(options, 'Decoding audio...', 0.16);

    const audioBuffer = await decodeAudio(Buffer.from(inputBuffer));
    const sourceSampleRate = Math.max(1, Number(audioBuffer?.sampleRate) || BASIC_PITCH_MODEL_SAMPLE_RATE);
    const monoAudio = downmixToMono(audioBuffer);
    const audioDurationSeconds = Math.max(0, monoAudio.length / sourceSampleRate);
    const resampledMonoAudio = resampleMonoSignal(monoAudio, sourceSampleRate, BASIC_PITCH_MODEL_SAMPLE_RATE);
    const normalizedMonoAudio = BALANCED_PRESET.normalizeInput
      ? normalizeMonoSignal(resampledMonoAudio, BALANCED_PRESET)
      : resampledMonoAudio;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neuralnote-converter-'));

    try {
      const inputPath = path.join(tempDir, 'input.f32');
      const outputPath = path.join(tempDir, 'events.json');

      const pcmBuffer = Buffer.from(
        normalizedMonoAudio.buffer,
        normalizedMonoAudio.byteOffset,
        normalizedMonoAudio.byteLength
      );
      await fs.writeFile(inputPath, pcmBuffer);

      reportProgress(options, 'Analyzing notes...', 0.58);

      await runNeuralNoteCli({
        cliBinaryPath,
        modelDir,
        onnxLibDir,
        inputPath,
        outputPath,
        options,
        diagnostics,
        preset: neuralNotePreset
      });

      reportProgress(options, 'Building MIDI events...', 0.92);

      const outputJson = await fs.readFile(outputPath, 'utf8');
      const noteEvents = parseCoreEvents(outputJson);
      diagnostics.log('events-parsed', {
        eventCount: noteEvents.length
      });

      if (!Array.isArray(noteEvents) || noteEvents.length === 0) {
        throw new Error('No notes detected in uploaded audio.');
      }

      const midi = new Midi();
      const midiTempoBpm = resolveMidiTempoBpm(options, BALANCED_PRESET.midiTempo);
      applyTempoMetadataToMidi(midi, {
        tempoBpm: midiTempoBpm,
        tempoMap: options?.tempoMap,
        audioDurationSeconds
      });
      const track = midi.addTrack();

      for (const event of noteEvents) {
        const time = Math.max(0, toFiniteNumber(event.startTimeSeconds, 0));
        if (time >= audioDurationSeconds) continue;
        const maxDuration = Math.max(0, audioDurationSeconds - time);
        if (maxDuration <= 0) continue;
        const duration = Math.min(Math.max(0.001, toFiniteNumber(event.durationSeconds, 0.02)), maxDuration);

        if (BALANCED_PRESET.useModelAmplitudeVelocity) {
          track.addNote({
            midi: event.pitchMidi,
            time,
            duration,
            velocity: clamp(event.amplitude, 0.01, 1)
          });
          continue;
        }

        const liftedAmplitude = Math.pow(event.amplitude, BALANCED_PRESET.amplitudeExponent);
        const baseVelocity = BALANCED_PRESET.velocityBase + liftedAmplitude * BALANCED_PRESET.velocityRange;
        const boostedVelocity = baseVelocity * BALANCED_PRESET.volumeBoost;
        const velocity = clamp(boostedVelocity, BALANCED_PRESET.velocityFloor, 1);
        track.addNote({
          midi: event.pitchMidi,
          time,
          duration,
          velocity
        });
      }

      reportProgress(options, 'Finalizing MIDI file...', 0.98);
      const midiBytes = midi.toArray();
      diagnostics.log('midi-built', {
        midiBytes: midiBytes.byteLength,
        noteCount: track.notes.length
      });
      reportProgress(options, 'Conversion complete.', 1);
      return Buffer.from(midiBytes.buffer, midiBytes.byteOffset, midiBytes.byteLength);
    } catch (error) {
      diagnostics.log('convert-failed', {
        message: toErrorMessage(error)
      });
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function convertUploadToMidi(upload, existingNamesSet = new Set(), options = {}) {
    const fileName = normalizeText(upload?.fileName);
    const mimeType = normalizeText(upload?.mimeType).toLowerCase();
    const buffer = upload?.buffer;

    if (!fileName) {
      const err = new Error('Uploaded file name is missing');
      err.statusCode = 400;
      throw err;
    }

    if (!buffer || Number(buffer.length || buffer.byteLength || 0) <= 0) {
      const err = new Error('Uploaded file is empty');
      err.statusCode = 400;
      throw err;
    }

    const sourceType = detectUploadSourceType(fileName) || detectUploadSourceType(mimeType);
    if (!sourceType) {
      const err = new Error('Unsupported file type. Use MID, MIDI, WAV, MP3, or OGG.');
      err.statusCode = 400;
      throw err;
    }

    const midiFileName = buildUniqueMidiFileName(fileName, existingNamesSet);

    if (sourceType === 'audio') {
      reportProgress(options, 'Preparing audio conversion...', 0.02);
      const midiBuffer = await convertAudioBufferToMidiBuffer(buffer, fileName || mimeType, options);
      return {
        midiFileName,
        sourceType,
        converted: true,
        midiBuffer
      };
    }

    reportProgress(options, 'Preparing MIDI file...', 0.55);
    const midiBuffer = Buffer.from(buffer);
    reportProgress(options, 'MIDI file ready.', 1);

    return {
      midiFileName,
      sourceType,
      converted: false,
      midiBuffer
    };
  }

  return {
    assertModelReady,
    detectUploadSourceType,
    buildUniqueMidiFileName,
    convertAudioBufferToMidiBuffer,
    convertUploadToMidi
  };
}
