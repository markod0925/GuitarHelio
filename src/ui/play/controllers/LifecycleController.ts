import Phaser from 'phaser';
import {
  DEFAULT_HOLD_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_GATING_TIMEOUT_SECONDS
} from '../../../app/config';
import { createInitialRuntimeState } from '../../../game/stateMachine';
import {
  disableKeepScreenOnAfterPlayScene,
  enableKeepScreenOnDuringPlayScene
} from '../../../platform/nativeKeepScreenOn';
import { releaseMicStream } from '../../AudioController';
import { isGameplayDebugOverlayEnabled } from '../../playSceneDebug';
import type { PlaySceneContext } from './PlaySceneContext';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;

export class LifecycleController {
  constructor(private readonly scene: PlaySceneContext) {}

  initializeSessionState(): void {
    initializeSessionStateImpl.call(this.scene);
  }

  registerResizeHandler(): void {
    registerResizeHandlerImpl.call(this.scene);
  }

  startRuntimeLoop(): void {
    startRuntimeLoopImpl.call(this.scene);
  }

  cleanup(): void {
    cleanupImpl.call(this.scene);
  }
}

function initializeSessionStateImpl(this: PlaySceneContext): void {
  void enableKeepScreenOnDuringPlayScene();
  const sceneClass = this.constructor as PlaySceneStatics;
  this.runtime = createInitialRuntimeState();
  this.scoreEvents = [];
  this.totalScore = 0;
  this.currentComboStreak = 0;
  this.correctlyHitTargetIds.clear();
  this.latestFrames.clear();
  this.waitingStartMs = null;
  this.playbackStartAudioTime = null;
  this.playbackStartSongSeconds = 0;
  this.pausedSongSeconds = 0;
  this.feedbackText = '';
  this.feedbackUntilMs = 0;
  this.fallbackTimeoutSeconds =
    this.profile.gating_timeout_seconds === undefined ? DEFAULT_GATING_TIMEOUT_SECONDS : undefined;
  this.playbackMode = 'midi';
  this.backingTrackBuffer = undefined;
  this.backingTrackSource = undefined;
  this.backingTrackGain = undefined;
  this.backingTrackSourceStartedAtAudioTime = undefined;
  this.backingTrackSourceStartSongSeconds = 0;
  this.backingTrackIsPlaying = false;
  this.backingTrackAudioUrl = undefined;
  this.lastBallTrailRedrawAtMs = Number.NEGATIVE_INFINITY;
  this.lastHudStatusText = '';
  this.lastHudFeedbackText = '';
  this.lastHudLiveScoreText = '';
  this.hitDebugSnapshot = {
    isWithinGraceWindow: false,
    canValidateHit: false,
    validHit: false,
    holdMs: 0,
    holdRequiredMs: DEFAULT_HOLD_MS,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    validFrameCount: 0,
    sampleCount: 0
  };
  this.lastRuntimeTransition = 'none';
  this.lastRuntimeTransitionAtMs = 0;
  this.lastAudioSeekDebug = undefined;
  this.debugOverlayEnabled = isGameplayDebugOverlayEnabled();
  this.playbackSpeedMultiplier = sceneClass.PLAYBACK_SPEED_DEFAULT;
}

function registerResizeHandlerImpl(this: PlaySceneContext): void {
  this.onResize = () => {
    this.cachedLayout = undefined;
    this.drawStaticLanes();
    this.redrawTargetsAndBall();
    this.updateSongMinimapProgress();
    this.updateHud();
    this.relayoutDebugOverlay();
    this.updateDebugOverlay();
    this.relayoutPauseOverlay();
  };
  this.scale.on('resize', this.onResize);
}

function startRuntimeLoopImpl(this: PlaySceneContext): void {
  this.runtimeTimer = this.time.addEvent({
    delay: 16,
    loop: true,
    callback: () => this.tickRuntime()
  });
  this.schedulePlaybackStart();
  this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
}

function cleanupImpl(this: PlaySceneContext): void {
  void disableKeepScreenOnAfterPlayScene();
  this.input.keyboard?.off('keydown-ESC', this.onBackRequested, this);
  this.input.keyboard?.off('keydown-F3', this.toggleDebugOverlay, this);

  if (this.pauseMenuBackListener) {
    document.removeEventListener('backbutton', this.pauseMenuBackListener);
    this.pauseMenuBackListener = undefined;
  }
  if (this.pauseMenuPopStateListener) {
    window.removeEventListener('popstate', this.pauseMenuPopStateListener);
    this.pauseMenuPopStateListener = undefined;
  }
  if (this.nativeBackButtonListener) {
    void this.nativeBackButtonListener.remove();
    this.nativeBackButtonListener = undefined;
  }
  if (this.nativeAppStateListener) {
    void this.nativeAppStateListener.remove();
    this.nativeAppStateListener = undefined;
  }

  this.pauseOverlay?.destroy(true);
  this.pauseOverlay = undefined;
  this.resultsOverlay?.destroy(true);
  this.resultsOverlay = undefined;
  this.playbackWasRunningBeforePauseMenu = false;
  this.pauseMenuResumeSongSeconds = undefined;
  this.playbackPausedByButton = false;
  this.playbackWasRunningBeforeButtonPause = false;
  this.waitingPauseStartedAtAudioTime = undefined;
  this.pauseButton?.destroy();
  this.pauseButton = undefined;
  this.pauseButtonLeftBar?.destroy();
  this.pauseButtonLeftBar = undefined;
  this.pauseButtonRightBar?.destroy();
  this.pauseButtonRightBar = undefined;
  this.pauseButtonPlayIcon?.destroy();
  this.pauseButtonPlayIcon = undefined;
  this.playbackSpeedPanel?.destroy();
  this.playbackSpeedPanel = undefined;
  this.playbackSpeedTrack?.destroy();
  this.playbackSpeedTrack = undefined;
  this.playbackSpeedKnob?.destroy();
  this.playbackSpeedKnob = undefined;
  this.input.off('pointerup', this.handlePlaybackSpeedPointerUp, this);
  this.input.off('pointerupoutside', this.handlePlaybackSpeedPointerUp, this);
  this.playbackSpeedAdjusting = false;
  this.playbackSpeedDragPointerId = undefined;
  this.pendingPlaybackSpeedMultiplier = undefined;
  this.playbackWasRunningBeforeSpeedAdjust = false;
  this.playbackSpeedLabel?.destroy();
  this.playbackSpeedLabel = undefined;
  this.playbackSpeedValueText?.destroy();
  this.playbackSpeedValueText = undefined;

  this.handReminderImage?.destroy();
  this.handReminderImage = undefined;
  this.minimapRenderer.destroy();
  this.fretboardRenderer.reset();
  this.destroyBallTrail();
  this.debugButton?.destroy();
  this.debugButton = undefined;
  this.debugButtonLabel?.destroy();
  this.debugButtonLabel = undefined;
  this.statusText?.destroy();
  this.statusText = undefined;
  this.feedbackMessageText?.destroy();
  this.feedbackMessageText = undefined;
  this.liveScoreText?.destroy();
  this.liveScoreText = undefined;
  this.lastHudStatusText = '';
  this.lastHudFeedbackText = '';
  this.lastHudLiveScoreText = '';
  this.debugOverlayContainer?.destroy(true);
  this.debugOverlayContainer = undefined;
  this.debugOverlayPanel = undefined;
  this.debugOverlayText = undefined;
  this.hitDebugSnapshot = undefined;

  this.noteRenderer.destroy();

  this.runtimeTimer?.remove(false);
  this.runtimeTimer = undefined;
  this.finishDelayTimer?.remove(false);
  this.finishDelayTimer = undefined;
  this.finishQueuedAtMs = undefined;
  this.playbackIntroTimer?.remove(false);
  this.playbackIntroTimer = undefined;
  this.prePlaybackStartAtMs = undefined;
  this.playbackStarted = false;

  this.stopBackingPlayback();
  this.scrubPlayer = undefined;

  this.debugSynth?.stopAll();
  this.debugSynth?.dispose();
  this.debugSynth = undefined;

  this.detector?.stop();
  this.detector = undefined;
  releaseMicStream(this.micStream);
  this.micStream = undefined;

  if (this.onResize) {
    this.scale.off('resize', this.onResize);
    this.onResize = undefined;
  }
  this.cachedLayout = undefined;

  if (this.audioCtx && this.audioCtx.state !== 'closed') {
    void this.audioCtx.close();
  }
  this.audioCtx = undefined;
}
