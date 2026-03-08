import Phaser from 'phaser';
import {
  BALL_BOUNCE_AMPLITUDE_FACTOR,
  BALL_BOUNCE_AMPLITUDE_MAX_PX,
  BALL_BOUNCE_AMPLITUDE_MIN_PX,
  BALL_GHOST_TRAIL_COUNT,
  BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS,
  BALL_GHOST_TRAIL_SAMPLE_STEP
} from '../../../app/config';
import { PlayState, type TargetNote } from '../../../types/models';
import type { Layout, MutablePoint } from '../../playSceneTypes';
import type { PlaySceneContext } from './PlaySceneContext';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;
const BALL_TRAIL_REDRAW_MIN_INTERVAL_MS = 33;

export class BallController {
  constructor(private readonly scene: PlaySceneContext) {}

  redrawTargetsAndBall(): void {
    redrawTargetsAndBallImpl.call(this.scene);
  }

  writeBallPosition(x: number, y: number): MutablePoint {
    return writeBallPositionImpl.call(this.scene, x, y);
  }

  resolveBallPosition(layout: Layout): MutablePoint {
    return resolveBallPositionImpl.call(this.scene, layout);
  }

  resolvePrePlaybackBallPosition(layout: Layout, firstTarget: TargetNote, firstTargetSeconds: number): MutablePoint {
    return resolvePrePlaybackBallPositionImpl.call(this.scene, layout, firstTarget, firstTargetSeconds);
  }

  resolveIntroBallPosition(layout: Layout, firstTarget: TargetNote, progress: number, firstTargetSeconds: number): MutablePoint {
    return resolveIntroBallPositionImpl.call(this.scene, layout, firstTarget, progress, firstTargetSeconds);
  }

  findTargetIndexAtOrAfterSongSeconds(songSeconds: number): number {
    return findTargetIndexAtOrAfterSongSecondsImpl.call(this.scene, songSeconds);
  }

  getStringCenterY(layout: Layout, stringNumber: number): number {
    return getStringCenterYImpl.call(this.scene, layout, stringNumber);
  }

  resolveBallArcHeight(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
    return resolveBallArcHeightImpl.call(this.scene, layout, startY, endY, intervalSeconds);
  }

  resolveBallLateralExcursion(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
    return resolveBallLateralExcursionImpl.call(this.scene, layout, startY, endY, intervalSeconds);
  }

  createBallTrail(): void {
    createBallTrailImpl.call(this.scene);
  }

  destroyBallTrail(): void {
    destroyBallTrailImpl.call(this.scene);
  }

  pushBallTrailPoint(x: number, y: number): void {
    pushBallTrailPointImpl.call(this.scene, x, y);
  }

  updateBallTrail(x: number, y: number, laneSpacing: number): void {
    updateBallTrailImpl.call(this.scene, x, y, laneSpacing);
  }

  resetBallTrailHistory(): void {
    resetBallTrailHistoryImpl.call(this.scene);
  }

  drawBallDashedTrail(laneSpacing: number): void {
    drawBallDashedTrailImpl.call(this.scene, laneSpacing);
  }

  getOrCreateTrailSegment(index: number): { shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line } {
    return getOrCreateTrailSegmentImpl.call(this.scene, index);
  }

  hideUnusedTrailSegments(startIndex: number): void {
    hideUnusedTrailSegmentsImpl.call(this.scene, startIndex);
  }

  computeTrailPathLength(startIndex: number, endExclusiveIndex: number): number {
    return computeTrailPathLengthImpl.call(this.scene, startIndex, endExclusiveIndex);
  }

  setBallAndTrailVisible(visible: boolean): void {
    setBallAndTrailVisibleImpl.call(this.scene, visible);
  }
}

function redrawTargetsAndBallImpl(this: PlaySceneContext): void {
  const layout = this.layout();
  this.noteRenderer.redrawTargetsAndBall({
    ball: this.ball,
    runtimeState: this.runtime.state,
    currentTick: this.runtime.current_tick,
    waitingTargetId: this.runtime.state === PlayState.WaitingForHit ? this.runtime.waiting_target_id : undefined,
    targets: this.targets,
    correctlyHitTargetIds: this.correctlyHitTargetIds,
    layout,
    resolveBallPosition: (nextLayout: Layout) => this.resolveBallPosition(nextLayout),
    updateBallTrail: (x: number, y: number, spacing: number) => this.updateBallTrail(x, y, spacing),
    setBallAndTrailVisible: (visible: boolean) => this.setBallAndTrailVisible(visible)
  });
}

function writeBallPositionImpl(this: PlaySceneContext, x: number, y: number): MutablePoint {
  this.ballPositionScratch.x = x;
  this.ballPositionScratch.y = y;
  return this.ballPositionScratch;
}

function resolveBallPositionImpl(this: PlaySceneContext, layout: Layout): MutablePoint {
  if (this.targets.length === 0) {
    return this.writeBallPosition(layout.hitLineX, layout.top - Math.max(18, this.scale.height * 0.04));
  }

  const waitingTarget = this.runtime.state === PlayState.WaitingForHit ? this.targets[this.runtime.active_target_index] : undefined;
  if (waitingTarget) {
    return this.writeBallPosition(layout.hitLineX, this.getStringCenterY(layout, waitingTarget.string));
  }

  const firstTarget = this.targets[0];
  if (this.targetOnsetSeconds.length !== this.targets.length) {
    return this.writeBallPosition(layout.hitLineX, this.getStringCenterY(layout, firstTarget.string));
  }

  const firstTargetSeconds = Math.max(0.001, this.targetOnsetSeconds[0]);
  if (!this.playbackStarted) {
    return this.resolvePrePlaybackBallPosition(layout, firstTarget, firstTargetSeconds);
  }

  const songSecondsNow = this.getSongSecondsNow();
  if (songSecondsNow <= firstTargetSeconds) {
    const progressToFirstTarget = Phaser.Math.Clamp(songSecondsNow / firstTargetSeconds, 0, 1);
    return this.resolveIntroBallPosition(layout, firstTarget, progressToFirstTarget, firstTargetSeconds);
  }

  const nextTargetIndex = this.findTargetIndexAtOrAfterSongSeconds(songSecondsNow);
  if (nextTargetIndex === -1) {
    const lastTarget = this.targets[this.targets.length - 1];
    return this.writeBallPosition(layout.hitLineX, this.getStringCenterY(layout, lastTarget.string));
  }

  if (nextTargetIndex === 0) {
    return this.writeBallPosition(layout.hitLineX, this.getStringCenterY(layout, this.targets[0].string));
  }

  const previousTargetIndex = nextTargetIndex - 1;
  const previousTarget = this.targets[previousTargetIndex];
  const nextTarget = this.targets[nextTargetIndex];
  const previousTargetSeconds = this.targetOnsetSeconds[previousTargetIndex];
  const nextTargetSeconds = this.targetOnsetSeconds[nextTargetIndex];
  const intervalSeconds = Math.max(0.001, nextTargetSeconds - previousTargetSeconds);
  const progress = Phaser.Math.Clamp((songSecondsNow - previousTargetSeconds) / intervalSeconds, 0, 1);
  const startY = this.getStringCenterY(layout, previousTarget.string);
  const endY = this.getStringCenterY(layout, nextTarget.string);
  const arcHeight = this.resolveBallArcHeight(layout, startY, endY, intervalSeconds);
  const lateralExcursion = this.resolveBallLateralExcursion(layout, startY, endY, intervalSeconds);
  const linearY = Phaser.Math.Linear(startY, endY, progress);
  const arcOffset = 4 * arcHeight * progress * (1 - progress);

  return this.writeBallPosition(
    layout.hitLineX + Math.sin(progress * Math.PI) * lateralExcursion,
    linearY - arcOffset
  );
}

function resolvePrePlaybackBallPositionImpl(
  this: PlaySceneContext,
  layout: Layout,
  firstTarget: TargetNote,
  firstTargetSeconds: number
): MutablePoint {
  const sceneClass = this.constructor as PlaySceneStatics;
  if (this.prePlaybackStartAtMs === undefined) {
    return this.resolveIntroBallPosition(layout, firstTarget, 0, firstTargetSeconds);
  }

  const elapsedRatio = Phaser.Math.Clamp(
    1 - Math.max(0, this.prePlaybackStartAtMs - performance.now()) / sceneClass.PRE_PLAYBACK_DELAY_MS,
    0,
    1
  );
  return this.resolveIntroBallPosition(layout, firstTarget, elapsedRatio * 0.9, firstTargetSeconds);
}

function resolveIntroBallPositionImpl(
  this: PlaySceneContext,
  layout: Layout,
  firstTarget: TargetNote,
  progress: number,
  firstTargetSeconds: number
): MutablePoint {
  const clampedProgress = Phaser.Math.Clamp(progress, 0, 1);
  const thirdStringY = this.getStringCenterY(layout, 3);
  const targetY = this.getStringCenterY(layout, firstTarget.string);
  const startY = thirdStringY - BALL_BOUNCE_AMPLITUDE_MAX_PX;
  const introDuration = Math.max(0.2, firstTargetSeconds);
  const introLateralExcursion = this.resolveBallLateralExcursion(layout, thirdStringY, targetY, introDuration);

  return this.writeBallPosition(
    layout.hitLineX + Phaser.Math.Linear(introLateralExcursion, 0, clampedProgress),
    startY + (targetY - startY) * clampedProgress * clampedProgress
  );
}

function findTargetIndexAtOrAfterSongSecondsImpl(this: PlaySceneContext, songSeconds: number): number {
  if (this.targetOnsetSeconds.length === 0) return -1;

  let low = 0;
  let high = this.targetOnsetSeconds.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (this.targetOnsetSeconds[mid] >= songSeconds) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}

function getStringCenterYImpl(this: PlaySceneContext, layout: Layout, stringNumber: number): number {
  const laneIndex = Phaser.Math.Clamp(Math.round(stringNumber) - 1, 0, 5);
  return layout.top + laneIndex * layout.laneSpacing;
}

function resolveBallArcHeightImpl(
  this: PlaySceneContext,
  layout: Layout,
  startY: number,
  endY: number,
  intervalSeconds: number
): number {
  const baseAmplitude = Phaser.Math.Clamp(
    layout.laneSpacing * BALL_BOUNCE_AMPLITUDE_FACTOR,
    BALL_BOUNCE_AMPLITUDE_MIN_PX,
    BALL_BOUNCE_AMPLITUDE_MAX_PX
  );
  const laneDistance = Math.abs(endY - startY) / Math.max(layout.laneSpacing, 1);
  const laneFactor = Phaser.Math.Clamp(0.9 + laneDistance * 0.2, 0.9, 2.1);
  const timeFactor = Phaser.Math.Clamp(intervalSeconds / 0.45, 0.4, 1.35);
  return Phaser.Math.Clamp(
    baseAmplitude * laneFactor * timeFactor,
    BALL_BOUNCE_AMPLITUDE_MIN_PX * 0.75,
    BALL_BOUNCE_AMPLITUDE_MAX_PX
  );
}

function resolveBallLateralExcursionImpl(
  this: PlaySceneContext,
  layout: Layout,
  startY: number,
  endY: number,
  intervalSeconds: number
): number {
  const laneDistance = Math.abs(endY - startY) / Math.max(layout.laneSpacing, 1);
  const laneFactor = Phaser.Math.Clamp(0.7 + laneDistance * 0.16, 0.7, 1.45);
  const timeFactor = Phaser.Math.Clamp(intervalSeconds / 0.55, 0.42, 1.05);
  const baseExcursion = Math.max(layout.laneSpacing * 0.62, 16);
  const halfScreenBoundary = this.scale.width * 0.5;
  const maxExcursion = Math.max(0, halfScreenBoundary - layout.hitLineX - 6);
  const minExcursion = Math.min(28, maxExcursion);
  return Phaser.Math.Clamp(baseExcursion * laneFactor * timeFactor, minExcursion, maxExcursion);
}

function createBallTrailImpl(this: PlaySceneContext): void {
  this.destroyBallTrail();
}

function destroyBallTrailImpl(this: PlaySceneContext): void {
  for (const segment of this.ballTrailSegments) {
    segment.shadow.destroy();
    segment.main.destroy();
  }
  this.ballTrailSegments = [];
  this.ballTrailHistory.clear();
  this.hasLastBallTrailPoint = false;
  this.lastBallTrailX = 0;
  this.lastBallTrailY = 0;
  this.lastBallTrailRedrawAtMs = Number.NEGATIVE_INFINITY;
}

function pushBallTrailPointImpl(this: PlaySceneContext, x: number, y: number): void {
  this.ballTrailHistory.push(x, y);
}

function updateBallTrailImpl(this: PlaySceneContext, x: number, y: number, laneSpacing: number): void {
  let forceRedraw = false;
  if (!this.hasLastBallTrailPoint) {
    this.pushBallTrailPoint(x, y);
    this.hasLastBallTrailPoint = true;
    this.lastBallTrailX = x;
    this.lastBallTrailY = y;
    forceRedraw = true;
  } else {
    const distance = Phaser.Math.Distance.Between(this.lastBallTrailX, this.lastBallTrailY, x, y);
    if (distance > laneSpacing * 4) {
      this.ballTrailHistory.clear();
      this.pushBallTrailPoint(x, y);
      this.lastBallTrailX = x;
      this.lastBallTrailY = y;
      forceRedraw = true;
    } else if (distance > 0.15) {
      const interpolationSteps = distance > laneSpacing * 0.7 ? BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS : 1;
      for (let i = 1; i <= interpolationSteps; i += 1) {
        const t = i / interpolationSteps;
        this.pushBallTrailPoint(
          Phaser.Math.Linear(this.lastBallTrailX, x, t),
          Phaser.Math.Linear(this.lastBallTrailY, y, t)
        );
      }
      this.lastBallTrailX = x;
      this.lastBallTrailY = y;
    }
  }

  const now = performance.now();
  if (forceRedraw || now - this.lastBallTrailRedrawAtMs >= BALL_TRAIL_REDRAW_MIN_INTERVAL_MS) {
    this.drawBallDashedTrail(laneSpacing);
    this.lastBallTrailRedrawAtMs = now;
  }
}

function resetBallTrailHistoryImpl(this: PlaySceneContext): void {
  this.ballTrailHistory.clear();
  this.hasLastBallTrailPoint = false;
  this.lastBallTrailX = 0;
  this.lastBallTrailY = 0;
  this.lastBallTrailRedrawAtMs = Number.NEGATIVE_INFINITY;
  this.hideUnusedTrailSegments(0);
}

function drawBallDashedTrailImpl(this: PlaySceneContext, laneSpacing: number): void {
  const historySize = this.ballTrailHistory.size;
  if (historySize < 3) {
    this.hideUnusedTrailSegments(0);
    return;
  }

  const maxPointCount = Math.max(28, BALL_GHOST_TRAIL_COUNT * BALL_GHOST_TRAIL_SAMPLE_STEP * 8);
  const startIndex = Math.max(0, historySize - maxPointCount);
  const pathLength = this.computeTrailPathLength(startIndex, historySize);
  if (pathLength <= 0.001) {
    this.hideUnusedTrailSegments(0);
    return;
  }

  const dashLength = Phaser.Math.Clamp(laneSpacing * 0.3, 7, 14);
  const gapLength = Phaser.Math.Clamp(laneSpacing * 0.2, 5, 11);
  const headClearDistance = dashLength * 1.8;
  const nearThickness = Phaser.Math.Clamp(laneSpacing * 0.09, 2.8, 5.2);
  const farThickness = Math.max(1.5, nearThickness * 0.55);

  let accumulatedDistance = 0;
  let segmentIndex = 0;
  for (let i = startIndex + 1; i < historySize; i += 1) {
    const startX = this.ballTrailHistory.getX(i - 1);
    const startY = this.ballTrailHistory.getY(i - 1);
    const endX = this.ballTrailHistory.getX(i);
    const endY = this.ballTrailHistory.getY(i);
    const segmentLength = Phaser.Math.Distance.Between(startX, startY, endX, endY);
    if (segmentLength <= 0.0001) continue;

    let localOffset = 0;
    while (localOffset < segmentLength) {
      const dashStart = localOffset;
      const dashEnd = Math.min(localOffset + dashLength, segmentLength);
      const absoluteDashEnd = accumulatedDistance + dashEnd;
      if (absoluteDashEnd >= pathLength - headClearDistance) {
        break;
      }

      const drawStartT = dashStart / segmentLength;
      const drawEndT = dashEnd / segmentLength;
      const x0 = Phaser.Math.Linear(startX, endX, drawStartT);
      const y0 = Phaser.Math.Linear(startY, endY, drawStartT);
      const x1 = Phaser.Math.Linear(startX, endX, drawEndT);
      const y1 = Phaser.Math.Linear(startY, endY, drawEndT);

      const alphaT = Phaser.Math.Clamp(absoluteDashEnd / Math.max(0.001, pathLength - headClearDistance), 0, 1);
      const alpha = Phaser.Math.Linear(0.12, 0.48, alphaT);
      const thickness = Phaser.Math.Linear(farThickness, nearThickness, alphaT);

      const segment = this.getOrCreateTrailSegment(segmentIndex);
      segment.shadow
        .setTo(x0, y0, x1, y1)
        .setLineWidth(thickness + 1.2, thickness + 1.2)
        .setStrokeStyle(thickness + 1.2, 0x1f2937, alpha * 0.24)
        .setVisible(true);
      segment.main
        .setTo(x0, y0, x1, y1)
        .setLineWidth(thickness, thickness)
        .setStrokeStyle(thickness, 0xd1d5db, alpha)
        .setVisible(true);
      segmentIndex += 1;

      localOffset += dashLength + gapLength;
    }
    accumulatedDistance += segmentLength;
  }
  this.hideUnusedTrailSegments(segmentIndex);
}

function getOrCreateTrailSegmentImpl(this: PlaySceneContext, index: number): { shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line } {
  const existing = this.ballTrailSegments[index];
  if (existing) return existing;

  const shadow = this.add
    .line(0, 0, 0, 0, 0, 0, 0x1f2937, 0.2)
    .setOrigin(0, 0)
    .setDepth(250)
    .setVisible(false);
  const main = this.add
    .line(0, 0, 0, 0, 0, 0, 0xd1d5db, 0.2)
    .setOrigin(0, 0)
    .setDepth(251)
    .setVisible(false);
  const created = { shadow, main };
  this.ballTrailSegments.push(created);
  return created;
}

function hideUnusedTrailSegmentsImpl(this: PlaySceneContext, startIndex: number): void {
  for (let i = startIndex; i < this.ballTrailSegments.length; i += 1) {
    this.ballTrailSegments[i].shadow.setVisible(false);
    this.ballTrailSegments[i].main.setVisible(false);
  }
}

function computeTrailPathLengthImpl(this: PlaySceneContext, startIndex: number, endExclusiveIndex: number): number {
  let length = 0;
  for (let i = startIndex + 1; i < endExclusiveIndex; i += 1) {
    length += Phaser.Math.Distance.Between(
      this.ballTrailHistory.getX(i - 1),
      this.ballTrailHistory.getY(i - 1),
      this.ballTrailHistory.getX(i),
      this.ballTrailHistory.getY(i)
    );
  }
  return length;
}

function setBallAndTrailVisibleImpl(this: PlaySceneContext, visible: boolean): void {
  this.ball?.setVisible(visible);
  if (!visible) {
    this.ballTrailHistory.clear();
    this.hasLastBallTrailPoint = false;
    this.lastBallTrailX = 0;
    this.lastBallTrailY = 0;
    this.lastBallTrailRedrawAtMs = Number.NEGATIVE_INFINITY;
    this.hideUnusedTrailSegments(0);
  } else {
    for (const segment of this.ballTrailSegments) {
      if (!segment.shadow.visible && !segment.main.visible) continue;
      segment.shadow.setVisible(true);
      segment.main.setVisible(true);
    }
  }
}
