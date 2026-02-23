#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAudioToMidiConverter } from '../src/index.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--input' && next) {
      args.input = next;
      i += 1;
    } else if (token === '--output' && next) {
      args.output = next;
      i += 1;
    } else if (token === '--model-dir' && next) {
      args.modelDir = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const { input, output, modelDir } = parseArgs(process.argv.slice(2));
  if (!input || !output || !modelDir) {
    throw new Error('Usage: convert-audio-to-midi --input <track.wav|mp3> --output <track.mid> --model-dir <basic-pitch-dir>');
  }

  const converter = createAudioToMidiConverter({
    modelDir: path.resolve(modelDir),
    modelDirLabel: modelDir
  });

  const sourceBuffer = await fs.readFile(path.resolve(input));
  const midiBuffer = await converter.convertAudioBufferToMidiBuffer(sourceBuffer, path.extname(input), {
    onProgress: ({ stage, progress }) => {
      const percent = Math.round(progress * 100);
      process.stdout.write(`[${percent}%] ${stage}\n`);
    }
  });

  await fs.writeFile(path.resolve(output), midiBuffer);
  process.stdout.write(`Saved MIDI to ${path.resolve(output)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || String(err)}\n`);
  process.exitCode = 1;
});
