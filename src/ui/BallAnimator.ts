export class BallTrailRingBuffer {
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private head = 0;
  private sizeValue = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`BallTrailRingBuffer capacity must be a positive integer, got: ${capacity}`);
    }
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
  }

  get size(): number {
    return this.sizeValue;
  }

  clear(): void {
    this.head = 0;
    this.sizeValue = 0;
  }

  push(x: number, y: number): void {
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.head = (this.head + 1) % this.capacity;
    if (this.sizeValue < this.capacity) {
      this.sizeValue += 1;
    }
  }

  getX(index: number): number {
    return this.xs[this.resolveIndex(index)];
  }

  getY(index: number): number {
    return this.ys[this.resolveIndex(index)];
  }

  private resolveIndex(index: number): number {
    if (index < 0 || index >= this.sizeValue) {
      throw new RangeError(`BallTrailRingBuffer index out of bounds: ${index} (size=${this.sizeValue})`);
    }
    const base = this.head - this.sizeValue + index;
    return (base % this.capacity + this.capacity) % this.capacity;
  }
}
