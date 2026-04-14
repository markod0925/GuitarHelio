import {
  DEFAULT_HOLD_MS,
  DEFAULT_MIN_CONFIDENCE
} from '../../../app/config';
import { buildMaspValidationContextForTargetGroup } from '../../../audio/maspShared';
import { resolveTargetGroup, resolveTargetChordId } from '../../../guitar/targetGrouping';
import { rateHit } from '../../../game/scoring';
import { updateRuntimeState, type RuntimeTransition, type RuntimeUpdate } from '../../../game/stateMachine';
import { PlayState, type ScoreEvent, type TargetNote } from '../../../types/models';
import { analyzeHeldHitForTarget } from '../../playSceneDebug';
import type { PlaySceneContext } from './PlaySceneContext';
import {
  buildValidationWindowTargetKey,
  markGameplayValidationWindowAccepted,
  resolveGameplayValidationToleranceSeconds,
  syncGameplayValidationWindow
} from './validationWindow';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;

type ChordHitProgress = {
  requiredCount: number;
  hitCount: number;
  valid: boolean;
};

const MASP_CONTEXT_MIN_SYNC_INTERVAL_SECONDS = 0.05;

export class GameplayController {
  constructor(private readonly scene: PlaySceneContext) {}

  tickRuntime(): void {
    tickRuntimeImpl.call(this.scene);
  }

  handleTransition(
    transition: RuntimeTransition,
    target: TargetNote | undefined,
    targetGroup: TargetNote[] | undefined,
    previousState: PlayState
  ): void {
    handleTransitionImpl.call(this.scene, transition, target, targetGroup, previousState);
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

function syncMaspValidationContext(scene: PlaySceneContext, targetGroup: TargetNote[]): void {
  const detector = scene.detector;
  const tempoMap = scene.tempoMap;
  if (!detector || !tempoMap) return;
  const playheadSec = scene.getSongSecondsFromClock();

  if (targetGroup.length === 0) {
    if (scene.activeMaspContextTargetKey !== '') {
      detector.updateMaspValidationContext(null);
      scene.activeMaspContextTargetKey = '';
      scene.lastMaspContextSyncSongSeconds = playheadSec;
    }
    return;
  }
  const targetKey = buildMaspTargetKey(targetGroup);
  const syncElapsed = playheadSec - scene.lastMaspContextSyncSongSeconds;
  const shouldSync = targetKey !== scene.activeMaspContextTargetKey || syncElapsed < 0 || syncElapsed >= MASP_CONTEXT_MIN_SYNC_INTERVAL_SECONDS;
  if (!shouldSync) {
    return;
  }

  const context = buildMaspValidationContextForTargetGroup(targetGroup, (tick) => tempoMap.tickToSeconds(tick), playheadSec);
  if (!context) {
    if (scene.activeMaspContextTargetKey !== '') {
      detector.updateMaspValidationContext(null);
      scene.activeMaspContextTargetKey = '';
      scene.lastMaspContextSyncSongSeconds = playheadSec;
    }
    return;
  }

  detector.updateMaspValidationContext(context);
  scene.activeMaspContextTargetKey = targetKey;
  scene.lastMaspContextSyncSongSeconds = playheadSec;
}

function buildMaspTargetKey(targetGroup: TargetNote[]): string {
  return targetGroup.map((target) => target.id).join('|');
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

  if (this.playbackStarted && this.audioCtx) {
    songSecondsNow = this.getSongSecondsNow();
  }

  if (this.runtime.state === PlayState.Playing && songSecondsNow !== undefined) {
    this.runtime.current_tick = this.tempoMap.secondsToTick(songSecondsNow);
    if (this.playbackMode === 'midi') {
      this.scrubPlayer?.updateToTick(this.runtime.current_tick, this.audioCtx.currentTime);
    }
  }

  const activeGroup = resolveTargetGroup(this.targets, this.runtime.active_target_index);
  const active = activeGroup[0];
  syncMaspValidationContext(this, activeGroup);
  syncActiveChordTracking(this, active);
  const validationWindow = syncGameplayValidationWindow(this, performance.now(), songSecondsNow);

  const targetSeconds = active ? this.tempoMap.tickToSeconds(active.tick) : undefined;
  const canValidateHit = validationWindow.phase === 'armed';
  const thresholds = resolveDetectionThresholds(this);
  const validationTolerance = resolveGameplayValidationToleranceSeconds(this.sceneData?.difficulty);
  const requireStringValidation = shouldRequireStringValidation(this.sceneData?.difficulty);

  const leadHitAnalysis =
    active !== undefined && canValidateHit
      ? analyzeHeldHitForTarget(
        this.latestFrames,
        active.expected_midi,
        active.string,
        this.profile.pitch_tolerance_semitones,
        thresholds.holdMs,
        thresholds.minConfidence,
        requireStringValidation,
        this.heldHitAnalysisScratch
      )
      : this.writeInvalidHeldHitAnalysis();

  const chordProgress =
    active !== undefined && canValidateHit
      ? updateChordHitProgress(this, activeGroup, requireStringValidation)
      : {
          requiredCount: activeGroup.length,
          hitCount: countChordHits(this, activeGroup),
          valid: false
        };

  const runtimeValidationOutput = this.realtimeValidationOutput;
  const validHit =
    active !== undefined &&
    validationWindow.phase === 'accepted' &&
    validationWindow.targetKey !== null &&
    validationWindow.targetKey === buildValidationWindowTargetKey(activeGroup) &&
    runtimeValidationOutput?.accepted === true;
  const targetDeltaMs =
    songSecondsNow !== undefined && targetSeconds !== undefined ? (songSecondsNow - targetSeconds) * 1000 : undefined;

  const snapshot = this.hitDebugSnapshot ?? {
    isWithinGraceWindow: false,
    canValidateHit: false,
    validHit: false,
    holdMs: 0,
    holdRequiredMs: thresholds.holdMs,
    minConfidence: thresholds.minConfidence,
    validFrameCount: 0,
    sampleCount: 0
  };
  snapshot.songSecondsNow = songSecondsNow;
  snapshot.targetSeconds = targetSeconds;
  snapshot.targetDeltaMs = targetDeltaMs;
  snapshot.isWithinGraceWindow = validationWindow.phase === 'armed' || validationWindow.phase === 'accepted';
  snapshot.canValidateHit = canValidateHit;
  snapshot.validHit = validHit;
  snapshot.activeTarget = active;
  snapshot.latestFrame = leadHitAnalysis.latestFrame;
  snapshot.holdMs = leadHitAnalysis.streakMs;
  snapshot.holdRequiredMs = thresholds.holdMs;
  snapshot.minConfidence = thresholds.minConfidence;
  snapshot.validFrameCount = leadHitAnalysis.validFrameCount;
  snapshot.sampleCount = leadHitAnalysis.sampleCount;
  snapshot.activeChordSize = chordProgress.requiredCount;
  snapshot.validatedChordNotes = chordProgress.hitCount;
  this.hitDebugSnapshot = snapshot;
  this.validationWindowState = validationWindow;

  const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, validHit, {
    gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
    targetTimeSeconds: targetSeconds,
    songTimeSeconds: songSecondsNow,
    lateHitWindowSeconds: validationTolerance.lateSeconds,
    finishWhenNoTargets: false
  }, getRuntimeUpdateScratch(this));

  this.runtime = update.state;
  this.handleTransition(update.transition, update.target, update.targetGroup, previousState);
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

function handleTransitionImpl(
  this: PlaySceneContext,
  transition: RuntimeTransition,
  target: TargetNote | undefined,
  targetGroup: TargetNote[] | undefined,
  previousState: PlayState
): void {
  const resolvedGroup = resolveTransitionGroup(target, targetGroup);

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

  if (transition === 'validated_hit' && resolvedGroup.length > 0) {
    if (previousState === PlayState.WaitingForHit && !this.playbackPausedByButton) {
      this.resumeBackingPlayback();
    }

    const leadTarget = resolvedGroup[0];
    const signedDeltaMs = this.measureHitSignedDeltaMs(leadTarget, previousState);
    const deltaMs = this.measureHitDeltaMs(leadTarget, previousState);
    const rated = rateHit(deltaMs, { noMiss: this.sceneData?.difficulty === 'Easy' });

    for (const targetNote of resolvedGroup) {
      this.recordScoreEvent({ targetId: targetNote.id, rating: rated.rating, deltaMs, points: rated.points });
      if (rated.rating !== 'Miss') {
        this.correctlyHitTargetIds.add(targetNote.id);
      }
    }

    clearChordTracking(this);
    this.waitingStartMs = null;
    this.latestFrames.clear();
    this.gameplayPitchStabilizer?.reset();
    markGameplayValidationWindowAccepted(
      this,
      performance.now(),
      this.playbackStarted ? this.getSongSecondsNow() : undefined
    );

    if (signedDeltaMs !== undefined && signedDeltaMs < -50) {
      this.feedbackText = 'Too Soon';
    } else if (rated.rating === 'Miss') {
      this.feedbackText = 'Too Late';
    } else {
      this.feedbackText = resolvedGroup.length > 1 ? `${rated.rating} x${resolvedGroup.length}` : rated.rating;
    }
    this.feedbackUntilMs = performance.now() + 700;
    return;
  }

  if (transition === 'timeout_miss' && resolvedGroup.length > 0) {
    if (previousState === PlayState.WaitingForHit && !this.playbackPausedByButton) {
      this.resumeBackingPlayback();
    }
    const fallbackDeltaMs = (this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds ?? 0) * 1000;
    const deltaMs = this.waitingStartMs === null ? fallbackDeltaMs : performance.now() - this.waitingStartMs;

    for (const targetNote of resolvedGroup) {
      this.recordScoreEvent({ targetId: targetNote.id, rating: 'Miss', deltaMs, points: 0 });
    }

    clearChordTracking(this);
    this.waitingStartMs = null;
    this.latestFrames.clear();
    this.gameplayPitchStabilizer?.reset();
    this.feedbackText = 'Too Late';
    this.feedbackUntilMs = performance.now() + 900;
  }
}

function recordScoreEventImpl(this: PlaySceneContext, event: ScoreEvent): void {
  const sceneClass = this.constructor as Partial<PlaySceneStatics>;
  const maxComboMultiplier = sceneClass.MAX_COMBO_MULTIPLIER ?? 20;
  this.scoreEvents.push(event);
  this.totalScore += event.points;
  if (event.rating === 'Miss') {
    this.currentComboStreak = 0;
    return;
  }
  this.currentComboStreak = Math.min(maxComboMultiplier, this.currentComboStreak + 1);
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
  const activeGroup = resolveTargetGroup(this.targets, this.runtime.active_target_index);
  const active = activeGroup[0];
  const targetTimeSeconds = active ? this.tempoMap.tickToSeconds(active.tick) : undefined;
  const songTimeSeconds = this.getSongSecondsNow();
  const validationTolerance = resolveGameplayValidationToleranceSeconds(this.sceneData?.difficulty);
  const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, true, {
    gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
    targetTimeSeconds,
    songTimeSeconds,
    lateHitWindowSeconds: validationTolerance.lateSeconds,
    finishWhenNoTargets: false
  }, getRuntimeUpdateScratch(this));
  this.runtime = update.state;
  this.handleTransition(update.transition, update.target, update.targetGroup, previousState);
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
  const tolerance = resolveGameplayValidationToleranceSeconds(this.sceneData?.difficulty);
  return now >= targetSeconds - tolerance.earlySeconds && now <= targetSeconds + tolerance.lateSeconds;
}

function resolveTransitionGroup(target: TargetNote | undefined, targetGroup: TargetNote[] | undefined): TargetNote[] {
  if (targetGroup && targetGroup.length > 0) return targetGroup;
  if (target) return [target];
  return [];
}

function syncActiveChordTracking(scene: PlaySceneContext, activeTarget: TargetNote | undefined): void {
  const nextChordId = activeTarget ? resolveTargetChordId(activeTarget) : undefined;
  if (scene.activeChordTrackingId === nextChordId) {
    return;
  }

  scene.activeChordTrackingId = nextChordId;
  scene.chordHitTargetIds.clear();
}

function updateChordHitProgress(
  scene: PlaySceneContext,
  chordTargets: TargetNote[],
  requireStringValidation: boolean
): ChordHitProgress {
  const thresholds = resolveDetectionThresholds(scene);
  for (const target of chordTargets) {
    if (scene.chordHitTargetIds.has(target.id)) continue;
    const hit = analyzeHeldHitForTarget(
      scene.latestFrames,
      target.expected_midi,
      target.string,
      scene.profile.pitch_tolerance_semitones,
      thresholds.holdMs,
      thresholds.minConfidence,
      requireStringValidation
    );
    if (!hit.valid) continue;
    scene.chordHitTargetIds.add(target.id);
  }

  const hitCount = countChordHits(scene, chordTargets);
  return {
    requiredCount: chordTargets.length,
    hitCount,
    valid: hitCount >= chordTargets.length
  };
}

function countChordHits(scene: PlaySceneContext, chordTargets: TargetNote[]): number {
  let hitCount = 0;
  for (const target of chordTargets) {
    if (scene.chordHitTargetIds.has(target.id)) {
      hitCount += 1;
    }
  }
  return hitCount;
}

function clearChordTracking(scene: PlaySceneContext): void {
  scene.activeChordTrackingId = undefined;
  scene.chordHitTargetIds.clear();
}

function resolveDetectionThresholds(scene: PlaySceneContext): { holdMs: number; minConfidence: number } {
  if (scene.audioInputMode === 'speaker') {
    return {
      holdMs: 110,
      minConfidence: 0.76
    };
  }
  return {
    holdMs: DEFAULT_HOLD_MS,
    minConfidence: DEFAULT_MIN_CONFIDENCE
  };
}

function shouldRequireStringValidation(difficulty: 'Easy' | 'Medium' | 'Hard' | undefined): boolean {
  return difficulty === 'Medium' || difficulty === 'Hard';
}
