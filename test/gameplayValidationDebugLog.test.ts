import { describe, expect, it } from 'vitest';
import {
  buildGameplayValidationDebugLogSessionDirectoryName,
  buildGameplayValidationDebugLogSessionDirectoryPath,
  buildGameplayValidationDebugLogSessionFilePath
} from '../src/ui/play/controllers/gameplayValidationDebugLog';

describe('gameplay validation debug log', () => {
  it('builds stable session directories and final dump paths for Android-friendly exports', () => {
    const directoryName = buildGameplayValidationDebugLogSessionDirectoryName(0, 1);
    expect(directoryName).toBe('playscene-debug-overlay-1970-01-01T00-00-00-000Z-001');
    expect(buildGameplayValidationDebugLogSessionDirectoryPath(0, 1)).toBe(
      'GuitarHelio/debug-overlay-logs/playscene-debug-overlay-1970-01-01T00-00-00-000Z-001'
    );
    expect(buildGameplayValidationDebugLogSessionFilePath(0, 1)).toBe(
      'GuitarHelio/debug-overlay-logs/playscene-debug-overlay-1970-01-01T00-00-00-000Z-001/session.json'
    );
  });
});
