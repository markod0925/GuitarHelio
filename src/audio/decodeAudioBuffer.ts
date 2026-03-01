export type DecodedAudioBuffer = {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
};

type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const candidate = (globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }) ?? {};
  return candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
}

function decodeWithAudioContext(ctx: AudioContext, sourceBuffer: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(sourceBuffer, resolve, reject);
  });
}

export async function decodeAudioBuffer(sourceBuffer: ArrayBuffer): Promise<DecodedAudioBuffer> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) {
    throw new Error('Audio decoding is not available in this runtime.');
  }

  const ctx = new Ctor();
  try {
    // decodeAudioData may detach the input ArrayBuffer; pass a copy.
    const decoded = await decodeWithAudioContext(ctx, sourceBuffer.slice(0));
    return decoded as DecodedAudioBuffer;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
