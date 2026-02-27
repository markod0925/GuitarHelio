export type ConverterMode = 'legacy' | 'neuralnote';
export type RequestedConverterMode = ConverterMode | 'ab';

export function resolveRequestedConverterMode(rawValue: string, debugEnabled: boolean): RequestedConverterMode {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase();

  if (normalized === 'neuralnote') {
    return debugEnabled ? 'neuralnote' : 'legacy';
  }
  if (normalized === 'ab') {
    return debugEnabled ? 'ab' : 'legacy';
  }
  return 'legacy';
}

export function toExecutableConverterMode(requestedMode: RequestedConverterMode): ConverterMode | null {
  if (requestedMode === 'ab') return null;
  return requestedMode === 'neuralnote' ? 'neuralnote' : 'legacy';
}
