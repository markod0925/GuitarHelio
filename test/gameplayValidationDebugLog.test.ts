import { describe, expect, it } from 'vitest';
import {
  buildGameplayValidationDebugLogFileName,
  buildGameplayValidationDebugLogPath
} from '../src/ui/play/controllers/gameplayValidationDebugLog';

describe('gameplay validation debug log', () => {
  it('builds a stable Documents path for Android-friendly exports', () => {
    const fileName = buildGameplayValidationDebugLogFileName(0);
    expect(fileName).toBe('playscene-debug-overlay-1970-01-01T00-00-00-000Z.jsonl');
    expect(buildGameplayValidationDebugLogPath(0)).toBe(
      'GuitarHelio/debug-overlay-logs/playscene-debug-overlay-1970-01-01T00-00-00-000Z.jsonl'
    );
  });
});
