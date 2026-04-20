import Phaser from 'phaser';
import {
  DEFAULT_HOLD_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_GATING_TIMEOUT_SECONDS,
  PLAY_SCENE_ENABLE_DEBUG_OVERLAY,
  PLAY_SCENE_ENABLE_PROFILING
} from '../../../app/config';
import { createInitialRuntimeState } from '../../../game/stateMachine';
import {
  disableKeepScreenOnAfterPlayScene,
  enableKeepScreenOnDuringPlayScene
} from '../../../platform/nativeKeepScreenOn';
import { releaseMicStream } from '../../AudioController';
import { isGameplayDebugOverlayEnabled } from '../../playSceneDebug';
import type { PlaySceneContext } from './PlaySceneContext';
import { runtimeLog } from '../../../app/runtimeLog';
import { createIdleValidationWindowState } from './validationWindow';
import { finalizeGameplayValidationDebugLog } from './gameplayValidationDebugLog';
import { createGameplayValidationLiveTraceSession } from './gameplayValidationLiveTrace';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;
const MAIN_LOOP_BUDGET_MS = 16.67;

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
  finalizeGameplayValidationDebugLog();
  runtimeLog(
    { scene: 'PlayScene', subsystem: 'scene' },
    'INFO',
    'Initializing play scene session state.',
    { audioInputMode: this.audioInputMode }
  );
  void enableKeepScreenOnDuringPlayScene();
  stopLongTaskObserver(this);
  const sceneClass = this.constructor as PlaySceneStatics;
  this.runtime = createInitialRuntimeState();
  this.scoreEvents = [];
  this.totalScore = 0;
  this.currentComboStreak = 0;
  this.correctlyHitTargetIds.clear();
  this.chordHitTargetIds.clear();
  this.activeChordTrackingId = undefined;
  this.activeMaspContextTargetKey = '';
  this.lastMaspContextSyncSongSeconds = Number.NEGATIVE_INFINITY;
  this.latestFrames.clear();
  this.gameplayPitchStabilizer?.reset();
  this.waitingStartMs = null;
  this.validationWindowState = createIdleValidationWindowState();
  this.gameplayValidationDebugSnapshot = undefined;
  this.gameplayValidationDebugLastAccepted = undefined;
  this.gameplayValidationDebugLastExpired = undefined;
  this.gameplayValidationDebugLastRejected = undefined;
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
  this.detectorLegacyFallback = false;
  this.realtimeGameplayValidator.reset();
  this.realtimeValidationOutput = undefined;
  this.realtimeValidationState = this.realtimeGameplayValidator.getState();
  this.latestRuntimeDetectorFrame = undefined;
  this.latestRuntimeFrameEvidence = undefined;
  this.latestRuntimeValidationSnapshot = undefined;
  this.gameplayValidationLiveTrace = createGameplayValidationLiveTraceSession();
  this.referenceInputGain = undefined;
  this.referenceTapGain = undefined;
  this.lastBallTrailRedrawAtMs = Number.NEGATIVE_INFINITY;
  this.lastHudStatusText = '';
  this.lastHudFeedbackText = '';
  this.lastHudLiveScoreText = '';
  this.multiplierShipBounds = undefined;
  this.multiplierShipX = 0;
  this.multiplierShipY = 0;
  this.multiplierShipTargetX = 0;
  this.multiplierShipTargetY = 0;
  this.multiplierShipRetargetAtMs = 0;
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
  this.runtimeLoopSampleCount = 0;
  this.runtimeLoopSampleCursor = 0;
  this.runtimeLoopOverBudgetCount = 0;
  this.runtimeLoopLastDurationMs = 0;
  this.runtimeLoopLastAtMs = 0;
  this.hudUpdateSampleCount = 0;
  this.hudUpdateSampleCursor = 0;
  this.hudUpdateOverBudgetCount = 0;
  this.hudUpdateLastDurationMs = 0;
  this.hudUpdateLastAtMs = 0;
  this.longTaskCount = 0;
  this.longTaskTotalDurationMs = 0;
  this.longTaskMaxDurationMs = 0;
  this.longTaskLastAtMs = 0;
  this.audioProfilingSnapshot = undefined;
  this.audioProfilingSnapshotAtMs = 0;
  this.debugOverlayEnabled =
    PLAY_SCENE_ENABLE_DEBUG_OVERLAY &&
    (this.sceneData?.showGameplayValidationDebug === true || isGameplayDebugOverlayEnabled());
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
  if (PLAY_SCENE_ENABLE_PROFILING) {
    startLongTaskObserver(this);
  }
  this.runtimeTimer = this.time.addEvent({
    delay: 16,
    loop: true,
    callback: () => {
      if (!PLAY_SCENE_ENABLE_PROFILING) {
        this.tickRuntime();
        return;
      }
      const startedAt = readClockMs();
      try {
        this.tickRuntime();
      } finally {
        recordRuntimeLoopDuration(this, readClockMs() - startedAt);
      }
    }
  });
  this.schedulePlaybackStart();
  this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
}

function cleanupImpl(this: PlaySceneContext): void {
  runtimeLog({ scene: 'PlayScene', subsystem: 'scene' }, 'INFO', 'Cleaning up play scene.');
  finalizeGameplayValidationDebugLog();
  void disableKeepScreenOnAfterPlayScene();
  stopLongTaskObserver(this);
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
  this.debugOverlayToggleButton?.destroy();
  this.debugOverlayToggleButton = undefined;
  this.debugOverlayToggleLabel?.destroy();
  this.debugOverlayToggleLabel = undefined;
  this.multiplierShipEngineGlow?.destroy();
  this.multiplierShipEngineGlow = undefined;
  this.multiplierShipWingTop?.destroy();
  this.multiplierShipWingTop = undefined;
  this.multiplierShipWingBottom?.destroy();
  this.multiplierShipWingBottom = undefined;
  this.multiplierShipHull?.destroy();
  this.multiplierShipHull = undefined;
  this.multiplierShipCockpit?.destroy();
  this.multiplierShipCockpit = undefined;
  this.multiplierShipBounds = undefined;
  this.multiplierShipX = 0;
  this.multiplierShipY = 0;
  this.multiplierShipTargetX = 0;
  this.multiplierShipTargetY = 0;
  this.multiplierShipRetargetAtMs = 0;
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
  this.realtimeValidationOutput = undefined;
  this.realtimeValidationState = undefined;
  this.latestRuntimeDetectorFrame = undefined;
  this.latestRuntimeFrameEvidence = undefined;

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
  this.gameplayPitchStabilizer = undefined;
  this.referenceInputGain?.disconnect();
  this.referenceInputGain = undefined;
  this.referenceTapGain?.disconnect();
  this.referenceTapGain = undefined;
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

function recordRuntimeLoopDuration(scene: PlaySceneContext, durationMs: number): void {
  const sample = sanitizeDuration(durationMs);
  const cursor = scene.runtimeLoopSampleCursor;
  scene.runtimeLoopDurationsMs[cursor] = sample;
  scene.runtimeLoopSampleCursor = (cursor + 1) % scene.runtimeLoopDurationsMs.length;
  scene.runtimeLoopSampleCount = Math.min(scene.runtimeLoopDurationsMs.length, scene.runtimeLoopSampleCount + 1);
  scene.runtimeLoopLastDurationMs = sample;
  scene.runtimeLoopLastAtMs = readClockMs();
  if (sample > MAIN_LOOP_BUDGET_MS) {
    scene.runtimeLoopOverBudgetCount += 1;
  }
}

function startLongTaskObserver(scene: PlaySceneContext): void {
  stopLongTaskObserver(scene);
  if (typeof PerformanceObserver === 'undefined') return;
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (!entries.length) return;
      const now = readClockMs();
      for (const entry of entries) {
        const duration = sanitizeDuration(entry.duration);
        scene.longTaskCount += 1;
        scene.longTaskTotalDurationMs += duration;
        scene.longTaskMaxDurationMs = Math.max(scene.longTaskMaxDurationMs, duration);
        scene.longTaskLastAtMs = now;
      }
    });
  } catch (error) {
    console.warn('Unable to allocate PerformanceObserver for long tasks.', error);
    return;
  }
  try {
    observer.observe({ type: 'longtask', buffered: true });
    scene.longTaskObserver = observer;
  } catch (error) {
    try {
      observer.disconnect();
    } catch {
      // best-effort cleanup
    }
    console.warn('Long task observer is not supported in this runtime.', error);
  }
}

function stopLongTaskObserver(scene: PlaySceneContext): void {
  if (!scene.longTaskObserver) return;
  try {
    scene.longTaskObserver.disconnect();
  } catch {
    // best-effort cleanup
  }
  scene.longTaskObserver = undefined;
}

function sanitizeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function readClockMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
