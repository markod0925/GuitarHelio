import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_MANIFEST = 'public/songs/manifest.json';
const DEFAULT_REPEAT = 20;
const OUTPUT_PATH = '/tmp/guitarhelio-startup-benchmark.json';

/** @typedef {'current'|'optimized'|'both'} Mode */

/** @typedef {{ id: string, name: string, folder: string, midi?: string, file?: string, audio?: string, cover?: string, highScore?: number }} SongManifestEntry */
/** @typedef {{ id: string, name: string, folder: string, midi: string, audio: string, cover: string, usesMidiFallback: boolean }} SongRuntimeEntry */

/** @typedef {{ manifest_fetch_parse_ms:number, catalog_normalize_ms:number, asset_validation_ms:number, cover_queue_prepare_ms:number, total_ms:number }} StageMetrics */

const args = parseArgs(process.argv.slice(2));
const rootDir = process.cwd();
const manifestPath = path.resolve(rootDir, args.manifestPath);
const modes = args.mode === 'both' ? ['current', 'optimized'] : [args.mode];

const runResults = [];
for (const mode of modes) {
  const samples = [];
  for (let i = 0; i < args.repeat; i += 1) {
    samples.push(await runSingleBenchmark(manifestPath, mode));
  }
  runResults.push({
    mode,
    stages: summarizeStageSamples(samples)
  });
}

const payload = {
  dataset: manifestPath,
  repeat: args.repeat,
  mode: args.mode,
  stages: runResults,
  summary: summarizeOverall(runResults)
};

await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
printResultsTable(payload, OUTPUT_PATH);

async function runSingleBenchmark(manifestPath, mode) {
  const t0 = performance.now();
  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(manifestRaw);
  const t1 = performance.now();

  const normalized = normalizeSongs(parsed);
  const t2 = performance.now();

  if (mode === 'current') {
    await validateAllAssets(normalized, manifestPath);
  }
  const t3 = performance.now();

  prepareCoverQueue(normalized);
  const t4 = performance.now();

  return {
    manifest_fetch_parse_ms: t1 - t0,
    catalog_normalize_ms: t2 - t1,
    asset_validation_ms: t3 - t2,
    cover_queue_prepare_ms: t4 - t3,
    total_ms: t4 - t0
  };
}

function normalizeSongs(value) {
  const songsRaw = value && typeof value === 'object' && Array.isArray(value.songs) ? value.songs : [];
  /** @type {SongRuntimeEntry[]} */
  const normalized = [];

  for (const song of songsRaw) {
    if (!song || typeof song !== 'object') continue;
    const entry = /** @type {SongManifestEntry} */ (song);
    const id = asNonEmpty(entry.id);
    const name = asNonEmpty(entry.name);
    const folder = normalizeFolder(asNonEmpty(entry.folder) ?? id);
    const midiField = asNonEmpty(entry.midi) ?? asNonEmpty(entry.file);
    if (!id || !name || !folder || !midiField) continue;

    const midi = toSongAssetPath(folder, midiField);
    const coverField = asNonEmpty(entry.cover);
    const audioField = asNonEmpty(entry.audio);
    const cover = coverField ? toSongAssetPath(folder, coverField) : '/ui/song-cover-placeholder-neon.png';
    const audio = audioField ? toSongAssetPath(folder, audioField) : midi;

    normalized.push({
      id,
      name,
      folder,
      midi,
      audio,
      cover,
      usesMidiFallback: !audioField
    });
  }

  return normalized;
}

async function validateAllAssets(songs, manifestPath) {
  const projectRoot = path.dirname(path.dirname(manifestPath));
  for (const song of songs) {
    await statIfExists(urlToFilePath(projectRoot, song.midi));
    if (!song.usesMidiFallback) {
      await statIfExists(urlToFilePath(projectRoot, song.audio));
    }
    if (song.cover !== '/ui/song-cover-placeholder-neon.png') {
      await statIfExists(urlToFilePath(projectRoot, song.cover));
    }
  }
}

function prepareCoverQueue(songs) {
  const coverCandidates = songs.filter((song) => song.cover !== '/ui/song-cover-placeholder-neon.png');
  const visible = coverCandidates.slice(0, 6).map((song) => song.id);
  const visibleSet = new Set(visible);
  return [
    ...coverCandidates.filter((song) => visibleSet.has(song.id)),
    ...coverCandidates.filter((song) => !visibleSet.has(song.id))
  ];
}

function urlToFilePath(projectRoot, urlPath) {
  if (urlPath.startsWith('/songs/')) {
    return path.join(projectRoot, 'public', decodeURIComponent(urlPath.slice(1)));
  }
  if (urlPath.startsWith('/ui/')) {
    return path.join(projectRoot, 'public', decodeURIComponent(urlPath.slice(1)));
  }
  return path.join(projectRoot, decodeURIComponent(urlPath));
}

async function statIfExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarizeStageSamples(samples) {
  return {
    manifest_fetch_parse_ms: summarizeNumbers(samples.map((sample) => sample.manifest_fetch_parse_ms)),
    catalog_normalize_ms: summarizeNumbers(samples.map((sample) => sample.catalog_normalize_ms)),
    asset_validation_ms: summarizeNumbers(samples.map((sample) => sample.asset_validation_ms)),
    cover_queue_prepare_ms: summarizeNumbers(samples.map((sample) => sample.cover_queue_prepare_ms)),
    total_ms: summarizeNumbers(samples.map((sample) => sample.total_ms))
  };
}

function summarizeOverall(results) {
  const summary = {};
  for (const result of results) {
    summary[result.mode] = {
      total_ms_avg: result.stages.total_ms.avg,
      total_ms_p50: result.stages.total_ms.p50,
      total_ms_p95: result.stages.total_ms.p95
    };
  }

  if (summary.current && summary.optimized) {
    const delta = summary.current.total_ms_avg - summary.optimized.total_ms_avg;
    summary.delta_ms_avg = delta;
    summary.delta_percent_avg = summary.current.total_ms_avg > 0 ? (delta / summary.current.total_ms_avg) * 100 : 0;
  }

  return summary;
}

function summarizeNumbers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return {
    avg,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function parseArgs(args) {
  /** @type {{ mode: Mode, repeat: number, manifestPath: string }} */
  const output = {
    mode: 'both',
    repeat: DEFAULT_REPEAT,
    manifestPath: DEFAULT_MANIFEST
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--mode') {
      const value = args[i + 1];
      if (value === 'current' || value === 'optimized' || value === 'both') {
        output.mode = value;
        i += 1;
      }
      continue;
    }
    if (arg === '--repeat') {
      const value = Number(args[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        output.repeat = Math.round(value);
        i += 1;
      }
      continue;
    }
    if (arg === '--manifest') {
      const value = args[i + 1];
      if (value && value.trim()) {
        output.manifestPath = value.trim();
        i += 1;
      }
    }
  }

  return output;
}

function normalizeFolder(value) {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

function toSongAssetPath(folder, fileName) {
  const normalizedFile = fileName.replace(/^\.?\//, '');
  return `/songs/${encodePathSegments(folder)}/${encodePathSegments(normalizedFile)}`;
}

function encodePathSegments(value) {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function asNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function printResultsTable(payload, outputPath) {
  console.log(`Startup benchmark dataset: ${payload.dataset}`);
  console.log(`Repeat: ${payload.repeat} | Mode: ${payload.mode}`);
  console.log('');
  for (const result of payload.stages) {
    const total = result.stages.total_ms;
    console.log(
      `[${result.mode}] total avg=${formatMs(total.avg)} p50=${formatMs(total.p50)} p95=${formatMs(total.p95)} max=${formatMs(total.max)}`
    );
    console.log(
      `  manifest_fetch_parse=${formatMs(result.stages.manifest_fetch_parse_ms.avg)} | catalog_normalize=${formatMs(result.stages.catalog_normalize_ms.avg)} | asset_validation=${formatMs(result.stages.asset_validation_ms.avg)} | cover_queue_prepare=${formatMs(result.stages.cover_queue_prepare_ms.avg)}`
    );
  }

  if (typeof payload.summary.delta_percent_avg === 'number') {
    console.log('');
    console.log(
      `Optimized delta: ${formatMs(payload.summary.delta_ms_avg)} (${payload.summary.delta_percent_avg.toFixed(1)}%)`
    );
  }

  console.log('');
  console.log(`JSON output: ${outputPath}`);
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}
