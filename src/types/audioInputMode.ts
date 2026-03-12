export type AudioInputMode = 'speaker' | 'headphones';

export const DEFAULT_AUDIO_INPUT_MODE: AudioInputMode = 'speaker';

export function parseAudioInputMode(value: unknown): AudioInputMode | null {
  return value === 'speaker' || value === 'headphones' ? value : null;
}
