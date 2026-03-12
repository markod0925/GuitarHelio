# gh_dsp_core

Rust/WASM DSP core for GuitarHelio.

Implemented API:
- `prepare(sample_rate, block_size, mode)`
- `set_reference_block(float32[])`
- `process_block(mic_block)` -> `{ residual_block, delay_samples, reference_correlation, energy_ratio_db, onset_strength, contamination_score }`
- `reset()`

## Build (wasm-pack + sync)

```bash
npm run build:dsp:wasm
```

This command compiles the WASM package and syncs artifacts to:
- `src/audio/dsp-core`
- `public/assets/dsp-core`

The generated package can be consumed by runtime wrappers in web/Electron/Capacitor and by Node test harnesses.
