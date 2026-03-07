type MicNodeOptions = {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
};

export async function createMicNode(
  ctx: AudioContext,
  options: MicNodeOptions = {}
): Promise<MediaStreamAudioSourceNode> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: options.echoCancellation ?? true,
      noiseSuppression: options.noiseSuppression ?? true,
      autoGainControl: options.autoGainControl ?? true,
      channelCount: options.channelCount ?? 1
    },
    video: false
  });
  return ctx.createMediaStreamSource(stream);
}
