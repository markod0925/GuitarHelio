import { describe, expect, test } from 'vitest';
import {
  PLAY_SCENE_DETECTOR_PRESET,
  resolvePlaySceneDetectorPreset
} from '../src/app/config';

describe('PlayScene detector preset', () => {
  test('defaults explicitly to the spectral gameplay backend', () => {
    expect(PLAY_SCENE_DETECTOR_PRESET).toBe('spectral_game_runtime_unified_v3');
    expect(resolvePlaySceneDetectorPreset()).toBe('spectral_game_runtime_unified_v3');
  });
});
