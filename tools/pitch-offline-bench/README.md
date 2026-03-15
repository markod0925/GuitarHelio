# Pitch Offline Benchmark

This folder provides an isolated offline workflow to compare pitch detector approaches on real guitar recordings.

## Included files

- `note-list-30.json`: 30-note sequence (`note`, `midi`, `string`, `fret`).
- `generate-manifest.mjs`: creates a timed session manifest from the note list.
- `infer-manifest-from-wav.mjs`: infers timed note windows from a WAV take using energy envelope.
- `benchmark-config.default.json`: detector candidates and scoring weights.
- `benchmark.mjs`: runs offline benchmark on one or more WAV takes.

## Recommended recording protocol

1. Use headphones for backing/click (avoid speaker bleed).
2. Record clean electric guitar DI or low-gain amp.
3. Keep one note at a time, stable sustain, minimal vibrato.
4. Record 3 takes of the same sequence.
5. Keep sample rate at `44.1 kHz` when possible.

## 1) Generate the session manifest

```bash
node tools/pitch-offline-bench/generate-manifest.mjs \
  --notes tools/pitch-offline-bench/note-list-30.json \
  --out tools/pitch-offline-bench/session-manifest.json \
  --repeats 2 \
  --count-in 2.0 \
  --hold 0.65 \
  --rest 0.25
```

This creates timestamped note events expected by the benchmark runner.

## 2) Record takes

Record files aligned to the same structure, for example:

- `recordings/take1.wav`
- `recordings/take2.wav`
- `recordings/take3.wav`

If your timing is not aligned to a click/MIDI guide, infer the manifest from your first take:

```bash
node tools/pitch-offline-bench/infer-manifest-from-wav.mjs \
  --wav recordings/take1.wav \
  --notes tools/pitch-offline-bench/note-list-30.json \
  --out tools/pitch-offline-bench/session-manifest.inferred.json \
  --repeats 2
```

Then use `session-manifest.inferred.json` for all benchmark runs of the same recording protocol.

## 3) Run benchmark

```bash
node tools/pitch-offline-bench/benchmark.mjs \
  --manifest tools/pitch-offline-bench/session-manifest.json \
  --config tools/pitch-offline-bench/benchmark-config.default.json \
  --wav recordings/take1.wav \
  --wav recordings/take2.wav \
  --wav recordings/take3.wav \
  --out tools/pitch-offline-bench/output/results.json
```

The script prints ranking and writes detailed JSON output with per-candidate and per-note metrics.

## Metrics

- `detect_rate`: valid pitch frames / total frames in note windows.
- `in_tune_rate`: frames within cents tolerance (default `<= 35c`) / total frames.
- `median_abs_cents`: median absolute pitch error.
- `jitter_cents`: standard deviation of signed cents error.
- `octave_error_rate`: octave-like mistakes among valid frames.
- `cpu_ms_per_audio_s`: computation cost (milliseconds needed for one second of audio).
- `realtime_factor`: how many times faster than real-time processing.

## Tuning parameters

Edit `benchmark-config.default.json` to test new candidates:

- Tuneo-like YIN parameters (`window_seconds`, `chunk_seconds`, thresholds, adaptive filter).
- Custom zero-reference decay guard (`decay_grace_frames`, `decay_energy_factor`, `decay_correlation_threshold`).
- Long-window custom preset (`custom_zero_ref_offline_tuned`) when offline stability is prioritized over latency.
- Optional `analysis_sample_rate` for speed/accuracy trade-offs.
- Alternative algorithms (`autocorr`) for baseline comparison.

Ranking uses:

- `quality_weight` (default `0.8`)
- `speed_weight` (default `0.2`)

Increase `speed_weight` if runtime cost is more important in your decision.
