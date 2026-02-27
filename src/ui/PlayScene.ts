import Phaser from 'phaser';
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
  FINGER_COLORS,
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
import { isNativeSongLibraryAvailable, updateNativeSongHighScore } from '../platform/nativeSongLibrary';
import type { DifficultyProfile, PitchFrame, ScoreEvent, SourceNote, TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { formatSummary } from './hud';
import { RoundedBox } from './RoundedBox';

type SceneData = {
  songId?: string;
  midiUrl: string;
  audioUrl: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  allowedStrings?: number[];
  allowedFingers?: number[];
  allowedFrets?: number[];
};

type Layout = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  laneSpacing: number;
  hitLineX: number;
  pxPerTick: number;
  noteHeight: number;
};

type PlaybackMode = 'midi' | 'audio';

type HitDebugSnapshot = {
  songSecondsNow?: number;
  targetSeconds?: number;
  targetDeltaMs?: number;
  isWithinGraceWindow: boolean;
  canValidateHit: boolean;
  validHit: boolean;
  activeTarget?: TargetNote;
  latestFrame?: PitchFrame;
  holdMs: number;
  holdRequiredMs: number;
  minConfidence: number;
  validFrameCount: number;
  sampleCount: number;
};

type HeldHitAnalysis = {
  valid: boolean;
  streakMs: number;
  validFrameCount: number;
  sampleCount: number;
  latestFrame?: PitchFrame;
};

type TopStar = {
  baseX: number;
  y: number;
  radius: number;
  baseAlpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
};

type SongMinimapLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  innerLeft: number;
  innerTop: number;
  innerWidth: number;
  innerHeight: number;
  rowHeight: number;
  totalTicks: number;
};

export class PlayScene extends Phaser.Scene {
  private static readonly PAUSE_BUTTON_SIZE = 34;
  private static readonly PAUSE_BUTTON_GAP = 10;
  private static readonly POST_SONG_END_SCREEN_DELAY_MS = 2000;

  private sceneData?: SceneData;
  private targets: TargetNote[] = [];
  private runtime = createInitialRuntimeState();
  private scoreEvents: ScoreEvent[] = [];
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
  private backingTrackAudio?: HTMLAudioElement;

  private laneLayer?: Phaser.GameObjects.Graphics;
  private starfieldLayer?: Phaser.GameObjects.Graphics;
  private targetLayer?: Phaser.GameObjects.Graphics;
  private ball?: Phaser.GameObjects.Arc;
  private ballTrail: Phaser.GameObjects.Arc[] = [];
  private ballTrailHistory: Array<{ x: number; y: number }> = [];
  private lastBallTrailPoint?: { x: number; y: number };
  private topStars: TopStar[] = [];
  private topStarBand?: { width: number; yMin: number; yMax: number };
  private handReminderImage?: Phaser.GameObjects.Image;
  private fretLabels: Phaser.GameObjects.Text[] = [];
  private statusText?: Phaser.GameObjects.Text;
  private liveScoreText?: Phaser.GameObjects.Text;
  private debugButton?: RoundedBox;
  private debugButtonLabel?: Phaser.GameObjects.Text;
  private resultsOverlay?: Phaser.GameObjects.Container;
  private pauseOverlay?: Phaser.GameObjects.Container;
  private pauseButton?: RoundedBox;
  private pauseButtonLeftBar?: Phaser.GameObjects.Rectangle;
  private pauseButtonRightBar?: Phaser.GameObjects.Rectangle;
  private pauseButtonPlayIcon?: Phaser.GameObjects.Triangle;
  private runtimeTimer?: Phaser.Time.TimerEvent;
  private finishDelayTimer?: Phaser.Time.TimerEvent;

  private audioCtx?: AudioContext;
  private debugSynth?: JzzTinySynth;
  private scrubPlayer?: MidiScrubPlayer;
  private detector?: PitchDetectorService;
  private onResize?: () => void;
  private pauseMenuBackListener?: (event: Event) => void;
  private pauseMenuPopStateListener?: (event: PopStateEvent) => void;
  private playbackWasRunningBeforePauseMenu = false;
  private songMinimapBackground?: RoundedBox;
  private songMinimapStaticLayer?: Phaser.GameObjects.Graphics;
  private songMinimapDynamicLayer?: Phaser.GameObjects.Graphics;
  private songMinimapLayout?: SongMinimapLayout;
  private debugOverlayEnabled = false;
  private debugOverlayContainer?: Phaser.GameObjects.Container;
  private debugOverlayPanel?: RoundedBox;
  private debugOverlayText?: Phaser.GameObjects.Text;
  private hitDebugSnapshot?: HitDebugSnapshot;
  private lastRuntimeTransition: RuntimeTransition = 'none';
  private lastRuntimeTransitionAtMs = 0;

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
    this.targets = generateTargetNotes(loaded.sourceNotes, this.profile, loaded.tempoMap);

    this.runtime = createInitialRuntimeState();
    this.scoreEvents = [];
    this.latestFrames = [];
    this.waitingStartMs = null;
    this.playbackStartAudioTime = null;
    this.playbackStartSongSeconds = 0;
    this.pausedSongSeconds = 0;
    this.feedbackText = '';
    this.feedbackUntilMs = 0;
    this.fallbackTimeoutSeconds = undefined;
    this.playbackMode = 'midi';
    this.hitDebugSnapshot = undefined;
    this.lastRuntimeTransition = 'none';
    this.lastRuntimeTransitionAtMs = 0;
    this.debugOverlayEnabled = isGameplayDebugOverlayEnabled();

    this.laneLayer = this.add.graphics();
    this.starfieldLayer = this.add.graphics();
    this.targetLayer = this.add.graphics();
    this.ball = this.add.circle(0, 0, 10, 0xfef08a, 1).setDepth(260);
    this.createBallTrail();
    if (this.textures.exists('handReminder')) {
      this.handReminderImage = this.add.image(0, 0, 'handReminder').setOrigin(1, 1).setDepth(300);
    }

    this.statusText = this.add.text(0, 0, '', {
      color: '#dbeafe',
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(14, Math.floor(this.scale.width * 0.016))}px`
    });
    this.liveScoreText = this.add.text(0, 0, '', {
      color: '#e2e8f0',
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
      .triangle(0, 0, -4, -7, -4, 7, 8, 0, 0xf8fafc, 1)
      .setDepth(290)
      .setVisible(false);
    this.pauseButton.on('pointerdown', () => {
      this.onBackRequested();
    });
    this.setPauseButtonIconMode(false);
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
    this.startPlaybackClock(0);
    const startedBackingAudio = await this.startBackingTrackAudio(this.sceneData?.audioUrl, 0);
    if (!startedBackingAudio) {
      this.playbackMode = 'midi';
      this.scrubPlayer.resume(0, audioCtx.currentTime);
    }
  }

  private tickRuntime(): void {
    if (!this.audioCtx || !this.tempoMap || this.runtime.state === PlayState.Finished || this.pauseOverlay) return;
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

    this.hitDebugSnapshot = {
      songSecondsNow,
      targetSeconds,
      targetDeltaMs,
      isWithinGraceWindow,
      canValidateHit,
      validHit,
      activeTarget: active,
      latestFrame: hitAnalysis.latestFrame,
      holdMs: hitAnalysis.streakMs,
      holdRequiredMs: DEFAULT_HOLD_MS,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      validFrameCount: hitAnalysis.validFrameCount,
      sampleCount: hitAnalysis.sampleCount
    };

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
      if (previousState === PlayState.WaitingForHit) {
        this.resumeBackingPlayback();
      }
      const deltaMs = this.measureHitDeltaMs(target, previousState);
      const rated = rateHit(deltaMs);
      this.scoreEvents.push({ targetId: target.id, rating: rated.rating, deltaMs, points: rated.points });
      this.waitingStartMs = null;
      this.latestFrames = [];
      this.feedbackText = `${rated.rating} +${rated.points}`;
      this.feedbackUntilMs = performance.now() + 700;
      return;
    }

    if (transition === 'timeout_miss' && target) {
      if (previousState === PlayState.WaitingForHit) {
        this.resumeBackingPlayback();
      }
      const fallbackDeltaMs = (this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds ?? 0) * 1000;
      const deltaMs = this.waitingStartMs === null ? fallbackDeltaMs : performance.now() - this.waitingStartMs;
      this.scoreEvents.push({ targetId: target.id, rating: 'Miss', deltaMs, points: 0 });
      this.waitingStartMs = null;
      this.latestFrames = [];
      this.feedbackText = 'Miss (timeout)';
      this.feedbackUntilMs = performance.now() + 900;
    }
  }

  private finishSong(): void {
    if (this.resultsOverlay) return;
    this.runtime = {
      ...this.runtime,
      state: PlayState.Finished,
      waiting_started_at_s: undefined,
      waiting_target_id: undefined
    };
    this.finishDelayTimer?.remove(false);
    this.finishDelayTimer = undefined;
    this.closePauseMenu();
    this.setBallAndTrailVisible(false);
    this.debugButton?.disableInteractive().setVisible(false);
    this.debugButtonLabel?.setVisible(false);
    this.pauseButton?.disableInteractive().setVisible(false);
    this.pauseButtonLeftBar?.setVisible(false);
    this.pauseButtonRightBar?.setVisible(false);
    this.pauseButtonPlayIcon?.setVisible(false);
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
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(24, Math.floor(width * 0.035))}px`
    }).setOrigin(0.5);
    const summaryText = this.add.text(width / 2, height * 0.34, `${formatSummary(summary)}\nBest Score: ${bestScore}`, {
      color: '#e2e8f0',
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
      align: 'left',
      fontSize: `${Math.max(16, Math.floor(width * 0.02))}px`
    }).setOrigin(0.5, 0);
    const earnedStars = this.computeEndScreenStars(summary);
    const starObjects = this.createEndScreenStars(width / 2, height * 0.6, earnedStars, width);
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
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
    const totalTargets = this.targets.length;
    if (totalTargets <= 0) return 0;
    const playedNotes =
      summary.hitDistribution.Perfect + summary.hitDistribution.Great + summary.hitDistribution.OK;
    const playedRatio = playedNotes / totalTargets;
    if (playedRatio >= 0.9) return 3;
    if (playedRatio >= 0.6) return 2;
    if (playedRatio >= 0.3) return 1;
    return 0;
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
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
          fontSize: starFontSize
        })
        .setOrigin(0.5);
      objects.push(baseStar);

      if (index >= earnedStars) continue;

      const fillStar = this.add
        .text(x, centerY, '★', {
          color: activeColor,
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
        yoyo: true,
        hold: 70,
        onYoyo: () => {
          fillStar.setScale(1);
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
    this.playbackWasRunningBeforePauseMenu = this.runtime.state === PlayState.Playing;

    if (this.runtimeTimer) {
      this.runtimeTimer.paused = true;
    }
    if (this.playbackWasRunningBeforePauseMenu) {
      this.pausePlaybackClock();
      this.pauseBackingPlayback();
    }
    this.latestFrames = [];

    const { width, height } = this.scale;
    const panelWidth = Math.min(420, width * 0.84);
    const panelHeight = Math.min(300, height * 0.58);
    const centerX = width / 2;
    const centerY = height / 2;

    const backdrop = new RoundedBox(this, centerX, centerY, width, height, 0x000000, 0.55, 0)
      .setInteractive({ useHandCursor: false });

    const panelGlow = new RoundedBox(this, centerX, centerY, panelWidth + 8, panelHeight + 8, 0x60a5fa, 0.14);
    const panel = new RoundedBox(this, centerX, centerY, panelWidth, panelHeight, 0x101c3c, 0.96).setStrokeStyle(2, 0x60a5fa, 0.58);
    const title = this.add
      .text(centerX, centerY - panelHeight * 0.33, 'Pause Menu', {
        color: '#f8fafc',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(22, Math.floor(width * 0.03))}px`
      })
      .setOrigin(0.5);

    const resetButtonY = centerY - panelHeight * 0.04;
    const backButtonY = centerY + panelHeight * 0.22;

    const resetButton = new RoundedBox(this, centerX, resetButtonY, panelWidth * 0.72, 54, 0xf97316, 1)
      .setStrokeStyle(1, 0xfed7aa, 0.9)
      .setInteractive({ useHandCursor: true });
    const resetLabel = this.add
      .text(centerX, resetButtonY, 'Reset', {
        color: '#fff7ed',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
      })
      .setOrigin(0.5);

    const backButton = new RoundedBox(this, centerX, backButtonY, panelWidth * 0.72, 54, 0x1e293b, 1)
      .setStrokeStyle(1, 0x64748b, 0.9)
      .setInteractive({ useHandCursor: true });
    const backLabel = this.add
      .text(centerX, backButtonY, 'Back to Start', {
        color: '#e2e8f0',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
      })
      .setOrigin(0.5);

    resetButton.on('pointerdown', () => this.resetSession());
    backButton.on('pointerdown', () => this.goBackToStart());

    this.pauseOverlay = this.add.container(0, 0, [backdrop, panelGlow, panel, title, resetButton, resetLabel, backButton, backLabel]);
    this.pauseOverlay.setDepth(1000);
    this.setPauseButtonIconMode(true);
  }

  private closePauseMenu(): void {
    if (!this.pauseOverlay) return;

    this.pauseOverlay.destroy(true);
    this.pauseOverlay = undefined;

    if (this.runtimeTimer) {
      this.runtimeTimer.paused = false;
    }
    if (this.playbackWasRunningBeforePauseMenu) {
      this.resumeBackingPlayback();
    }
    this.latestFrames = [];
    this.playbackWasRunningBeforePauseMenu = false;
    this.setPauseButtonIconMode(false);
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
    if (!isNativeSongLibraryAvailable()) return;
    void updateNativeSongHighScore(songScoreKey, bestScore).catch((error) => {
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
        fontFamily: 'Courier New, monospace',
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
    const panelHeight = Math.min(240, height * 0.38);
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
    const deltaMs =
      snapshot?.targetDeltaMs ?? (songSecondsNow !== undefined && targetSeconds !== undefined ? (songSecondsNow - targetSeconds) * 1000 : undefined);
    const timeoutSeconds = this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds;
    const waitingElapsedSeconds =
      this.runtime.waiting_started_at_s !== undefined && this.audioCtx
        ? Math.max(0, this.audioCtx.currentTime - this.runtime.waiting_started_at_s)
        : undefined;
    const transitionAgeMs = this.lastRuntimeTransitionAtMs > 0 ? performance.now() - this.lastRuntimeTransitionAtMs : undefined;

    const lines = [
      'DEBUG OVERLAY (F3)',
      `state=${this.runtime.state} mode=${this.playbackMode} audio=${this.audioCtx?.state ?? 'n/a'} transition=${this.lastRuntimeTransition}${transitionAgeMs !== undefined ? ` (${Math.round(transitionAgeMs)}ms)` : ''}`,
      active
        ? `target=${this.runtime.active_target_index + 1}/${this.targets.length} id=${active.id} string=${active.string} fret=${active.fret} expMidi=${active.expected_midi}`
        : `target=${this.runtime.active_target_index + 1}/${this.targets.length} none`,
      `tick now=${Math.round(this.runtime.current_tick)} target=${active ? active.tick : '-'} dtick=${active ? active.tick - this.runtime.current_tick : '-'}`,
      `time now=${formatDebugNumber(songSecondsNow, 3)}s target=${formatDebugNumber(targetSeconds, 3)}s d=${formatSignedMs(deltaMs)} window=+/-${Math.round(TARGET_HIT_GRACE_SECONDS * 1000)}ms`,
      `pitch midi=${formatDebugNumber(latestFrame?.midi_estimate, 2)} conf=${formatDebugNumber(latestFrame?.confidence, 2)} hold=${Math.round(snapshot?.holdMs ?? 0)}/${Math.round(snapshot?.holdRequiredMs ?? DEFAULT_HOLD_MS)}ms`,
      `validate can=${formatDebugBool(snapshot?.canValidateHit ?? false)} within=${formatDebugBool(snapshot?.isWithinGraceWindow ?? false)} validHit=${formatDebugBool(snapshot?.validHit ?? false)} minConf=${formatDebugNumber(snapshot?.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 2)} frames=${snapshot?.sampleCount ?? this.latestFrames.length} validFrames=${snapshot?.validFrameCount ?? 0}`,
      `waiting=${waitingElapsedSeconds !== undefined ? `${waitingElapsedSeconds.toFixed(2)}s` : '-'} timeout=${timeoutSeconds !== undefined ? `${timeoutSeconds.toFixed(2)}s` : '-'} feedback=${this.feedbackText || '-'}`
    ];

    this.debugOverlayText.setText(lines.join('\n'));
  }

  private drawStaticLanes(): void {
    if (!this.laneLayer || !this.statusText || !this.liveScoreText) return;

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
    this.layoutSongMinimap();
    this.redrawSongMinimapStatic();
    this.updateSongMinimapProgress();

    this.statusText.setPosition(layout.left, 16);
    this.liveScoreText.setPosition(layout.right, 16);
    if (this.debugButton && this.debugButtonLabel) {
      this.debugButton.setPosition(layout.right - 62, 52);
      this.debugButtonLabel.setPosition(this.debugButton.x, this.debugButton.y);
    }
  }

  private layoutSongMinimap(): void {
    const { width, height } = this.scale;
    const sideMargin = 14;
    const reservedLeft = this.pauseButton
      ? sideMargin + PlayScene.PAUSE_BUTTON_SIZE + PlayScene.PAUSE_BUTTON_GAP
      : sideMargin;
    const handReminderGap = 18;
    const handReminderLeft = this.handReminderImage
      ? this.handReminderImage.x - this.handReminderImage.displayWidth
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
    const lastTarget = this.targets.length > 0 ? this.targets[this.targets.length - 1] : undefined;
    const mapEndTick = lastTarget ? lastTarget.tick + Math.max(lastTarget.duration_ticks, 1) : this.ticksPerQuarter * 4;
    const totalTicks = Math.max(this.ticksPerQuarter * 4, mapEndTick);

    if (!this.songMinimapBackground) {
      this.songMinimapBackground = new RoundedBox(this, centerX, centerY, minimapWidth, minimapHeight, 0x0b1228, 0.9)
        .setStrokeStyle(1, 0x334155, 0.85)
        .setDepth(286);
      this.songMinimapStaticLayer = this.add.graphics().setDepth(287);
      this.songMinimapDynamicLayer = this.add.graphics().setDepth(288);
    } else {
      this.songMinimapBackground.setPosition(centerX, centerY).setBoxSize(minimapWidth, minimapHeight);
      this.songMinimapBackground.setDepth(286);
      this.songMinimapStaticLayer?.setDepth(287);
      this.songMinimapDynamicLayer?.setDepth(288);
    }

    this.songMinimapLayout = {
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
  }

  private layoutPauseButton(): void {
    if (!this.pauseButton || !this.pauseButtonLeftBar || !this.pauseButtonRightBar || !this.pauseButtonPlayIcon) return;

    const sideMargin = 14;
    const centerX = sideMargin + PlayScene.PAUSE_BUTTON_SIZE / 2;
    const centerY = this.scale.height - sideMargin - PlayScene.PAUSE_BUTTON_SIZE / 2;
    const barOffsetX = Math.max(4, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.15));
    const barHeight = Math.max(14, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.48));
    const barWidth = Math.max(4, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.14));

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
      .setPosition(centerX + Math.max(1, Math.floor(PlayScene.PAUSE_BUTTON_SIZE * 0.04)), centerY)
      .setScale(Math.max(1, PlayScene.PAUSE_BUTTON_SIZE / 24))
      .setDepth(290);
  }

  private setPauseButtonIconMode(showPlay: boolean): void {
    this.pauseButtonLeftBar?.setVisible(!showPlay);
    this.pauseButtonRightBar?.setVisible(!showPlay);
    this.pauseButtonPlayIcon?.setVisible(showPlay);
  }

  private redrawSongMinimapStatic(): void {
    if (!this.songMinimapStaticLayer || !this.songMinimapLayout) return;
    const layout = this.songMinimapLayout;
    this.songMinimapStaticLayer.clear();

    this.songMinimapStaticLayer.lineStyle(1, 0x1e293b, 0.7);
    for (let i = 0; i <= 6; i += 1) {
      const y = layout.innerTop + i * layout.rowHeight;
      this.songMinimapStaticLayer.beginPath();
      this.songMinimapStaticLayer.moveTo(layout.innerLeft, y);
      this.songMinimapStaticLayer.lineTo(layout.innerLeft + layout.innerWidth, y);
      this.songMinimapStaticLayer.strokePath();
    }

    const measureTicks = this.ticksPerQuarter * 4;
    if (measureTicks > 0) {
      for (let tick = 0; tick <= layout.totalTicks; tick += measureTicks) {
        const markerX = layout.innerLeft + (tick / layout.totalTicks) * layout.innerWidth;
        const isMajor = tick % (measureTicks * 4) === 0;
        this.songMinimapStaticLayer.lineStyle(1, isMajor ? 0xfacc15 : 0x64748b, isMajor ? 0.7 : 0.35);
        this.songMinimapStaticLayer.beginPath();
        this.songMinimapStaticLayer.moveTo(markerX, layout.innerTop);
        this.songMinimapStaticLayer.lineTo(markerX, layout.innerTop + layout.innerHeight);
        this.songMinimapStaticLayer.strokePath();
      }
    }

    const noteHeight = Math.max(1.4, layout.rowHeight * 0.62);
    for (const target of this.targets) {
      const startX = layout.innerLeft + (target.tick / layout.totalTicks) * layout.innerWidth;
      const endX = layout.innerLeft + ((target.tick + Math.max(target.duration_ticks, 1)) / layout.totalTicks) * layout.innerWidth;
      const noteWidth = Math.max(1.6, endX - startX);
      const rowIndex = Phaser.Math.Clamp(target.string - 1, 0, 5);
      const y = layout.innerTop + rowIndex * layout.rowHeight + (layout.rowHeight - noteHeight) / 2;
      this.songMinimapStaticLayer.fillStyle(FINGER_COLORS[target.finger] ?? 0xffffff, 0.9);
      this.songMinimapStaticLayer.fillRoundedRect(startX, y, noteWidth, noteHeight, Math.min(2.5, noteHeight / 2));
    }
  }

  private updateSongMinimapProgress(): void {
    if (!this.songMinimapDynamicLayer || !this.songMinimapLayout) return;
    const layout = this.songMinimapLayout;
    this.songMinimapDynamicLayer.clear();

    const clampedTick = Phaser.Math.Clamp(this.runtime.current_tick, 0, layout.totalTicks);
    const progressX = layout.innerLeft + (clampedTick / layout.totalTicks) * layout.innerWidth;
    const playedWidth = Math.max(0, progressX - layout.innerLeft);
    this.songMinimapDynamicLayer.fillStyle(0x22c55e, 0.18);
    this.songMinimapDynamicLayer.fillRect(layout.innerLeft, layout.innerTop, playedWidth, layout.innerHeight);

    this.songMinimapDynamicLayer.lineStyle(2, 0xf8fafc, 0.95);
    this.songMinimapDynamicLayer.beginPath();
    this.songMinimapDynamicLayer.moveTo(progressX, layout.innerTop - 1);
    this.songMinimapDynamicLayer.lineTo(progressX, layout.innerTop + layout.innerHeight + 1);
    this.songMinimapDynamicLayer.strokePath();
  }

  private drawTopStarfield(): void {
    if (!this.starfieldLayer) return;

    const layout = this.layout();
    const { width } = this.scale;
    const yMin = 6;
    const yMax = Math.max(yMin + 12, layout.top - 14);
    const bandHeight = yMax - yMin;
    const starCount = Math.max(36, Math.round((width * bandHeight) / 12000));

    const shouldRebuildStars =
      !this.topStarBand ||
      this.topStarBand.width !== width ||
      Math.abs(this.topStarBand.yMin - yMin) > 1 ||
      Math.abs(this.topStarBand.yMax - yMax) > 1 ||
      this.topStars.length !== starCount;

    if (shouldRebuildStars) {
      this.topStarBand = { width, yMin, yMax };
      this.topStars = [];
      for (let i = 0; i < starCount; i += 1) {
        this.topStars.push({
          baseX: Math.random() * width,
          y: Phaser.Math.FloatBetween(yMin, yMax),
          radius: Phaser.Math.FloatBetween(0.7, 1.9),
          baseAlpha: Phaser.Math.FloatBetween(0.25, 0.85),
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: Phaser.Math.FloatBetween(0.4, 1.35)
        });
      }
    }

    this.starfieldLayer.clear();
    const scrollPx = this.runtime.current_tick * layout.pxPerTick;
    const nowSeconds = performance.now() / 1000;
    for (const star of this.topStars) {
      const x = Phaser.Math.Wrap(star.baseX - scrollPx, -8, width + 8);
      const twinkle = 0.72 + 0.28 * Math.sin(nowSeconds * star.twinkleSpeed + star.twinklePhase);
      const alpha = Phaser.Math.Clamp(star.baseAlpha * twinkle, 0.1, 0.9);
      this.starfieldLayer.fillStyle(0xe2e8f0, alpha);
      this.starfieldLayer.fillCircle(x, star.y, star.radius);
      if (star.radius >= 1.5) {
        this.starfieldLayer.fillStyle(0x93c5fd, alpha * 0.32);
        this.starfieldLayer.fillCircle(x, star.y, star.radius * 2.2);
      }
    }
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
    if (!this.audioCtx || !this.tempoMap) return;
    const previousState = this.runtime.state;
    const active = this.targets[this.runtime.active_target_index];
    const targetTimeSeconds = active ? this.tempoMap.tickToSeconds(active.tick) : undefined;
    const songTimeSeconds = this.getSongSecondsNow();
    const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, true, {
      gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
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
    }
  }

  private queueFinishSong(): void {
    if (this.resultsOverlay || this.finishDelayTimer) return;
    this.finishDelayTimer = this.time.delayedCall(PlayScene.POST_SONG_END_SCREEN_DELAY_MS, () => {
      this.finishDelayTimer = undefined;
      if (!this.scene.isActive()) return;
      this.finishSong();
    });
  }

  private redrawTargetsAndBall(): void {
    if (!this.targetLayer || !this.ball) return;

    if (this.runtime.state === PlayState.Finished) {
      this.setBallAndTrailVisible(false);
      return;
    }
    this.setBallAndTrailVisible(true);

    const layout = this.layout();
    const currentTick = this.runtime.current_tick;
    const waitingTargetId = this.runtime.state === PlayState.WaitingForHit ? this.runtime.waiting_target_id : undefined;
    const viewLeft = layout.left - 30;
    const viewRight = layout.right + 40;
    const labelFontSize = `${Math.max(11, Math.floor(layout.noteHeight * 0.95))}px`;

    this.targetLayer.clear();
    this.clearFretLabels();

    for (const target of this.targets) {
      const x = layout.hitLineX + (target.tick - currentTick) * layout.pxPerTick;
      const noteDiameter = layout.noteHeight;
      const noteRadius = noteDiameter / 2;
      const width = Math.max(noteDiameter, target.duration_ticks * layout.pxPerTick);
      if (x + width < viewLeft || x > viewRight) continue;

      const y = layout.top + (target.string - 1) * layout.laneSpacing;
      const isWaitingTarget = waitingTargetId === target.id;
      const isPast = target.tick < currentTick;
      const alpha = isWaitingTarget ? 1 : isPast ? 0.28 : 0.95;

      this.targetLayer.fillStyle(FINGER_COLORS[target.finger] ?? 0xffffff, alpha);
      this.targetLayer.fillRoundedRect(x, y - noteRadius, width, noteDiameter, noteRadius);

      const fretLabel = this.add
        .text(x + noteRadius, y, `${target.fret}`, {
          color: '#0b1020',
          fontSize: labelFontSize,
          fontStyle: 'bold'
        })
        .setOrigin(0.5)
        .setAlpha(alpha);
      this.fretLabels.push(fretLabel);

      if (isWaitingTarget) {
        this.targetLayer.lineStyle(2, 0xffffff, 1);
        this.targetLayer.strokeRoundedRect(x, y - noteRadius, width, noteDiameter, noteRadius);
      }
    }

    this.ball.x = layout.hitLineX;
    const anchorY = this.getBallAnchorY(layout);
    if (this.runtime.state === PlayState.WaitingForHit) {
      this.ball.y = anchorY;
      this.updateBallTrail(this.ball.x, this.ball.y, layout.laneSpacing);
      return;
    }

    const beatTick = ((this.runtime.current_tick % this.ticksPerQuarter) + this.ticksPerQuarter) % this.ticksPerQuarter;
    const beatPhase = beatTick / this.ticksPerQuarter;
    const amplitude = Phaser.Math.Clamp(
      layout.laneSpacing * BALL_BOUNCE_AMPLITUDE_FACTOR,
      BALL_BOUNCE_AMPLITUDE_MIN_PX,
      BALL_BOUNCE_AMPLITUDE_MAX_PX
    );
    this.ball.y = anchorY - Math.sin(beatPhase * Math.PI) * amplitude;
    this.updateBallTrail(this.ball.x, this.ball.y, layout.laneSpacing);
  }

  private updateHud(): void {
    if (!this.statusText || !this.liveScoreText) return;

    const now = performance.now();
    const timeoutSeconds = this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds;

    const streak = Math.max(1, currentStreak(this.scoreEvents));
    let status = `x${streak}`;
    if (now < this.feedbackUntilMs) {
      status = `x${streak}  ${this.feedbackText}`;
    } else if (this.runtime.state === PlayState.WaitingForHit) {
      if (timeoutSeconds !== undefined && this.audioCtx && this.runtime.waiting_started_at_s !== undefined) {
        const remaining = Math.max(0, timeoutSeconds - (this.audioCtx.currentTime - this.runtime.waiting_started_at_s));
        status = `x${streak}  Waiting (${remaining.toFixed(1)}s)`;
      } else {
        status = `x${streak}  Waiting`;
      }
    }

    const totalScore = this.scoreEvents.reduce((acc, event) => acc + event.points, 0);
    const completed = Math.min(this.runtime.active_target_index, this.targets.length);

    this.statusText.setText(status);
    this.liveScoreText.setText(`${totalScore}  |  ${completed}/${this.targets.length}`);
    this.updateDebugOverlay();
  }

  private layout(): Layout {
    const { width, height } = this.scale;
    const left = width * 0.08;
    const right = width * 0.96;
    const baseTop = height * 0.2;
    const baseBottom = height * 0.84;
    const tabHeight = (baseBottom - baseTop) * 0.9;
    const top = baseTop - height * 0.018;
    const bottom = top + tabHeight;
    const laneSpacing = (bottom - top) / 5;

    return {
      left,
      right,
      top,
      bottom,
      laneSpacing,
      hitLineX: left + (right - left) * 0.19,
      pxPerTick: Math.max(0.09, width / 5200),
      noteHeight: Math.max(14, laneSpacing * 0.38)
    };
  }

  private getBallAnchorY(layout: Layout): number {
    const activeTarget = this.targets[this.runtime.active_target_index];
    if (!activeTarget) {
      return layout.top - Math.max(18, this.scale.height * 0.04);
    }
    return layout.top + (activeTarget.string - 1) * layout.laneSpacing;
  }

  private createBallTrail(): void {
    this.destroyBallTrail();
    for (let i = 0; i < BALL_GHOST_TRAIL_COUNT; i += 1) {
      const ghost = this.add
        .circle(0, 0, 10, 0xfef08a, 1)
        .setDepth(250 - i)
        .setAlpha(0)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.ballTrail.push(ghost);
    }
  }

  private destroyBallTrail(): void {
    for (const ghost of this.ballTrail) {
      ghost.destroy();
    }
    this.ballTrail = [];
    this.ballTrailHistory = [];
    this.lastBallTrailPoint = undefined;
  }

  private pushBallTrailPoint(x: number, y: number): void {
    this.ballTrailHistory.push({ x, y });
    const maxHistory =
      BALL_GHOST_TRAIL_COUNT * BALL_GHOST_TRAIL_SAMPLE_STEP + BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS + 8;
    if (this.ballTrailHistory.length > maxHistory) {
      this.ballTrailHistory.splice(0, this.ballTrailHistory.length - maxHistory);
    }
  }

  private updateBallTrail(x: number, y: number, laneSpacing: number): void {
    if (this.ballTrail.length === 0) return;

    const previous = this.lastBallTrailPoint;
    if (!previous) {
      this.pushBallTrailPoint(x, y);
      this.lastBallTrailPoint = { x, y };
    } else {
      const distance = Phaser.Math.Distance.Between(previous.x, previous.y, x, y);
      if (distance > laneSpacing * 4) {
        this.ballTrailHistory = [];
        this.pushBallTrailPoint(x, y);
        this.lastBallTrailPoint = { x, y };
      } else if (distance > 0.15) {
        const interpolationSteps = distance > laneSpacing * 0.7 ? BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS : 1;
        for (let i = 1; i <= interpolationSteps; i += 1) {
          const t = i / interpolationSteps;
          this.pushBallTrailPoint(Phaser.Math.Linear(previous.x, x, t), Phaser.Math.Linear(previous.y, y, t));
        }
        this.lastBallTrailPoint = { x, y };
      }
    }

    const historyCount = this.ballTrailHistory.length;
    const basePoint = historyCount > 0 ? this.ballTrailHistory[0] : undefined;
    const alphaNear = 0.62;
    const alphaFar = 0.08;
    const scaleNear = 0.95;
    const scaleFar = 0.45;
    const denom = Math.max(1, this.ballTrail.length - 1);

    for (let i = 0; i < this.ballTrail.length; i += 1) {
      const historyIndex = historyCount - 1 - i * BALL_GHOST_TRAIL_SAMPLE_STEP;
      const point = historyIndex >= 0 ? this.ballTrailHistory[historyIndex] : basePoint;
      const ghost = this.ballTrail[i];
      if (!point) {
        ghost.setAlpha(0);
        continue;
      }
      const t = i / denom;
      ghost
        .setPosition(point.x, point.y)
        .setAlpha(Phaser.Math.Linear(alphaNear, alphaFar, t))
        .setScale(Phaser.Math.Linear(scaleNear, scaleFar, t));
    }
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
    this.playbackWasRunningBeforePauseMenu = false;
    this.pauseButton?.destroy();
    this.pauseButton = undefined;
    this.pauseButtonLeftBar?.destroy();
    this.pauseButtonLeftBar = undefined;
    this.pauseButtonRightBar?.destroy();
    this.pauseButtonRightBar = undefined;
    this.pauseButtonPlayIcon?.destroy();
    this.pauseButtonPlayIcon = undefined;

    this.handReminderImage?.destroy();
    this.handReminderImage = undefined;
    this.songMinimapBackground?.destroy();
    this.songMinimapBackground = undefined;
    this.songMinimapStaticLayer?.destroy();
    this.songMinimapStaticLayer = undefined;
    this.songMinimapDynamicLayer?.destroy();
    this.songMinimapDynamicLayer = undefined;
    this.songMinimapLayout = undefined;
    this.starfieldLayer?.destroy();
    this.starfieldLayer = undefined;
    this.topStars = [];
    this.topStarBand = undefined;
    this.destroyBallTrail();
    this.debugButton?.destroy();
    this.debugButton = undefined;
    this.debugButtonLabel?.destroy();
    this.debugButtonLabel = undefined;
    this.debugOverlayContainer?.destroy(true);
    this.debugOverlayContainer = undefined;
    this.debugOverlayPanel = undefined;
    this.debugOverlayText = undefined;
    this.hitDebugSnapshot = undefined;

    this.clearFretLabels();

    this.runtimeTimer?.remove(false);
    this.runtimeTimer = undefined;
    this.finishDelayTimer?.remove(false);
    this.finishDelayTimer = undefined;

    this.stopBackingPlayback();
    this.scrubPlayer = undefined;

    this.debugSynth?.stopAll();
    this.debugSynth?.dispose();
    this.debugSynth = undefined;

    this.detector?.stop();
    this.detector = undefined;

    if (this.onResize) {
      this.scale.off('resize', this.onResize);
      this.onResize = undefined;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
    }
    this.audioCtx = undefined;
  }

  private async startBackingTrackAudio(audioUrl: string | undefined, startSongSeconds: number): Promise<boolean> {
    if (!audioUrl || !isBackingTrackAudioUrl(audioUrl)) {
      return false;
    }

    const audio = new Audio(audioUrl);
    audio.preload = 'auto';
    audio.loop = false;
    this.backingTrackAudio = audio;
    this.playbackMode = 'audio';
    const played = await this.playBackingTrackAudioFrom(startSongSeconds);
    if (played) return true;

    this.releaseBackingTrackAudio();
    this.playbackMode = 'midi';
    return false;
  }

  private pauseBackingPlayback(): void {
    if (this.playbackMode === 'audio') {
      this.backingTrackAudio?.pause();
      return;
    }
    this.scrubPlayer?.pause(this.runtime.current_tick);
  }

  private resumeBackingPlayback(): void {
    const resumeSeconds = this.tempoMap?.tickToSeconds(this.runtime.current_tick) ?? this.pausedSongSeconds;
    this.startPlaybackClock(resumeSeconds);

    if (this.playbackMode === 'audio') {
      void this.resumeBackingTrackAudioOrFallback(resumeSeconds);
      return;
    }
    this.scrubPlayer?.resume(this.runtime.current_tick, this.audioCtx?.currentTime ?? 0);
  }

  private stopBackingPlayback(): void {
    this.backingTrackAudio?.pause();
    this.releaseBackingTrackAudio();
    this.scrubPlayer?.stop();
  }

  private async resumeBackingTrackAudioOrFallback(songSeconds: number): Promise<void> {
    const resumed = await this.playBackingTrackAudioFrom(songSeconds);
    if (resumed) return;

    this.playbackMode = 'midi';
    this.releaseBackingTrackAudio();
    this.scrubPlayer?.resume(this.runtime.current_tick, this.audioCtx?.currentTime ?? 0);
    this.feedbackText = 'Backing track unavailable. Switched to MIDI.';
    this.feedbackUntilMs = performance.now() + 1200;
  }

  private async playBackingTrackAudioFrom(songSeconds: number): Promise<boolean> {
    if (!this.backingTrackAudio) return false;
    const safeSeconds = Math.max(0, songSeconds);
    const audio = this.backingTrackAudio;

    try {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Phaser.Math.Clamp(safeSeconds, 0, Math.max(0, audio.duration - 0.02));
      } else {
        audio.currentTime = safeSeconds;
      }
    } catch {
      // Ignore seek failures, we still try to play from current position.
    }

    try {
      await audio.play();
      return true;
    } catch (error) {
      console.warn('Backing track play failed', { audioUrl: this.sceneData?.audioUrl, error });
      return false;
    }
  }

  private releaseBackingTrackAudio(): void {
    if (!this.backingTrackAudio) return;
    this.backingTrackAudio.pause();
    this.backingTrackAudio.removeAttribute('src');
    this.backingTrackAudio.load();
    this.backingTrackAudio = undefined;
  }

  private startPlaybackClock(songSeconds: number): void {
    const safeSongSeconds = Math.max(0, songSeconds);
    this.playbackStartSongSeconds = safeSongSeconds;
    this.pausedSongSeconds = safeSongSeconds;
    this.playbackStartAudioTime = this.audioCtx ? this.audioCtx.currentTime : null;
  }

  private pausePlaybackClock(): void {
    if (!this.audioCtx) return;
    this.pausedSongSeconds = this.getSongSecondsNow();
    this.playbackStartAudioTime = null;
    this.playbackStartSongSeconds = this.pausedSongSeconds;
  }

  private getSongSecondsNow(): number {
    if (this.playbackMode === 'audio' && this.backingTrackAudio) {
      return this.backingTrackAudio.currentTime;
    }
    if (!this.audioCtx || this.playbackStartAudioTime === null) {
      return this.pausedSongSeconds;
    }
    const elapsed = Math.max(0, this.audioCtx.currentTime - this.playbackStartAudioTime);
    return this.playbackStartSongSeconds + elapsed;
  }

  private clearFretLabels(): void {
    for (const label of this.fretLabels) {
      label.destroy();
    }
    this.fretLabels = [];
  }

  private setBallAndTrailVisible(visible: boolean): void {
    this.ball?.setVisible(visible);
    if (!visible) {
      this.ballTrailHistory = [];
      this.lastBallTrailPoint = undefined;
    }
    for (const ghost of this.ballTrail) {
      ghost.setVisible(visible);
      if (!visible) ghost.setAlpha(0);
    }
  }

  private measureHitDeltaMs(target: TargetNote, previousState: PlayState): number {
    if (previousState === PlayState.Playing && this.tempoMap) {
      const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
      return Math.abs(this.getSongSecondsNow() - targetSeconds) * 1000;
    }
    return this.waitingStartMs === null ? 0 : performance.now() - this.waitingStartMs;
  }

  private isInsideLiveHitWindow(target: TargetNote): boolean {
    if (!this.tempoMap) return false;
    const targetSeconds = this.tempoMap.tickToSeconds(target.tick);
    const now = this.getSongSecondsNow();
    return now >= targetSeconds - TARGET_HIT_GRACE_SECONDS && now <= targetSeconds + TARGET_HIT_GRACE_SECONDS;
  }
}

function currentStreak(events: ScoreEvent[]): number {
  let streak = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].rating === 'Miss') break;
    streak += 1;
  }
  return streak;
}

function sanitizeSelection(
  values: number[] | undefined,
  min: number,
  max: number,
  fallback: number[] | undefined
): number[] {
  const candidate = values ?? fallback ?? [];
  const deduped = Array.from(
    new Set(candidate.filter((value) => Number.isInteger(value) && value >= min && value <= max))
  );
  deduped.sort((a, b) => a - b);
  return deduped;
}

function isBackingTrackAudioUrl(url: string): boolean {
  return /\.(mp3|wav|ogg|m4a)(?:[?#].*)?$/i.test(url);
}

function analyzeHeldHit(
  frames: PitchFrame[],
  expectedMidi: number,
  tolerance: number,
  holdMs: number,
  minConfidence: number
): HeldHitAnalysis {
  if (frames.length === 0) {
    return { valid: false, streakMs: 0, validFrameCount: 0, sampleCount: 0, latestFrame: undefined };
  }

  let streakStartSeconds: number | null = null;
  let streakMs = 0;
  let validFrameCount = 0;

  for (const frame of frames) {
    const validFrame = isPitchFrameValid(frame, expectedMidi, tolerance, minConfidence);
    if (!validFrame) {
      streakStartSeconds = null;
      streakMs = 0;
      continue;
    }

    validFrameCount += 1;
    if (streakStartSeconds === null) {
      streakStartSeconds = frame.t_seconds;
      streakMs = 0;
      continue;
    }

    streakMs = Math.max(0, (frame.t_seconds - streakStartSeconds) * 1000);
    if (streakMs >= holdMs) {
      return {
        valid: true,
        streakMs,
        validFrameCount,
        sampleCount: frames.length,
        latestFrame: frames[frames.length - 1]
      };
    }
  }

  return {
    valid: false,
    streakMs,
    validFrameCount,
    sampleCount: frames.length,
    latestFrame: frames[frames.length - 1]
  };
}

function isPitchFrameValid(frame: PitchFrame, expectedMidi: number, tolerance: number, minConfidence: number): boolean {
  return (
    frame.midi_estimate !== null &&
    frame.confidence >= minConfidence &&
    Math.abs(frame.midi_estimate - expectedMidi) <= tolerance
  );
}

function formatDebugBool(value: boolean): string {
  return value ? 'Y' : 'N';
}

function formatDebugNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toFixed(digits);
}

function formatSignedMs(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '-';
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}ms`;
}

function isGameplayDebugOverlayEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  return params.get('debugGameplayOverlay') === '1';
}
