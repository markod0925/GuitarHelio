const EPS = 1e-12

export type MaspScoreWeights = {
  har: number
  mbw: number
  cent: number
  rms: number
}

export type MaspParams = {
  mode: 'strict'
  strictSampleRate: number
  binsPerOctave: number
  maxHarmonics: number
  bExponent: number
  centTolerance: number
  rmsWindowMs: number
  rmsHRelax: number
  scoreThreshold: number
  scoreWeights: MaspScoreWeights
  localAggregation: 'max' | 'mean'
  midiMin: number
}

export type MaspHarmonicRange = {
  start: number
  end: number
}

export type MaspHarmonicMap = {
  midi: number
  f0_hz: number
  ranges: MaspHarmonicRange[]
}

export type MaspFrameMetrics = {
  h: number
  har: number
  mbw: number
  centError: number
  noiseRms: number
}

export const MASP_TUNED_PARAMS: MaspParams = Object.freeze({
  mode: 'strict',
  strictSampleRate: 22050,
  binsPerOctave: 36,
  maxHarmonics: 8,
  bExponent: 0.7726795,
  centTolerance: 50.0,
  rmsWindowMs: 50,
  rmsHRelax: 0.25,
  scoreThreshold: 0.4370982,
  scoreWeights: Object.freeze({
    har: 0.16453995,
    mbw: 0.5508079,
    cent: 0.038484424,
    rms: 0.24616772
  }),
  localAggregation: 'max',
  midiMin: 40
})

export function pitchToHz(midi: number): number {
  return 440.0 * Math.pow(2.0, (midi - 69.0) / 12.0)
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

export function smoothingFactor(k: number, bExponent: number): number {
  return 1.0 / (1.0 + Math.pow(k, Math.max(0.0, bExponent)))
}

export function centScore(centError: number, tolerance: number): number {
  if (!(tolerance > 0.0)) {
    return 0.0
  }
  return clamp(1.0 - Math.abs(centError) / tolerance, 0.0, 1.0)
}

export function aggregateLocalMasp(
  mag: ArrayLike<number>,
  start: number,
  end: number,
  mode: MaspParams['localAggregation'] = 'max'
): number {
  if (!mag.length) {
    return 0.0
  }
  const s = Math.min(Math.max(0, start), mag.length - 1)
  const e = Math.min(Math.max(0, end), mag.length - 1)
  if (s > e) {
    return 0.0
  }
  if (mode === 'max') {
    let out = 0.0
    for (let i = s; i <= e; i += 1) {
      out = Math.max(out, mag[i])
    }
    return out
  }
  let sum = 0.0
  let n = 0
  for (let i = s; i <= e; i += 1) {
    sum += mag[i]
    n += 1
  }
  return n > 0 ? sum / n : 0.0
}

export function scoreMaspMidiFrame(
  mag: ArrayLike<number>,
  maps: readonly MaspHarmonicMap[],
  params: MaspParams = MASP_TUNED_PARAMS
): number[] {
  if (!mag.length) {
    return maps.map(() => 0.0)
  }
  let sumX = 0.0
  for (let i = 0; i < mag.length; i += 1) {
    sumX += mag[i]
  }
  const meanX = sumX / mag.length
  const out = new Array(maps.length).fill(0.0)
  for (let idx = 0; idx < maps.length; idx += 1) {
    const map = maps[idx]
    let product = 1.0
    let smoothSum = 0.0
    let used = 0
    const limit = Math.min(map.ranges.length, params.maxHarmonics)
    for (let hIdx = 0; hIdx < limit; hIdx += 1) {
      const range = map.ranges[hIdx]
      const k = hIdx + 1
      const local = aggregateLocalMasp(mag, range.start, range.end, params.localAggregation || 'max')
      const a = smoothingFactor(k, params.bExponent)
      const xk = Math.max(EPS, a * local + (1.0 - a) * meanX)
      product *= xk
      smoothSum += xk
      used += 1
    }
    if (!used) {
      out[idx] = 0.0
      continue
    }
    const s = Math.log(1.0 + sumX) / (smoothSum + EPS)
    out[idx] = Math.max(0.0, s * product)
  }
  return out
}

export function computeHarmonicityH(
  mag: ArrayLike<number>,
  pitchSpectrum: readonly number[],
  sampleRate: number,
  nfft: number,
  midiMin = MASP_TUNED_PARAMS.midiMin
): number {
  if (!mag.length || !pitchSpectrum.length || !(nfft > 0) || !(sampleRate > 0)) {
    return 1.0
  }
  let magSum = 0.0
  let magExpect = 0.0
  const hzPerBin = sampleRate / nfft
  for (let binIdx = 1; binIdx < mag.length; binIdx += 1) {
    const x = mag[binIdx]
    if (!(x > 0.0)) {
      continue
    }
    const freq = Math.max(1.0, binIdx * hzPerBin)
    magSum += x
    magExpect += x * Math.log2(freq)
  }
  if (!(magSum > 0.0)) {
    return 1.0
  }
  const mF = magExpect / magSum
  let pitchSum = 0.0
  let pitchExpect = 0.0
  for (let idx = 0; idx < pitchSpectrum.length; idx += 1) {
    const x = pitchSpectrum[idx]
    if (!(x > 0.0)) {
      continue
    }
    const freq = Math.max(1.0, pitchToHz(midiMin + idx))
    pitchSum += x
    pitchExpect += x * Math.log2(freq)
  }
  if (!(pitchSum > 0.0)) {
    return 1.0
  }
  const mP = pitchExpect / pitchSum
  return Math.pow(2.0, mF - mP)
}

export function computeHar(
  pitchSpectrum: readonly number[],
  expectedMidis: readonly number[],
  midiMin = MASP_TUNED_PARAMS.midiMin
): number {
  if (!pitchSpectrum.length) {
    return 0.0
  }
  const total = pitchSpectrum.reduce((acc, x) => acc + x, 0.0)
  if (!(total > 0.0)) {
    return 0.0
  }
  let explained = 0.0
  for (const midi of expectedMidis) {
    if (midi < midiMin) {
      continue
    }
    const idx = midi - midiMin
    if (idx >= 0 && idx < pitchSpectrum.length) {
      explained += pitchSpectrum[idx]
    }
  }
  return clamp(explained / total, 0.0, 1.0)
}

export function computeMbw(
  mag: ArrayLike<number>,
  expectedMidis: readonly number[],
  maps: readonly MaspHarmonicMap[]
): number {
  if (!mag.length || !expectedMidis.length) {
    return 0.0
  }
  const selected = new Set<number>()
  for (const midi of expectedMidis) {
    const map = maps.find((item) => item.midi === midi)
    if (!map) {
      continue
    }
    for (const range of map.ranges) {
      const center = Math.floor((range.start + range.end) / 2)
      selected.add(Math.min(center, mag.length - 1))
    }
  }
  const bins = Array.from(selected).sort((a, b) => a - b)
  if (bins.length < 2) {
    return 0.0
  }
  let prev: number | null = null
  let absDiffSum = 0.0
  let count = 0
  for (const bin of bins) {
    const x = Math.log(mag[bin] + EPS)
    if (prev !== null) {
      absDiffSum += Math.abs(x - prev)
      count += 1
    }
    prev = x
  }
  if (!count) {
    return 0.0
  }
  const mad = absDiffSum / count
  return clamp(1.0 / (1.0 + mad), 0.0, 1.0)
}

export function computeCentError(
  pitchSpectrum: readonly number[],
  expectedMidis: readonly number[],
  midiMin = MASP_TUNED_PARAMS.midiMin
): number {
  if (!pitchSpectrum.length || !expectedMidis.length) {
    return 0.0
  }
  let maxIdx = 0
  let maxValue = Number.NEGATIVE_INFINITY
  for (let idx = 0; idx < pitchSpectrum.length; idx += 1) {
    if (pitchSpectrum[idx] > maxValue) {
      maxValue = pitchSpectrum[idx]
      maxIdx = idx
    }
  }
  const predictedMidi = midiMin + maxIdx
  let nearest = predictedMidi
  let bestDelta = Number.POSITIVE_INFINITY
  for (const midi of expectedMidis) {
    const delta = Math.abs(predictedMidi - midi)
    if (delta < bestDelta) {
      bestDelta = delta
      nearest = midi
    }
  }
  return 100.0 * (predictedMidi - nearest)
}

export function weightedMetricsScore(
  metrics: MaspFrameMetrics,
  weights: MaspScoreWeights = MASP_TUNED_PARAMS.scoreWeights,
  centTolerance = MASP_TUNED_PARAMS.centTolerance
): number {
  const cent = centScore(metrics.centError, centTolerance)
  const rmsScore = clamp(1.0 - metrics.noiseRms, 0.0, 1.0)
  return weights.har * metrics.har + weights.mbw * metrics.mbw + weights.cent * cent + weights.rms * rmsScore
}

export function computeValidationDecision({
  metrics,
  hTarget,
  params = MASP_TUNED_PARAMS
}: {
  metrics: MaspFrameMetrics
  hTarget: number
  params?: MaspParams
}): {
  centGate: boolean
  hGate: boolean
  hDynamicThreshold: number
  weightedScore: number
  pass: boolean
  reason: string
} {
  const centGate = Math.abs(metrics.centError) <= params.centTolerance
  const hDynamicThreshold = Math.max(0.0, hTarget * (1.0 - params.rmsHRelax * clamp(metrics.noiseRms, 0.0, 1.0)))
  const hGate = metrics.h >= hDynamicThreshold
  const weightedScore = weightedMetricsScore(metrics, params.scoreWeights, params.centTolerance)
  const pass = weightedScore >= params.scoreThreshold
  let reason = 'weighted_score_failed'
  if (pass) {
    if (centGate && hGate) {
      reason = 'validated'
    } else if (!centGate && !hGate) {
      reason = 'validated_soft_score_without_cent_or_h_gate'
    } else if (!centGate) {
      reason = 'validated_soft_score_without_cent_gate'
    } else {
      reason = 'validated_soft_score_without_h_gate'
    }
  } else if (!centGate) {
    reason = 'cent_gate_failed'
  } else if (!hGate) {
    reason = 'harmonicity_threshold_failed'
  }
  return {
    centGate,
    hGate,
    hDynamicThreshold,
    weightedScore,
    pass,
    reason
  }
}
