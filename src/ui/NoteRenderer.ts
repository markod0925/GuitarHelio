import Phaser from 'phaser';
import { FINGER_COLORS } from '../app/config';
import type { TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import type { Layout, MutablePoint } from './playSceneTypes';

type RedrawArgs = {
  ball?: Phaser.GameObjects.Arc;
  runtimeState: PlayState;
  currentTick: number;
  waitingTargetId?: string;
  targets: TargetNote[];
  correctlyHitTargetIds: ReadonlySet<string>;
  layout: Layout;
  resolveBallPosition: (layout: Layout) => MutablePoint;
  updateBallTrail: (x: number, y: number, laneSpacing: number) => void;
  setBallAndTrailVisible: (visible: boolean) => void;
};

type NoteVisual = {
  leftCap: Phaser.GameObjects.Arc;
  rightCap: Phaser.GameObjects.Arc;
  body: Phaser.GameObjects.Rectangle;
  fretLabel: Phaser.GameObjects.Text;
};

export class NoteRenderer {
  private notePool: NoteVisual[] = [];

  constructor(private readonly scene: Phaser.Scene) {}

  redrawTargetsAndBall(args: RedrawArgs): void {
    const {
      ball,
      runtimeState,
      currentTick,
      waitingTargetId,
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
    const labelFontSize = `${Math.max(11, Math.floor(layout.noteHeight * 0.95))}px`;

    let visibleNotes = 0;
    for (const target of targets) {
      const x = layout.hitLineX + (target.tick - currentTick) * layout.pxPerTick;
      const noteDiameter = layout.noteHeight;
      const width = Math.max(noteDiameter, target.duration_ticks * layout.pxPerTick);
      if (x + width < viewLeft || x > viewRight) continue;

      const y = layout.top + (target.string - 1) * layout.laneSpacing;
      const isWaitingTarget = waitingTargetId === target.id;
      const isPast = target.tick < currentTick;
      const alpha = isWaitingTarget ? 1 : isPast ? 0.28 : 0.95;
      const noteColor = correctlyHitTargetIds.has(target.id) ? 0x22c55e : (FINGER_COLORS[target.finger] ?? 0xffffff);
      const strokeAlpha = isWaitingTarget ? 1 : 0;
      const radius = noteDiameter / 2;
      const coreWidth = Math.max(0, width - noteDiameter);

      const visual = this.getOrCreateNoteVisual(visibleNotes);
      visual.leftCap
        .setPosition(x + radius, y)
        .setRadius(radius)
        .setFillStyle(noteColor, alpha)
        .setStrokeStyle(2, 0xffffff, strokeAlpha)
        .setVisible(true);
      if (coreWidth <= 0.5) {
        visual.body.setVisible(false);
        visual.rightCap.setVisible(false);
      } else {
        visual.body
          .setPosition(x + radius, y)
          .setSize(coreWidth, noteDiameter)
          .setDisplaySize(coreWidth, noteDiameter)
          .setFillStyle(noteColor, alpha)
          .setStrokeStyle(2, 0xffffff, strokeAlpha)
          .setVisible(true);
        visual.rightCap
          .setPosition(x + width - radius, y)
          .setRadius(radius)
          .setFillStyle(noteColor, alpha)
          .setStrokeStyle(2, 0xffffff, strokeAlpha)
          .setVisible(true);
      }
      visual.fretLabel
        .setPosition(x + radius, y)
        .setText(`${target.fret}`)
        .setFontSize(labelFontSize)
        .setAlpha(alpha)
        .setVisible(true);
      visibleNotes += 1;
    }
    this.hideUnusedNotes(visibleNotes);

    const ballPosition = resolveBallPosition(layout);
    ball.setPosition(ballPosition.x, ballPosition.y);
    updateBallTrail(ball.x, ball.y, layout.laneSpacing);
  }

  destroy(): void {
    for (const visual of this.notePool) {
      visual.leftCap.destroy();
      visual.rightCap.destroy();
      visual.body.destroy();
      visual.fretLabel.destroy();
    }
    this.notePool = [];
  }

  private getOrCreateNoteVisual(index: number): NoteVisual {
    const existing = this.notePool[index];
    if (existing) return existing;

    const leftCap = this.scene.add
      .circle(0, 0, 5, 0xffffff, 1)
      .setOrigin(0.5, 0.5)
      .setDepth(260)
      .setVisible(false);
    const rightCap = this.scene.add
      .circle(0, 0, 5, 0xffffff, 1)
      .setOrigin(0.5, 0.5)
      .setDepth(260)
      .setVisible(false);
    const body = this.scene.add
      .rectangle(0, 0, 10, 10, 0xffffff, 1)
      .setOrigin(0, 0.5)
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

    const created: NoteVisual = { leftCap, rightCap, body, fretLabel };
    this.notePool.push(created);
    return created;
  }

  private hideUnusedNotes(startIndex: number): void {
    for (let i = startIndex; i < this.notePool.length; i += 1) {
      const visual = this.notePool[i];
      visual.leftCap.setVisible(false);
      visual.rightCap.setVisible(false);
      visual.body.setVisible(false);
      visual.fretLabel.setVisible(false);
    }
  }
}
