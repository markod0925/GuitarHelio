#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import toneMidi from '@tonejs/midi';

const { Midi } = toneMidi;

function printUsage() {
  console.log(`Usage:
  node tools/pitch-offline-bench/render-midi-to-wav.mjs --midi <path> --out <path> [options]

Options:
  --midi <path>        Input MIDI file (required)
  --out <path>         Output WAV file (required)
  --sample-rate <hz>   Sample rate (default: 44100)
  --tail <seconds>     Extra silence tail (default: 1.0)
  --gain <0..1>        Global gain before limiter (default: 0.85)
  --help               Show this help
`);
}

function parseArgs(argv) {
  const args = {
    midi: null,
    out: null,
    sampleRate: 44100,
    tail: 1.0,
    gain: 0.85
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--help') {
      printUsage();
      process.exit(0);
    }
    if (key === '--midi' && val) {
      args.midi = path.resolve(val);
      i += 1;
      continue;
    }
    if (key === '--out' && val) {
      args.out = path.resolve(val);
      i += 1;
      continue;
    }
    if (key === '--sample-rate' && val) {
      args.sampleRate = Number.parseInt(val, 10);
      i += 1;
      continue;
    }
    if (key === '--tail' && val) {
      args.tail = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--gain' && val) {
      args.gain = Number.parseFloat(val);
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${key}`);
  }

  if (!args.midi) throw new Error('--midi is required');
  if (!args.out) throw new Error('--out is required');
  if (!Number.isFinite(args.sampleRate) || args.sampleRate < 8000) throw new Error('--sample-rate must be >= 8000');
  if (!Number.isFinite(args.tail) || args.tail < 0) throw new Error('--tail must be >= 0');
  if (!Number.isFinite(args.gain) || args.gain <= 0 || args.gain > 1) throw new Error('--gain must be in (0,1]');
  return args;
}

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function envelopeAt(t, duration) {
  const attack = 0.01;
  const decay = 0.06;
  const sustain = 0.65;
  const release = 0.08;
  const hold = Math.max(0, duration - attack - decay - release);

  if (t < 0 || t > duration) return 0;
  if (t <= attack) return t / attack;
  const t2 = t - attack;
  if (t2 <= decay) {
    const x = t2 / decay;
    return 1 - x * (1 - sustain);
  }
  const t3 = t2 - decay;
  if (t3 <= hold) return sustain;
  const t4 = t3 - hold;
  if (t4 <= release) {
    return sustain * (1 - t4 / release);
  }
  return 0;
}

function writeWav16Mono(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const s = clamp(samples[i], -1, 1);
    const v = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    buffer.writeInt16LE(v, 44 + i * 2);
  }

  return buffer;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const midiBytes = await fs.readFile(args.midi);
  const midi = new Midi(midiBytes);

  const notes = [];
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      notes.push({
        midi: note.midi,
        time: note.time,
        duration: note.duration,
        velocity: note.velocity
      });
    }
  }
  if (notes.length === 0) {
    throw new Error('No notes found in MIDI');
  }

  let totalDuration = 0;
  for (const note of notes) {
    totalDuration = Math.max(totalDuration, note.time + note.duration);
  }
  totalDuration += args.tail;

  const totalSamples = Math.max(1, Math.ceil(totalDuration * args.sampleRate));
  const pcm = new Float32Array(totalSamples);

  for (const note of notes) {
    const frequency = midiToHz(note.midi);
    const velocity = clamp(note.velocity, 0.01, 1);
    const startIndex = Math.max(0, Math.floor(note.time * args.sampleRate));
    const endIndex = Math.min(totalSamples, Math.ceil((note.time + note.duration + 0.1) * args.sampleRate));
    let phase = 0;
    const phaseStep = (2 * Math.PI * frequency) / args.sampleRate;

    for (let i = startIndex; i < endIndex; i += 1) {
      const t = i / args.sampleRate - note.time;
      const env = envelopeAt(t, note.duration);
      if (env <= 0) continue;

      const harmonic =
        Math.sin(phase) * 0.65 +
        Math.sin(phase * 2) * 0.25 +
        Math.sin(phase * 3) * 0.1;
      pcm[i] += harmonic * env * velocity * args.gain;
      phase += phaseStep;
    }
  }

  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    peak = Math.max(peak, Math.abs(pcm[i]));
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let i = 0; i < pcm.length; i += 1) {
      pcm[i] *= scale;
    }
  }

  const wavBuffer = writeWav16Mono(pcm, args.sampleRate);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, wavBuffer);

  console.log(`WAV written: ${args.out}`);
  console.log(`Duration: ${totalDuration.toFixed(2)}s`);
  console.log(`Notes rendered: ${notes.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
