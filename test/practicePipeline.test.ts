import { describe, expect, test } from 'vitest';
import {
  createPracticePipelineSessionDefault,
  formatPracticePipelineLabel,
  resolvePracticePipelineAvailability,
  resolvePracticePipelineSwitch
} from '../src/ui/practicePipeline';

describe('practice pipeline session defaults', () => {
  test('defaults to current pipeline', () => {
    expect(createPracticePipelineSessionDefault()).toBe('current');
  });

  test('resets to current on new session', () => {
    let selected = createPracticePipelineSessionDefault();
    selected = 'fretnet';
    expect(selected).toBe('fretnet');
    expect(createPracticePipelineSessionDefault()).toBe('current');
  });
});

describe('practice pipeline switch behavior', () => {
  test('marks switching and requires mic restart when active', () => {
    const result = resolvePracticePipelineSwitch({
      currentPipeline: 'current',
      nextPipeline: 'fretnet',
      micActive: true
    });

    expect(result.isNoop).toBe(false);
    expect(result.isSwitching).toBe(true);
    expect(result.requiresMicRestart).toBe(true);
    expect(result.nextPipeline).toBe('fretnet');
  });
});

describe('practice pipeline availability', () => {
  test('keeps fretnet pipeline available in phase-2', () => {
    const availability = resolvePracticePipelineAvailability('fretnet');
    expect(availability.available).toBe(true);
    expect(availability.reason).toBeNull();
  });

  test('keeps current pipeline available', () => {
    const availability = resolvePracticePipelineAvailability('current');
    expect(availability.available).toBe(true);
    expect(availability.reason).toBeNull();
    expect(formatPracticePipelineLabel('current')).toBe('Current');
  });
});
