import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parseMidi } from './midi-utils.mjs';

const midiArg = process.argv[2];
if (!midiArg) {
  console.error('Usage: npm run midi:cli -- <path/to/file.mid>');
  process.exit(1);
}

const midiPath = path.resolve(process.cwd(), midiArg);
const raw = await readFile(midiPath);
const parsed = parseMidi(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

const events = parsed.notes.flatMap((note) => {
  const label = `track=${note.trackIndex} ch=${note.channel + 1} midi=${note.midi} velocity=${note.velocity.toFixed(2)}`;
  return [
    { timeMs: Math.round(note.timeOn * 1000), type: 'ON', label },
    { timeMs: Math.round((note.timeOn + note.duration) * 1000), type: 'OFF', label }
  ];
});

events.sort((a, b) => a.timeMs - b.timeMs || (a.type === 'OFF' ? 1 : -1));

const totalDurationMs = Math.ceil(parsed.durationSeconds * 1000);

let eventIndex = 0;
let paused = true;
let timelineMs = 0;
let timer = null;

function updateEventIndexFromTimeline() {
  eventIndex = events.findIndex((event) => event.timeMs >= timelineMs);
  if (eventIndex === -1) {
    eventIndex = events.length;
  }
}

function printStatus() {
  const next = events[eventIndex];
  const state = paused ? 'PAUSED' : 'PLAYING';
  const nextInfo = next
    ? `next=${next.type}@${(next.timeMs / 1000).toFixed(2)}s ${next.label}`
    : 'next=<end>';
  console.log(`[${state}] t=${(timelineMs / 1000).toFixed(2)}s / ${(totalDurationMs / 1000).toFixed(2)}s | ${nextInfo}`);
}

function stopPlayback() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startPlayback() {
  if (!paused || timelineMs >= totalDurationMs) {
    return;
  }
  paused = false;
  const startedAt = Date.now() - timelineMs;

  timer = setInterval(() => {
    timelineMs = Date.now() - startedAt;

    while (eventIndex < events.length && events[eventIndex].timeMs <= timelineMs) {
      const event = events[eventIndex];
      console.log(`${(event.timeMs / 1000).toFixed(2).padStart(8, ' ')}s  ${event.type.padEnd(3, ' ')}  ${event.label}`);
      eventIndex += 1;
    }

    if (timelineMs >= totalDurationMs) {
      timelineMs = totalDurationMs;
      paused = true;
      stopPlayback();
      printStatus();
      console.log('Reached end of MIDI. Use "seek <seconds>" then "play" to replay.');
    }
  }, 20);
}

function seek(seconds) {
  const clampedMs = Math.max(0, Math.min(totalDurationMs, Math.floor(seconds * 1000)));
  timelineMs = clampedMs;
  updateEventIndexFromTimeline();
}

console.log(`Loaded MIDI: ${midiPath}`);
console.log(`Format: ${parsed.formatType} | Tracks: ${parsed.trackCount} | PPQ: ${parsed.ppq}`);
console.log(`Notes: ${parsed.notes.length}`);
console.log('Commands: play | pause | seek <seconds> | status | help | quit');
printStatus();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'midi> '
});

rl.prompt();
rl.on('line', (line) => {
  const input = line.trim();
  const [command, value] = input.split(/\s+/, 2);

  if (command === 'play') {
    if (!paused) {
      console.log('Already playing.');
    } else {
      startPlayback();
      printStatus();
    }
  } else if (command === 'pause') {
    if (paused) {
      console.log('Already paused.');
    } else {
      paused = true;
      stopPlayback();
      printStatus();
    }
  } else if (command === 'seek') {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) {
      console.log('Usage: seek <seconds>');
    } else {
      seek(seconds);
      if (!paused) {
        paused = true;
        stopPlayback();
      }
      printStatus();
    }
  } else if (command === 'status') {
    printStatus();
  } else if (command === 'help') {
    console.log('Commands: play | pause | seek <seconds> | status | help | quit');
  } else if (command === 'quit' || command === 'exit') {
    paused = true;
    stopPlayback();
    rl.close();
    return;
  } else if (input.length === 0) {
    // no-op
  } else {
    console.log(`Unknown command: ${input}`);
  }

  rl.prompt();
});

rl.on('close', () => {
  stopPlayback();
  process.exit(0);
});
