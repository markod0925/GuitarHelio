import { Capacitor } from '@capacitor/core';
import {
  DEFAULT_HOLD_MS,
  DEFAULT_MIN_CONFIDENCE,
  TARGET_HIT_GRACE_SECONDS
} from '../../../app/config';
import { saveSongHighScoreIfHigher } from '../../../app/sessionPersistence';
import { summarizeScores } from '../../../game/scoring';
import { PlayState } from '../../../types/models';
import { formatSummary } from '../../hud';
import {
  formatDebugBool,
  formatDebugNumber,
  formatDebugPath,
  formatSignedMs
} from '../../playSceneDebug';
import { RoundedBox } from '../../RoundedBox';
import {
  computeEndScreenStars as computeOverlayEndScreenStars,
  resolveTopFeedbackMessage as resolveOverlayTopFeedbackMessage
} from '../../UIOverlays';
import type { PlaySceneContext } from './PlaySceneContext';

export class UIController {
  constructor(private readonly scene: PlaySceneContext) {}

  finishSong(): void {
    finishSongImpl.call(this.scene);
  }

  computeEndScreenStars(summary: ReturnType<typeof summarizeScores>): number {
    return computeEndScreenStarsImpl.call(this.scene, summary);
  }

  createEndScreenStars(
    centerX: number,
    centerY: number,
    earnedStars: number,
    width: number
  ): Phaser.GameObjects.GameObject[] {
    return createEndScreenStarsImpl.call(this.scene, centerX, centerY, earnedStars, width);
  }

  attachBackHandlers(): void {
    attachBackHandlersImpl.call(this.scene);
  }

  onBackRequested(): void {
    onBackRequestedImpl.call(this.scene);
  }

  openPauseMenu(): void {
    openPauseMenuImpl.call(this.scene);
  }

  closePauseMenu(): void {
    closePauseMenuImpl.call(this.scene);
  }

  toggleGameplayPauseFromButton(): void {
    toggleGameplayPauseFromButtonImpl.call(this.scene);
  }

  pauseGameplayFromButton(): void {
    pauseGameplayFromButtonImpl.call(this.scene);
  }

  resumeGameplayFromButtonPause(): void {
    resumeGameplayFromButtonPauseImpl.call(this.scene);
  }

  isWaitingPausedByButton(): boolean {
    return isWaitingPausedByButtonImpl.call(this.scene);
  }

  relayoutPauseOverlay(): void {
    relayoutPauseOverlayImpl.call(this.scene);
  }

  resetSession(): void {
    resetSessionImpl.call(this.scene);
  }

  goBackToStart(): void {
    goBackToStartImpl.call(this.scene);
  }

  resolveSongScoreKey(): string {
    return resolveSongScoreKeyImpl.call(this.scene);
  }

  persistNativeSongHighScore(songScoreKey: string, bestScore: number): void {
    persistNativeSongHighScoreImpl.call(this.scene, songScoreKey, bestScore);
  }

  createDebugOverlay(): void {
    createDebugOverlayImpl.call(this.scene);
  }

  relayoutDebugOverlay(): void {
    relayoutDebugOverlayImpl.call(this.scene);
  }

  toggleDebugOverlay(): void {
    toggleDebugOverlayImpl.call(this.scene);
  }

  updateDebugOverlay(): void {
    updateDebugOverlayImpl.call(this.scene);
  }

  updateHud(): void {
    updateHudImpl.call(this.scene);
  }

  resolveTopFeedbackMessage(now: number): string {
    return resolveTopFeedbackMessageImpl.call(this.scene, now);
  }
}

function finishSongImpl(this: PlaySceneContext): void {
  if (this.resultsOverlay?.active) return;
  this.runtime.state = PlayState.Finished;
  this.runtime.waiting_started_at_s = undefined;
  this.runtime.waiting_target_id = undefined;
  this.finishDelayTimer?.remove(false);
  this.finishDelayTimer = undefined;
  this.finishQueuedAtMs = undefined;
  this.playbackIntroTimer?.remove(false);
  this.playbackIntroTimer = undefined;
  this.prePlaybackStartAtMs = undefined;
  this.playbackStarted = false;
  this.pauseMenuResumeSongSeconds = undefined;
  this.playbackPausedByButton = false;
  this.playbackWasRunningBeforeButtonPause = false;
  this.waitingPauseStartedAtAudioTime = undefined;
  this.closePauseMenu();
  this.setBallAndTrailVisible(false);
  this.debugButton?.disableInteractive().setVisible(false);
  this.debugButtonLabel?.setVisible(false);
  this.pauseButton?.disableInteractive().setVisible(false);
  this.pauseButtonLeftBar?.setVisible(false);
  this.pauseButtonRightBar?.setVisible(false);
  this.pauseButtonPlayIcon?.setVisible(false);
  this.handReminderImage?.setVisible(false);
  this.minimapRenderer.setVisible(false);
  this.feedbackMessageText?.setVisible(false);
  this.playbackSpeedTrack?.disableInteractive().setVisible(false);
  this.playbackSpeedKnob?.disableInteractive().setVisible(false);
  this.playbackSpeedPanel?.setVisible(false);
  this.playbackSpeedLabel?.setVisible(false);
  this.playbackSpeedValueText?.setVisible(false);
  this.debugOverlayContainer?.setVisible(false);

  this.runtimeTimer?.remove(false);
  this.runtimeTimer = undefined;

  this.stopBackingPlayback();
  this.detector?.stop();

  const summary = summarizeScores(this.scoreEvents);
  const songScoreKey = this.resolveSongScoreKey();
  const bestScore = songScoreKey ? saveSongHighScoreIfHigher(songScoreKey, summary.totalScore) : summary.totalScore;
  if (songScoreKey) {
    this.persistNativeSongHighScore(songScoreKey, bestScore);
  }
  const { width, height } = this.scale;
  const panelWidth = Math.min(620, width * 0.82);
  const panelHeight = Math.min(420, height * 0.76);

  const panelGlow = new RoundedBox(this, width / 2, height / 2, panelWidth + 10, panelHeight + 10, 0x60a5fa, 0.16);
  const panel = new RoundedBox(this, width / 2, height / 2, panelWidth, panelHeight, 0x101c3c, 0.95)
    .setStrokeStyle(2, 0x60a5fa, 0.58);
  const title = this.add.text(width / 2, height * 0.26, 'Session Complete', {
    color: '#f8fafc',
    fontFamily: 'Montserrat, sans-serif',
    fontStyle: 'bold',
    fontSize: `${Math.max(24, Math.floor(width * 0.035))}px`
  }).setOrigin(0.5);
  const summaryText = this.add.text(width / 2, height * 0.34, `${formatSummary(summary)}\nBest Score: ${bestScore}`, {
    color: '#e2e8f0',
    fontFamily: 'Montserrat, sans-serif',
    align: 'left',
    fontSize: `${Math.max(16, Math.floor(width * 0.02))}px`
  }).setOrigin(0.5, 0);
  const earnedStars = this.computeEndScreenStars(summary);
  const starObjects = this.createEndScreenStars(width / 2, height * 0.18, earnedStars, width);
  const restartButtonY = height * 0.69;
  const backButtonY = height * 0.81;
  const actionButtonWidth = panelWidth * 0.74;
  const actionButtonHeight = 52;
  const restartButton = new RoundedBox(this, width / 2, restartButtonY, actionButtonWidth, actionButtonHeight, 0xf97316, 1)
    .setStrokeStyle(1, 0xfed7aa, 0.9)
    .setInteractive({ useHandCursor: true });
  const restartLabel = this.add
    .text(width / 2, restartButtonY, 'Restart', {
      color: '#fff7ed',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });
  const backButton = new RoundedBox(this, width / 2, backButtonY, actionButtonWidth, actionButtonHeight, 0x1e293b, 1)
    .setStrokeStyle(1, 0x64748b, 0.9)
    .setInteractive({ useHandCursor: true });
  const backLabel = this.add
    .text(width / 2, backButtonY, 'Back to Start', {
      color: '#e2e8f0',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

  const restart = (): void => this.resetSession();
  const goBack = (): void => this.goBackToStart();
  restartButton.on('pointerdown', restart);
  restartLabel.on('pointerdown', restart);
  backButton.on('pointerdown', goBack);
  backLabel.on('pointerdown', goBack);
  this.input.keyboard?.once('keydown-ENTER', restart);
  this.input.keyboard?.once('keydown-ESC', goBack);

  this.resultsOverlay = this.add.container(0, 0, [
    panelGlow,
    panel,
    title,
    summaryText,
    ...starObjects,
    restartButton,
    restartLabel,
    backButton,
    backLabel
  ]);
}

function computeEndScreenStarsImpl(this: PlaySceneContext, summary: ReturnType<typeof summarizeScores>): number {
  return computeOverlayEndScreenStars(this.targets.length, summary);
}

function createEndScreenStarsImpl(
  this: PlaySceneContext,
  centerX: number,
  centerY: number,
  earnedStars: number,
  width: number
): Phaser.GameObjects.GameObject[] {
  const objects: Phaser.GameObjects.GameObject[] = [];
  const spacing = Math.max(44, Math.floor(width * 0.06));
  const starFontSize = `${Math.max(34, Math.floor(width * 0.05))}px`;
  const baseColor = '#64748b';
  const activeColor = '#facc15';

  for (let index = 0; index < 3; index += 1) {
    const x = centerX + (index - 1) * spacing;
    const baseStar = this.add
      .text(x, centerY, '☆', {
        color: baseColor,
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: starFontSize
      })
      .setOrigin(0.5);
    objects.push(baseStar);

    if (index >= earnedStars) continue;

    const fillStar = this.add
      .text(x, centerY, '★', {
        color: activeColor,
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: starFontSize
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setScale(0.7);
    this.tweens.add({
      targets: fillStar,
      alpha: 1,
      scaleX: 1.14,
      scaleY: 1.14,
      duration: 220,
      delay: 180 + index * 180,
      ease: 'Back.Out',
      onComplete: () => {
        this.tweens.add({
          targets: fillStar,
          scaleX: 1,
          scaleY: 1,
          duration: 110,
          ease: 'Sine.Out'
        });
      }
    });
    objects.push(fillStar);
  }

  return objects;
}

function attachBackHandlersImpl(this: PlaySceneContext): void {
  this.input.keyboard?.on('keydown-ESC', this.onBackRequested, this);

  if (this.nativeBackButtonListener) {
    void this.nativeBackButtonListener.remove();
    this.nativeBackButtonListener = undefined;
  }

  if (Capacitor.isNativePlatform()) {
    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('backButton', () => {
          if (!this.scene.isActive()) return;
          if (this.runtime.state === PlayState.Finished) return;
          this.onBackRequested();
        })
      )
      .then((listener) => {
        this.nativeBackButtonListener = listener;
      })
      .catch((error) => {
        console.warn('Failed to register native back button handler', error);
      });
    return;
  }

  this.pauseMenuBackListener = (event: Event): void => {
    event.preventDefault();
    this.onBackRequested();
  };
  document.addEventListener('backbutton', this.pauseMenuBackListener);

  this.pauseMenuPopStateListener = (_event: PopStateEvent): void => {
    if (!this.scene.isActive()) return;
    if (this.runtime.state === PlayState.Finished) return;
    window.history.pushState({ gh_play_scene: true }, '', window.location.href);
    this.onBackRequested();
  };
  window.addEventListener('popstate', this.pauseMenuPopStateListener);
  window.history.pushState({ gh_play_scene: true }, '', window.location.href);
}

function onBackRequestedImpl(this: PlaySceneContext): void {
  if (this.runtime.state === PlayState.Finished) return;
  if (this.pauseOverlay) {
    this.closePauseMenu();
    return;
  }
  this.openPauseMenu();
}

function openPauseMenuImpl(this: PlaySceneContext): void {
  if (this.pauseOverlay) return;
  this.playbackWasRunningBeforePauseMenu =
    this.runtime.state === PlayState.Playing && this.playbackStarted && !this.playbackPausedByButton;
  this.pauseMenuResumeSongSeconds = undefined;

  if (this.runtimeTimer) {
    this.runtimeTimer.paused = true;
  }
  if (this.playbackWasRunningBeforePauseMenu) {
    this.pausePlaybackClock();
    this.pauseMenuResumeSongSeconds = this.pausedSongSeconds;
    this.pauseBackingPlayback();
  }
  this.latestFrames.clear();

  const { width, height } = this.scale;
  const panelWidth = Math.min(420, width * 0.84);
  const panelHeight = Math.min(360, height * 0.7);
  const centerX = width / 2;
  const centerY = height / 2;

  const backdrop = new RoundedBox(this, centerX, centerY, width, height, 0x000000, 0.55, 0)
    .setInteractive({ useHandCursor: false });

  const panelGlow = new RoundedBox(this, centerX, centerY, panelWidth + 8, panelHeight + 8, 0x60a5fa, 0.14);
  const panel = new RoundedBox(this, centerX, centerY, panelWidth, panelHeight, 0x101c3c, 0.96).setStrokeStyle(2, 0x60a5fa, 0.58);
  const title = this.add
    .text(centerX, centerY - panelHeight * 0.33, 'Pause Menu', {
      color: '#f8fafc',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(22, Math.floor(width * 0.03))}px`
    })
    .setOrigin(0.5);

  const continueButtonY = centerY - panelHeight * 0.12;
  const resetButtonY = centerY + panelHeight * 0.08;
  const backButtonY = centerY + panelHeight * 0.28;

  const continueButton = new RoundedBox(this, centerX, continueButtonY, panelWidth * 0.72, 54, 0x1d4ed8, 1)
    .setStrokeStyle(1, 0x93c5fd, 0.9)
    .setInteractive({ useHandCursor: true });
  const continueLabel = this.add
    .text(centerX, continueButtonY, 'Continue', {
      color: '#eff6ff',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

  const resetButton = new RoundedBox(this, centerX, resetButtonY, panelWidth * 0.72, 54, 0xf97316, 1)
    .setStrokeStyle(1, 0xfed7aa, 0.9)
    .setInteractive({ useHandCursor: true });
  const resetLabel = this.add
    .text(centerX, resetButtonY, 'Reset', {
      color: '#fff7ed',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

  const backButton = new RoundedBox(this, centerX, backButtonY, panelWidth * 0.72, 54, 0x1e293b, 1)
    .setStrokeStyle(1, 0x64748b, 0.9)
    .setInteractive({ useHandCursor: true });
  const backLabel = this.add
    .text(centerX, backButtonY, 'Back to Start', {
      color: '#e2e8f0',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

  continueButton.on('pointerdown', () => this.closePauseMenu());
  continueLabel.on('pointerdown', () => this.closePauseMenu());
  resetButton.on('pointerdown', () => this.resetSession());
  resetLabel.on('pointerdown', () => this.resetSession());
  backButton.on('pointerdown', () => this.goBackToStart());
  backLabel.on('pointerdown', () => this.goBackToStart());

  this.pauseOverlay = this.add.container(0, 0, [
    backdrop,
    panelGlow,
    panel,
    title,
    continueButton,
    continueLabel,
    resetButton,
    resetLabel,
    backButton,
    backLabel
  ]);
  this.pauseOverlay.setDepth(1000);
  this.syncPauseButtonIcon();
}

function closePauseMenuImpl(this: PlaySceneContext): void {
  if (!this.pauseOverlay) return;

  this.pauseOverlay.destroy(true);
  this.pauseOverlay = undefined;

  if (this.runtimeTimer) {
    this.runtimeTimer.paused = this.playbackPausedByButton;
  }
  if (this.playbackWasRunningBeforePauseMenu) {
    if (this.pauseMenuResumeSongSeconds !== undefined) {
      this.pausedSongSeconds = this.pauseMenuResumeSongSeconds;
    }
    this.resumeBackingPlayback();
  }
  this.latestFrames.clear();
  this.playbackWasRunningBeforePauseMenu = false;
  this.pauseMenuResumeSongSeconds = undefined;
  this.syncPauseButtonIcon();
}

function toggleGameplayPauseFromButtonImpl(this: PlaySceneContext): void {
  if (this.runtime.state === PlayState.Finished || this.pauseOverlay) return;
  if (this.playbackPausedByButton) {
    this.resumeGameplayFromButtonPause();
    return;
  }
  this.pauseGameplayFromButton();
}

function pauseGameplayFromButtonImpl(this: PlaySceneContext): void {
  if (this.playbackPausedByButton) return;
  this.playbackPausedByButton = true;
  this.playbackWasRunningBeforeButtonPause = this.runtime.state === PlayState.Playing && this.playbackStarted;
  this.waitingPauseStartedAtAudioTime =
    this.runtime.state === PlayState.WaitingForHit && this.audioCtx ? this.audioCtx.currentTime : undefined;

  if (this.runtimeTimer) {
    this.runtimeTimer.paused = true;
  }
  if (this.playbackWasRunningBeforeButtonPause) {
    this.pausePlaybackClock();
    this.pauseBackingPlayback();
  }
  this.latestFrames.clear();
  this.syncPauseButtonIcon();
}

function resumeGameplayFromButtonPauseImpl(this: PlaySceneContext): void {
  if (!this.playbackPausedByButton) return;
  this.playbackPausedByButton = false;

  if (
    this.runtime.state === PlayState.WaitingForHit &&
    this.audioCtx &&
    this.runtime.waiting_started_at_s !== undefined &&
    this.waitingPauseStartedAtAudioTime !== undefined
  ) {
    const pausedForSeconds = Math.max(0, this.audioCtx.currentTime - this.waitingPauseStartedAtAudioTime);
    this.runtime.waiting_started_at_s += pausedForSeconds;
  }
  this.waitingPauseStartedAtAudioTime = undefined;

  if (this.runtimeTimer) {
    this.runtimeTimer.paused = false;
  }
  if (this.runtime.state === PlayState.WaitingForHit) {
    this.stopBackingTrackSource();
    this.playbackStartAudioTime = null;
    this.playbackStartSongSeconds = this.pausedSongSeconds;
  } else if (this.playbackWasRunningBeforeButtonPause) {
    this.resumeBackingPlayback();
  }
  this.playbackWasRunningBeforeButtonPause = false;
  this.latestFrames.clear();
  this.syncPauseButtonIcon();
}

function isWaitingPausedByButtonImpl(this: PlaySceneContext): boolean {
  return this.playbackPausedByButton && this.runtime.state === PlayState.WaitingForHit;
}

function relayoutPauseOverlayImpl(this: PlaySceneContext): void {
  if (!this.pauseOverlay) return;
  this.pauseOverlay.destroy(true);
  this.pauseOverlay = undefined;
  this.openPauseMenu();
}

function resetSessionImpl(this: PlaySceneContext): void {
  const data = this.sceneData;
  if (!data) return;
  this.scene.restart(data);
}

function goBackToStartImpl(this: PlaySceneContext): void {
  this.scene.start('SongSelectScene');
}

function resolveSongScoreKeyImpl(this: PlaySceneContext): string {
  const explicitSongId = this.sceneData?.songId?.trim();
  if (explicitSongId) return explicitSongId;
  return this.sceneData?.midiUrl?.trim() ?? '';
}

function persistNativeSongHighScoreImpl(this: PlaySceneContext, songScoreKey: string, bestScore: number): void {
  if (!Capacitor.isNativePlatform()) return;

  void import('../../../platform/nativeSongLibrary')
    .then(({ updateNativeSongHighScore }) => updateNativeSongHighScore(songScoreKey, bestScore))
    .catch((error) => {
      console.warn('Failed to persist native high score', { songScoreKey, bestScore, error });
    });
}

function createDebugOverlayImpl(this: PlaySceneContext): void {
  if (!this.debugOverlayEnabled || this.debugOverlayContainer) return;

  this.debugOverlayPanel = new RoundedBox(this, 0, 0, 10, 10, 0x020617, 0.78)
    .setStrokeStyle(2, 0x38bdf8, 0.48)
    .setDepth(910);
  this.debugOverlayText = this.add
    .text(0, 0, '', {
      color: '#dbeafe',
      fontFamily: 'Montserrat, sans-serif',
      fontSize: '12px',
      lineSpacing: 3
    })
    .setOrigin(0, 0)
    .setDepth(911);

  this.debugOverlayContainer = this.add
    .container(0, 0, [this.debugOverlayPanel, this.debugOverlayText])
    .setDepth(910)
    .setVisible(true);
  this.relayoutDebugOverlay();
}

function relayoutDebugOverlayImpl(this: PlaySceneContext): void {
  if (!this.debugOverlayPanel || !this.debugOverlayText) return;

  const { width, height } = this.scale;
  const panelWidth = Math.min(760, width * 0.84);
  const panelHeight = Math.min(360, height * 0.56);
  const centerX = width / 2;
  const centerY = height * 0.52;

  this.debugOverlayPanel.setBoxSize(panelWidth, panelHeight);
  this.debugOverlayPanel.setPosition(centerX, centerY);
  this.debugOverlayText
    .setPosition(centerX - panelWidth / 2 + 12, centerY - panelHeight / 2 + 12)
    .setFontSize(`${Math.max(11, Math.floor(width * 0.0115))}px`);
}

function toggleDebugOverlayImpl(this: PlaySceneContext): void {
  if (!this.debugOverlayContainer) return;
  const nextVisible = !this.debugOverlayContainer.visible;
  this.debugOverlayContainer.setVisible(nextVisible);
  this.feedbackText = `Debug overlay ${nextVisible ? 'ON' : 'OFF'} (F3)`;
  this.feedbackUntilMs = performance.now() + 900;
  this.updateHud();
}

function updateDebugOverlayImpl(this: PlaySceneContext): void {
  if (!this.debugOverlayEnabled || !this.debugOverlayText || !this.debugOverlayContainer || !this.debugOverlayContainer.visible) {
    return;
  }

  const snapshot = this.hitDebugSnapshot;
  const active = snapshot?.activeTarget ?? this.targets[this.runtime.active_target_index];
  const latestFrame = snapshot?.latestFrame ?? this.latestFrames.latest();
  const songSecondsNow =
    snapshot?.songSecondsNow ?? (this.runtime.state === PlayState.Playing ? this.getSongSecondsNow() : this.pausedSongSeconds);
  const targetSeconds = snapshot?.targetSeconds ?? (active && this.tempoMap ? this.tempoMap.tickToSeconds(active.tick) : undefined);
  const playbackBpm = this.getCurrentPlaybackBpm(songSecondsNow);
  const deltaMs =
    snapshot?.targetDeltaMs ?? (songSecondsNow !== undefined && targetSeconds !== undefined ? (songSecondsNow - targetSeconds) * 1000 : undefined);
  const timeoutSeconds = this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds;
  const waitingElapsedSeconds =
    this.runtime.waiting_started_at_s !== undefined && this.audioCtx
      ? Math.max(0, this.audioCtx.currentTime - this.runtime.waiting_started_at_s)
      : undefined;
  const transitionAgeMs = this.lastRuntimeTransitionAtMs > 0 ? performance.now() - this.lastRuntimeTransitionAtMs : undefined;
  const clockSongSeconds = this.getSongSecondsFromClock();
  const runtimeTickSongSeconds = this.tempoMap ? this.tempoMap.tickToSeconds(Math.max(0, this.runtime.current_tick)) : undefined;
  const backingCurrentSeconds = this.getBackingTrackSongSeconds();
  const backingDurationSeconds = this.backingTrackBuffer?.duration;
  const backingDriftMs =
    songSecondsNow !== undefined && backingCurrentSeconds !== undefined
      ? (backingCurrentSeconds - songSecondsNow) * 1000
      : undefined;
  const seekDebug = this.lastAudioSeekDebug;
  const seekAgeMs = seekDebug ? performance.now() - seekDebug.atMs : undefined;

  const lines = [
    'DEBUG OVERLAY (F3)',
    `state=${this.runtime.state} mode=${this.playbackMode} audio=${this.audioCtx?.state ?? 'n/a'} transition=${this.lastRuntimeTransition}${transitionAgeMs !== undefined ? ` (${Math.round(transitionAgeMs)}ms)` : ''}`,
    `song id=${this.sceneData?.songId ?? '-'} midi=${formatDebugPath(this.sceneData?.midiUrl)} audio=${formatDebugPath(this.sceneData?.audioUrl)}`,
    active
      ? `target=${this.runtime.active_target_index + 1}/${this.targets.length} id=${active.id} string=${active.string} fret=${active.fret} expMidi=${active.expected_midi}`
      : `target=${this.runtime.active_target_index + 1}/${this.targets.length} none`,
    `tick now=${Math.round(this.runtime.current_tick)} target=${active ? active.tick : '-'} dtick=${active ? active.tick - this.runtime.current_tick : '-'}`,
    `time now=${formatDebugNumber(songSecondsNow, 3)}s target=${formatDebugNumber(targetSeconds, 3)}s bpm=${formatDebugNumber(playbackBpm, 2)} d=${formatSignedMs(deltaMs)} window=+/-${Math.round(TARGET_HIT_GRACE_SECONDS * 1000)}ms`,
    `clock song=${formatDebugNumber(clockSongSeconds, 3)}s tickSong=${formatDebugNumber(runtimeTickSongSeconds, 3)}s startSong=${formatDebugNumber(this.playbackStartSongSeconds, 3)}s ctxStart=${formatDebugNumber(this.playbackStartAudioTime, 3)}s`,
    `resume pausedSong=${formatDebugNumber(this.pausedSongSeconds, 3)}s pausedAudio=${formatDebugNumber(this.pausedBackingAudioSeconds, 3)}s lastAudio=${formatDebugNumber(this.lastKnownBackingAudioSeconds, 3)}s speed=${formatDebugNumber(this.playbackSpeedMultiplier, 2)}x started=${formatDebugBool(this.playbackStarted)}`,
    `backing cur=${formatDebugNumber(backingCurrentSeconds, 3)}s dur=${formatDebugNumber(backingDurationSeconds, 3)}s playing=${formatDebugBool(this.backingTrackIsPlaying)} sourceSong=${formatDebugNumber(this.backingTrackSourceStartSongSeconds, 3)}s sourceCtx=${formatDebugNumber(this.backingTrackSourceStartedAtAudioTime, 3)}s drift=${formatSignedMs(backingDriftMs)}`,
    `seek req=${formatDebugNumber(seekDebug?.requestedSongSeconds, 3)}s target=${formatDebugNumber(seekDebug?.targetSeconds, 3)}s before=${formatDebugNumber(seekDebug?.beforeSeekSeconds, 3)}s after=${formatDebugNumber(seekDebug?.afterPlaySeconds, 3)}s retry=${formatDebugNumber(seekDebug?.afterRetrySeconds, 3)}s fallbackMidi=${seekDebug ? formatDebugBool(seekDebug.fallbackToMidi) : '-'} ok=${seekDebug ? formatDebugBool(seekDebug.ok) : '-'} age=${seekAgeMs !== undefined ? `${Math.round(seekAgeMs)}ms` : '-'}`,
    `pitch midi=${formatDebugNumber(latestFrame?.midi_estimate, 2)} conf=${formatDebugNumber(latestFrame?.confidence, 2)} hold=${Math.round(snapshot?.holdMs ?? 0)}/${Math.round(snapshot?.holdRequiredMs ?? DEFAULT_HOLD_MS)}ms`,
    `validate can=${formatDebugBool(snapshot?.canValidateHit ?? false)} within=${formatDebugBool(snapshot?.isWithinGraceWindow ?? false)} validHit=${formatDebugBool(snapshot?.validHit ?? false)} minConf=${formatDebugNumber(snapshot?.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 2)} frames=${snapshot?.sampleCount ?? this.latestFrames.length} validFrames=${snapshot?.validFrameCount ?? 0}`,
    `waiting=${waitingElapsedSeconds !== undefined ? `${waitingElapsedSeconds.toFixed(2)}s` : '-'} timeout=${timeoutSeconds !== undefined ? `${timeoutSeconds.toFixed(2)}s` : '-'} feedback=${this.feedbackText || '-'}`
  ];

  this.debugOverlayText.setText(lines.join('\n'));
}

function updateHudImpl(this: PlaySceneContext): void {
  if (!this.statusText || !this.liveScoreText || !this.feedbackMessageText) return;

  const now = performance.now();

  const streak = Math.max(1, this.currentComboStreak);
  let status = `x${streak}`;
  if (!this.playbackStarted && this.runtime.state !== PlayState.Finished) {
    status = `x${streak}`;
  }

  const topMessage = this.resolveTopFeedbackMessage(now);
  const completed = Math.min(this.runtime.active_target_index, this.targets.length);

  this.statusText.setText(status);
  this.feedbackMessageText.setText(topMessage).setVisible(topMessage.length > 0);
  this.liveScoreText.setText(`${this.totalScore}  |  ${completed}/${this.targets.length}`);
  this.updateDebugOverlay();
}

function resolveTopFeedbackMessageImpl(this: PlaySceneContext, now: number): string {
  return resolveOverlayTopFeedbackMessage({
    runtimeState: this.runtime.state,
    timeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
    audioCurrentTime: this.audioCtx?.currentTime,
    waitingStartedAtSeconds: this.runtime.waiting_started_at_s,
    playbackStarted: this.playbackStarted,
    prePlaybackStartAtMs: this.prePlaybackStartAtMs,
    nowMs: now,
    feedbackUntilMs: this.feedbackUntilMs,
    feedbackText: this.feedbackText
  });
}
