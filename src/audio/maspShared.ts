import type { TargetNote } from '../types/models'

export const MASP_GAME_SCENE_PRESET = 'masp_game_scene_ts_v1'
export const MASP_PLAYHEAD_ANTICIPATION_SECONDS = 0.01

export type MaspResampleMode = 'native_22050' | 'decimate_44100' | 'linear_48000' | 'unsupported'

export type MaspExpectedNoteContext = {
  note_id: string
  midi: number
  string: number
  fret: number
  onset_sec: number
  offset_sec: number
}

export type MaspValidationContext = {
  playhead_sec: number
  start_sec: number
  end_sec: number
  expected_midis: number[]
  expected_notes: MaspExpectedNoteContext[]
}

export function resolveMaspResampleMode(sampleRate: number): MaspResampleMode {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 'unsupported'
  if (Math.abs(sampleRate - 22050) <= 1) return 'native_22050'
  if (Math.abs(sampleRate - 44100) <= 1) return 'decimate_44100'
  if (Math.abs(sampleRate - 48000) <= 1) return 'linear_48000'
  return 'unsupported'
}

export function sanitizeMaspValidationContext(context: MaspValidationContext | null | undefined): MaspValidationContext | null {
  if (!context) return null
  const playheadSec = sanitizeFinite(context.playhead_sec)
  const startSec = sanitizeFinite(context.start_sec)
  const endSec = sanitizeFinite(context.end_sec)
  if (playheadSec === null || startSec === null || endSec === null || endSec < startSec) {
    return null
  }

  const expectedMidis = Array.from(new Set((context.expected_midis ?? [])
    .map((midi) => sanitizeInteger(midi))
    .filter((midi): midi is number => midi !== null)))
    .sort((a, b) => a - b)

  const expectedNotes: MaspExpectedNoteContext[] = []
  for (const note of context.expected_notes ?? []) {
    const noteId = sanitizeId(note.note_id)
    const midi = sanitizeInteger(note.midi)
    const string = sanitizeInteger(note.string)
    const fret = sanitizeInteger(note.fret)
    const onsetSec = sanitizeFinite(note.onset_sec)
    const offsetSec = sanitizeFinite(note.offset_sec)
    if (!noteId || midi === null || string === null || fret === null || onsetSec === null || offsetSec === null) {
      continue
    }
    if (offsetSec < onsetSec) continue
    expectedNotes.push({
      note_id: noteId,
      midi,
      string,
      fret,
      onset_sec: onsetSec,
      offset_sec: offsetSec
    })
  }

  if (expectedMidis.length === 0 || expectedNotes.length === 0) {
    return null
  }

  return {
    playhead_sec: Math.max(0, playheadSec),
    start_sec: Math.max(0, startSec),
    end_sec: Math.max(0, endSec),
    expected_midis: expectedMidis,
    expected_notes: expectedNotes
  }
}

export function buildMaspValidationContextForTargetGroup(
  targetGroup: readonly TargetNote[],
  tickToSeconds: (tick: number) => number,
  playheadSec: number,
  anticipationSec = MASP_PLAYHEAD_ANTICIPATION_SECONDS
): MaspValidationContext | null {
  if (targetGroup.length === 0) return null
  const sanitizedPlayhead = sanitizeFinite(playheadSec)
  if (sanitizedPlayhead === null) return null

  const expectedNotes: MaspExpectedNoteContext[] = []
  let startSec = Number.POSITIVE_INFINITY
  let endSec = Number.NEGATIVE_INFINITY

  for (const target of targetGroup) {
    const midi = sanitizeInteger(target.expected_midi)
    const string = sanitizeInteger(target.string)
    const fret = sanitizeInteger(target.fret)
    if (midi === null || string === null || fret === null) continue

    const onsetSec = sanitizeFinite(tickToSeconds(target.tick))
    const durationTicks = Math.max(1, Math.floor(target.duration_ticks))
    const offsetSecRaw = sanitizeFinite(tickToSeconds(target.tick + durationTicks))
    if (onsetSec === null || offsetSecRaw === null) continue
    const offsetSec = Math.max(onsetSec, offsetSecRaw)

    expectedNotes.push({
      note_id: target.id,
      midi,
      string,
      fret,
      onset_sec: onsetSec,
      offset_sec: offsetSec
    })

    startSec = Math.min(startSec, onsetSec)
    endSec = Math.max(endSec, offsetSec)
  }

  if (expectedNotes.length === 0 || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return null
  }

  const expectedMidis = Array.from(new Set(expectedNotes.map((note) => note.midi))).sort((a, b) => a - b)

  return sanitizeMaspValidationContext({
    playhead_sec: sanitizedPlayhead + Math.max(0, anticipationSec),
    start_sec: startSec,
    end_sec: endSec,
    expected_midis: expectedMidis,
    expected_notes: expectedNotes
  })
}

function sanitizeFinite(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return value
}

function sanitizeInteger(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.round(value)
}

function sanitizeId(value: string): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
