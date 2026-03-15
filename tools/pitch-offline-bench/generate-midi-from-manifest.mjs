#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import toneMidi from '@tonejs/midi';

const { Midi } = toneMidi;

function printUsage() {
  console.log(`Usage:
  node tools/pitch-offline-bench/generate-midi-from-manifest.mjs --manifest <path> --out <path> [options]

Options:
  --manifest <path>   Session manifest JSON (required)
  --out <path>        Output MIDI path (required)
  --tempo <bpm>       MIDI tempo in BPM (default: 120)
  --velocity <0..1>   Note velocity (default: 0.85)
  --program <0..127>  Program change value (default: 26, Jazz Guitar)
  --tail <seconds>    Extra tail silence after last note (default: 1.0)
  --help              Show this help
`);
}

function parseArgs(argv) {
  const args = {
    manifest: null,
    out: null,
    tempo: 120,
    velocity: 0.85,
    program: 26,
    tail: 1.0
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--help') {
      printUsage();
      process.exit(0);
    }
    if (key === '--manifest' && val) {
      args.manifest = path.resolve(val);
      i += 1;
      continue;
    }
    if (key === '--out' && val) {
      args.out = path.resolve(val);
      i += 1;
      continue;
    }
    if (key === '--tempo' && val) {
      args.tempo = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--velocity' && val) {
      args.velocity = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--program' && val) {
      args.program = Number.parseInt(val, 10);
      i += 1;
      continue;
    }
    if (key === '--tail' && val) {
      args.tail = Number.parseFloat(val);
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${key}`);
  }

  if (!args.manifest) throw new Error('--manifest is required');
  if (!args.out) throw new Error('--out is required');
  if (!Number.isFinite(args.tempo) || args.tempo <= 0) throw new Error('--tempo must be > 0');
  if (!Number.isFinite(args.velocity) || args.velocity < 0 || args.velocity > 1) throw new Error('--velocity must be in [0,1]');
  if (!Number.isFinite(args.program) || args.program < 0 || args.program > 127) throw new Error('--program must be in [0,127]');
  if (!Number.isFinite(args.tail) || args.tail < 0) throw new Error('--tail must be >= 0');
  return args;
}

function toFinite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestRaw = await fs.readFile(args.manifest, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const events = Array.isArray(manifest?.events) ? manifest.events : null;
  if (!events || events.length === 0) {
    throw new Error('Manifest must contain a non-empty "events" array');
  }

  const midi = new Midi();
  midi.header.setTempo(args.tempo);
  const track = midi.addTrack();
  track.instrument.number = args.program;

  let maxEnd = 0;
  for (const event of events) {
    const midiPitch = Math.max(0, Math.min(127, Math.round(toFinite(event.midi, 60))));
    const start = Math.max(0, toFinite(event.start_s, 0));
    const end = Math.max(start + 0.001, toFinite(event.end_s, start + 0.5));
    const duration = Math.max(0.001, end - start);
    maxEnd = Math.max(maxEnd, end);
    track.addNote({
      midi: midiPitch,
      time: start,
      duration,
      velocity: args.velocity
    });
  }

  if (args.tail > 0) {
    const silentTime = maxEnd + args.tail;
    track.addNote({
      midi: 0,
      time: silentTime,
      duration: 0.001,
      velocity: 0
    });
    track.notes.pop();
  }

  const bytes = midi.toArray();
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  console.log(`MIDI written: ${args.out}`);
  console.log(`Notes: ${events.length}`);
  console.log(`Tempo: ${args.tempo} BPM`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
