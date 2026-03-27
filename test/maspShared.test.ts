import { describe, expect, test } from 'vitest'
import {
  MASP_PLAYHEAD_ANTICIPATION_SECONDS,
  buildMaspValidationContextForTargetGroup,
  resolveMaspResampleMode,
  sanitizeMaspValidationContext,
  type MaspValidationContext
} from '../src/audio/maspShared'
import type { TargetNote } from '../src/types/models'

function target(id: string, tick: number, durationTicks: number, midi: number, string: number, fret: number): TargetNote {
  return {
    id,
    tick,
    duration_ticks: durationTicks,
    expected_midi: midi,
    string,
    fret,
    finger: 1
  }
}

describe('resolveMaspResampleMode', () => {
  test('maps supported sample rates to expected policy', () => {
    expect(resolveMaspResampleMode(22050)).toBe('native_22050')
    expect(resolveMaspResampleMode(44100)).toBe('decimate_44100')
    expect(resolveMaspResampleMode(48000)).toBe('linear_48000')
    expect(resolveMaspResampleMode(32000)).toBe('unsupported')
  })
})

describe('buildMaspValidationContextForTargetGroup', () => {
  test('builds expected_midis/start_end and applies +10ms anticipation', () => {
    const group: TargetNote[] = [
      target('n1', 100, 120, 64, 2, 9),
      target('n2', 100, 120, 60, 3, 5),
      target('n3', 100, 120, 64, 1, 0)
    ]

    const ctx = buildMaspValidationContextForTargetGroup(group, (tick) => tick / 100, 1.2)
    expect(ctx).not.toBeNull()
    if (!ctx) return

    expect(ctx.playhead_sec).toBeCloseTo(1.2 + MASP_PLAYHEAD_ANTICIPATION_SECONDS, 6)
    expect(ctx.start_sec).toBeCloseTo(1.0, 6)
    expect(ctx.end_sec).toBeCloseTo(2.2, 6)
    expect(ctx.expected_midis).toEqual([60, 64])
    expect(ctx.expected_notes.map((note) => note.note_id)).toEqual(['n1', 'n2', 'n3'])
  })

  test('returns null when no valid targets are available', () => {
    const ctx = buildMaspValidationContextForTargetGroup([], (tick) => tick / 100, 0.5)
    expect(ctx).toBeNull()
  })
})

describe('sanitizeMaspValidationContext', () => {
  test('drops malformed contexts', () => {
    const malformed = {
      playhead_sec: 1,
      start_sec: 2,
      end_sec: 1,
      expected_midis: [60],
      expected_notes: []
    } as unknown as MaspValidationContext
    expect(sanitizeMaspValidationContext(malformed)).toBeNull()
  })
})
