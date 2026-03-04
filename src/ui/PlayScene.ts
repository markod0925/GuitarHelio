import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import {
  BALL_BOUNCE_AMPLITUDE_FACTOR,
  BALL_BOUNCE_AMPLITUDE_MAX_PX,
  BALL_BOUNCE_AMPLITUDE_MIN_PX,
  BALL_GHOST_TRAIL_COUNT,
  BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS,
  BALL_GHOST_TRAIL_SAMPLE_STEP,
  DEFAULT_HOLD_MS,
  DEFAULT_MIN_CONFIDENCE,
  DIFFICULTY_PRESETS,
  PLAY_SCENE_NOTE_START_CUTOFF_SECONDS,
  TARGET_HIT_GRACE_SECONDS
} from '../app/config';
import { saveSongHighScoreIfHigher } from '../app/sessionPersistence';
import { createMicNode } from '../audio/micInput';
import { JzzTinySynth } from '../audio/jzzTinySynth';
import { MidiScrubPlayer } from '../audio/midiScrubPlayer';
import { PitchDetectorService } from '../audio/pitchDetector';
import { buildPlaybackNotes } from '../audio/playbackNotes';
import { rateHit, summarizeScores } from '../game/scoring';
import { createInitialRuntimeState, type RuntimeTransition, updateRuntimeState } from '../game/stateMachine';
import { generateTargetNotes } from '../guitar/targetGenerator';
import { loadMidiFromUrl } from '../midi/midiLoader';
import { TempoMap } from '../midi/tempoMap';
import type { DifficultyProfile, PitchFrame, ScoreEvent, SourceNote, TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { formatSummary } from './hud';
import {
  resolveResumeSongSeconds,
  resolveResumeSongSecondsForAudio,
  resolveSongSecondsForRuntime,
  sanitizeSongSeconds
} from './playbackResumeState';
import { BallTrailRingBuffer } from './BallAnimator';
import {
  getSongSecondsFromClock as getSongSecondsFromClockValue,
  pausePlaybackClock as pausePlaybackClockState,
  releaseMicStream,
  startPlaybackClock as startPlaybackClockState,
  type PlaybackClockState
} from './AudioController';
import { FretboardRenderer } from './FretboardRenderer';
import { MinimapRenderer } from './MinimapRenderer';
import { NoteRenderer } from './NoteRenderer';
import {
  analyzeHeldHit,
  filterSourceNotesByOnsetSeconds,
  formatDebugBool,
  formatDebugNumber,
  formatDebugPath,
  formatSignedMs,
  isBackingTrackAudioUrl,
  isGameplayDebugOverlayEnabled,
  sanitizeSelection
} from './playSceneDebug';
import type {
  AudioSeekDebugInfo,
  HitDebugSnapshot,
  Layout,
  PlaybackMode,
  SceneData,
} from './playSceneTypes';
import { RoundedBox } from './RoundedBox';
import {
  computeEndScreenStars as computeOverlayEndScreenStars,
  resolveTopFeedbackMessage as resolveOverlayTopFeedbackMessage
} from './UIOverlays';

export class PlayScene extends Phaser.Scene {
  private static readonly PAUSE_BUTTON_SIZE = 34;
  private static readonly PAUSE_BUTTON_GAP = 10;
  private static readonly PLAYBACK_SPEED_MIN = 0.25;
  private static readonly PLAYBACK_SPEED_MAX = 1.25;
  private static readonly PLAYBACK_SPEED_DEFAULT = 1;
  private static readonly POST_SONG_END_SCREEN_DELAY_MS = 2000;
  private static readonly PRE_PLAYBACK_DELAY_MS = 3500;
  private static readonly BALL_TRAIL_HISTORY_CAPACITY =
    BALL_GHOST_TRAIL_COUNT * BALL_GHOST_TRAIL_SAMPLE_STEP * 12 + BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS * 4 + 96;

  private sceneData?: SceneData;
  private targets: TargetNote[] = [];
  private targetOnsetSeconds: number[] = [];
  private runtime = createInitialRuntimeState();
  private scoreEvents: ScoreEvent[] = [];
  private totalScore = 0;
  private currentComboStreak = 0;
  private correctlyHitTargetIds = new Set<string>();
  private latestFrames: PitchFrame[] = [];
  private waitingStartMs: number | null = null;
  private ticksPerQuarter = 480;
  private tempoMap: TempoMap | null = null;
  private playbackStartAudioTime: number | null = null;
  private playbackStartSongSeconds = 0;
  private pausedSongSeconds = 0;
  private profile: DifficultyProfile = DIFFICULTY_PRESETS.Easy;
  private fallbackTimeoutSeconds: number | undefined;
  private feedbackText = '';
  private feedbackUntilMs = 0;
  private playbackMode: PlaybackMode = 'midi';
  private backingTrackBuffer?: AudioBuffer;
  private backingTrackSource?: AudioBufferSourceNode;
  private backingTrackGain?: GainNode;
  private backingTrackSourceStartedAtAudioTime?: number;
  private backingTrackSourceStartSongSeconds = 0;
  private backingTrackIsPlaying = false;
  private backingTrackAudioUrl?: string;
  private pausedBackingAudioSeconds?: number;
  private lastKnownBackingAudioSeconds = 0;
  private playbackSpeedMultiplier = PlayScene.PLAYBACK_SPEED_DEFAULT;

  private laneLayer?: Phaser.GameObjects.Graphics;
  private ball?: Phaser.GameObjects.Arc;
  private ballTrailSegments: Array<{ shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line }> = [];
  private readonly ballTrailHistory = new BallTrailRingBuffer(PlayScene.BALL_TRAIL_HISTORY_CAPACITY);
  private hasLastBallTrailPoint = false;
  private lastBallTrailX = 0;
  private lastBallTrailY = 0;
  private readonly fretboardRenderer = new FretboardRenderer(this);
  private readonly minimapRenderer = new MinimapRenderer(this);
  private readonly noteRenderer = new NoteRenderer(this);
  private handReminderImage?: Phaser.GameObjects.Image;
  private statusText?: Phaser.GameObjects.Text;
  private feedbackMessageText?: Phaser.GameObjects.Text;
  private liveScoreText?: Phaser.GameObjects.Text;
  private debugButton?: RoundedBox;
  private debugButtonLabel?: Phaser.GameObjects.Text;
  private resultsOverlay?: Phaser.GameObjects.Container;
  private pauseOverlay?: Phaser.GameObjects.Container;
  private pauseButton?: RoundedBox;
  private pauseButtonLeftBar?: Phaser.GameObjects.Rectangle;
  private pauseButtonRightBar?: Phaser.GameObjects.Rectangle;
  private pauseButtonPlayIcon?: Phaser.GameObjects.Triangle;
  private playbackSpeedPanel?: RoundedBox;
  private playbackSpeedTrack?: Phaser.GameObjects.Rectangle;
  private playbackSpeedKnob?: Phaser.GameObjects.Arc;
  private playbackSpeedLabel?: Phaser.GameObjects.Text;
  private playbackSpeedValueText?: Phaser.GameObjects.Text;
  private playbackSpeedAdjusting = false;
  private playbackSpeedDragPointerId?: number;
  private pendingPlaybackSpeedMultiplier?: number;
  private playbackWasRunningBeforeSpeedAdjust = false;
  private runtimeTimer?: Phaser.Time.TimerEvent;
  private finishDelayTimer?: Phaser.Time.TimerEvent;
  private finishQueuedAtMs?: number;
  private playbackIntroTimer?: Phaser.Time.TimerEvent;
  private playbackStarted = false;
  private prePlaybackStartAtMs?: number;

  private audioCtx?: AudioContext;
  private debugSynth?: JzzTinySynth;
  private scrubPlayer?: MidiScrubPlayer;
  private detector?: PitchDetectorService;
  private micStream?: MediaStream;
  private onResize?: () => void;
  private cachedLayout?: Layout;
  private pauseMenuBackListener?: (event: Event) => void;
  private pauseMenuPopStateListener?: (event: PopStateEvent) => void;
  private playbackWasRunningBeforePauseMenu = false;
  private pauseMenuResumeSongSeconds?: number;
  private playbackPausedByButton = false;
  private playbackWasRunningBeforeButtonPause = false;
  private waitingPauseStartedAtAudioTime?: number;
  private debugOverlayEnabled = false;
  private debugOverlayContainer?: Phaser.GameObjects.Container;
  private debugOverlayPanel?: RoundedBox;
  private debugOverlayText?: Phaser.GameObjects.Text;
  private hitDebugSnapshot?: HitDebugSnapshot;
  private lastRuntimeTransition: RuntimeTransition = 'none';
  private lastRuntimeTransitionAtMs = 0;
  private lastAudioSeekDebug?: AudioSeekDebugInfo;

  constructor() {
    super('PlayScene');
  }

  async create(data: SceneData): Promise<void> {
    this.sceneData = data;
    const difficulty = DIFFICULTY_PRESETS[data.difficulty] ?? DIFFICULTY_PRESETS.Easy;
    this.profile = this.buildProfileWithSettings(difficulty, data.allowedStrings, data.allowedFingers, data.allowedFrets);

    let loaded;
    try {
      loaded = await loadMidiFromUrl(data.midiUrl);
    } catch (error) {
      console.error('Failed to load MIDI', { midiUrl: data.midiUrl, audioUrl: data.audioUrl, error });
      this.add
        .text(this.scale.width / 2, this.scale.height / 2, `Could not load song file:\n${data.midiUrl}`, {
          color: '#ffb4b4',
          align: 'center',
          fontSize: `${Math.max(16, Math.floor(this.scale.width * 0.02))}px`
        })
        .setOrigin(0.5);
      return;
    }

    this.tempoMap = loaded.tempoMap;
    this.ticksPerQuarter = loaded.ticksPerQuarter;
    const sessionTargetSourceNotes = filterSourceNotesByOnsetSeconds(
      loaded.sourceNotes,
      loaded.tempoMap,
      PLAY_SCENE_NOTE_START_CUTOFF_SECONDS
    );
    this.targets = generateTargetNotes(sessionTargetSourceNotes, this.profile, loaded.tempoMap);
    this.targetOnsetSeconds = this.targets.map((target) => loaded.tempoMap.tickToSeconds(target.tick));

    this.runtime = createInitialRuntimeState();
    this.scoreEvents = [];
    this.totalScore = 0;
    this.currentComboStreak = 0;
    this.correctlyHitTargetIds.clear();
    this.latestFrames = [];
    this.waitingStartMs = null;
    this.playbackStartAudioTime = null;
    this.playbackStartSongSeconds = 0;
    this.pausedSongSeconds = 0;
    this.feedbackText = '';
    this.feedbackUntilMs = 0;
    this.fallbackTimeoutSeconds = undefined;
    this.playbackMode = 'midi';
    this.backingTrackBuffer = undefined;
    this.backingTrackSource = undefined;
    this.backingTrackGain = undefined;
    this.backingTrackSourceStartedAtAudioTime = undefined;
    this.backingTrackSourceStartSongSeconds = 0;
    this.backingTrackIsPlaying = false;
    this.backingTrackAudioUrl = undefined;
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
    this.playbackSpeedMultiplier = PlayScene.PLAYBACK_SPEED_DEFAULT;

    this.laneLayer = this.add.graphics();
    this.ball = this.add.circle(0, 0, 10, 0xfef08a, 1).setDepth(260);
    this.createBallTrail();
    if (this.textures.exists('handReminder')) {
      this.handReminderImage = this.add.image(0, 0, 'handReminder').setOrigin(1, 1).setDepth(300);
    }

    this.statusText = this.add.text(0, 0, '', {
      color: '#dbeafe',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(14, Math.floor(this.scale.width * 0.016))}px`
    });
    this.feedbackMessageText = this.add
      .text(0, 0, '', {
        color: '#f8fafc',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(30, Math.floor(this.scale.width * 0.047))}px`,
        align: 'center'
      })
      .setOrigin(0.5, 0)
      .setDepth(360)
      .setStroke('#0b1228', 6)
      .setVisible(false);
    this.liveScoreText = this.add.text(0, 0, '', {
      color: '#e2e8f0',
      fontFamily: 'Montserrat, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(13, Math.floor(this.scale.width * 0.015))}px`
    }).setOrigin(1, 0);
    this.debugButton = new RoundedBox(
      this,
      0,
      0,
      Math.max(126, Math.floor(this.scale.width * 0.15)),
      36,
      0x1f3b74,
      0.9
    )
      .setStrokeStyle(2, 0x60a5fa, 0.65)
      .setInteractive({ useHandCursor: true })
      .setDepth(350);
    this.debugButtonLabel = this.add
      .text(0, 0, 'Debug Note', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, Math.floor(this.scale.width * 0.014))}px`
      })
      .setOrigin(0.5)
      .setDepth(351);
    this.debugButton.on('pointerdown', () => {
      void this.playDebugTargetNote();
    });
    this.pauseButton = new RoundedBox(
      this,
      0,
      0,
      PlayScene.PAUSE_BUTTON_SIZE,
      PlayScene.PAUSE_BUTTON_SIZE,
      0x0b1228,
      0.94
    )
      .setStrokeStyle(1, 0x94a3b8, 0.9)
      .setInteractive({ useHandCursor: true })
      .setDepth(289);
    this.pauseButtonLeftBar = this.add
      .rectangle(0, 0, 4, 16, 0xf8fafc, 1)
      .setDepth(290);
    this.pauseButtonRightBar = this.add
      .rectangle(0, 0, 4, 16, 0xf8fafc, 1)
      .setDepth(290);
    this.pauseButtonPlayIcon = this.add
      .triangle(0, 0, -6, -7, -6, 7, 6, 0, 0xf8fafc, 1)
      .setOrigin(0.5, 0.5)
      .setDepth(290)
      .setVisible(false);
    this.pauseButton.on('pointerdown', () => {
      this.toggleGameplayPauseFromButton();
    });
    this.syncPauseButtonIcon();
    this.createPlaybackSpeedSlider();
    if (this.debugOverlayEnabled) {
      this.createDebugOverlay();
      this.updateDebugOverlay();
      this.input.keyboard?.on('keydown-F3', this.toggleDebugOverlay, this);
    }

    this.drawStaticLanes();
    this.redrawTargetsAndBall();
    this.updateSongMinimapProgress();
    this.updateHud();

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

    await this.setupAudioStack(loaded.sourceNotes);
    this.attachBackHandlers();

    this.runtimeTimer = this.time.addEvent({
      delay: 16,
      loop: true,
      callback: () => this.tickRuntime()
    });
    this.schedulePlaybackStart();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  private async setupAudioStack(sourceNotes: SourceNote[]): Promise<void> {
    const audioCtx = new AudioContext();
    this.audioCtx = audioCtx;
    let synth: JzzTinySynth;
    try {
      synth = new JzzTinySynth(audioCtx);
    } catch (error) {
      console.error('JZZ Tiny synth setup failed', error);
      this.feedbackText = 'Playback synth unavailable.';
      this.feedbackUntilMs = Number.POSITIVE_INFINITY;
      return;
    }
    this.debugSynth = synth;
    const playbackNotes = buildPlaybackNotes(sourceNotes, this.ticksPerQuarter);
    this.scrubPlayer = new MidiScrubPlayer(synth, playbackNotes, Math.max(1, Math.floor(this.ticksPerQuarter / 2)));

    try {
      const micSource = await createMicNode(audioCtx);
      this.micStream = micSource.mediaStream;
      const detector = new PitchDetectorService(audioCtx);
      await detector.init();
      detector.onPitch((frame) => {
        if (this.pauseOverlay) return;
        if (this.runtime.state === PlayState.Finished) return;
        this.latestFrames.push(frame);
        if (this.latestFrames.length > 64) this.latestFrames.shift();
      });
      detector.start(micSource);
      this.detector = detector;
    } catch (error) {
      console.error('Microphone setup failed', error);
      if (this.profile.gating_timeout_seconds === undefined) {
        this.fallbackTimeoutSeconds = 2.5;
      }
      this.feedbackText = this.fallbackTimeoutSeconds
        ? 'Microphone unavailable. Auto-miss timeout active.'
        : 'Microphone unavailable.';
      this.feedbackUntilMs = Number.POSITIVE_INFINITY;
    }

    await audioCtx.resume();
    this.playbackMode = 'midi';
    this.pausedBackingAudioSeconds = undefined;
    this.lastKnownBackingAudioSeconds = 0;
    this.backingTrackBuffer = undefined;
    this.backingTrackSource = undefined;
    this.backingTrackGain = undefined;
    this.backingTrackSourceStartedAtAudioTime = undefined;
    this.backingTrackSourceStartSongSeconds = 0;
    this.backingTrackIsPlaying = false;
    this.backingTrackAudioUrl = undefined;
    this.playbackStarted = false;
    this.pausedSongSeconds = 0;
    this.playbackStartSongSeconds = 0;
    this.playbackStartAudioTime = null;
    this.prePlaybackStartAtMs = undefined;
  }

  private schedulePlaybackStart(delayMs: number = PlayScene.PRE_PLAYBACK_DELAY_MS): void {
    if (this.runtime.state === PlayState.Finished || this.playbackStarted) return;
    const clampedDelayMs = Math.max(0, delayMs);
    this.prePlaybackStartAtMs = performance.now() + clampedDelayMs;
    this.playbackIntroTimer?.remove(false);
    this.playbackIntroTimer = this.time.delayedCall(clampedDelayMs, () => {
      this.playbackIntroTimer = undefined;
      if (!this.scene.isActive() || this.runtime.state === PlayState.Finished || this.playbackStarted) return;
      if (this.pauseOverlay || this.playbackPausedByButton) {
        this.schedulePlaybackStart(120);
        return;
      }
      void this.beginSessionPlayback();
    });
  }

  private async beginSessionPlayback(): Promise<void> {
    if (!this.audioCtx || this.playbackStarted) return;
    if (this.audioCtx.state !== 'running') {
      await this.audioCtx.resume();
    }

    const startSongSeconds = this.tempoMap?.tickToSeconds(this.runtime.current_tick) ?? 0;
    this.resetBallTrailHistory();
    this.prePlaybackStartAtMs = undefined;

    const wantsBackingAudio = isBackingTrackAudioUrl(this.sceneData?.audioUrl ?? '');
    if (wantsBackingAudio) {
      const startedBackingAudio = await this.startBackingTrackAudio(this.sceneData?.audioUrl, startSongSeconds);
      if (!startedBackingAudio) {
        this.playbackStarted = false;
        this.startPlaybackClock(startSongSeconds);
        this.pausePlaybackClock();
        this.schedulePlaybackStart(300);
        this.feedbackText = 'Backing track failed to start. Retrying...';
        this.feedbackUntilMs = performance.now() + 1200;
        return;
      }
      this.playbackStarted = true;
    } else {
      this.playbackMode = 'midi';
      this.startPlaybackClock(startSongSeconds);
      this.scrubPlayer?.resume(this.runtime.current_tick, this.audioCtx.currentTime);
      this.playbackStarted = true;
    }

    this.feedbackText = 'Go!';
    this.feedbackUntilMs = performance.now() + 900;
  }

  private tickRuntime(): void {
    if (!this.audioCtx || !this.tempoMap || this.runtime.state === PlayState.Finished || this.pauseOverlay) return;
    if (!this.playbackStarted) {
      this.drawTopStarfield();
      this.updateSongMinimapProgress();
      this.updateHud();
      this.updateDebugOverlay();
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
          DEFAULT_MIN_CONFIDENCE
        )
        : {
          valid: false,
          streakMs: 0,
          validFrameCount: 0,
          sampleCount: this.latestFrames.length,
          latestFrame: this.latestFrames.length > 0 ? this.latestFrames[this.latestFrames.length - 1] : undefined
        };
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
    });

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
    this.updateDebugOverlay();

    if (!this.targets[this.runtime.active_target_index]) {
      this.queueFinishSong();
    } else {
      this.clearFinishSongQueue();
    }
  }

  private handleTransition(transition: RuntimeTransition, target: TargetNote | undefined, previousState: PlayState): void {
    if (transition === 'entered_waiting') {
      this.pausePlaybackClock();
      this.pauseBackingPlayback();
      this.waitingStartMs = performance.now();
      this.latestFrames = [];
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
      this.latestFrames = [];
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
      this.latestFrames = [];
      this.feedbackText = 'Too Late';
      this.feedbackUntilMs = performance.now() + 900;
    }
  }

  private recordScoreEvent(event: ScoreEvent): void {
    this.scoreEvents.push(event);
    this.totalScore += event.points;
    if (event.rating === 'Miss') {
      this.currentComboStreak = 0;
      return;
    }
    this.currentComboStreak += 1;
  }

  private finishSong(): void {
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

  private computeEndScreenStars(summary: ReturnType<typeof summarizeScores>): number {
    return computeOverlayEndScreenStars(this.targets.length, summary);
  }

  private createEndScreenStars(
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

  private attachBackHandlers(): void {
    this.input.keyboard?.on('keydown-ESC', this.onBackRequested, this);

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

  private onBackRequested(): void {
    if (this.runtime.state === PlayState.Finished) return;
    if (this.pauseOverlay) {
      this.closePauseMenu();
      return;
    }
    this.openPauseMenu();
  }

  private openPauseMenu(): void {
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
    this.latestFrames = [];

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

  private closePauseMenu(): void {
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
    this.latestFrames = [];
    this.playbackWasRunningBeforePauseMenu = false;
    this.pauseMenuResumeSongSeconds = undefined;
    this.syncPauseButtonIcon();
  }

  private toggleGameplayPauseFromButton(): void {
    if (this.runtime.state === PlayState.Finished || this.pauseOverlay) return;
    if (this.playbackPausedByButton) {
      this.resumeGameplayFromButtonPause();
      return;
    }
    this.pauseGameplayFromButton();
  }

  private pauseGameplayFromButton(): void {
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
    this.latestFrames = [];
    this.syncPauseButtonIcon();
  }

  private resumeGameplayFromButtonPause(): void {
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
    this.latestFrames = [];
    this.syncPauseButtonIcon();
  }

  private isWaitingPausedByButton(): boolean {
    return this.playbackPausedByButton && this.runtime.state === PlayState.WaitingForHit;
  }

  private relayoutPauseOverlay(): void {
    if (!this.pauseOverlay) return;
    this.pauseOverlay.destroy(true);
    this.pauseOverlay = undefined;
    this.openPauseMenu();
  }

  private resetSession(): void {
    const data = this.sceneData;
    if (!data) return;
    this.scene.restart(data);
  }

  private goBackToStart(): void {
    this.scene.start('SongSelectScene');
  }

  private resolveSongScoreKey(): string {
    const explicitSongId = this.sceneData?.songId?.trim();
    if (explicitSongId) return explicitSongId;
    return this.sceneData?.midiUrl?.trim() ?? '';
  }

  private persistNativeSongHighScore(songScoreKey: string, bestScore: number): void {
    if (!Capacitor.isNativePlatform()) return;

    void import('../platform/nativeSongLibrary')
      .then(({ updateNativeSongHighScore }) => updateNativeSongHighScore(songScoreKey, bestScore))
      .catch((error) => {
        console.warn('Failed to persist native high score', { songScoreKey, bestScore, error });
      });
  }

  private createDebugOverlay(): void {
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

  private relayoutDebugOverlay(): void {
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

  private toggleDebugOverlay(): void {
    if (!this.debugOverlayContainer) return;
    const nextVisible = !this.debugOverlayContainer.visible;
    this.debugOverlayContainer.setVisible(nextVisible);
    this.feedbackText = `Debug overlay ${nextVisible ? 'ON' : 'OFF'} (F3)`;
    this.feedbackUntilMs = performance.now() + 900;
    this.updateHud();
  }

  private updateDebugOverlay(): void {
    if (!this.debugOverlayEnabled || !this.debugOverlayText || !this.debugOverlayContainer || !this.debugOverlayContainer.visible) {
      return;
    }

    const snapshot = this.hitDebugSnapshot;
    const active = snapshot?.activeTarget ?? this.targets[this.runtime.active_target_index];
    const latestFrame = snapshot?.latestFrame ?? (this.latestFrames.length > 0 ? this.latestFrames[this.latestFrames.length - 1] : undefined);
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

  private drawStaticLanes(): void {
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

    this.statusText.setPosition(layout.left, 16);
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

  private layoutSongMinimap(): void {
    this.minimapRenderer.layoutMinimap(
      this.targets,
      this.ticksPerQuarter,
      this.pauseButton,
      this.handReminderImage,
      PlayScene.PAUSE_BUTTON_SIZE,
      PlayScene.PAUSE_BUTTON_GAP
    );
  }

  private layoutPauseButton(): void {
    if (!this.pauseButton || !this.pauseButtonLeftBar || !this.pauseButtonRightBar || !this.pauseButtonPlayIcon) return;

    const sideMargin = 14;
    const centerX = sideMargin + PlayScene.PAUSE_BUTTON_SIZE / 2;
    const centerY = this.scale.height - sideMargin - PlayScene.PAUSE_BUTTON_SIZE / 2;
    const barOffsetX = Math.max(4, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.15));
    const barHeight = Math.max(14, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.48));
    const barWidth = Math.max(4, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.14));
    const playIconOffsetX = Math.max(4, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.3));
    const playIconOffsetY = Math.max(4, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.3));

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
      .setScale(Math.max(1, PlayScene.PAUSE_BUTTON_SIZE / 24))
      .setDepth(290);
  }

  private createPlaybackSpeedSlider(): void {
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

  private layoutPlaybackSpeedSlider(): void {
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
    const centerY = 24;
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

  private applyPlaybackSpeedFromSliderX(pointerX: number, previewOnly = false): void {
    if (this.isWaitingPausedByButton()) return;
    if (!this.playbackSpeedTrack) return;
    const left = this.playbackSpeedTrack.x - this.playbackSpeedTrack.displayWidth / 2;
    const ratio = Phaser.Math.Clamp((pointerX - left) / this.playbackSpeedTrack.displayWidth, 0, 1);
    const speed =
      PlayScene.PLAYBACK_SPEED_MIN + ratio * (PlayScene.PLAYBACK_SPEED_MAX - PlayScene.PLAYBACK_SPEED_MIN);
    if (previewOnly) {
      this.setPendingPlaybackSpeed(speed);
      return;
    }
    this.setPlaybackSpeed(speed);
  }

  private beginPlaybackSpeedAdjustment(pointerId: number): void {
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

  private handlePlaybackSpeedPointerUp(pointer: Phaser.Input.Pointer): void {
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

  private setPendingPlaybackSpeed(speedMultiplier: number): void {
    this.pendingPlaybackSpeedMultiplier = Phaser.Math.Clamp(
      speedMultiplier,
      PlayScene.PLAYBACK_SPEED_MIN,
      PlayScene.PLAYBACK_SPEED_MAX
    );
    this.updatePlaybackSpeedSliderVisuals();
  }

  private setPlaybackSpeed(speedMultiplier: number): void {
    const safeSpeed = Phaser.Math.Clamp(
      speedMultiplier,
      PlayScene.PLAYBACK_SPEED_MIN,
      PlayScene.PLAYBACK_SPEED_MAX
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

  private updatePlaybackSpeedSliderVisuals(): void {
    if (!this.playbackSpeedTrack || !this.playbackSpeedKnob || !this.playbackSpeedValueText) return;

    const visualSpeed = this.pendingPlaybackSpeedMultiplier ?? this.playbackSpeedMultiplier;
    const ratio =
      (visualSpeed - PlayScene.PLAYBACK_SPEED_MIN) /
      (PlayScene.PLAYBACK_SPEED_MAX - PlayScene.PLAYBACK_SPEED_MIN);
    const clampedRatio = Phaser.Math.Clamp(ratio, 0, 1);
    const left = this.playbackSpeedTrack.x - this.playbackSpeedTrack.displayWidth / 2;
    this.playbackSpeedKnob.setPosition(left + this.playbackSpeedTrack.displayWidth * clampedRatio, this.playbackSpeedTrack.y);
    this.playbackSpeedValueText.setText(`${Math.round(visualSpeed * 100)}%`);
  }

  private setPauseButtonIconMode(showPlay: boolean): void {
    this.pauseButtonLeftBar?.setVisible(!showPlay);
    this.pauseButtonRightBar?.setVisible(!showPlay);
    this.pauseButtonPlayIcon?.setVisible(showPlay);
  }

  private syncPauseButtonIcon(): void {
    this.setPauseButtonIconMode(this.pauseOverlay !== undefined || this.playbackPausedByButton);
  }

  private redrawSongMinimapStatic(): void {
    this.minimapRenderer.redrawStatic(this.targets, this.ticksPerQuarter);
  }

  private updateSongMinimapProgress(): void {
    this.minimapRenderer.updateProgress(this.runtime.current_tick, this.targets, this.correctlyHitTargetIds);
  }

  private drawTopStarfield(): void {
    const layout = this.layout();
    this.fretboardRenderer.drawTopStarfield(layout, this.runtime.current_tick);
  }

  private layoutHandReminder(): void {
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

  private async playDebugTargetNote(): Promise<void> {
    if (this.isWaitingPausedByButton()) {
      this.feedbackText = 'Resume with Play before debug input';
      this.feedbackUntilMs = performance.now() + 900;
      this.updateHud();
      this.updateDebugOverlay();
      return;
    }
    const target = this.targets[this.runtime.active_target_index];
    if (!target) {
      this.feedbackText = 'No target to play';
      this.feedbackUntilMs = performance.now() + 700;
      return;
    }
    if (!this.audioCtx || !this.debugSynth) return;

    if (this.audioCtx.state !== 'running') {
      await this.audioCtx.resume();
    }

    const when = this.audioCtx.currentTime + 0.01;
    const tickSeed = Math.floor(performance.now() * 1000);
    const note: SourceNote = {
      tick_on: tickSeed,
      tick_off: tickSeed + 1,
      midi_note: target.expected_midi,
      velocity: 1,
      channel: 15,
      track: 99
    };

    this.debugSynth.noteOn(note, when);
    this.debugSynth.noteOff(note, when + 0.35);
    this.feedbackText = `Debug note: ${target.expected_midi}`;
    this.feedbackUntilMs = performance.now() + 600;

    if (
      this.audioCtx &&
      (this.runtime.state === PlayState.WaitingForHit ||
        (this.runtime.state === PlayState.Playing && this.isInsideLiveHitWindow(target)))
    ) {
      this.consumeDebugHit();
    } else {
      this.feedbackText = `Debug note: ${target.expected_midi} (outside hit window)`;
      this.feedbackUntilMs = performance.now() + 900;
      this.updateHud();
      this.updateDebugOverlay();
    }
  }

  private consumeDebugHit(): void {
    if (this.isWaitingPausedByButton()) {
      this.feedbackText = 'Resume with Play before debug input';
      this.feedbackUntilMs = performance.now() + 900;
      this.updateHud();
      this.updateDebugOverlay();
      return;
    }
    if (!this.audioCtx || !this.tempoMap) return;
    if (!this.playbackStarted) {
      this.feedbackText = 'Playback not started yet';
      this.feedbackUntilMs = performance.now() + 700;
      this.updateHud();
      this.updateDebugOverlay();
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
    });
    this.runtime = update.state;
    this.handleTransition(update.transition, update.target, previousState);
    if (update.transition !== 'none') {
      this.lastRuntimeTransition = update.transition;
      this.lastRuntimeTransitionAtMs = performance.now();
    }
    this.redrawTargetsAndBall();
    this.updateSongMinimapProgress();
    this.updateHud();
    this.updateDebugOverlay();
    if (!this.targets[this.runtime.active_target_index]) {
      this.queueFinishSong();
    } else {
      this.clearFinishSongQueue();
    }
  }

  private queueFinishSong(): void {
    if (this.resultsOverlay?.active) return;
    const now = performance.now();
    if (this.finishQueuedAtMs === undefined) {
      this.finishQueuedAtMs = now + PlayScene.POST_SONG_END_SCREEN_DELAY_MS;
      if (!this.finishDelayTimer) {
        this.finishDelayTimer = this.time.delayedCall(PlayScene.POST_SONG_END_SCREEN_DELAY_MS, () => {
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

  private clearFinishSongQueue(): void {
    this.finishDelayTimer?.remove(false);
    this.finishDelayTimer = undefined;
    this.finishQueuedAtMs = undefined;
  }

  private redrawTargetsAndBall(): void {
    const layout = this.layout();
    this.noteRenderer.redrawTargetsAndBall({
      ball: this.ball,
      runtimeState: this.runtime.state,
      currentTick: this.runtime.current_tick,
      waitingTargetId: this.runtime.state === PlayState.WaitingForHit ? this.runtime.waiting_target_id : undefined,
      targets: this.targets,
      correctlyHitTargetIds: this.correctlyHitTargetIds,
      layout,
      resolveBallPosition: (nextLayout) => this.resolveBallPosition(nextLayout),
      updateBallTrail: (x, y, laneSpacing) => this.updateBallTrail(x, y, laneSpacing),
      setBallAndTrailVisible: (visible) => this.setBallAndTrailVisible(visible)
    });
  }

  private resolveBallPosition(layout: Layout): { x: number; y: number } {
    if (this.targets.length === 0) {
      return {
        x: layout.hitLineX,
        y: layout.top - Math.max(18, this.scale.height * 0.04)
      };
    }

    const waitingTarget = this.runtime.state === PlayState.WaitingForHit ? this.targets[this.runtime.active_target_index] : undefined;
    if (waitingTarget) {
      return { x: layout.hitLineX, y: this.getStringCenterY(layout, waitingTarget.string) };
    }

    const firstTarget = this.targets[0];
    if (this.targetOnsetSeconds.length !== this.targets.length) {
      return { x: layout.hitLineX, y: this.getStringCenterY(layout, firstTarget.string) };
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
      return { x: layout.hitLineX, y: this.getStringCenterY(layout, lastTarget.string) };
    }

    if (nextTargetIndex === 0) {
      return { x: layout.hitLineX, y: this.getStringCenterY(layout, this.targets[0].string) };
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

    return {
      x: layout.hitLineX + Math.sin(progress * Math.PI) * lateralExcursion,
      y: linearY - arcOffset
    };
  }

  private resolvePrePlaybackBallPosition(
    layout: Layout,
    firstTarget: TargetNote,
    firstTargetSeconds: number
  ): { x: number; y: number } {
    if (this.prePlaybackStartAtMs === undefined) {
      return this.resolveIntroBallPosition(layout, firstTarget, 0, firstTargetSeconds);
    }

    const elapsedRatio = Phaser.Math.Clamp(
      1 - Math.max(0, this.prePlaybackStartAtMs - performance.now()) / PlayScene.PRE_PLAYBACK_DELAY_MS,
      0,
      1
    );
    return this.resolveIntroBallPosition(layout, firstTarget, elapsedRatio * 0.9, firstTargetSeconds);
  }

  private resolveIntroBallPosition(
    layout: Layout,
    firstTarget: TargetNote,
    progress: number,
    firstTargetSeconds: number
  ): { x: number; y: number } {
    const clampedProgress = Phaser.Math.Clamp(progress, 0, 1);
    const thirdStringY = this.getStringCenterY(layout, 3);
    const targetY = this.getStringCenterY(layout, firstTarget.string);
    const startY = thirdStringY - BALL_BOUNCE_AMPLITUDE_MAX_PX;
    const introDuration = Math.max(0.2, firstTargetSeconds);
    const introLateralExcursion = this.resolveBallLateralExcursion(layout, thirdStringY, targetY, introDuration);

    return {
      x: layout.hitLineX + Phaser.Math.Linear(introLateralExcursion, 0, clampedProgress),
      y: startY + (targetY - startY) * clampedProgress * clampedProgress
    };
  }

  private findTargetIndexAtOrAfterSongSeconds(songSeconds: number): number {
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

  private getStringCenterY(layout: Layout, stringNumber: number): number {
    const laneIndex = Phaser.Math.Clamp(Math.round(stringNumber) - 1, 0, 5);
    return layout.top + laneIndex * layout.laneSpacing;
  }

  private resolveBallArcHeight(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
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

  private resolveBallLateralExcursion(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
    const laneDistance = Math.abs(endY - startY) / Math.max(layout.laneSpacing, 1);
    const laneFactor = Phaser.Math.Clamp(0.7 + laneDistance * 0.16, 0.7, 1.45);
    const timeFactor = Phaser.Math.Clamp(intervalSeconds / 0.55, 0.42, 1.05);
    const baseExcursion = Math.max(layout.laneSpacing * 0.62, 16);
    const halfScreenBoundary = this.scale.width * 0.5;
    const maxExcursion = Math.max(0, halfScreenBoundary - layout.hitLineX - 6);
    const minExcursion = Math.min(28, maxExcursion);
    return Phaser.Math.Clamp(baseExcursion * laneFactor * timeFactor, minExcursion, maxExcursion);
  }

  private updateHud(): void {
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

  private resolveTopFeedbackMessage(now: number): string {
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

  private layout(): Layout {
    if (this.cachedLayout) {
      return this.cachedLayout;
    }
    const { width, height } = this.scale;
    const left = width * 0.08;
    const right = width * 0.96;
    const baseTop = height * 0.2;
    const baseBottom = height * 0.84;
    const tabHeight = (baseBottom - baseTop) * 0.9;
    const top = baseTop - height * 0.018;
    const bottom = top + tabHeight;
    const laneSpacing = (bottom - top) / 5;

    const nextLayout: Layout = {
      left,
      right,
      top,
      bottom,
      laneSpacing,
      hitLineX: left + (right - left) * 0.19,
      pxPerTick: Math.max(0.09, width / 5200),
      noteHeight: Math.max(14, laneSpacing * 0.38)
    };
    this.cachedLayout = nextLayout;
    return nextLayout;
  }

  private createBallTrail(): void {
    this.destroyBallTrail();
  }

  private destroyBallTrail(): void {
    for (const segment of this.ballTrailSegments) {
      segment.shadow.destroy();
      segment.main.destroy();
    }
    this.ballTrailSegments = [];
    this.ballTrailHistory.clear();
    this.hasLastBallTrailPoint = false;
    this.lastBallTrailX = 0;
    this.lastBallTrailY = 0;
  }

  private pushBallTrailPoint(x: number, y: number): void {
    this.ballTrailHistory.push(x, y);
  }

  private updateBallTrail(x: number, y: number, laneSpacing: number): void {
    if (!this.hasLastBallTrailPoint) {
      this.pushBallTrailPoint(x, y);
      this.hasLastBallTrailPoint = true;
      this.lastBallTrailX = x;
      this.lastBallTrailY = y;
    } else {
      const distance = Phaser.Math.Distance.Between(this.lastBallTrailX, this.lastBallTrailY, x, y);
      if (distance > laneSpacing * 4) {
        this.ballTrailHistory.clear();
        this.pushBallTrailPoint(x, y);
        this.lastBallTrailX = x;
        this.lastBallTrailY = y;
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

    this.drawBallDashedTrail(laneSpacing);
  }

  private resetBallTrailHistory(): void {
    this.ballTrailHistory.clear();
    this.hasLastBallTrailPoint = false;
    this.lastBallTrailX = 0;
    this.lastBallTrailY = 0;
    this.hideUnusedTrailSegments(0);
  }

  private drawBallDashedTrail(laneSpacing: number): void {
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

  private getOrCreateTrailSegment(index: number): { shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line } {
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

  private hideUnusedTrailSegments(startIndex: number): void {
    for (let i = startIndex; i < this.ballTrailSegments.length; i += 1) {
      this.ballTrailSegments[i].shadow.setVisible(false);
      this.ballTrailSegments[i].main.setVisible(false);
    }
  }

  private computeTrailPathLength(startIndex: number, endExclusiveIndex: number): number {
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

  private buildProfileWithSettings(
    base: DifficultyProfile,
    allowedStrings: number[] | undefined,
    allowedFingers: number[] | undefined,
    allowedFrets: number[] | undefined
  ): DifficultyProfile {
    const strings = sanitizeSelection(allowedStrings, 1, 6, base.allowed_strings);
    const fingers = sanitizeSelection(allowedFingers, 1, 4, base.allowed_fingers);
    const frets = sanitizeSelection(allowedFrets, 0, 21, undefined);
    const fallbackFrets: number[] = [];
    for (let fret = base.allowed_frets.min; fret <= base.allowed_frets.max; fret += 1) {
      fallbackFrets.push(fret);
    }
    const resolvedFrets = frets.length > 0 ? frets : fallbackFrets;

    return {
      ...base,
      allowed_strings: strings,
      allowed_fingers: fingers,
      allowed_fret_list: resolvedFrets,
      allowed_frets: { min: resolvedFrets[0], max: resolvedFrets[resolvedFrets.length - 1] }
    };
  }

  private cleanup(): void {
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

  private async startBackingTrackAudio(audioUrl: string | undefined, startSongSeconds: number): Promise<boolean> {
    if (!audioUrl || !isBackingTrackAudioUrl(audioUrl)) {
      return false;
    }
    if (!this.audioCtx) return false;

    this.playbackMode = 'audio';
    this.lastKnownBackingAudioSeconds = 0;
    this.pausedBackingAudioSeconds = undefined;

    try {
      if (!this.backingTrackBuffer || this.backingTrackAudioUrl !== audioUrl) {
        this.backingTrackBuffer = await this.loadBackingTrackBuffer(audioUrl);
        this.backingTrackAudioUrl = audioUrl;
      }
      this.ensureBackingTrackGainNode();
      return await this.playBackingTrackAudioFrom(startSongSeconds);
    } catch (error) {
      this.lastAudioSeekDebug = {
        requestedSongSeconds: startSongSeconds,
        targetSeconds: startSongSeconds,
        beforeSeekSeconds: 0,
        afterPlaySeconds: undefined,
        fallbackToMidi: false,
        seekDisabled: false,
        ok: false,
        atMs: performance.now()
      };
      console.warn('Backing track load failed', { audioUrl, error });
      return false;
    }
  }

  private pauseBackingPlayback(): void {
    if (!this.playbackStarted) return;
    if (this.playbackMode === 'audio') {
      const pausedAudioSeconds = resolveSongSecondsForRuntime(
        this.getSongSecondsFromClock(),
        this.pausedSongSeconds,
        this.getBackingTrackSongSeconds()
      );
      this.lastKnownBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, pausedAudioSeconds);
      this.pausedBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, pausedAudioSeconds, this.pausedSongSeconds);
      this.pausedSongSeconds = this.pausedBackingAudioSeconds;
      this.stopBackingTrackSource();
      return;
    }
    this.scrubPlayer?.pause(this.runtime.current_tick);
  }

  private resumeBackingPlayback(): void {
    if (!this.playbackStarted) return;
    const runtimeResumeSeconds = resolveResumeSongSeconds(this.runtime.current_tick, this.pausedSongSeconds, this.tempoMap);
    let resumeSeconds = runtimeResumeSeconds;
    if (this.playbackMode === 'audio') {
      resumeSeconds = resolveResumeSongSecondsForAudio(resumeSeconds, this.pausedBackingAudioSeconds);
      resumeSeconds = Math.max(resumeSeconds, this.lastKnownBackingAudioSeconds);
    }
    this.pausedSongSeconds = resumeSeconds;
    this.startPlaybackClock(resumeSeconds);

    if (this.playbackMode === 'audio') {
      void this.resumeBackingTrackAudio(resumeSeconds);
      return;
    }
    this.scrubPlayer?.resume(this.runtime.current_tick, this.audioCtx?.currentTime ?? 0);
  }

  private stopBackingPlayback(): void {
    this.stopBackingTrackSource();
    this.releaseBackingTrackAudio();
    this.scrubPlayer?.stop();
  }

  private async resumeBackingTrackAudio(songSeconds: number): Promise<void> {
    const resumed = await this.playBackingTrackAudioFrom(songSeconds);
    if (resumed) return;

    this.feedbackText = 'Backing track unavailable.';
    this.feedbackUntilMs = performance.now() + 1200;
  }

  private async playBackingTrackAudioFrom(songSeconds: number): Promise<boolean> {
    if (!this.audioCtx || !this.backingTrackBuffer) return false;
    const safeSeconds = Math.max(0, songSeconds);
    const targetSeconds = this.clampAudioSeekSeconds(safeSeconds);
    const beforeSeekSeconds = sanitizeSongSeconds(
      this.getBackingTrackSongSeconds() ?? this.pausedSongSeconds,
      this.pausedSongSeconds
    );
    this.stopBackingTrackSource();
    this.ensureBackingTrackGainNode();

    try {
      const source = this.audioCtx.createBufferSource();
      source.buffer = this.backingTrackBuffer;
      source.playbackRate.value = this.playbackSpeedMultiplier;
      source.connect(this.backingTrackGain!);
      const startAtAudioTime = this.audioCtx.currentTime + 0.005;
      source.onended = () => {
        if (this.backingTrackSource !== source) return;
        this.backingTrackSource = undefined;
        this.backingTrackSourceStartedAtAudioTime = undefined;
        this.backingTrackSourceStartSongSeconds = this.backingTrackBuffer?.duration ?? targetSeconds;
        this.backingTrackIsPlaying = false;
      };
      source.start(startAtAudioTime, targetSeconds);
      this.backingTrackSource = source;
      this.backingTrackSourceStartedAtAudioTime = startAtAudioTime;
      this.backingTrackSourceStartSongSeconds = targetSeconds;
      this.backingTrackIsPlaying = true;

      this.lastAudioSeekDebug = {
        requestedSongSeconds: safeSeconds,
        targetSeconds,
        beforeSeekSeconds,
        afterPlaySeconds: targetSeconds,
        afterRetrySeconds: undefined,
        fallbackToMidi: false,
        seekDisabled: false,
        ok: true,
        atMs: performance.now()
      };
      this.lastKnownBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, targetSeconds);
      this.syncRuntimeToBackingTrackPosition(targetSeconds);
      this.pausedBackingAudioSeconds = undefined;
      return true;
    } catch (error) {
      this.lastAudioSeekDebug = {
        requestedSongSeconds: safeSeconds,
        targetSeconds,
        beforeSeekSeconds,
        afterPlaySeconds: undefined,
        fallbackToMidi: false,
        seekDisabled: false,
        ok: false,
        atMs: performance.now()
      };
      console.warn('Backing track play failed', { audioUrl: this.sceneData?.audioUrl, error });
      return false;
    }
  }

  private releaseBackingTrackAudio(): void {
    this.stopBackingTrackSource();
    this.backingTrackBuffer = undefined;
    this.backingTrackAudioUrl = undefined;
    if (this.backingTrackGain) {
      try {
        this.backingTrackGain.disconnect();
      } catch {
        // Ignore best-effort disconnect errors.
      }
    }
    this.backingTrackGain = undefined;
    this.backingTrackSourceStartedAtAudioTime = undefined;
    this.backingTrackSourceStartSongSeconds = 0;
    this.backingTrackIsPlaying = false;
    this.pausedBackingAudioSeconds = undefined;
    this.lastKnownBackingAudioSeconds = 0;
  }

  private syncRuntimeToBackingTrackPosition(songSeconds: number): void {
    const safeSeconds = sanitizeSongSeconds(songSeconds, this.pausedSongSeconds);
    this.startPlaybackClock(safeSeconds);
    if (this.tempoMap) {
      this.runtime.current_tick = Math.max(0, this.tempoMap.secondsToTick(safeSeconds));
    }
  }

  private stopBackingTrackSource(): void {
    if (!this.backingTrackSource) return;
    this.backingTrackSource.onended = null;
    try {
      this.backingTrackSource.stop();
    } catch {
      // Ignore stop errors for already-ended sources.
    }
    try {
      this.backingTrackSource.disconnect();
    } catch {
      // Ignore best-effort disconnect errors.
    }
    this.backingTrackSource = undefined;
    this.backingTrackSourceStartedAtAudioTime = undefined;
    this.backingTrackIsPlaying = false;
  }

  private ensureBackingTrackGainNode(): void {
    if (!this.audioCtx) return;
    if (this.backingTrackGain) return;
    const gain = this.audioCtx.createGain();
    gain.gain.value = 1;
    gain.connect(this.audioCtx.destination);
    this.backingTrackGain = gain;
  }

  private getBackingTrackSongSeconds(): number | undefined {
    const buffer = this.backingTrackBuffer;
    if (!buffer) return undefined;
    if (!this.backingTrackIsPlaying || !this.audioCtx || this.backingTrackSourceStartedAtAudioTime === undefined) {
      return Phaser.Math.Clamp(this.backingTrackSourceStartSongSeconds, 0, Math.max(0, buffer.duration));
    }
    const elapsed = Math.max(0, this.audioCtx.currentTime - this.backingTrackSourceStartedAtAudioTime);
    const position = this.backingTrackSourceStartSongSeconds + elapsed * this.playbackSpeedMultiplier;
    return Phaser.Math.Clamp(position, 0, Math.max(0, buffer.duration));
  }

  private async loadBackingTrackBuffer(audioUrl: string): Promise<AudioBuffer> {
    if (!this.audioCtx) {
      throw new Error('Audio context unavailable while loading backing track.');
    }
    const response = await fetch(audioUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch backing track (${response.status} ${response.statusText})`);
    }
    const encoded = await response.arrayBuffer();
    if (encoded.byteLength === 0) {
      throw new Error('Backing track file is empty.');
    }
    return await this.audioCtx.decodeAudioData(encoded.slice(0));
  }

  private clampAudioSeekSeconds(songSeconds: number): number {
    if (!this.backingTrackBuffer || !Number.isFinite(this.backingTrackBuffer.duration) || this.backingTrackBuffer.duration <= 0) {
      return songSeconds;
    }
    return Phaser.Math.Clamp(songSeconds, 0, Math.max(0, this.backingTrackBuffer.duration - 0.02));
  }

  private createPlaybackClockState(): PlaybackClockState {
    return {
      playbackStartSongSeconds: this.playbackStartSongSeconds,
      pausedSongSeconds: this.pausedSongSeconds,
      playbackStartAudioTime: this.playbackStartAudioTime
    };
  }

  private applyPlaybackClockState(state: PlaybackClockState): void {
    this.playbackStartSongSeconds = state.playbackStartSongSeconds;
    this.pausedSongSeconds = state.pausedSongSeconds;
    this.playbackStartAudioTime = state.playbackStartAudioTime;
  }

  private startPlaybackClock(songSeconds: number): void {
    const clockState = this.createPlaybackClockState();
    startPlaybackClockState(clockState, this.audioCtx, songSeconds);
    this.applyPlaybackClockState(clockState);
  }

  private pausePlaybackClock(): void {
    const clockState = this.createPlaybackClockState();
    const pausedCurrentTick = pausePlaybackClockState(
      clockState,
      this.audioCtx,
      this.runtime.current_tick,
      this.tempoMap,
      this.playbackSpeedMultiplier
    );
    this.applyPlaybackClockState(clockState);
    this.runtime.current_tick = pausedCurrentTick;
  }

  private getSongSecondsNow(): number {
    const expectedClockSongSeconds = this.getSongSecondsFromClock();
    if (this.playbackMode === 'audio' && this.backingTrackBuffer) {
      const resolved = resolveSongSecondsForRuntime(
        expectedClockSongSeconds,
        this.pausedSongSeconds,
        this.getBackingTrackSongSeconds()
      );
      this.lastKnownBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, resolved);
      return resolved;
    }
    return expectedClockSongSeconds;
  }

  private getSongSecondsFromClock(): number {
    return getSongSecondsFromClockValue(
      this.createPlaybackClockState(),
      this.audioCtx,
      this.playbackSpeedMultiplier
    );
  }

  private getCurrentPlaybackBpm(songSeconds: number | undefined): number | undefined {
    if (!this.tempoMap || songSeconds === undefined || !Number.isFinite(songSeconds)) return undefined;
    const segments = this.tempoMap.segments;
    if (segments.length === 0) return undefined;

    const safeSeconds = Math.max(0, songSeconds);
    let selected = segments[0];
    for (const segment of segments) {
      if (segment.startSeconds <= safeSeconds) {
        selected = segment;
        continue;
      }
      break;
    }

    if (!Number.isFinite(selected.usPerQuarter) || selected.usPerQuarter <= 0) return undefined;
    return 60_000_000 / selected.usPerQuarter;
  }

  private setBallAndTrailVisible(visible: boolean): void {
    this.ball?.setVisible(visible);
    if (!visible) {
      this.ballTrailHistory.clear();
      this.hasLastBallTrailPoint = false;
      this.lastBallTrailX = 0;
      this.lastBallTrailY = 0;
      this.hideUnusedTrailSegments(0);
    } else {
      for (const segment of this.ballTrailSegments) {
        if (!segment.shadow.visible && !segment.main.visible) continue;
        segment.shadow.setVisible(true);
        segment.main.setVisible(true);
      }
    }
  }

  private measureHitDeltaMs(target: TargetNote, previousState: PlayState): number {
    if (previousState === PlayState.Playing && this.tempoMap) {
      const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
      return Math.abs(this.getSongSecondsNow() - targetSeconds) * 1000;
    }
    return this.waitingStartMs === null ? 0 : performance.now() - this.waitingStartMs;
  }

  private measureHitSignedDeltaMs(target: TargetNote, previousState: PlayState): number | undefined {
    if (previousState !== PlayState.Playing || !this.tempoMap) return undefined;
    const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
    return (this.getSongSecondsNow() - targetSeconds) * 1000;
  }

  private isInsideLiveHitWindow(target: TargetNote): boolean {
    if (!this.tempoMap) return false;
    const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
    const now = this.getSongSecondsNow();
    return now >= targetSeconds - TARGET_HIT_GRACE_SECONDS && now <= targetSeconds + TARGET_HIT_GRACE_SECONDS;
  }
}
