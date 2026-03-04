import type { PitchFrame } from '../types/models';

export type PitchFrameWindow = {
  readonly length: number;
  at(index: number): PitchFrame | undefined;
  latest(): PitchFrame | undefined;
};

export class PitchFrameRingBuffer implements PitchFrameWindow {
  private readonly frames: Array<PitchFrame | undefined>;
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('PitchFrameRingBuffer capacity must be a positive integer.');
    }
    this.frames = new Array<PitchFrame | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(frame: PitchFrame): void {
    this.frames[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  at(index: number): PitchFrame | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      return undefined;
    }

    const oldestIndex = (this.head - this.count + this.capacity) % this.capacity;
    const bufferIndex = (oldestIndex + index) % this.capacity;
    return this.frames[bufferIndex];
  }

  latest(): PitchFrame | undefined {
    if (this.count === 0) return undefined;
    const latestIndex = (this.head - 1 + this.capacity) % this.capacity;
    return this.frames[latestIndex];
  }
}
