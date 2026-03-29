import initDspCore, { GhDspCore, PitchDetectorPreset } from '../../audio/dsp-core/gh_dsp_core.js';
import dspCoreWasmUrl from '../../audio/dsp-core/gh_dsp_core_bg.wasm?url';
import type { PitchCandidate, PitchDetectorResult, PrecomputedFeatures } from '../types';
import { buildPracticeSpectralRuntimeModel } from '../../audio/spectralRuntimeModel';
import { midiToHz, midiToNoteName } from '../../ui/song-select/utils/songSelectUtils';

let initPromise: Promise<void> | null = null;

export async function ensureDspCoreLoaded(): Promise<void> {
  if (!initPromise) {
    initPromise = initDspCore({ module_or_path: dspCoreWasmUrl }).then(() => undefined);
  }
  await initPromise;
}

export function createPreparedCore(
  preset: PitchDetectorPreset,
  sampleRate: number,
  blockSize: number,
  spectralModelJson?: string | null
): GhDspCore {
  const core = new GhDspCore();
  core.prepare(sampleRate, blockSize, 1);
  core.set_pitch_detector_preset(preset);
  if (spectralModelJson) {
    core.set_spectral_model(spectralModelJson);
  }
  return core;
}

export function resolveDefaultSpectralModelJson(maxFret = 12): string {
  return JSON.stringify(buildPracticeSpectralRuntimeModel(maxFret));
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractSelectedNoteCandidates(value: unknown, limit = 4): PitchCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: PitchCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const data = item as Record<string, unknown>;
    const midi = finiteNumber(data.midi);
    if (midi === undefined) continue;
    candidates.push({
      pitchHz: midiToHz(midi),
      midi,
      noteName: midiToNoteName(Math.round(midi)),
      confidence: finiteNumber(data.score),
      label: stringOrNull(data.note_id) ?? undefined
    });
  }
  candidates.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return candidates.slice(0, limit);
}

export function makeRejectedResult(detectorName: string, rejectReason: string, debug: Record<string, unknown> = {}): PitchDetectorResult {
  return {
    detectorName,
    accepted: false,
    rejectReason,
    debug
  };
}

export function makeAcceptedResult(
  detectorName: string,
  midi: number,
  confidence: number,
  debug: Record<string, unknown> = {},
  candidates: PitchCandidate[] = []
): PitchDetectorResult {
  const roundedMidi = Math.round(midi);
  return {
    detectorName,
    accepted: true,
    midi,
    pitchHz: midiToHz(midi),
    noteName: midiToNoteName(roundedMidi),
    confidence,
    candidates,
    debug
  };
}

export function buildCommonRejectReason(features: PrecomputedFeatures | undefined, fallback: string): string {
  const rmsDbfs = features?.metrics.rmsDbfs ?? -120;
  if (rmsDbfs < -55) return 'insufficient_signal_level';
  if ((features?.metrics.lowBandEnergyRatio ?? 0) < 0.03) return 'low_band_energy';
  return fallback;
}
