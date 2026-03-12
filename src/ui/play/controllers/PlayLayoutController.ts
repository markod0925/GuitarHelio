import Phaser from 'phaser';
import { PlayState } from '../../../types/models';
import { RoundedBox } from '../../RoundedBox';
import type { PlaySceneContext } from './PlaySceneContext';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;

export class PlayLayoutController {
  constructor(private readonly scene: PlaySceneContext) {}

  drawStaticLanes(): void {
    drawStaticLanesImpl.call(this.scene);
  }

  layoutSongMinimap(): void {
    layoutSongMinimapImpl.call(this.scene);
  }

  layoutPauseButton(): void {
    layoutPauseButtonImpl.call(this.scene);
  }

  createMultiplierWidget(): void {
    createMultiplierWidgetImpl.call(this.scene);
  }

  layoutMultiplierWidget(): void {
    layoutMultiplierWidgetImpl.call(this.scene);
  }

  updateMultiplierWidget(nowMs: number, bpm: number | undefined): void {
    updateMultiplierWidgetImpl.call(this.scene, nowMs, bpm);
  }

  createPlaybackSpeedSlider(): void {
    createPlaybackSpeedSliderImpl.call(this.scene);
  }

  layoutPlaybackSpeedSlider(): void {
    layoutPlaybackSpeedSliderImpl.call(this.scene);
  }

  applyPlaybackSpeedFromSliderX(pointerX: number, previewOnly = false): void {
    applyPlaybackSpeedFromSliderXImpl.call(this.scene, pointerX, previewOnly);
  }

  beginPlaybackSpeedAdjustment(pointerId: number): void {
    beginPlaybackSpeedAdjustmentImpl.call(this.scene, pointerId);
  }

  handlePlaybackSpeedPointerUp(pointer: Phaser.Input.Pointer): void {
    handlePlaybackSpeedPointerUpImpl.call(this.scene, pointer);
  }

  setPendingPlaybackSpeed(speedMultiplier: number): void {
    setPendingPlaybackSpeedImpl.call(this.scene, speedMultiplier);
  }

  setPlaybackSpeed(speedMultiplier: number): void {
    setPlaybackSpeedImpl.call(this.scene, speedMultiplier);
  }

  updatePlaybackSpeedSliderVisuals(): void {
    updatePlaybackSpeedSliderVisualsImpl.call(this.scene);
  }

  layoutHandReminder(): void {
    layoutHandReminderImpl.call(this.scene);
  }
}

function getSceneClass(scene: PlaySceneContext): PlaySceneStatics {
  return scene.constructor as PlaySceneStatics;
}

function drawStaticLanesImpl(this: PlaySceneContext): void {
  if (!this.laneLayer || !this.statusText || !this.liveScoreText || !this.feedbackMessageText) return;

  const layout = this.layout();
  this.laneLayer.clear();

  const { width, height } = this.scale;
  this.laneLayer.fillGradientStyle(0x040b1f, 0x0b1a45, 0x030915, 0x071632, 1, 1, 1, 1);
  this.laneLayer.fillRect(0, 0, width, height);

  this.laneLayer.fillStyle(0x09122a, 0.75);
  this.laneLayer.fillRect(0, 0, width, layout.top - 8);
  this.laneLayer.fillStyle(0x0c1938, 0.82);
  this.laneLayer.fillRect(0, layout.top - 8, width, height - (layout.top - 8));

  const fretTopY = layout.top + 6;
  const fretBottomY = layout.bottom + 28;
  const fretboardWidth = layout.right - layout.left;
  const topInset = Math.max(120, fretboardWidth * 0.18);
  const bottomExpand = Math.max(36, fretboardWidth * 0.08);
  const fretTopLeft = layout.left + topInset;
  const fretTopRight = layout.right - topInset;
  const fretBottomLeft = layout.left - bottomExpand;
  const fretBottomRight = layout.right + bottomExpand;

  this.laneLayer.fillStyle(0x1f2937, 0.92);
  this.laneLayer.beginPath();
  this.laneLayer.moveTo(fretTopLeft, fretTopY);
  this.laneLayer.lineTo(fretTopRight, fretTopY);
  this.laneLayer.lineTo(fretBottomRight, fretBottomY);
  this.laneLayer.lineTo(fretBottomLeft, fretBottomY);
  this.laneLayer.closePath();
  this.laneLayer.fillPath();

  this.laneLayer.lineStyle(1.2, 0x64748b, 0.72);
  for (let i = 0; i < 16; i += 1) {
    const t = i / 15;
    const xTop = Phaser.Math.Linear(fretTopLeft, fretTopRight, t);
    const xBottom = Phaser.Math.Linear(fretBottomLeft, fretBottomRight, t);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(xTop, fretTopY);
    this.laneLayer.lineTo(xBottom, fretBottomY);
    this.laneLayer.strokePath();
  }

  const sideBlockCount = 6;
  const sideTopBlockWidth = Math.max(44, fretboardWidth * 0.06);
  const sideBottomBlockWidth = Math.max(58, fretboardWidth * 0.08);
  const sideBaseColor = 0x182437;
  for (let i = 0; i < sideBlockCount; i += 1) {
    const prevTopOffset = i * sideTopBlockWidth;
    const nextTopOffset = (i + 1) * sideTopBlockWidth;
    const prevBottomOffset = i * sideBottomBlockWidth;
    const nextBottomOffset = (i + 1) * sideBottomBlockWidth;
    const alpha = 0.8 - i * 0.12;

    this.laneLayer.fillStyle(sideBaseColor, alpha);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(fretTopLeft - prevTopOffset, fretTopY);
    this.laneLayer.lineTo(fretTopLeft - nextTopOffset, fretTopY);
    this.laneLayer.lineTo(fretBottomLeft - nextBottomOffset, fretBottomY);
    this.laneLayer.lineTo(fretBottomLeft - prevBottomOffset, fretBottomY);
    this.laneLayer.closePath();
    this.laneLayer.fillPath();

    this.laneLayer.fillStyle(sideBaseColor, alpha);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(fretTopRight + prevTopOffset, fretTopY);
    this.laneLayer.lineTo(fretTopRight + nextTopOffset, fretTopY);
    this.laneLayer.lineTo(fretBottomRight + nextBottomOffset, fretBottomY);
    this.laneLayer.lineTo(fretBottomRight + prevBottomOffset, fretBottomY);
    this.laneLayer.closePath();
    this.laneLayer.fillPath();

    this.laneLayer.lineStyle(1, 0x64748b, 0.48);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(fretTopLeft - nextTopOffset, fretTopY);
    this.laneLayer.lineTo(fretBottomLeft - nextBottomOffset, fretBottomY);
    this.laneLayer.strokePath();

    this.laneLayer.beginPath();
    this.laneLayer.moveTo(fretTopRight + nextTopOffset, fretTopY);
    this.laneLayer.lineTo(fretBottomRight + nextBottomOffset, fretBottomY);
    this.laneLayer.strokePath();
  }

  const stringStyles = [
    { width: 2.2, color: 0xdbeafe, alpha: 0.9 },
    { width: 2.3, color: 0xdbeafe, alpha: 0.9 },
    { width: 2.4, color: 0xdbeafe, alpha: 0.9 },
    { width: 2.6, color: 0xfacc15, alpha: 0.95 },
    { width: 3.3, color: 0xfacc15, alpha: 0.95 },
    { width: 4.1, color: 0xfacc15, alpha: 0.95 }
  ] as const;
  for (let i = 0; i < 6; i += 1) {
    const style = stringStyles[i];
    const y = layout.top + i * layout.laneSpacing + 10;
    this.laneLayer.lineStyle(style.width, style.color, style.alpha);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(0, y);
    this.laneLayer.lineTo(width, y);
    this.laneLayer.strokePath();
  }

  this.laneLayer.lineStyle(2.6, 0xfef3c7, 0.95);
  this.laneLayer.beginPath();
  this.laneLayer.moveTo(layout.hitLineX, layout.top - 18);
  this.laneLayer.lineTo(layout.hitLineX, layout.bottom + 26);
  this.laneLayer.strokePath();

  this.drawTopStarfield();
  this.layoutHandReminder();
  this.layoutPauseButton();
  this.layoutPlaybackSpeedSlider();
  this.layoutSongMinimap();
  this.redrawSongMinimapStatic();
  this.updateSongMinimapProgress();

  this.layoutMultiplierWidget();
  this.liveScoreText.setPosition(layout.right, 16);
  const feedbackFontPx = Math.max(30, Math.floor(width * 0.047));
  const sliderBottomY = this.playbackSpeedPanel ? this.playbackSpeedPanel.y + this.playbackSpeedPanel.height / 2 : 46;
  const feedbackTopMinY = sliderBottomY + 6;
  const feedbackTopMaxY = Math.max(feedbackTopMinY, layout.top - feedbackFontPx - 8);
  const feedbackTopY = feedbackTopMinY + (feedbackTopMaxY - feedbackTopMinY) * 0.5;
  this.feedbackMessageText
    .setPosition(width / 2, feedbackTopY)
    .setFontSize(`${feedbackFontPx}px`);
  if (this.debugButton && this.debugButtonLabel) {
    this.debugButton.setPosition(layout.right - 62, 52);
    this.debugButtonLabel.setPosition(this.debugButton.x, this.debugButton.y);
  }
}

function createMultiplierWidgetImpl(this: PlaySceneContext): void {
  if (!this.statusText || this.multiplierShipHull) return;

  this.multiplierShipEngineGlow = this.add
    .ellipse(0, 0, 20, 10, 0x38bdf8, 0.45)
    .setDepth(304);
  this.multiplierShipWingTop = this.add
    .triangle(0, 0, 0, 0, 18, 0, 7, 12, 0x1d4ed8, 0.9)
    .setDepth(305);
  this.multiplierShipWingBottom = this.add
    .triangle(0, 0, 0, 12, 18, 12, 7, 0, 0x1d4ed8, 0.9)
    .setDepth(305);
  this.multiplierShipHull = this.add
    .triangle(0, 0, 0, 0, 32, 9, 0, 18, 0x93c5fd, 0.95)
    .setDepth(306);
  this.multiplierShipCockpit = this.add
    .circle(0, 0, 4, 0xf8fafc, 0.95)
    .setDepth(307);
  this.statusText.setDepth(308);
}

function layoutMultiplierWidgetImpl(this: PlaySceneContext): void {
  if (!this.statusText || !this.multiplierShipHull) return;

  const layout = this.layout();
  const boundsX = layout.left - 6;
  const boundsY = 10;
  const boundsWidth = Math.max(108, Math.floor(this.scale.width * 0.14));
  const minBottomY = boundsY + Math.max(72, Math.floor(this.scale.height * 0.12));
  const nearFretboardY = layout.top + Math.max(10, Math.floor(layout.laneSpacing * 0.18));
  const boundsBottom = Math.max(minBottomY, nearFretboardY);
  const boundsHeight = Math.max(46, boundsBottom - boundsY);
  this.multiplierShipBounds = new Phaser.Geom.Rectangle(boundsX, boundsY, boundsWidth, boundsHeight);

  if (this.multiplierShipX === 0 && this.multiplierShipY === 0) {
    this.multiplierShipX = boundsX + boundsWidth * 0.5;
    this.multiplierShipY = boundsY + boundsHeight * 0.5;
    this.multiplierShipTargetX = this.multiplierShipX;
    this.multiplierShipTargetY = this.multiplierShipY;
  } else {
    this.multiplierShipX = Phaser.Math.Clamp(this.multiplierShipX, boundsX, boundsX + boundsWidth);
    this.multiplierShipY = Phaser.Math.Clamp(this.multiplierShipY, boundsY, boundsY + boundsHeight);
    this.multiplierShipTargetX = Phaser.Math.Clamp(this.multiplierShipTargetX, boundsX, boundsX + boundsWidth);
    this.multiplierShipTargetY = Phaser.Math.Clamp(this.multiplierShipTargetY, boundsY, boundsY + boundsHeight);
  }

  setMultiplierShipPosition(this, this.multiplierShipX, this.multiplierShipY);
}

function updateMultiplierWidgetImpl(this: PlaySceneContext, nowMs: number, bpm: number | undefined): void {
  if (!this.statusText || !this.multiplierShipHull || !this.multiplierShipBounds) return;

  const clampedBpm = Phaser.Math.Clamp(bpm ?? 96, 40, 220);
  const beatPeriodMs = 60000 / clampedBpm;
  const beatPhase = (nowMs % beatPeriodMs) / beatPeriodMs;
  const pulse = Math.pow(Math.max(0, Math.cos(beatPhase * Math.PI * 2)), 2);
  const shipPulse = 0.2 + pulse * 0.8;

  if (nowMs >= this.multiplierShipRetargetAtMs) {
    this.multiplierShipTargetX = Phaser.Math.Between(
      Math.floor(this.multiplierShipBounds.left),
      Math.floor(this.multiplierShipBounds.right)
    );
    this.multiplierShipTargetY = Phaser.Math.Between(
      Math.floor(this.multiplierShipBounds.top),
      Math.floor(this.multiplierShipBounds.bottom)
    );
    this.multiplierShipRetargetAtMs = nowMs + Phaser.Math.Between(850, 2000);
  }

  this.multiplierShipX = Phaser.Math.Linear(this.multiplierShipX, this.multiplierShipTargetX, 0.03);
  this.multiplierShipY = Phaser.Math.Linear(this.multiplierShipY, this.multiplierShipTargetY, 0.03);
  setMultiplierShipPosition(this, this.multiplierShipX, this.multiplierShipY);

  const heading = Phaser.Math.Clamp((this.multiplierShipTargetX - this.multiplierShipX) / 34, -0.28, 0.28);
  const wingColor = blendColor(0x1d4ed8, 0x60a5fa, shipPulse * 0.65);
  const hullColor = blendColor(0x93c5fd, 0xe0f2fe, shipPulse * 0.72);
  const cockpitColor = blendColor(0xf8fafc, 0xffffff, shipPulse * 0.45);
  const shipScale = 1 + pulse * 0.1;
  const labelScale = 1 + pulse * 0.18;

  this.multiplierShipWingTop?.setFillStyle(wingColor, 0.92).setScale(shipScale);
  this.multiplierShipWingBottom?.setFillStyle(wingColor, 0.92).setScale(shipScale);
  this.multiplierShipHull.setFillStyle(hullColor, 0.96).setScale(shipScale);
  this.multiplierShipCockpit?.setFillStyle(cockpitColor, 0.98).setScale(shipScale);
  this.multiplierShipEngineGlow?.setFillStyle(blendColor(0x38bdf8, 0xa5f3fc, shipPulse), 0.26 + pulse * 0.48);

  this.multiplierShipHull.setRotation(heading);
  this.multiplierShipWingTop?.setRotation(heading * 0.7);
  this.multiplierShipWingBottom?.setRotation(heading * 0.7);
  this.multiplierShipCockpit?.setRotation(heading * 0.2);
  this.multiplierShipEngineGlow?.setScale(1 + pulse * 0.2).setAlpha(0.24 + pulse * 0.42 + Math.abs(Math.sin(nowMs * 0.014)) * 0.07);
  this.statusText.setScale(labelScale);
}

function setMultiplierShipPosition(scene: PlaySceneContext, x: number, y: number): void {
  scene.multiplierShipEngineGlow?.setPosition(x - 14, y + 1);
  scene.multiplierShipWingTop?.setPosition(x - 10, y - 8);
  scene.multiplierShipWingBottom?.setPosition(x - 10, y - 4);
  scene.multiplierShipHull?.setPosition(x - 6, y - 8);
  scene.multiplierShipCockpit?.setPosition(x + 1, y + 1);
  scene.statusText?.setPosition(x + 4, y + 1);
}

function blendColor(from: number, to: number, mix: number): number {
  const t = Phaser.Math.Clamp(mix, 0, 1);
  const fromR = (from >> 16) & 0xff;
  const fromG = (from >> 8) & 0xff;
  const fromB = from & 0xff;
  const toR = (to >> 16) & 0xff;
  const toG = (to >> 8) & 0xff;
  const toB = to & 0xff;
  const r = Math.round(fromR + (toR - fromR) * t);
  const g = Math.round(fromG + (toG - fromG) * t);
  const b = Math.round(fromB + (toB - fromB) * t);
  return (r << 16) | (g << 8) | b;
}

function layoutSongMinimapImpl(this: PlaySceneContext): void {
  const sceneClass = getSceneClass(this);
  this.minimapRenderer.layoutMinimap(
    this.targets,
    this.ticksPerQuarter,
    this.pauseButton,
    this.handReminderImage,
    sceneClass.PAUSE_BUTTON_SIZE,
    sceneClass.PAUSE_BUTTON_GAP
  );
}

function layoutPauseButtonImpl(this: PlaySceneContext): void {
  const sceneClass = getSceneClass(this);
  if (!this.pauseButton || !this.pauseButtonLeftBar || !this.pauseButtonRightBar || !this.pauseButtonPlayIcon) return;

  const sideMargin = 14;
  const centerX = sideMargin + sceneClass.PAUSE_BUTTON_SIZE / 2;
  const centerY = this.scale.height - sideMargin - sceneClass.PAUSE_BUTTON_SIZE / 2 - 4;
  const barOffsetX = Math.max(4, Math.floor(sceneClass.PAUSE_BUTTON_SIZE * 0.15));
  const barHeight = Math.max(14, Math.floor(sceneClass.PAUSE_BUTTON_SIZE * 0.48));
  const barWidth = Math.max(4, Math.floor(sceneClass.PAUSE_BUTTON_SIZE * 0.14));
  const playIconOffsetX = Math.max(4, Math.floor(sceneClass.PAUSE_BUTTON_SIZE * 0.3));
  const playIconOffsetY = Math.max(4, Math.floor(sceneClass.PAUSE_BUTTON_SIZE * 0.3));

  this.pauseButton
    .setPosition(centerX, centerY)
    .setDepth(289);
  this.pauseButtonLeftBar
    .setPosition(centerX - barOffsetX, centerY)
    .setSize(barWidth, barHeight)
    .setDisplaySize(barWidth, barHeight)
    .setDepth(290);
  this.pauseButtonRightBar
    .setPosition(centerX + barOffsetX, centerY)
    .setSize(barWidth, barHeight)
    .setDisplaySize(barWidth, barHeight)
    .setDepth(290);
  this.pauseButtonPlayIcon
    .setPosition(centerX + playIconOffsetX, centerY + playIconOffsetY)
    .setScale(Math.max(1, sceneClass.PAUSE_BUTTON_SIZE / 24))
    .setDepth(290);
}

function createPlaybackSpeedSliderImpl(this: PlaySceneContext): void {
  if (this.playbackSpeedPanel || this.playbackSpeedTrack || this.playbackSpeedKnob) return;

  this.playbackSpeedPanel = new RoundedBox(this, 0, 0, 10, 10, 0x0b1228, 0.9)
    .setStrokeStyle(1, 0x334155, 0.86)
    .setDepth(292);
  this.playbackSpeedLabel = this.add
    .text(0, 0, 'Speed', {
      color: '#cbd5e1',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(12, Math.floor(this.scale.width * 0.0125))}px`
    })
    .setOrigin(0, 0.5)
    .setDepth(293);
  this.playbackSpeedValueText = this.add
    .text(0, 0, '100%', {
      color: '#f8fafc',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(12, Math.floor(this.scale.width * 0.0125))}px`
    })
    .setOrigin(1, 0.5)
    .setDepth(293);
  this.playbackSpeedTrack = this.add
    .rectangle(0, 0, 100, 8, 0x334155, 0.95)
    .setStrokeStyle(1, 0x64748b, 0.86)
    .setInteractive({ useHandCursor: true })
    .setDepth(293);
  this.playbackSpeedTrack.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    this.applyPlaybackSpeedFromSliderX(pointer.x);
  });
  this.playbackSpeedKnob = this.add
    .circle(0, 0, 8, 0xf8fafc, 1)
    .setStrokeStyle(2, 0x38bdf8, 1)
    .setInteractive({ useHandCursor: true, draggable: true })
    .setDepth(294);
  this.input.setDraggable(this.playbackSpeedKnob);
  this.playbackSpeedKnob.on('drag', (_pointer: Phaser.Input.Pointer, dragX: number) => {
    this.applyPlaybackSpeedFromSliderX(dragX, true);
  });
  this.playbackSpeedKnob.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    this.beginPlaybackSpeedAdjustment(pointer.id);
    this.applyPlaybackSpeedFromSliderX(pointer.x, true);
  });
  this.input.on('pointerup', this.handlePlaybackSpeedPointerUp, this);
  this.input.on('pointerupoutside', this.handlePlaybackSpeedPointerUp, this);

  this.layoutPlaybackSpeedSlider();
  this.updatePlaybackSpeedSliderVisuals();
}

function layoutPlaybackSpeedSliderImpl(this: PlaySceneContext): void {
  if (
    !this.playbackSpeedPanel ||
    !this.playbackSpeedTrack ||
    !this.playbackSpeedKnob ||
    !this.playbackSpeedLabel ||
    !this.playbackSpeedValueText
  ) {
    return;
  }

  const { width } = this.scale;
  const panelWidth = Math.min(360, width * 0.4);
  const panelHeight = 42;
  const centerX = width / 2;
  const centerY = 28;
  const sidePadding = 12;
  const labelWidth = Math.max(52, Math.floor(panelWidth * 0.2));
  const valueWidth = Math.max(52, Math.floor(panelWidth * 0.2));
  const trackWidth = Math.max(90, panelWidth - sidePadding * 2 - labelWidth - valueWidth - 16);

  this.playbackSpeedPanel
    .setPosition(centerX, centerY)
    .setBoxSize(panelWidth, panelHeight);
  this.playbackSpeedTrack
    .setPosition(centerX - panelWidth / 2 + sidePadding + labelWidth + 8 + trackWidth / 2, centerY)
    .setSize(trackWidth, 8)
    .setDisplaySize(trackWidth, 8);
  this.playbackSpeedKnob.setRadius(Math.max(7, Math.floor(panelHeight * 0.23)));
  this.playbackSpeedLabel
    .setPosition(centerX - panelWidth / 2 + sidePadding, centerY)
    .setFontSize(`${Math.max(12, Math.floor(width * 0.0125))}px`);
  this.playbackSpeedValueText
    .setPosition(centerX + panelWidth / 2 - sidePadding, centerY)
    .setFontSize(`${Math.max(12, Math.floor(width * 0.0125))}px`);

  this.updatePlaybackSpeedSliderVisuals();
}

function applyPlaybackSpeedFromSliderXImpl(this: PlaySceneContext, pointerX: number, previewOnly = false): void {
  const sceneClass = getSceneClass(this);
  if (this.isWaitingPausedByButton()) return;
  if (!this.playbackSpeedTrack) return;
  const left = this.playbackSpeedTrack.x - this.playbackSpeedTrack.displayWidth / 2;
  const ratio = Phaser.Math.Clamp((pointerX - left) / this.playbackSpeedTrack.displayWidth, 0, 1);
  const speed =
    sceneClass.PLAYBACK_SPEED_MIN + ratio * (sceneClass.PLAYBACK_SPEED_MAX - sceneClass.PLAYBACK_SPEED_MIN);
  if (previewOnly) {
    this.setPendingPlaybackSpeed(speed);
    return;
  }
  this.setPlaybackSpeed(speed);
}

function beginPlaybackSpeedAdjustmentImpl(this: PlaySceneContext, pointerId: number): void {
  this.playbackSpeedAdjusting = true;
  this.playbackSpeedDragPointerId = pointerId;
  this.pendingPlaybackSpeedMultiplier = this.playbackSpeedMultiplier;
  this.playbackWasRunningBeforeSpeedAdjust =
    this.playbackMode === 'audio' &&
    this.playbackStarted &&
    this.runtime.state === PlayState.Playing &&
    !this.pauseOverlay &&
    !this.playbackPausedByButton;
  if (!this.playbackWasRunningBeforeSpeedAdjust) return;
  if (this.runtimeTimer) {
    this.runtimeTimer.paused = true;
  }
  this.pausePlaybackClock();
  this.pauseBackingPlayback();
}

function handlePlaybackSpeedPointerUpImpl(this: PlaySceneContext, pointer: Phaser.Input.Pointer): void {
  if (!this.playbackSpeedAdjusting) return;
  if (this.playbackSpeedDragPointerId !== undefined && pointer.id !== this.playbackSpeedDragPointerId) return;
  this.playbackSpeedAdjusting = false;
  this.playbackSpeedDragPointerId = undefined;
  const pendingSpeed = this.pendingPlaybackSpeedMultiplier;
  this.pendingPlaybackSpeedMultiplier = undefined;
  if (pendingSpeed !== undefined) {
    this.setPlaybackSpeed(pendingSpeed);
  } else {
    this.updatePlaybackSpeedSliderVisuals();
  }
  if (!this.playbackWasRunningBeforeSpeedAdjust) return;
  this.playbackWasRunningBeforeSpeedAdjust = false;
  if (this.runtimeTimer) {
    this.runtimeTimer.paused = false;
  }
  if (this.playbackMode === 'audio' && this.playbackStarted && this.runtime.state === PlayState.Playing) {
    this.resumeBackingPlayback();
  }
}

function setPendingPlaybackSpeedImpl(this: PlaySceneContext, speedMultiplier: number): void {
  const sceneClass = getSceneClass(this);
  this.pendingPlaybackSpeedMultiplier = Phaser.Math.Clamp(
    speedMultiplier,
    sceneClass.PLAYBACK_SPEED_MIN,
    sceneClass.PLAYBACK_SPEED_MAX
  );
  this.updatePlaybackSpeedSliderVisuals();
}

function setPlaybackSpeedImpl(this: PlaySceneContext, speedMultiplier: number): void {
  const sceneClass = getSceneClass(this);
  const safeSpeed = Phaser.Math.Clamp(
    speedMultiplier,
    sceneClass.PLAYBACK_SPEED_MIN,
    sceneClass.PLAYBACK_SPEED_MAX
  );
  const previousSpeed = this.playbackSpeedMultiplier;
  if (Math.abs(previousSpeed - safeSpeed) < 0.0001) {
    this.updatePlaybackSpeedSliderVisuals();
    return;
  }

  const nowSongSeconds = this.getSongSecondsNow();
  this.playbackSpeedMultiplier = safeSpeed;
  if (this.playbackStarted) {
    this.startPlaybackClock(nowSongSeconds);
  } else {
    this.pausedSongSeconds = nowSongSeconds;
  }

  if (this.playbackMode === 'audio' && this.backingTrackBuffer) {
    if (this.playbackStarted && this.backingTrackIsPlaying) {
      // Rebuild source node so playback rate and offset stay coherent.
      void this.playBackingTrackAudioFrom(nowSongSeconds);
    } else {
      this.backingTrackSourceStartSongSeconds = nowSongSeconds;
    }
  }

  this.feedbackText = `Speed ${Math.round(safeSpeed * 100)}%`;
  this.feedbackUntilMs = performance.now() + 900;
  this.updatePlaybackSpeedSliderVisuals();
  this.updateHud();
}

function updatePlaybackSpeedSliderVisualsImpl(this: PlaySceneContext): void {
  const sceneClass = getSceneClass(this);
  if (!this.playbackSpeedTrack || !this.playbackSpeedKnob || !this.playbackSpeedValueText) return;

  const visualSpeed = this.pendingPlaybackSpeedMultiplier ?? this.playbackSpeedMultiplier;
  const ratio =
    (visualSpeed - sceneClass.PLAYBACK_SPEED_MIN) /
    (sceneClass.PLAYBACK_SPEED_MAX - sceneClass.PLAYBACK_SPEED_MIN);
  const clampedRatio = Phaser.Math.Clamp(ratio, 0, 1);
  const left = this.playbackSpeedTrack.x - this.playbackSpeedTrack.displayWidth / 2;
  this.playbackSpeedKnob.setPosition(left + this.playbackSpeedTrack.displayWidth * clampedRatio, this.playbackSpeedTrack.y);
  this.playbackSpeedValueText.setText(`${Math.round(visualSpeed * 100)}%`);
}

function layoutHandReminderImpl(this: PlaySceneContext): void {
  if (!this.handReminderImage) return;
  const { width, height } = this.scale;
  const textureFrame = this.handReminderImage.frame;
  const texWidth = textureFrame.width;
  const texHeight = textureFrame.height;
  if (texWidth <= 0 || texHeight <= 0) return;

  const maxWidth = Math.max(150, width * 0.22);
  const maxHeight = Math.max(76, height * 0.16);
  const scale = Math.min(maxWidth / texWidth, maxHeight / texHeight);

  this.handReminderImage.setScale(scale);
  this.handReminderImage.setPosition(width - 12, height - 8);
}
