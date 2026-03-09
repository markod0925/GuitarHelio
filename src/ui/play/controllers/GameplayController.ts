import {
  DEFAULT_HOLD_MS,
  DEFAULT_MIN_CONFIDENCE,
  TARGET_HIT_GRACE_SECONDS
} from '../../../app/config';
import { rateHit } from '../../../game/scoring';
import { updateRuntimeState, type RuntimeTransition, type RuntimeUpdate } from '../../../game/stateMachine';
import { PlayState, type ScoreEvent, type TargetNote } from '../../../types/models';
import { analyzeHeldHit } from '../../playSceneDebug';
import type { PlaySceneContext } from './PlaySceneContext';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;

export class GameplayController {
  constructor(private readonly scene: PlaySceneContext) {}

  tickRuntime(): void {
    tickRuntimeImpl.call(this.scene);
  }

  handleTransition(transition: RuntimeTransition, target: TargetNote | undefined, previousState: PlayState): void {
    handleTransitionImpl.call(this.scene, transition, target, previousState);
  }

  recordScoreEvent(event: ScoreEvent): void {
    recordScoreEventImpl.call(this.scene, event);
  }

  consumeDebugHit(): void {
    consumeDebugHitImpl.call(this.scene);
  }

  queueFinishSong(): void {
    queueFinishSongImpl.call(this.scene);
  }

  clearFinishSongQueue(): void {
    clearFinishSongQueueImpl.call(this.scene);
  }

  measureHitDeltaMs(target: TargetNote, previousState: PlayState): number {
    return measureHitDeltaMsImpl.call(this.scene, target, previousState);
  }

  measureHitSignedDeltaMs(target: TargetNote, previousState: PlayState): number | undefined {
    return measureHitSignedDeltaMsImpl.call(this.scene, target, previousState);
  }

  isInsideLiveHitWindow(target: TargetNote): boolean {
    return isInsideLiveHitWindowImpl.call(this.scene, target);
  }
}

function getRuntimeUpdateScratch(scene: PlaySceneContext): RuntimeUpdate {
  if (scene.runtimeUpdateScratch) return scene.runtimeUpdateScratch;
  scene.runtimeUpdateScratch = {
    state: scene.runtime,
    transition: 'none'
  };
  return scene.runtimeUpdateScratch;
}

function tickRuntimeImpl(this: PlaySceneContext): void {
  if (!this.audioCtx || !this.tempoMap || this.runtime.state === PlayState.Finished || this.pauseOverlay) return;
  if (!this.playbackStarted) {
    this.drawTopStarfield();
    this.updateSongMinimapProgress();
    this.updateHud();
    return;
  }
  const previousState = this.runtime.state;
  let songSecondsNow: number | undefined;

  if (this.runtime.state === PlayState.Playing) {
    songSecondsNow = this.getSongSecondsNow();
    this.runtime.current_tick = this.tempoMap.secondsToTick(songSecondsNow);
    if (this.playbackMode === 'midi') {
      this.scrubPlayer?.updateToTick(this.runtime.current_tick, this.audioCtx.currentTime);
    }
  }

  const active = this.targets[this.runtime.active_target_index];
  const targetSeconds = active ? this.tempoMap.tickToSeconds(active.tick) : undefined;
  const isWithinGraceWindow =
    active !== undefined &&
    this.runtime.state === PlayState.Playing &&
    songSecondsNow !== undefined &&
    targetSeconds !== undefined &&
    songSecondsNow >= targetSeconds - TARGET_HIT_GRACE_SECONDS &&
    songSecondsNow <= targetSeconds + TARGET_HIT_GRACE_SECONDS;
  const canValidateHit =
    active !== undefined && (this.runtime.state === PlayState.WaitingForHit || isWithinGraceWindow);
  const hitAnalysis =
    active !== undefined && canValidateHit
      ? analyzeHeldHit(
        this.latestFrames,
        active.expected_midi,
        this.profile.pitch_tolerance_semitones,
        DEFAULT_HOLD_MS,
        DEFAULT_MIN_CONFIDENCE,
        this.heldHitAnalysisScratch
      )
      : this.writeInvalidHeldHitAnalysis();
  const validHit = active !== undefined && canValidateHit && hitAnalysis.valid;
  const targetDeltaMs =
    songSecondsNow !== undefined && targetSeconds !== undefined ? (songSecondsNow - targetSeconds) * 1000 : undefined;

  const snapshot = this.hitDebugSnapshot ?? {
    isWithinGraceWindow: false,
    canValidateHit: false,
    validHit: false,
    holdMs: 0,
    holdRequiredMs: DEFAULT_HOLD_MS,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    validFrameCount: 0,
    sampleCount: 0
  };
  snapshot.songSecondsNow = songSecondsNow;
  snapshot.targetSeconds = targetSeconds;
  snapshot.targetDeltaMs = targetDeltaMs;
  snapshot.isWithinGraceWindow = isWithinGraceWindow;
  snapshot.canValidateHit = canValidateHit;
  snapshot.validHit = validHit;
  snapshot.activeTarget = active;
  snapshot.latestFrame = hitAnalysis.latestFrame;
  snapshot.holdMs = hitAnalysis.streakMs;
  snapshot.holdRequiredMs = DEFAULT_HOLD_MS;
  snapshot.minConfidence = DEFAULT_MIN_CONFIDENCE;
  snapshot.validFrameCount = hitAnalysis.validFrameCount;
  snapshot.sampleCount = hitAnalysis.sampleCount;
  this.hitDebugSnapshot = snapshot;

  const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, validHit, {
    gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
    targetTimeSeconds: targetSeconds,
    songTimeSeconds: songSecondsNow,
    lateHitWindowSeconds: TARGET_HIT_GRACE_SECONDS,
    finishWhenNoTargets: false
  }, getRuntimeUpdateScratch(this));

  this.runtime = update.state;
  this.handleTransition(update.transition, update.target, previousState);
  if (update.transition !== 'none') {
    this.lastRuntimeTransition = update.transition;
    this.lastRuntimeTransitionAtMs = performance.now();
  }

  this.redrawTargetsAndBall();
  this.drawTopStarfield();
  this.updateSongMinimapProgress();
  this.updateHud();

  if (!this.targets[this.runtime.active_target_index]) {
    this.queueFinishSong();
  } else {
    this.clearFinishSongQueue();
  }
}

function handleTransitionImpl(this: PlaySceneContext, transition: RuntimeTransition, target: TargetNote | undefined, previousState: PlayState): void {
  if (transition === 'entered_waiting') {
    this.pausePlaybackClock();
    this.pauseBackingPlayback();
    this.waitingStartMs = performance.now();
    this.latestFrames.clear();
    this.gameplayPitchStabilizer?.reset();
    this.feedbackText = 'Waiting...';
    this.feedbackUntilMs = performance.now() + 500;
    return;
  }

  if (transition === 'validated_hit' && target) {
    if (previousState === PlayState.WaitingForHit && !this.playbackPausedByButton) {
      this.resumeBackingPlayback();
    }
    const signedDeltaMs = this.measureHitSignedDeltaMs(target, previousState);
    const deltaMs = this.measureHitDeltaMs(target, previousState);
    const rated = rateHit(deltaMs);
    this.recordScoreEvent({ targetId: target.id, rating: rated.rating, deltaMs, points: rated.points });
    if (rated.rating !== 'Miss') {
      this.correctlyHitTargetIds.add(target.id);
    }
    this.waitingStartMs = null;
    this.latestFrames.clear();
    this.gameplayPitchStabilizer?.reset();
    if (signedDeltaMs !== undefined && signedDeltaMs < -50) {
      this.feedbackText = 'Too Soon';
    } else {
      this.feedbackText = rated.rating === 'Miss' ? 'Too Late' : rated.rating;
    }
    this.feedbackUntilMs = performance.now() + 700;
    return;
  }

  if (transition === 'timeout_miss' && target) {
    if (previousState === PlayState.WaitingForHit && !this.playbackPausedByButton) {
      this.resumeBackingPlayback();
    }
    const fallbackDeltaMs = (this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds ?? 0) * 1000;
    const deltaMs = this.waitingStartMs === null ? fallbackDeltaMs : performance.now() - this.waitingStartMs;
    this.recordScoreEvent({ targetId: target.id, rating: 'Miss', deltaMs, points: 0 });
    this.waitingStartMs = null;
    this.latestFrames.clear();
    this.gameplayPitchStabilizer?.reset();
    this.feedbackText = 'Too Late';
    this.feedbackUntilMs = performance.now() + 900;
  }
}

function recordScoreEventImpl(this: PlaySceneContext, event: ScoreEvent): void {
  this.scoreEvents.push(event);
  this.totalScore += event.points;
  if (event.rating === 'Miss') {
    this.currentComboStreak = 0;
    return;
  }
  this.currentComboStreak += 1;
}

function consumeDebugHitImpl(this: PlaySceneContext): void {
  if (this.isWaitingPausedByButton()) {
    this.feedbackText = 'Resume with Play before debug input';
    this.feedbackUntilMs = performance.now() + 900;
    this.updateHud();
    return;
  }
  if (!this.audioCtx || !this.tempoMap) return;
  if (!this.playbackStarted) {
    this.feedbackText = 'Playback not started yet';
    this.feedbackUntilMs = performance.now() + 700;
    this.updateHud();
    return;
  }
  const previousState = this.runtime.state;
  const active = this.targets[this.runtime.active_target_index];
  const targetTimeSeconds = active ? this.tempoMap.tickToSeconds(active.tick) : undefined;
  const songTimeSeconds = this.getSongSecondsNow();
  const forceTooLateForWaiting = previousState === PlayState.WaitingForHit;
  const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, !forceTooLateForWaiting, {
    gatingTimeoutSeconds: forceTooLateForWaiting ? 0 : this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
    targetTimeSeconds,
    songTimeSeconds,
    lateHitWindowSeconds: TARGET_HIT_GRACE_SECONDS,
    finishWhenNoTargets: false
  }, getRuntimeUpdateScratch(this));
  this.runtime = update.state;
  this.handleTransition(update.transition, update.target, previousState);
  if (update.transition !== 'none') {
    this.lastRuntimeTransition = update.transition;
    this.lastRuntimeTransitionAtMs = performance.now();
  }
  this.redrawTargetsAndBall();
  this.updateSongMinimapProgress();
  this.updateHud();
  if (!this.targets[this.runtime.active_target_index]) {
    this.queueFinishSong();
  } else {
    this.clearFinishSongQueue();
  }
}

function queueFinishSongImpl(this: PlaySceneContext): void {
  const sceneClass = this.constructor as PlaySceneStatics;
  if (this.resultsOverlay?.active) return;
  const now = performance.now();
  if (this.finishQueuedAtMs === undefined) {
    this.finishQueuedAtMs = now + sceneClass.POST_SONG_END_SCREEN_DELAY_MS;
    if (!this.finishDelayTimer) {
      this.finishDelayTimer = this.time.delayedCall(sceneClass.POST_SONG_END_SCREEN_DELAY_MS, () => {
        this.finishDelayTimer = undefined;
        this.finishQueuedAtMs = undefined;
        if (!this.scene.isActive()) return;
        this.finishSong();
      });
    }
    return;
  }

  if (now >= this.finishQueuedAtMs) {
    this.finishDelayTimer?.remove(false);
    this.finishDelayTimer = undefined;
    this.finishQueuedAtMs = undefined;
    if (!this.scene.isActive()) return;
    this.finishSong();
  }
}

function clearFinishSongQueueImpl(this: PlaySceneContext): void {
  this.finishDelayTimer?.remove(false);
  this.finishDelayTimer = undefined;
  this.finishQueuedAtMs = undefined;
}

function measureHitDeltaMsImpl(this: PlaySceneContext, target: TargetNote, previousState: PlayState): number {
  if (previousState === PlayState.Playing && this.tempoMap) {
    const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
    return Math.abs(this.getSongSecondsNow() - targetSeconds) * 1000;
  }
  return this.waitingStartMs === null ? 0 : performance.now() - this.waitingStartMs;
}

function measureHitSignedDeltaMsImpl(this: PlaySceneContext, target: TargetNote, previousState: PlayState): number | undefined {
  if (previousState !== PlayState.Playing || !this.tempoMap) return undefined;
  const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
  return (this.getSongSecondsNow() - targetSeconds) * 1000;
}

function isInsideLiveHitWindowImpl(this: PlaySceneContext, target: TargetNote): boolean {
  if (!this.tempoMap) return false;
  const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
  const now = this.getSongSecondsNow();
  return now >= targetSeconds - TARGET_HIT_GRACE_SECONDS && now <= targetSeconds + TARGET_HIT_GRACE_SECONDS;
}
