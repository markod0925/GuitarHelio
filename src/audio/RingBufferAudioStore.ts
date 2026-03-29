export class RingBufferAudioStore {
  private readonly buffer: Float32Array;
  private writeIndex = 0;
  private length = 0;

  constructor(size: number) {
    this.buffer = new Float32Array(Math.max(1, size));
  }

  clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.length = 0;
  }

  append(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
      this.length = Math.min(this.length + 1, this.buffer.length);
    }
  }

  readLatest(sampleCount: number): Float32Array {
    const safeCount = Math.max(0, Math.min(sampleCount, this.length));
    const out = new Float32Array(safeCount);
    if (safeCount <= 0) return out;
    const start = (this.writeIndex - safeCount + this.buffer.length) % this.buffer.length;
    for (let i = 0; i < safeCount; i += 1) {
      out[i] = this.buffer[(start + i) % this.buffer.length];
    }
    return out;
  }

  getLength(): number {
    return this.length;
  }
}
