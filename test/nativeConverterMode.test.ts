import { describe, expect, test } from 'vitest';
import { isNativeConverterModeExecutable, normalizeNativeConverterMode } from '../src/platform/nativeSongImport';

describe('native converter mode compatibility', () => {
  test('normalizes unknown mode to legacy alias', () => {
    expect(normalizeNativeConverterMode(undefined)).toBe('legacy');
  });

  test('keeps accepted aliases', () => {
    expect(normalizeNativeConverterMode('legacy')).toBe('legacy');
    expect(normalizeNativeConverterMode('neuralnote')).toBe('neuralnote');
    expect(normalizeNativeConverterMode('ab')).toBe('ab');
  });

  test('marks ab as non executable mode', () => {
    expect(isNativeConverterModeExecutable('legacy')).toBe(true);
    expect(isNativeConverterModeExecutable('neuralnote')).toBe(true);
    expect(isNativeConverterModeExecutable('ab')).toBe(false);
  });
});
