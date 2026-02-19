export type TempoSegment = {
  startTick: number;
  startSeconds: number;
  usPerQuarter: number;
};

export class TempoMap {
  constructor(
    public readonly ticksPerQuarter: number,
    public readonly segments: TempoSegment[]
  ) {}

  static fromTempoEvents(
    ticksPerQuarter: number,
    tempoEvents: Array<{ tick: number; bpm: number }>
  ): TempoMap {
    const sorted = [...tempoEvents].sort((a, b) => a.tick - b.tick);
    const events = sorted.length > 0 && sorted[0].tick === 0
      ? sorted
      : [{ tick: 0, bpm: 120 }, ...sorted];

    const segments: TempoSegment[] = [];
    let lastTick = 0;
    let lastSeconds = 0;
    let currentUsPerQuarter = 500_000;

    for (const evt of events) {
      const deltaTicks = evt.tick - lastTick;
      if (segments.length === 0 || evt.tick !== lastTick) {
        lastSeconds += (deltaTicks / ticksPerQuarter) * (currentUsPerQuarter / 1_000_000);
      }
      currentUsPerQuarter = 60_000_000 / evt.bpm;
      segments.push({ startTick: evt.tick, startSeconds: lastSeconds, usPerQuarter: currentUsPerQuarter });
      lastTick = evt.tick;
    }

    return new TempoMap(ticksPerQuarter, segments);
  }

  tickToSeconds(tick: number): number {
    const seg = this.findSegmentByTick(tick);
    const deltaTicks = tick - seg.startTick;
    return seg.startSeconds + (deltaTicks / this.ticksPerQuarter) * (seg.usPerQuarter / 1_000_000);
  }

  secondsToTick(seconds: number): number {
    const seg = this.findSegmentBySeconds(seconds);
    const deltaSeconds = seconds - seg.startSeconds;
    return Math.round(seg.startTick + (deltaSeconds * 1_000_000 * this.ticksPerQuarter) / seg.usPerQuarter);
  }

  private findSegmentByTick(tick: number): TempoSegment {
    let selected = this.segments[0];
    for (const seg of this.segments) {
      if (seg.startTick <= tick) selected = seg;
      else break;
    }
    return selected;
  }

  private findSegmentBySeconds(seconds: number): TempoSegment {
    let selected = this.segments[0];
    for (const seg of this.segments) {
      if (seg.startSeconds <= seconds) selected = seg;
      else break;
    }
    return selected;
  }
}
