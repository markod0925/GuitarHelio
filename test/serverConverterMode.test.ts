import { describe, expect, test } from 'vitest';
import { resolveRequestedConverterMode, toExecutableConverterMode } from '../src/platform/converterMode';

describe('server converter mode compatibility', () => {
  test('maps legacy and neuralnote labels to executable converter modes', () => {
    expect(resolveRequestedConverterMode('legacy', true)).toBe('legacy');
    expect(resolveRequestedConverterMode('neuralnote', true)).toBe('neuralnote');
    expect(toExecutableConverterMode('legacy')).toBe('legacy');
    expect(toExecutableConverterMode('neuralnote')).toBe('neuralnote');
  });

  test('downgrades debug-only labels when debug flag is disabled', () => {
    expect(resolveRequestedConverterMode('neuralnote', false)).toBe('legacy');
    expect(resolveRequestedConverterMode('ab', false)).toBe('legacy');
  });

  test('rejects ab as non executable when debug flag is enabled', () => {
    expect(resolveRequestedConverterMode('ab', true)).toBe('ab');
    expect(toExecutableConverterMode('ab')).toBeNull();
  });
});
