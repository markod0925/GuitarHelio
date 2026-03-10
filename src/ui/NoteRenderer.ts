import Phaser from 'phaser';
import { FINGER_COLORS } from '../app/config';
import type { TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { RoundedBox } from './RoundedBox';
import type { Layout, MutablePoint } from './playSceneTypes';

type RedrawArgs = {
  ball?: Phaser.GameObjects.Arc;
  runtimeState: PlayState;
  currentTick: number;
  waitingTargetId?: string;
  waitingChordId?: string;
  targets: TargetNote[];
  correctlyHitTargetIds: ReadonlySet<string>;
  layout: Layout;
  resolveBallPosition: (layout: Layout) => MutablePoint;
  updateBallTrail: (x: number, y: number, laneSpacing: number) => void;
  setBallAndTrailVisible: (visible: boolean) => void;
};

type NoteVisual = {
  shape: RoundedBox;
  fretLabel: Phaser.GameObjects.Text;
  lastFretText: string;
  lastFontSize: string;
  lastWidth: number;
  lastHeight: number;
  lastCornerRadius: number;
  lastFillColor: number;
  lastFillAlpha: number;
  lastStrokeAlpha: number;
  lastLabelAlpha: number;
};

export class NoteRenderer {
  private notePool: NoteVisual[] = [];
  private targetTicks: number[] = [];
  private maxTargetDurationTicks = 1;
  private cachedTargets?: TargetNote[];

  constructor(private readonly scene: Phaser.Scene) {}

  redrawTargetsAndBall(args: RedrawArgs): void {
    const {
      ball,
      runtimeState,
      currentTick,
      waitingTargetId,
      waitingChordId,
      targets,
      correctlyHitTargetIds,
      layout,
      resolveBallPosition,
      updateBallTrail,
      setBallAndTrailVisible
    } = args;

    if (!ball) return;

    if (runtimeState === PlayState.Finished) {
      setBallAndTrailVisible(false);
      this.hideUnusedNotes(0);
      return;
    }
    setBallAndTrailVisible(true);

    const viewLeft = layout.left - 30;
    const viewRight = layout.right + 40;
    const labelFontSize = `${Math.max(12, Math.floor(layout.noteHeight * 1.45))}px`;
    this.ensureTargetCache(targets);

    const marginTicks = Math.ceil(Math.max(2, (layout.noteHeight * 2) / Math.max(layout.pxPerTick, 0.0001)));
    const leftTickBound =
      currentTick + (viewLeft - layout.hitLineX) / Math.max(layout.pxPerTick, 0.0001) - this.maxTargetDurationTicks - marginTicks;
    const rightTickBound = currentTick + (viewRight - layout.hitLineX) / Math.max(layout.pxPerTick, 0.0001) + marginTicks;
    const startIndex = this.lowerBoundByTick(leftTickBound);
    const endIndex = this.upperBoundByTick(rightTickBound);

    let visibleNotes = 0;
    for (let i = startIndex; i < endIndex; i += 1) {
      const target = targets[i];
      const x = layout.hitLineX + (target.tick - currentTick) * layout.pxPerTick;
      const noteDiameter = layout.noteHeight * 2;
      const width = Math.max(noteDiameter, target.duration_ticks * layout.pxPerTick);
      if (x + width < viewLeft || x > viewRight) continue;

      const y = layout.top + (target.string - 1) * layout.laneSpacing;
      const targetChordId = target.chord_id ?? target.id;
      const isWaitingTarget = waitingChordId ? waitingChordId === targetChordId : waitingTargetId === target.id;
      const isPast = target.tick < currentTick;
      const alpha = isWaitingTarget ? 1 : isPast ? 0.28 : 0.95;
      const noteColor = correctlyHitTargetIds.has(target.id) ? 0x22c55e : (FINGER_COLORS[target.finger] ?? 0xffffff);
      const strokeAlpha = isWaitingTarget ? 1 : 0;
      const radius = noteDiameter / 2;

      const visual = this.getOrCreateNoteVisual(visibleNotes);
      visual.shape.setPosition(x + width / 2, y);
      if (visual.lastWidth !== width || visual.lastHeight !== noteDiameter) {
        visual.shape.setBoxSize(width, noteDiameter);
        visual.lastWidth = width;
        visual.lastHeight = noteDiameter;
      }
      if (visual.lastCornerRadius !== radius) {
        visual.shape.setCornerRadius(radius);
        visual.lastCornerRadius = radius;
      }
      if (visual.lastFillColor !== noteColor || visual.lastFillAlpha !== alpha) {
        visual.shape.setFillStyle(noteColor, alpha);
        visual.lastFillColor = noteColor;
        visual.lastFillAlpha = alpha;
      }
      if (visual.lastStrokeAlpha !== strokeAlpha) {
        visual.shape.setStrokeStyle(2, 0xffffff, strokeAlpha);
        visual.lastStrokeAlpha = strokeAlpha;
      }
      if (!visual.shape.visible) {
        visual.shape.setVisible(true);
      }
      visual.fretLabel
        .setPosition(x + radius, y)
        .setVisible(true);
      if (visual.lastLabelAlpha !== alpha) {
        visual.fretLabel.setAlpha(alpha);
        visual.lastLabelAlpha = alpha;
      }
      const fretText = `${target.fret}`;
      if (visual.lastFretText !== fretText) {
        visual.fretLabel.setText(fretText);
        visual.lastFretText = fretText;
      }
      if (visual.lastFontSize !== labelFontSize) {
        visual.fretLabel.setFontSize(labelFontSize);
        visual.lastFontSize = labelFontSize;
      }
      visibleNotes += 1;
    }
    this.hideUnusedNotes(visibleNotes);

    const ballPosition = resolveBallPosition(layout);
    ball.setPosition(ballPosition.x, ballPosition.y);
    updateBallTrail(ball.x, ball.y, layout.laneSpacing);
  }

  destroy(): void {
    for (const visual of this.notePool) {
      visual.shape.destroy();
      visual.fretLabel.destroy();
    }
    this.notePool = [];
  }

  private getOrCreateNoteVisual(index: number): NoteVisual {
    const existing = this.notePool[index];
    if (existing) return existing;

    const shape = new RoundedBox(this.scene, 0, 0, 10, 10, 0xffffff, 1, 5)
      .setDepth(260)
      .setVisible(false);
    const fretLabel = this.scene.add
      .text(0, 0, '', {
        color: '#0b1020',
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setDepth(261)
      .setVisible(false);

    const created: NoteVisual = {
      shape,
      fretLabel,
      lastFretText: '',
      lastFontSize: '',
      lastWidth: Number.NaN,
      lastHeight: Number.NaN,
      lastCornerRadius: Number.NaN,
      lastFillColor: -1,
      lastFillAlpha: Number.NaN,
      lastStrokeAlpha: Number.NaN,
      lastLabelAlpha: Number.NaN
    };
    this.notePool.push(created);
    return created;
  }

  private ensureTargetCache(targets: TargetNote[]): void {
    if (this.cachedTargets === targets && this.targetTicks.length === targets.length) {
      return;
    }

    this.cachedTargets = targets;
    this.targetTicks = new Array(targets.length);
    let maxDuration = 1;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      this.targetTicks[i] = target.tick;
      maxDuration = Math.max(maxDuration, Math.max(1, target.duration_ticks));
    }
    this.maxTargetDurationTicks = maxDuration;
  }

  private lowerBoundByTick(targetTick: number): number {
    let low = 0;
    let high = this.targetTicks.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (this.targetTicks[mid] < targetTick) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private upperBoundByTick(targetTick: number): number {
    let low = 0;
    let high = this.targetTicks.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (this.targetTicks[mid] <= targetTick) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private hideUnusedNotes(startIndex: number): void {
    for (let i = startIndex; i < this.notePool.length; i += 1) {
      const visual = this.notePool[i];
      visual.shape.setVisible(false);
      visual.fretLabel.setVisible(false);
    }
  }
}
