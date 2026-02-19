export async function createMicNode(ctx: AudioContext): Promise<MediaStreamAudioSourceNode> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return ctx.createMediaStreamSource(stream);
}
