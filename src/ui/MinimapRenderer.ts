import Phaser from 'phaser';
import { FINGER_COLORS, PLAY_SCENE_MINIMAP_UPDATE_INTERVAL_MS } from '../app/config';
import type { TargetNote } from '../types/models';
import { RoundedBox } from './RoundedBox';
import type { SongMinimapLayout } from './playSceneTypes';

type MinimapNoteRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

export class MinimapRenderer {
  private background?: RoundedBox;
  private gridLayer?: Phaser.GameObjects.Graphics;
  private notesLayer?: Phaser.GameObjects.RenderTexture;
  private hitLayer?: Phaser.GameObjects.RenderTexture;
  private hitStampScratch?: Phaser.GameObjects.Graphics;
  private progressFill?: Phaser.GameObjects.Rectangle;
  private progressCursor?: Phaser.GameObjects.Line;
  private layout?: SongMinimapLayout;
  private cachedTargets?: TargetNote[];
  private cachedTargetTicks: number[] = [];
  private noteRects: MinimapNoteRect[] = [];
  private lastProgressPixelX = Number.NaN;
  private lastPassedTargetIndex = -1;
  private lastCorrectHitCount = -1;
  private lastProgressUpdateAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly scene: Phaser.Scene) {}

  setVisible(visible: boolean): void {
    this.background?.setVisible(visible);
    this.gridLayer?.setVisible(visible);
    this.notesLayer?.setVisible(visible);
    this.hitLayer?.setVisible(visible);
    this.progressFill?.setVisible(visible);
    this.progressCursor?.setVisible(visible);
  }

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
      this.gridLayer = this.scene.add.graphics().setDepth(287);
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
      this.gridLayer?.setDepth(287);
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

    this.recreateRasterLayers();

    this.progressFill?.setPosition(this.layout.innerLeft, this.layout.innerTop).setSize(1, this.layout.innerHeight);
    this.progressCursor?.setPosition(this.layout.innerLeft, this.layout.innerTop - 1);
    this.background?.setVisible(true);
    this.gridLayer?.setVisible(true);
    this.notesLayer?.setVisible(true);
    this.hitLayer?.setVisible(true);
    this.progressFill?.setVisible(true);
    this.progressCursor?.setVisible(true);
    this.resetProgressCache();
  }

  redrawStatic(targets: TargetNote[], ticksPerQuarter: number): void {
    if (!this.gridLayer || !this.layout || !this.notesLayer) return;
    const layout = this.layout;
    this.gridLayer.clear();

    this.gridLayer.lineStyle(1, 0x1e293b, 0.7);
    for (let i = 0; i <= 6; i += 1) {
      const y = layout.innerTop + i * layout.rowHeight;
      this.gridLayer.beginPath();
      this.gridLayer.moveTo(layout.innerLeft, y);
      this.gridLayer.lineTo(layout.innerLeft + layout.innerWidth, y);
      this.gridLayer.strokePath();
    }

    const measureTicks = ticksPerQuarter * 4;
    if (measureTicks > 0) {
      for (let tick = 0; tick <= layout.totalTicks; tick += measureTicks) {
        const markerX = layout.innerLeft + (tick / layout.totalTicks) * layout.innerWidth;
        const isMajor = tick % (measureTicks * 4) === 0;
        this.gridLayer.lineStyle(1, isMajor ? 0xfacc15 : 0x64748b, isMajor ? 0.7 : 0.35);
        this.gridLayer.beginPath();
        this.gridLayer.moveTo(markerX, layout.innerTop);
        this.gridLayer.lineTo(markerX, layout.innerTop + layout.innerHeight);
        this.gridLayer.strokePath();
      }
    }

    this.cacheNoteRects(targets, layout);
    this.notesLayer.clear();
    if (targets.length > 0) {
      const noteBatch = this.scene.add.graphics().setVisible(false);
      for (let i = 0; i < targets.length; i += 1) {
        const rect = this.noteRects[i];
        noteBatch.fillStyle(FINGER_COLORS[targets[i].finger] ?? 0xffffff, 0.9);
        noteBatch.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
      }
      this.notesLayer.draw(noteBatch, 0, 0);
      noteBatch.destroy();
    }

    this.hitLayer?.clear();
    this.resetProgressCache();
  }

  updateProgress(runtimeTick: number, targets: TargetNote[], correctlyHitTargetIds: ReadonlySet<string>): void {
    if (!this.layout || !this.progressFill || !this.progressCursor) return;
    const now = performance.now();
    if (now - this.lastProgressUpdateAtMs < PLAY_SCENE_MINIMAP_UPDATE_INTERVAL_MS) {
      return;
    }

    const layout = this.layout;
    const clampedTick = Phaser.Math.Clamp(runtimeTick, 0, layout.totalTicks);
    const progressX = layout.innerLeft + (clampedTick / layout.totalTicks) * layout.innerWidth;
    const progressPixelX = Math.round(progressX);
    const playedWidth = Math.max(1, progressPixelX - layout.innerLeft);

    if (progressPixelX !== this.lastProgressPixelX) {
      this.progressFill
        .setPosition(layout.innerLeft, layout.innerTop)
        .setSize(playedWidth, layout.innerHeight)
        .setDisplaySize(playedWidth, layout.innerHeight);
      this.progressCursor
        .setPosition(progressPixelX, layout.innerTop - 1)
        .setTo(0, 0, 0, layout.innerHeight + 2)
        .setVisible(true);
      this.lastProgressPixelX = progressPixelX;
    }

    const correctHitCount = correctlyHitTargetIds.size;
    const targetCacheChanged = this.ensureTargetTickCache(targets);
    const passedTargetIndex = this.findLastTargetIndexAtOrBeforeTick(clampedTick);

    if (!targetCacheChanged && passedTargetIndex === this.lastPassedTargetIndex && correctHitCount === this.lastCorrectHitCount) {
      this.lastProgressUpdateAtMs = now;
      return;
    }

    const canApplyIncremental =
      !targetCacheChanged &&
      correctHitCount === this.lastCorrectHitCount &&
      passedTargetIndex >= this.lastPassedTargetIndex;
    const passedTargetAdvanced = passedTargetIndex > this.lastPassedTargetIndex;

    if (canApplyIncremental) {
      if (passedTargetAdvanced) {
        for (let i = this.lastPassedTargetIndex + 1; i <= passedTargetIndex; i += 1) {
          if (!correctlyHitTargetIds.has(targets[i].id)) continue;
          this.drawCorrectHitNote(i);
        }
      }
    } else {
      this.rebuildCorrectHitLayer(passedTargetIndex, targets, correctlyHitTargetIds);
    }

    this.lastPassedTargetIndex = passedTargetIndex;
    this.lastCorrectHitCount = correctHitCount;
    this.lastProgressUpdateAtMs = now;
  }

  destroy(): void {
    this.background?.destroy();
    this.background = undefined;
    this.gridLayer?.destroy();
    this.gridLayer = undefined;
    this.notesLayer?.destroy();
    this.notesLayer = undefined;
    this.hitLayer?.destroy();
    this.hitLayer = undefined;
    this.hitStampScratch?.destroy();
    this.hitStampScratch = undefined;
    this.progressFill?.destroy();
    this.progressFill = undefined;
    this.progressCursor?.destroy();
    this.progressCursor = undefined;
    this.layout = undefined;
    this.noteRects = [];
    this.resetProgressCache();
  }

  private recreateRasterLayers(): void {
    const layout = this.layout;
    if (!layout) return;
    const rasterWidth = Math.max(1, Math.ceil(layout.innerWidth));
    const rasterHeight = Math.max(1, Math.ceil(layout.innerHeight));

    this.notesLayer?.destroy();
    this.notesLayer = this.scene.add
      .renderTexture(layout.innerLeft, layout.innerTop, rasterWidth, rasterHeight)
      .setOrigin(0, 0)
      .setDepth(287.4);
    this.notesLayer.clear();

    this.hitLayer?.destroy();
    this.hitLayer = this.scene.add
      .renderTexture(layout.innerLeft, layout.innerTop, rasterWidth, rasterHeight)
      .setOrigin(0, 0)
      .setDepth(288.5);
    this.hitLayer.clear();
  }

  private getSongMinimapNoteRect(
    target: TargetNote,
    layout: SongMinimapLayout
  ): MinimapNoteRect {
    const noteHeight = Math.max(1.4, layout.rowHeight * 0.62);
    const startX = (target.tick / layout.totalTicks) * layout.innerWidth;
    const endX = ((target.tick + Math.max(target.duration_ticks, 1)) / layout.totalTicks) * layout.innerWidth;
    const noteWidth = Math.max(1.6, endX - startX);
    const rowIndex = Phaser.Math.Clamp(target.string - 1, 0, 5);
    const y = rowIndex * layout.rowHeight + (layout.rowHeight - noteHeight) / 2;
    return {
      x: startX,
      y,
      width: noteWidth,
      height: noteHeight,
      radius: Math.min(2.5, noteHeight / 2)
    };
  }

  private cacheNoteRects(targets: TargetNote[], layout: SongMinimapLayout): void {
    this.noteRects = new Array(targets.length);
    for (let i = 0; i < targets.length; i += 1) {
      this.noteRects[i] = this.getSongMinimapNoteRect(targets[i], layout);
    }
  }

  private drawCorrectHitNote(index: number): void {
    const layer = this.hitLayer;
    const rect = this.noteRects[index];
    if (!layer || !rect) return;
    const scratch = this.getOrCreateHitStampScratch();
    scratch.clear();
    scratch.fillStyle(0x22c55e, 0.95);
    scratch.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
    layer.draw(scratch, 0, 0);
  }

  private rebuildCorrectHitLayer(
    passedTargetIndex: number,
    targets: TargetNote[],
    correctlyHitTargetIds: ReadonlySet<string>
  ): void {
    if (!this.hitLayer) return;
    this.hitLayer.clear();
    const endIndex = Math.min(passedTargetIndex, targets.length - 1);
    if (endIndex < 0) return;
    for (let i = 0; i <= endIndex; i += 1) {
      if (!correctlyHitTargetIds.has(targets[i].id)) continue;
      this.drawCorrectHitNote(i);
    }
  }

  private getOrCreateHitStampScratch(): Phaser.GameObjects.Graphics {
    if (this.hitStampScratch) return this.hitStampScratch;
    this.hitStampScratch = this.scene.add.graphics().setVisible(false);
    return this.hitStampScratch;
  }

  private ensureTargetTickCache(targets: TargetNote[]): boolean {
    if (this.cachedTargets === targets && this.cachedTargetTicks.length === targets.length) {
      return false;
    }
    this.cachedTargets = targets;
    this.cachedTargetTicks = new Array(targets.length);
    for (let i = 0; i < targets.length; i += 1) {
      this.cachedTargetTicks[i] = targets[i].tick;
    }
    this.lastPassedTargetIndex = -1;
    return true;
  }

  private findLastTargetIndexAtOrBeforeTick(tick: number): number {
    let low = 0;
    let high = this.cachedTargetTicks.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (this.cachedTargetTicks[mid] <= tick) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low - 1;
  }

  private resetProgressCache(): void {
    this.cachedTargets = undefined;
    this.cachedTargetTicks = [];
    this.lastProgressPixelX = Number.NaN;
    this.lastPassedTargetIndex = -1;
    this.lastCorrectHitCount = -1;
    this.lastProgressUpdateAtMs = Number.NEGATIVE_INFINITY;
    this.hitLayer?.clear();
  }
}
