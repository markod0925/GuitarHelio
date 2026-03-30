import { DEFAULT_AUDIO_INPUT_MODE, type AudioInputMode } from '../types/audioInputMode';
import { shouldUseNativePitchInput } from '../platform/nativePitchInput';

type MicNodeOptions = {
  audioInputMode?: AudioInputMode;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
};

export type MicInputNode = AudioNode & {
  mediaStream?: MediaStream;
};

export async function createMicNode(
  ctx: AudioContext,
  options: MicNodeOptions = {}
): Promise<MicInputNode> {
  if (shouldUseNativePitchInput()) {
    const placeholderGain = ctx.createGain();
    placeholderGain.gain.value = 0;
    const placeholder = placeholderGain as MicInputNode;
    placeholder.mediaStream = undefined;
    return placeholder;
  }

  const audioInputMode = options.audioInputMode ?? DEFAULT_AUDIO_INPUT_MODE;
  const speakerProfile = audioInputMode === 'speaker';
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: options.echoCancellation ?? speakerProfile,
      noiseSuppression: options.noiseSuppression ?? speakerProfile,
      autoGainControl: options.autoGainControl ?? speakerProfile,
      channelCount: options.channelCount ?? 1
    },
    video: false
  });
  const source = ctx.createMediaStreamSource(stream) as MicInputNode;
  source.mediaStream = stream;
  return source;
}
