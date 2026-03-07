export type PitchCalibrationPoint = {
  midi: number;
  offsetCents: number;
  sampleCount: number;
  scatterCents: number;
};

export type PitchCalibrationProfile = {
  version: 1;
  createdAtMs: number;
  points: PitchCalibrationPoint[];
};

export type PitchCalibrationMeasurement = PitchCalibrationPoint;

export const PITCH_CALIBRATION_STORAGE_KEY = 'gh_pitch_calibration_v1';
export const DEFAULT_PITCH_CALIBRATION_REFERENCE_MIDI = Object.freeze([40, 45, 50, 55, 59, 64, 69]);

const MIN_MEASUREMENT_SAMPLES = 6;

export function estimatePitchCalibrationMeasurement(
  midiSamples: readonly number[],
  targetMidi: number
): PitchCalibrationMeasurement | null {
  const safeTargetMidi = Number.isFinite(targetMidi) ? targetMidi : NaN;
  if (!Number.isFinite(safeTargetMidi)) return null;

  const centsSamples = midiSamples
    .filter((sample) => Number.isFinite(sample))
    .map((sample) => (sample - safeTargetMidi) * 100)
    .filter((cents) => Math.abs(cents) <= 300);

  if (centsSamples.length < MIN_MEASUREMENT_SAMPLES) return null;

  const median = percentile(centsSamples, 0.5);
  const absDeviations = centsSamples.map((value) => Math.abs(value - median));
  const mad = percentile(absDeviations, 0.5);
  const keepThreshold = Math.max(15, mad * 3);
  const trimmed = centsSamples.filter((value) => Math.abs(value - median) <= keepThreshold);
  if (trimmed.length < MIN_MEASUREMENT_SAMPLES) return null;

  const offsetCents = clamp(mean(trimmed), -150, 150);
  const scatterCents = stddev(trimmed);

  return {
    midi: Math.round(safeTargetMidi),
    offsetCents: roundTo(offsetCents, 0.1),
    sampleCount: trimmed.length,
    scatterCents: roundTo(scatterCents, 0.1)
  };
}

export function buildPitchCalibrationProfile(
  measurements: readonly PitchCalibrationMeasurement[],
  createdAtMs = Date.now()
): PitchCalibrationProfile | null {
  const byMidi = new Map<number, PitchCalibrationPoint>();
  for (const raw of measurements) {
    if (!raw || !Number.isFinite(raw.midi) || !Number.isFinite(raw.offsetCents)) continue;
    const midi = Math.round(raw.midi);
    const sampleCount = Math.max(0, Math.round(raw.sampleCount));
    const scatterCents = Number.isFinite(raw.scatterCents) ? Math.max(0, raw.scatterCents) : 0;
    const point: PitchCalibrationPoint = {
      midi,
      offsetCents: clamp(raw.offsetCents, -200, 200),
      sampleCount,
      scatterCents
    };
    const existing = byMidi.get(midi);
    if (!existing) {
      byMidi.set(midi, point);
      continue;
    }
    const replace =
      point.sampleCount > existing.sampleCount ||
      (point.sampleCount === existing.sampleCount && point.scatterCents < existing.scatterCents);
    if (replace) byMidi.set(midi, point);
  }

  const points = Array.from(byMidi.values())
    .filter((point) => point.sampleCount >= MIN_MEASUREMENT_SAMPLES)
    .sort((a, b) => a.midi - b.midi);

  if (points.length < 2) return null;

  return {
    version: 1,
    createdAtMs: Math.max(0, Math.round(Number.isFinite(createdAtMs) ? createdAtMs : Date.now())),
    points
  };
}

export function getPitchCalibrationOffsetCents(
  midiEstimate: number,
  profile: PitchCalibrationProfile | null | undefined
): number {
  if (!profile || !Array.isArray(profile.points) || profile.points.length === 0) return 0;
  if (!Number.isFinite(midiEstimate)) return 0;

  const points = profile.points;
  if (points.length === 1) return points[0].offsetCents;

  if (midiEstimate <= points[0].midi) return points[0].offsetCents;
  if (midiEstimate >= points[points.length - 1].midi) return points[points.length - 1].offsetCents;

  for (let i = 0; i < points.length - 1; i += 1) {
    const left = points[i];
    const right = points[i + 1];
    if (midiEstimate < left.midi || midiEstimate > right.midi) continue;
    const span = right.midi - left.midi;
    if (span <= 0) return left.offsetCents;
    const t = (midiEstimate - left.midi) / span;
    return left.offsetCents + t * (right.offsetCents - left.offsetCents);
  }

  return points[points.length - 1].offsetCents;
}

export function applyPitchCalibration(
  midiEstimate: number,
  profile: PitchCalibrationProfile | null | undefined
): number {
  if (!Number.isFinite(midiEstimate)) return midiEstimate;
  const correctionCents = getPitchCalibrationOffsetCents(midiEstimate, profile);
  return midiEstimate - correctionCents / 100;
}

export function loadPitchCalibrationProfile(): PitchCalibrationProfile | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PITCH_CALIBRATION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return sanitizePitchCalibrationProfile(parsed);
  } catch {
    return null;
  }
}

export function savePitchCalibrationProfile(profile: PitchCalibrationProfile): void {
  if (typeof window === 'undefined') return;
  const safe = sanitizePitchCalibrationProfile(profile);
  if (!safe) return;
  try {
    window.localStorage.setItem(PITCH_CALIBRATION_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // ignore storage failures
  }
}

export function clearPitchCalibrationProfile(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PITCH_CALIBRATION_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function sanitizePitchCalibrationProfile(input: unknown): PitchCalibrationProfile | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  if (data.version !== 1) return null;
  if (!Array.isArray(data.points)) return null;

  const points: PitchCalibrationPoint[] = [];
  for (const pointRaw of data.points) {
    if (!pointRaw || typeof pointRaw !== 'object') continue;
    const pointData = pointRaw as Record<string, unknown>;
    const midiRaw = Number(pointData.midi);
    const offsetRaw = Number(pointData.offsetCents);
    const sampleRaw = Number(pointData.sampleCount);
    const scatterRaw = Number(pointData.scatterCents);
    if (!Number.isFinite(midiRaw) || !Number.isFinite(offsetRaw)) continue;
    const point: PitchCalibrationPoint = {
      midi: Math.round(midiRaw),
      offsetCents: clamp(offsetRaw, -200, 200),
      sampleCount: Number.isFinite(sampleRaw) ? Math.max(0, Math.round(sampleRaw)) : 0,
      scatterCents: Number.isFinite(scatterRaw) ? Math.max(0, scatterRaw) : 0
    };
    points.push(point);
  }

  const deduped = Array.from(
    points.reduce((map, point) => {
      const existing = map.get(point.midi);
      if (!existing) {
        map.set(point.midi, point);
        return map;
      }
      const replace =
        point.sampleCount > existing.sampleCount ||
        (point.sampleCount === existing.sampleCount && point.scatterCents < existing.scatterCents);
      if (replace) map.set(point.midi, point);
      return map;
    }, new Map<number, PitchCalibrationPoint>())
  )
    .map((entry) => entry[1])
    .filter((point) => point.sampleCount >= MIN_MEASUREMENT_SAMPLES)
    .sort((a, b) => a.midi - b.midi);

  if (deduped.length < 2) return null;

  return {
    version: 1,
    createdAtMs: Math.max(0, Math.round(Number(data.createdAtMs) || Date.now())),
    points: deduped
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function stddev(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  let variance = 0;
  for (const value of values) {
    const delta = value - avg;
    variance += delta * delta;
  }
  variance /= values.length;
  return Math.sqrt(Math.max(0, variance));
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedQ = clamp(q, 0, 1);
  const index = (sorted.length - 1) * clampedQ;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const t = index - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * t;
}

function roundTo(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}
