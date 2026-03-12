import { DEFAULT_AUDIO_INPUT_MODE, type AudioInputMode } from '../types/audioInputMode';

type MicNodeOptions = {
  audioInputMode?: AudioInputMode;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
};

export async function createMicNode(
  ctx: AudioContext,
  options: MicNodeOptions = {}
): Promise<MediaStreamAudioSourceNode> {
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
  return ctx.createMediaStreamSource(stream);
}
