class PitchDebugCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const configuredChunkSize = Number(options?.processorOptions?.chunkSize);
    this.chunkSize = Number.isFinite(configuredChunkSize) && configuredChunkSize > 0
      ? Math.max(128, Math.round(configuredChunkSize))
      : 512;
    this.buffer = new Float32Array(this.chunkSize);
    this.writeIndex = 0;
    this.port.onmessage = (event) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'config' && Number.isFinite(payload.chunkSize) && payload.chunkSize > 0) {
        this.chunkSize = Math.max(128, Math.round(payload.chunkSize));
        this.buffer = new Float32Array(this.chunkSize);
        this.writeIndex = 0;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length <= 0) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.writeIndex] = channel[i];
      this.writeIndex += 1;
      if (this.writeIndex >= this.buffer.length) {
        const out = new Float32Array(this.buffer);
        this.port.postMessage(
          {
            type: 'chunk',
            timeSeconds: currentTime,
            sampleRate,
            samples: out
          },
          [out.buffer]
        );
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('pitch-debug-capture-processor', PitchDebugCaptureProcessor);
