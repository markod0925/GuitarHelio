import Phaser from 'phaser';
import { FINGER_COLORS } from '../app/config';
import type { TargetNote } from '../types/models';
import { RoundedBox } from './RoundedBox';
import type { SongMinimapLayout } from './playSceneTypes';

export class MinimapRenderer {
  private background?: RoundedBox;
  private staticLayer?: Phaser.GameObjects.Graphics;
  private hitOverlays: Phaser.GameObjects.Rectangle[] = [];
  private progressFill?: Phaser.GameObjects.Rectangle;
  private progressCursor?: Phaser.GameObjects.Line;
  private layout?: SongMinimapLayout;

  constructor(private readonly scene: Phaser.Scene) {}

  layoutMinimap(
    targets: TargetNote[],
    ticksPerQuarter: number,
    pauseButton: Phaser.GameObjects.GameObject | undefined,
    handReminderImage: Phaser.GameObjects.Image | undefined,
    pauseButtonSize: number,
    pauseButtonGap: number
  ): void {
    const { width, height } = this.scene.scale;
    const sideMargin = 14;
    const reservedLeft = pauseButton ? sideMargin + pauseButtonSize + pauseButtonGap : sideMargin;
    const handReminderGap = 18;
    const handReminderLeft = handReminderImage
      ? handReminderImage.x - handReminderImage.displayWidth
      : Number.POSITIVE_INFINITY;
    const minimapRightLimit = Math.min(width - sideMargin, handReminderLeft - handReminderGap);
    const minimapWidth = Math.max(1, minimapRightLimit - reservedLeft);
    const minimapHeight = Math.max(44, Math.floor(height * 0.084));
    const minimapX = reservedLeft;
    const minimapY = height - minimapHeight - 14;
    const centerX = minimapX + minimapWidth / 2;
    const centerY = minimapY + minimapHeight / 2;
    const innerPaddingX = 8;
    const innerPaddingY = 4;
    const innerWidth = Math.max(1, minimapWidth - innerPaddingX * 2);
    const innerHeight = Math.max(1, minimapHeight - innerPaddingY * 2);
    const lastTarget = targets.length > 0 ? targets[targets.length - 1] : undefined;
    const mapEndTick = lastTarget ? lastTarget.tick + Math.max(lastTarget.duration_ticks, 1) : ticksPerQuarter * 4;
    const totalTicks = Math.max(ticksPerQuarter * 4, mapEndTick);

    if (!this.background) {
      this.background = new RoundedBox(this.scene, centerX, centerY, minimapWidth, minimapHeight, 0x0b1228, 0.9)
        .setStrokeStyle(1, 0x334155, 0.85)
        .setDepth(286);
      this.staticLayer = this.scene.add.graphics().setDepth(287);
      this.progressFill = this.scene.add
        .rectangle(0, 0, 1, innerHeight, 0x22c55e, 0.18)
        .setOrigin(0, 0)
        .setDepth(288);
      this.progressCursor = this.scene.add
        .line(0, 0, 0, 0, 0, innerHeight + 2, 0xf8fafc, 0.95)
        .setOrigin(0, 0)
        .setLineWidth(2, 2)
        .setDepth(289);
    } else {
      this.background.setPosition(centerX, centerY).setBoxSize(minimapWidth, minimapHeight);
      this.staticLayer?.setDepth(287);
      this.progressFill?.setDepth(288);
      this.progressCursor?.setDepth(289);
    }

    this.layout = {
      x: minimapX,
      y: minimapY,
      width: minimapWidth,
      height: minimapHeight,
      innerLeft: minimapX + innerPaddingX,
      innerTop: minimapY + innerPaddingY,
      innerWidth,
      innerHeight,
      rowHeight: innerHeight / 6,
      totalTicks
    };

    this.progressFill?.setPosition(this.layout.innerLeft, this.layout.innerTop).setSize(1, this.layout.innerHeight);
    this.progressCursor?.setPosition(this.layout.innerLeft, this.layout.innerTop - 1);
  }

  redrawStatic(targets: TargetNote[], ticksPerQuarter: number): void {
    if (!this.staticLayer || !this.layout) return;
    const layout = this.layout;
    this.staticLayer.clear();

    this.staticLayer.lineStyle(1, 0x1e293b, 0.7);
    for (let i = 0; i <= 6; i += 1) {
      const y = layout.innerTop + i * layout.rowHeight;
      this.staticLayer.beginPath();
      this.staticLayer.moveTo(layout.innerLeft, y);
      this.staticLayer.lineTo(layout.innerLeft + layout.innerWidth, y);
      this.staticLayer.strokePath();
    }

    const measureTicks = ticksPerQuarter * 4;
    if (measureTicks > 0) {
      for (let tick = 0; tick <= layout.totalTicks; tick += measureTicks) {
        const markerX = layout.innerLeft + (tick / layout.totalTicks) * layout.innerWidth;
        const isMajor = tick % (measureTicks * 4) === 0;
        this.staticLayer.lineStyle(1, isMajor ? 0xfacc15 : 0x64748b, isMajor ? 0.7 : 0.35);
        this.staticLayer.beginPath();
        this.staticLayer.moveTo(markerX, layout.innerTop);
        this.staticLayer.lineTo(markerX, layout.innerTop + layout.innerHeight);
        this.staticLayer.strokePath();
      }
    }

    for (const target of targets) {
      const { x, y, width, height, radius } = this.getSongMinimapNoteRect(target, layout);
      this.staticLayer.fillStyle(FINGER_COLORS[target.finger] ?? 0xffffff, 0.9);
      this.staticLayer.fillRoundedRect(x, y, width, height, radius);
    }

    this.layoutHitOverlays(targets, layout);
  }

  updateProgress(runtimeTick: number, targets: TargetNote[], correctlyHitTargetIds: ReadonlySet<string>): void {
    if (!this.layout || !this.progressFill || !this.progressCursor) return;
    const layout = this.layout;
    const clampedTick = Phaser.Math.Clamp(runtimeTick, 0, layout.totalTicks);
    const progressX = layout.innerLeft + (clampedTick / layout.totalTicks) * layout.innerWidth;
    const playedWidth = Math.max(1, progressX - layout.innerLeft);

    this.progressFill
      .setPosition(layout.innerLeft, layout.innerTop)
      .setSize(playedWidth, layout.innerHeight)
      .setDisplaySize(playedWidth, layout.innerHeight);
    this.progressCursor
      .setPosition(progressX, layout.innerTop - 1)
      .setTo(0, 0, 0, layout.innerHeight + 2)
      .setVisible(true);

    for (let i = 0; i < targets.length; i += 1) {
      const overlay = this.hitOverlays[i];
      if (!overlay) continue;
      const target = targets[i];
      const show = target.tick <= clampedTick && correctlyHitTargetIds.has(target.id);
      overlay.setVisible(show);
    }
  }

  destroy(): void {
    this.background?.destroy();
    this.background = undefined;
    this.staticLayer?.destroy();
    this.staticLayer = undefined;
    for (const overlay of this.hitOverlays) {
      overlay.destroy();
    }
    this.hitOverlays = [];
    this.progressFill?.destroy();
    this.progressFill = undefined;
    this.progressCursor?.destroy();
    this.progressCursor = undefined;
    this.layout = undefined;
  }

  private getSongMinimapNoteRect(
    target: TargetNote,
    layout: SongMinimapLayout
  ): {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  } {
    const noteHeight = Math.max(1.4, layout.rowHeight * 0.62);
    const startX = layout.innerLeft + (target.tick / layout.totalTicks) * layout.innerWidth;
    const endX =
      layout.innerLeft + ((target.tick + Math.max(target.duration_ticks, 1)) / layout.totalTicks) * layout.innerWidth;
    const noteWidth = Math.max(1.6, endX - startX);
    const rowIndex = Phaser.Math.Clamp(target.string - 1, 0, 5);
    const y = layout.innerTop + rowIndex * layout.rowHeight + (layout.rowHeight - noteHeight) / 2;
    return {
      x: startX,
      y,
      width: noteWidth,
      height: noteHeight,
      radius: Math.min(2.5, noteHeight / 2)
    };
  }

  private layoutHitOverlays(targets: TargetNote[], layout: SongMinimapLayout): void {
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const rect = this.getSongMinimapNoteRect(target, layout);
      const overlay = this.getOrCreateHitOverlay(i);
      overlay
        .setPosition(rect.x, rect.y)
        .setSize(rect.width, rect.height)
        .setDisplaySize(rect.width, rect.height)
        .setVisible(false);
    }
    for (let i = targets.length; i < this.hitOverlays.length; i += 1) {
      this.hitOverlays[i].setVisible(false);
    }
  }

  private getOrCreateHitOverlay(index: number): Phaser.GameObjects.Rectangle {
    const existing = this.hitOverlays[index];
    if (existing) return existing;

    const overlay = this.scene.add
      .rectangle(0, 0, 1, 1, 0x22c55e, 0.95)
      .setOrigin(0, 0)
      .setDepth(288.5)
      .setVisible(false);
    this.hitOverlays.push(overlay);
    return overlay;
  }
}
