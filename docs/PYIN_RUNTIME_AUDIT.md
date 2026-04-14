# pYIN Runtime Parameter Audit

This note audits the `pyin` backend integration in the existing native detector runtime (`tools/native_pitch_runtime`) and records the final parameter ownership model.

## Native runtime source of truth

- Analysis sample rate:
  - Native stream sample rate from Oboe/host capture (`runtime_sample_rate` in diagnostics).
  - Passed into Rust runtime config as `sample_rate`.
- Processing cadence:
  - Native worker drains fixed `block_size` chunks from the ring buffer.
  - Detector dispatch is one runtime call per drained block.
- Timestamp contract:
  - Runtime detector events use `timestamp_sec = capture_time_sec` (end-of-submitted-block convention).
- Channel model:
  - Android callback is downmixed to mono before detector staging when input channels > 1.

## pYIN parameter ownership

| Parameter | Current source of truth | Used by pYIN as | Sample-rate dependent? | Final status |
|-----------|--------------------------|-----------------|------------------------|--------------|
| analysis sample rate | native stream/runtime config `sample_rate` | direct (`PYINExecutor::new(..., sr, ...)`) | yes | aligned |
| frame length | runtime `block_size` + low-frequency safety derivation | default `max(block_size, next_pow2(2 * (ceil(sr/fmin)+2)))` unless explicitly configured | yes | aligned |
| window length | pYIN config field | explicit `win_length` if set; otherwise crate default (`frame_length / 2`) | indirectly | aligned |
| hop length | runtime `block_size` | default `hop_length = block_size` unless explicitly configured | yes (through block duration) | aligned |
| fmin | native pYIN default config | default `82.40689 Hz` unless explicitly configured | no | aligned |
| fmax | repository detector range convention (baseline/worklet ceiling) | default `1200.0 Hz` unless explicitly configured | no | aligned |
| resolution | native pYIN default config | default `0.1` unless explicitly configured | no | aligned |
| fill_unvoiced | pYIN config field | default `NaN` unless explicitly configured | no | aligned |
| centering/padding | pYIN config field | default `center=false`, `pad_mode=constant` | no | aligned |
| event timestamp | native detector contract | end-of-block `capture_time_sec` | yes (through capture clock) | aligned |
| voiced/unvoiced mapping | canonical detector event schema | unvoiced -> `pitch_hz=None`, `midi_estimate=None`, `reason="pyin_unvoiced"` | no | aligned |

## Sample-rate policy summary

- `pyin` runs at the same runtime sample rate used by the current native detector pipeline.
- No hidden fixed `48000`/`44100` assumption remains in default frame/hop derivation.
- Defaults are derived from runtime `block_size` and validated against `sample_rate` + `fmin` constraints.

