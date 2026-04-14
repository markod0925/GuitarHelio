export const DEFAULT_AUDIO_INPUT_MODE = 'speaker';
export function parseAudioInputMode(value) {
    return value === 'speaker' || value === 'headphones' ? value : null;
}
