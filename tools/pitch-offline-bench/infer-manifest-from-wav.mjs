#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import decodeAudio from 'audio-decode';

const HERE = path.dirname(new URL(import.meta.url).pathname);

function printUsage() {
  console.log(`Usage:
  node tools/pitch-offline-bench/infer-manifest-from-wav.mjs --wav <take.wav> --notes <note-list.json> --out <manifest.json> [options]

Options:
  --wav <path>            Input WAV path (required)
  --notes <path>          Note list JSON path (default: note-list-30.json)
  --out <path>            Output manifest path (required)
  --repeats <n>           Expected repeats of the note list (optional, inferred if omitted)
  --frame-ms <ms>         RMS frame size in ms (default: 30)
  --hop-ms <ms>           RMS hop size in ms (default: 10)
  --threshold-ratio <0..1> Energy threshold ratio over dynamic range (default: 0.22)
  --release-ratio <0..1>  Release threshold ratio over dynamic range (default: 0.16)
  --min-note-ms <ms>      Minimum detected note duration (default: 180)
  --min-gap-ms <ms>       Minimum silence gap between notes (default: 80)
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const args = {
    wav: null,
    notes: path.join(HERE, 'note-list-30.json'),
    out: null,
    repeats: null,
    frameMs: 30,
    hopMs: 10,
    thresholdRatio: 0.22,
    releaseRatio: 0.16,
    minNoteMs: 180,
    minGapMs: 80
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--help') {
      printUsage();
      process.exit(0);
    }
    if (key === '--wav' && val) {
      args.wav = path.resolve(val);
      i += 1;
      continue;
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
    if (key === '--frame-ms' && val) {
      args.frameMs = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--hop-ms' && val) {
      args.hopMs = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--threshold-ratio' && val) {
      args.thresholdRatio = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--release-ratio' && val) {
      args.releaseRatio = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--min-note-ms' && val) {
      args.minNoteMs = Number.parseFloat(val);
      i += 1;
      continue;
    }
    if (key === '--min-gap-ms' && val) {
      args.minGapMs = Number.parseFloat(val);
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${key}`);
  }

  if (!args.wav) throw new Error('--wav is required');
  if (!args.out) throw new Error('--out is required');
  if (!Number.isFinite(args.frameMs) || args.frameMs <= 0) throw new Error('--frame-ms must be > 0');
  if (!Number.isFinite(args.hopMs) || args.hopMs <= 0) throw new Error('--hop-ms must be > 0');
  if (!Number.isFinite(args.thresholdRatio) || args.thresholdRatio < 0 || args.thresholdRatio > 1) {
    throw new Error('--threshold-ratio must be in [0,1]');
  }
  if (!Number.isFinite(args.releaseRatio) || args.releaseRatio < 0 || args.releaseRatio > 1) {
    throw new Error('--release-ratio must be in [0,1]');
  }
  if (!Number.isFinite(args.minNoteMs) || args.minNoteMs <= 0) throw new Error('--min-note-ms must be > 0');
  if (!Number.isFinite(args.minGapMs) || args.minGapMs < 0) throw new Error('--min-gap-ms must be >= 0');
  if (args.repeats !== null && (!Number.isFinite(args.repeats) || args.repeats < 1)) {
    throw new Error('--repeats must be >= 1');
  }
  return args;
}

function computeRms(samples) {
  if (!samples.length) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

function smooth(values, radius) {
  if (radius <= 0) return values.slice();
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i += 1) {
    let acc = 0;
    let count = 0;
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    for (let j = start; j <= end; j += 1) {
      acc += values[j];
      count += 1;
    }
    out[i] = count > 0 ? acc / count : 0;
  }
  return out;
}

function detectEnergyRegions(envelope, hopSeconds, thresholdOn, thresholdOff) {
  const regions = [];
  let active = false;
  let regionStartFrame = 0;
  let peak = 0;
  let area = 0;

  for (let i = 0; i < envelope.length; i += 1) {
    const value = envelope[i];
    if (!active && value >= thresholdOn) {
      active = true;
      regionStartFrame = i;
      peak = value;
      area = value;
      continue;
    }
    if (active) {
      peak = Math.max(peak, value);
      area += value;
      if (value <= thresholdOff) {
        regions.push({
          start_s: regionStartFrame * hopSeconds,
          end_s: (i + 1) * hopSeconds,
          peak,
          area
        });
        active = false;
      }
    }
  }

  if (active) {
    regions.push({
      start_s: regionStartFrame * hopSeconds,
      end_s: envelope.length * hopSeconds,
      peak,
      area
    });
  }
  return regions;
}

function mergeCloseRegions(regions, minGapSeconds) {
  if (regions.length <= 1) return regions.slice();
  const merged = [regions[0]];
  for (let i = 1; i < regions.length; i += 1) {
    const prev = merged[merged.length - 1];
    const current = regions[i];
    if (current.start_s - prev.end_s <= minGapSeconds) {
      prev.end_s = Math.max(prev.end_s, current.end_s);
      prev.peak = Math.max(prev.peak, current.peak);
      prev.area += current.area;
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function dropShortRegions(regions, minDurationSeconds) {
  return regions.filter((region) => region.end_s - region.start_s >= minDurationSeconds);
}

function compressRegionsToCount(regions, expectedCount) {
  const out = regions.map((region) => ({ ...region }));
  if (out.length <= expectedCount) return out;

  while (out.length > expectedCount) {
    let bestIndex = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i += 1) {
      const gap = out[i + 1].start_s - out[i].end_s;
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    const left = out[bestIndex];
    const right = out[bestIndex + 1];
    const merged = {
      start_s: left.start_s,
      end_s: right.end_s,
      peak: Math.max(left.peak, right.peak),
      area: left.area + right.area
    };
    out.splice(bestIndex, 2, merged);
  }
  return out;
}

function roundTime(value) {
  return Math.round(value * 1e6) / 1e6;
}

async function decodeWavMono(wavPath) {
  const encoded = await fs.readFile(wavPath);
  const audio = await decodeAudio(encoded);
  const mono = new Float32Array(audio.length);
  for (let ch = 0; ch < audio.numberOfChannels; ch += 1) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / audio.numberOfChannels;
    }
  }
  return {
    samples: mono,
    sampleRate: audio.sampleRate,
    durationSeconds: mono.length / audio.sampleRate
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [{ samples, sampleRate, durationSeconds }, notesRaw] = await Promise.all([
    decodeWavMono(args.wav),
    fs.readFile(args.notes, 'utf8')
  ]);
  const noteList = JSON.parse(notesRaw);
  const notes = Array.isArray(noteList?.notes) ? noteList.notes : null;
  if (!notes || notes.length === 0) {
    throw new Error('Note list JSON must contain a non-empty "notes" array');
  }

  const frameSize = Math.max(16, Math.floor((args.frameMs / 1000) * sampleRate));
  const hopSize = Math.max(8, Math.floor((args.hopMs / 1000) * sampleRate));
  const hopSeconds = hopSize / sampleRate;

  const envelopeRaw = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    envelopeRaw.push(computeRms(samples.subarray(start, start + frameSize)));
  }
  const envelope = smooth(envelopeRaw, 2);
  const noiseFloor = percentile(envelope, 0.2);
  const p95 = percentile(envelope, 0.95);
  const dynamicRange = Math.max(1e-8, p95 - noiseFloor);
  const thresholdOn = noiseFloor + args.thresholdRatio * dynamicRange;
  const thresholdOff = noiseFloor + args.releaseRatio * dynamicRange;

  let regions = detectEnergyRegions(envelope, hopSeconds, thresholdOn, thresholdOff);
  regions = mergeCloseRegions(regions, args.minGapMs / 1000);
  regions = dropShortRegions(regions, args.minNoteMs / 1000);
  regions.sort((a, b) => a.start_s - b.start_s);

  if (regions.length === 0) {
    throw new Error('No note-like energy regions detected. Try lower threshold-ratio or lower min-note-ms.');
  }

  const notesPerCycle = notes.length;
  const inferredRepeats = Math.max(1, Math.floor(regions.length / notesPerCycle));
  const repeats = args.repeats ?? inferredRepeats;
  const expectedEvents = repeats * notesPerCycle;
  if (regions.length < expectedEvents) {
    throw new Error(
      `Detected ${regions.length} note regions, but expected at least ${expectedEvents}. ` +
        `Try lower --threshold-ratio / --min-note-ms, or pass --repeats 1 if you recorded one pass.`
    );
  }
  if (regions.length > expectedEvents) {
    regions = compressRegionsToCount(regions, expectedEvents);
  }

  const events = [];
  for (let i = 0; i < expectedEvents; i += 1) {
    const region = regions[i];
    const note = notes[i % notesPerCycle];
    const repeatIndex = Math.floor(i / notesPerCycle) + 1;
    events.push({
      event_id: `r${repeatIndex}_n${String(i + 1).padStart(3, '0')}`,
      sequence_index: i + 1,
      repeat_index: repeatIndex,
      note_order: note.order,
      note: note.note,
      midi: note.midi,
      string: note.string,
      fret: note.fret,
      start_s: roundTime(region.start_s),
      end_s: roundTime(region.end_s)
    });
  }

  const gaps = [];
  const durations = [];
  for (let i = 0; i < events.length; i += 1) {
    durations.push(events[i].end_s - events[i].start_s);
    if (i > 0) {
      gaps.push(Math.max(0, events[i].start_s - events[i - 1].end_s));
    }
  }
  const avgHold = durations.reduce((acc, value) => acc + value, 0) / Math.max(1, durations.length);
  const avgRest = gaps.reduce((acc, value) => acc + value, 0) / Math.max(1, gaps.length);

  const manifest = {
    session_name: `${noteList?.name ?? 'Pitch Session'} x${repeats} (energy-inferred)`,
    source_note_list: path.basename(args.notes),
    source_wav: path.basename(args.wav),
    tuning: noteList?.tuning ?? 'Standard EADGBE',
    generated_at: new Date().toISOString(),
    generated_by: 'infer-manifest-from-wav.mjs',
    setup: {
      repeats,
      count_in_s: roundTime(events[0].start_s),
      hold_s: roundTime(avgHold),
      rest_s: roundTime(avgRest)
    },
    detection: {
      sample_rate: sampleRate,
      duration_s: roundTime(durationSeconds),
      frame_ms: args.frameMs,
      hop_ms: args.hopMs,
      threshold_ratio: args.thresholdRatio,
      release_ratio: args.releaseRatio,
      threshold_on: thresholdOn,
      threshold_off: thresholdOff,
      min_note_ms: args.minNoteMs,
      min_gap_ms: args.minGapMs,
      detected_regions: regions.length
    },
    total_events: events.length,
    expected_duration_s: roundTime(events[events.length - 1].end_s),
    events
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`Manifest inferred: ${args.out}`);
  console.log(`Detected regions: ${regions.length}`);
  console.log(`Events mapped: ${events.length}`);
  console.log(`Inferred repeats: ${repeats}`);
  console.log(`Average hold/rest: ${manifest.setup.hold_s}s / ${manifest.setup.rest_s}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
