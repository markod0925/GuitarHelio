You are implementing a verification-driven stabilization pass on the GuitarHelio repository.

Context:
- This repo contains Android/mobile pitch detection and gameplay-related audio processing.
- The current goal is NOT broad feature work.
- The current goal is to verify, instrument, and harden the real-time/native pitch path before further refactors.
- You must prefer small, reviewable, low-risk patches over large rewrites.
- Do not do speculative refactors unless the required instrumentation proves they are justified.

Working style:
- Read the relevant code paths first.
- Track cross-file interactions carefully.
- Keep behavior unchanged unless the task explicitly requires a behavioral change.
- Add diagnostics in a way that can be disabled or kept low overhead in production.
- For every task, explain exactly which files were changed and why.
- At the end, produce a concise summary of findings, metrics added, and any newly confirmed or disproved risks.

Main objective:
Implement the first verification/stabilization wave for the Android/native pitch pipeline.

Focus areas:
1. Observability and telemetry
2. Queue loss visibility
3. Android smoke/instrumentation coverage
4. Real-time callback safety
5. Sample-rate/resampling traceability
6. Detector identity truthfulness

Important:
Do NOT start with large architectural rewrites.
Do NOT replace JSON transport yet unless instrumentation demonstrates it is a material bottleneck.
Do NOT merge or redesign all DSP implementations yet.
First make the current system observable and verifiable.

Tasks
=====

Task 1 — Add end-to-end runtime telemetry for the native pitch path
Goal:
Add low-overhead telemetry so we can measure callback timing, queue pressure, drop behavior, sample-rate chain, and detector identity.

Required metrics:
- callback_exec_time_us histogram or rolling stats (at least count, max, mean, p95/p99 if practical)
- xrun_count snapshots/deltas if available
- detector_queue_depth current/max
- detector_events_dropped_count
- monotonic event_seq on detector outputs
- detector_engine explicit identifier
  - examples: fretnet_onnx, fretnet_spectral_proxy, masp_native, masp_ts_fallback, ac14_native, etc.
- input_sample_rate
- runtime_sample_rate
- frontend_sample_rate if distinct
- resample_stage_count per processed path if applicable

Implementation guidance:
- Put timing in the Android native/JNI/C++ layer close to the real callback/worker boundary.
- Surface summary telemetry to Java/TS debug/status paths in a minimally invasive way.
- Prefer additive diagnostics over redesign.
- Keep callback-side telemetry minimal and RT-conscious.

Deliverables:
- Code changes implementing telemetry
- A short note describing exactly where each metric is gathered
- A debug-readable dump/report path for these metrics

Completion criteria:
- Telemetry compiles and runs
- Metrics can be queried during or after a capture session
- event_seq is visible in emitted detections
- detector_engine is explicit and truthful

Task 2 — Make queue loss observable and testable
Goal:
Make any detector result dropping explicit instead of silent.

Required changes:
- Add sequence IDs to every emitted detection result
- Add dropped-event counters whenever queue truncation occurs
- If practical, expose last_dropped_seq_range or equivalent gap diagnostics
- Ensure JS/TS side can detect sequence gaps during polling

Validation:
- Add one test or debug harness path that intentionally stresses polling/consumption and demonstrates gap detection

Deliverables:
- Queue instrumentation patch
- Consumer-side gap detection or logging
- Short explanation of current queue semantics after patch

Completion criteria:
- Under stress, sequence gaps are detectable
- No silent truncation remains invisible

Task 3 — Replace stale Android template test with native pitch smoke coverage
Goal:
Create minimal but real Android-side smoke coverage for the native pitch plugin/path.

Minimum scope:
- Verify plugin/package wiring is correct
- Exercise startCapture
- Exercise at least one polling/status path
- Exercise stopCapture
- Ensure no stale template package assertions remain

Nice to have if practical:
- Repeat start/stop more than once
- Validate telemetry/status fields are populated

Constraints:
- Keep this test robust and simple; do not create a flaky integration monster
- Prefer smoke coverage over deep scenario coverage for this patch

Deliverables:
- New Android test(s)
- Removal/replacement of stale template test
- Brief note on what is covered and what is still missing

Completion criteria:
- Android test suite includes a meaningful native pitch smoke test
- No stale template-only test remains as the main instrumentation coverage

Task 4 — Harden callback path against obvious RT hazards
Goal:
Remove the most obvious real-time safety problems in the callback without broad redesign.

Required changes:
- Eliminate callback-path dynamic resize/allocation if currently present
- Preallocate scratch buffers during stream/capture initialization using known/max sizes
- Move any nonessential heavy diagnostics work out of the callback if currently done there
- Keep callback work as close as possible to:
  - ingest/copy/stage
  - minimal counters
  - fast return

Constraints:
- Do not rewrite the full engine architecture in this task
- Preserve behavior as much as possible

Deliverables:
- Patch reducing callback hazards
- Notes on what work still remains in callback after patch
- Any telemetry needed to validate improvement

Completion criteria:
- No obvious callback-path resize/allocation remains
- Callback path is measurably simpler and safer
- Code builds and existing behavior is preserved as much as possible

Task 5 — Add explicit sample-rate/resampling chain tracing
Goal:
Make the actual FRETNET/native runtime sample-rate path auditable.

Required visibility:
- requested input sample rate
- actual device/capture sample rate
- runtime processing sample rate
- frontend/model sample rate if different
- number of resample stages actually applied
- block/frame size used at each important stage if relevant

Implementation guidance:
- Do not assume comments/config are truthful; trace real values at runtime
- Surface this in telemetry/debug outputs
- Especially cover FRETNET path, but use a design that can support other detectors too

Validation:
- Make it possible to inspect one session and know whether there was one resample stage or multiple

Deliverables:
- Traceable sample-rate telemetry
- Brief summary note describing the current observed chain from code

Completion criteria:
- Runtime makes the sample-rate chain explicit
- Multi-stage resampling, if present, can be detected from logs/telemetry

Task 6 — Normalize detector identity and fail-fast backend mapping where appropriate
Goal:
Make runtime identity truthful and prevent misleading fallback behavior.

Required changes:
- Ensure detector_engine reflects the actual implementation used
- If “fretnet” TS/web fallback is really a spectral proxy, make that explicit in telemetry and any relevant internal naming
- Review mapping functions that silently default unknown presets to MASP (or similar)
- Change unknown preset behavior to fail fast or emit an explicit error in a controlled way rather than silently changing backend

Constraints:
- Avoid unnecessary user-facing churn unless needed
- Internal truthfulness and diagnostics are the priority

Deliverables:
- Detector identity patch
- Mapping hardening patch
- Small test for unknown preset handling if applicable

Completion criteria:
- Runtime and logs no longer pretend different implementations are the same
- Unknown preset/backend mapping is no longer silently misleading

Execution order
==============
Do the tasks in this order unless the code structure strongly suggests a safer variant:
1. Task 1 telemetry
2. Task 2 queue visibility
3. Task 3 Android smoke test
4. Task 5 sample-rate tracing
5. Task 6 detector identity / mapping hardening
6. Task 4 callback hardening

Reason:
We want observability first, then truthfulness, then focused safety improvements with measurement support.

Output format
=============
At the end provide:

1. Files changed
- list files changed per task

2. What was implemented
- concise bullet list by task

3. Metrics now available
- exact metrics/fields added

4. Confirmed vs disproved risks
- which previous concerns are now confirmed by code/telemetry
- which concerns remain only inferred
- which concerns were disproved

5. Remaining high-priority next steps
- ordered by ROI
- explicitly separate:
  - immediate next patch
  - follow-up verification
  - larger refactors to postpone

6. Tests added
- what each test covers
- what is still missing

Quality bar
===========
A good result is not a giant rewrite.
A good result is:
- better observability
- better truthfulness
- fewer silent failure modes
- safer callback behavior
- meaningful Android smoke coverage
- small, reviewable patches with clear evidence value

If a requested item cannot be completed exactly as stated, implement the closest safe version and explain the limitation precisely.