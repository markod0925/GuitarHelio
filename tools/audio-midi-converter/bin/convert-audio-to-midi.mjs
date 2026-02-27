#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAudioToMidiConverter as createNeuralNoteConverter } from '../src/neuralnote.mjs';

function parseBooleanFlag(rawValue, flagName) {
  const normalized = String(rawValue ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`Invalid value for ${flagName}. Use true/false (or 1/0).`);
}

function parseNumberFlag(rawValue, flagName) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${flagName}. Expected a number.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    mode: 'legacy'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--input' && next) {
      args.input = next;
      i += 1;
    } else if (token === '--output' && next) {
      args.output = next;
      i += 1;
    } else if (token === '--mode' && next) {
      args.mode = next.toLowerCase();
      i += 1;
    } else if (token === '--model-dir' && next) {
      args.modelDir = next;
      i += 1;
    } else if (token === '--cli-bin' && next) {
      args.cliBin = next;
      i += 1;
    } else if (token === '--onnx-lib-dir' && next) {
      args.onnxLibDir = next;
      i += 1;
    } else if (token === '--diag') {
      args.diag = true;
    } else if (token === '--diag-watchdog-ms' && next) {
      args.diagWatchdogMs = Number(next);
      i += 1;
    } else if (token === '--diag-stall-ms' && next) {
      args.diagStallMs = Number(next);
      i += 1;
    } else if (token === '--diag-timeout-ms' && next) {
      args.diagTimeoutMs = Number(next);
      i += 1;
    } else if (token === '--nn-note-sensitivity' && next) {
      args.nnNoteSensitivity = parseNumberFlag(next, '--nn-note-sensitivity');
      i += 1;
    } else if (token === '--nn-model-confidence-threshold' && next) {
      args.nnModelConfidenceThreshold = parseNumberFlag(next, '--nn-model-confidence-threshold');
      i += 1;
    } else if (token === '--nn-split-sensitivity' && next) {
      args.nnSplitSensitivity = parseNumberFlag(next, '--nn-split-sensitivity');
      i += 1;
    } else if (token === '--nn-note-segmentation-threshold' && next) {
      args.nnNoteSegmentationThreshold = parseNumberFlag(next, '--nn-note-segmentation-threshold');
      i += 1;
    } else if (token === '--nn-min-note-ms' && next) {
      args.nnMinNoteMs = parseNumberFlag(next, '--nn-min-note-ms');
      i += 1;
    } else if (token === '--nn-melodia-trick' && next) {
      args.nnMelodiaTrick = parseBooleanFlag(next, '--nn-melodia-trick');
      i += 1;
    } else if (token === '--nn-min-pitch-hz' && next) {
      args.nnMinPitchHz = parseNumberFlag(next, '--nn-min-pitch-hz');
      i += 1;
    } else if (token === '--nn-max-pitch-hz' && next) {
      args.nnMaxPitchHz = parseNumberFlag(next, '--nn-max-pitch-hz');
      i += 1;
    } else if (token === '--nn-energy-tolerance' && next) {
      args.nnEnergyTolerance = parseNumberFlag(next, '--nn-energy-tolerance');
      i += 1;
    }
  }
  return args;
}

function validateMode(rawMode) {
  if (rawMode === 'legacy' || rawMode === 'neuralnote') return rawMode;
  throw new Error(`Unsupported mode "${rawMode}". Use "legacy" or "neuralnote".`);
}

function buildConverter(mode, args) {
  if (mode !== 'legacy' && mode !== 'neuralnote') {
    throw new Error(`Unsupported mode "${mode}". Use "legacy" or "neuralnote".`);
  }

  return createNeuralNoteConverter({
    modelDir: args.modelDir ? path.resolve(args.modelDir) : path.resolve(process.cwd(), 'third_party/neuralnote_core/modeldata'),
    modelDirLabel: args.modelDir || 'third_party/neuralnote_core/modeldata',
    cliBinaryPath: args.cliBin ? path.resolve(args.cliBin) : path.resolve(process.cwd(), 'third_party/neuralnote_core/bin/nn_transcriber_cli'),
    onnxLibDir: args.onnxLibDir
      ? path.resolve(args.onnxLibDir)
      : path.resolve(process.cwd(), 'third_party/onnxruntime/linux-x64/lib')
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = validateMode(args.mode);
  if (!args.input || !args.output) {
    throw new Error(
      'Usage: convert-audio-to-midi --input <track.wav|mp3|ogg> --output <track.mid> [--mode legacy|neuralnote] [--model-dir <path>] [--cli-bin <path>] [--onnx-lib-dir <path>] [--diag] [--diag-watchdog-ms <ms>] [--diag-stall-ms <ms>] [--diag-timeout-ms <ms>] [--nn-note-sensitivity <0..1>] [--nn-model-confidence-threshold <0..1>] [--nn-split-sensitivity <0..1>] [--nn-note-segmentation-threshold <0..1>] [--nn-min-note-ms <ms>] [--nn-melodia-trick <true|false>] [--nn-min-pitch-hz <hz>] [--nn-max-pitch-hz <hz>] [--nn-energy-tolerance <int>] (legacy/neuralnote are aliases to C++/ONNX backend)'
    );
  }

  const converter = buildConverter(mode, args);
  const diagnosticsEnabled = args.diag || process.env.GH_NEURALNOTE_DIAGNOSTICS === '1';
  const diagnostics = diagnosticsEnabled
    ? {
        enabled: true,
        ...(Number.isFinite(args.diagWatchdogMs) ? { watchdogIntervalMs: Math.max(1000, Math.round(args.diagWatchdogMs)) } : {}),
        ...(Number.isFinite(args.diagStallMs) ? { stallWarningMs: Math.max(1000, Math.round(args.diagStallMs)) } : {}),
        ...(Number.isFinite(args.diagTimeoutMs) ? { maxRuntimeMs: Math.max(1000, Math.round(args.diagTimeoutMs)) } : {}),
        logger: (event, payload) => {
          process.stderr.write(`[diag:${event}] ${JSON.stringify(payload)}\n`);
        }
      }
    : undefined;

  const neuralnotePreset = {
    ...(Number.isFinite(args.nnNoteSensitivity) ? { noteSensitivity: args.nnNoteSensitivity } : {}),
    ...(Number.isFinite(args.nnModelConfidenceThreshold)
      ? { modelConfidenceThreshold: args.nnModelConfidenceThreshold }
      : {}),
    ...(Number.isFinite(args.nnSplitSensitivity) ? { splitSensitivity: args.nnSplitSensitivity } : {}),
    ...(Number.isFinite(args.nnNoteSegmentationThreshold)
      ? { noteSegmentationThreshold: args.nnNoteSegmentationThreshold }
      : {}),
    ...(Number.isFinite(args.nnMinNoteMs) ? { minNoteDurationMs: args.nnMinNoteMs } : {}),
    ...(typeof args.nnMelodiaTrick === 'boolean' ? { melodiaTrick: args.nnMelodiaTrick } : {}),
    ...(Number.isFinite(args.nnMinPitchHz) ? { minPitchHz: args.nnMinPitchHz } : {}),
    ...(Number.isFinite(args.nnMaxPitchHz) ? { maxPitchHz: args.nnMaxPitchHz } : {}),
    ...(Number.isFinite(args.nnEnergyTolerance) ? { energyTolerance: args.nnEnergyTolerance } : {})
  };

  const sourceBuffer = await fs.readFile(path.resolve(args.input));
  const midiBuffer = await converter.convertAudioBufferToMidiBuffer(sourceBuffer, path.extname(args.input), {
    conversionPreset: 'balanced',
    ...(Object.keys(neuralnotePreset).length > 0 ? { neuralnotePreset } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    onProgress: ({ stage, progress }) => {
      const percent = Math.round((Number(progress) || 0) * 100);
      process.stdout.write(`[${percent}%] ${stage}\n`);
    }
  });

  await fs.writeFile(path.resolve(args.output), midiBuffer);
  process.stdout.write(`Saved MIDI to ${path.resolve(args.output)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || String(err)}\n`);
  process.exitCode = 1;
});
