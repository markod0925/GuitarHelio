#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);

function printUsage() {
  console.log(`Usage:
  node tools/pitch-offline-bench/generate-manifest.mjs [options]

Options:
  --notes <path>       Path to note list JSON (default: note-list-30.json)
  --out <path>         Output manifest path (default: session-manifest.json)
  --repeats <number>   How many times to repeat the full note list (default: 2)
  --count-in <seconds> Initial silence before first note (default: 2.0)
  --hold <seconds>     Note sustain duration (default: 0.65)
  --rest <seconds>     Gap between notes (default: 0.25)
  --name <text>        Optional session name override
  --help               Show this help
`);
}

function parseArgs(argv) {
  const args = {
    notes: path.join(HERE, 'note-list-30.json'),
    out: path.join(HERE, 'session-manifest.json'),
    repeats: 2,
    countIn: 2.0,
    hold: 0.65,
    rest: 0.25,
    name: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--help') {
      printUsage();
      process.exit(0);
    }
    if (key === '--notes' && val) {
      args.notes = path.resolve(val);
      i += 1;
      continue;
    }
    if (key === '--out' && val) {
      args.out = path.resolve(val);
      i += 1;
      continue;
    }
    if (key === '--repeats' && val) {
      args.repeats = Number.parseInt(val, 10);
      i += 1;
      continue;
    }
    if (key === '--count-in' && val) {
      args.countIn = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--hold' && val) {
      args.hold = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--rest' && val) {
      args.rest = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--name' && val) {
      args.name = val;
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${key}`);
  }

  if (!Number.isFinite(args.repeats) || args.repeats < 1) {
    throw new Error('--repeats must be an integer >= 1');
  }
  if (!Number.isFinite(args.countIn) || args.countIn < 0) {
    throw new Error('--count-in must be >= 0');
  }
  if (!Number.isFinite(args.hold) || args.hold <= 0) {
    throw new Error('--hold must be > 0');
  }
  if (!Number.isFinite(args.rest) || args.rest < 0) {
    throw new Error('--rest must be >= 0');
  }

  return args;
}

function roundTime(value) {
  return Math.round(value * 1e6) / 1e6;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.notes, 'utf8');
  const parsed = JSON.parse(raw);
  const notes = Array.isArray(parsed?.notes) ? parsed.notes : null;
  if (!notes || notes.length === 0) {
    throw new Error('Note list JSON must contain a non-empty "notes" array');
  }

  let t = args.countIn;
  let sequenceIndex = 0;
  const events = [];
  for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    for (const note of notes) {
      const start = t;
      const end = start + args.hold;
      sequenceIndex += 1;
      events.push({
        event_id: `r${repeat}_n${String(sequenceIndex).padStart(3, '0')}`,
        sequence_index: sequenceIndex,
        repeat_index: repeat,
        note_order: note.order,
        note: note.note,
        midi: note.midi,
        string: note.string,
        fret: note.fret,
        start_s: roundTime(start),
        end_s: roundTime(end)
      });
      t = end + args.rest;
    }
  }

  const sessionName = args.name ?? `${parsed?.name ?? 'Pitch Session'} x${args.repeats}`;
  const manifest = {
    session_name: sessionName,
    source_note_list: path.basename(args.notes),
    tuning: parsed?.tuning ?? 'Standard EADGBE',
    generated_at: new Date().toISOString(),
    setup: {
      repeats: args.repeats,
      count_in_s: args.countIn,
      hold_s: args.hold,
      rest_s: args.rest
    },
    total_events: events.length,
    expected_duration_s: roundTime(t),
    events
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Manifest generated: ${args.out}`);
  console.log(`Events: ${manifest.total_events}`);
  console.log(`Expected duration: ${manifest.expected_duration_s.toFixed(2)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
