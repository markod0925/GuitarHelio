import type { AudioFrameContext, PitchDetectorAdapter, PitchDetectorConfig, PitchDetectorResult } from './types';

export class PitchDetectorManager {
  constructor(
    private readonly adapters: PitchDetectorAdapter[]
  ) {}

  async init(configByName: Record<string, PitchDetectorConfig>): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.init(configByName[adapter.name] ?? { enabled: true });
    }
  }

  resetAll(): void {
    for (const adapter of this.adapters) {
      adapter.reset();
    }
  }

  processAll(frame: AudioFrameContext): PitchDetectorResult[] {
    const results: PitchDetectorResult[] = [];
    for (const adapter of this.adapters) {
      const startedAt = performance.now();
      const result = adapter.processFrame(frame);
      result.processingTimeMs = performance.now() - startedAt;
      results.push(result);
    }
    return results;
  }

  dispose(): void {
    for (const adapter of this.adapters) {
      adapter.dispose?.();
    }
  }
}
