export type PracticeCellVisual = {
  fillColor: number;
  fillAlpha: number;
  strokeColor: number;
  strokeAlpha: number;
};

const INACTIVE_CELL: PracticeCellVisual = {
  fillColor: 0x64748b,
  fillAlpha: 0.36,
  strokeColor: 0x475569,
  strokeAlpha: 0.86
};

const ACTIVE_CELL: PracticeCellVisual = {
  fillColor: 0x22c55e,
  fillAlpha: 0.94,
  strokeColor: 0xbbf7d0,
  strokeAlpha: 0.95
};

export function resolvePracticeCellVisual(
  cellMidi: number,
  cellString: number,
  detectedMidi: number | null,
  detectedString: number | null
): PracticeCellVisual {
  if (detectedMidi === null || detectedMidi !== cellMidi) {
    return INACTIVE_CELL;
  }

  if (detectedString === null || detectedString === cellString) {
    return ACTIVE_CELL;
  }

  return INACTIVE_CELL;
}

export function resolvePracticeStringBandAlpha(stringNumber: number, detectedString: number | null): number {
  return detectedString !== null && detectedString === stringNumber ? 0.24 : 0;
}
