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
  PLAY_SCENE_NOTE_START_CUTOFF_SECONDS
} from '../app/config';
import { PitchFrameRingBuffer } from '../audio/PitchFrameRingBuffer';
import type { JzzTinySynth } from '../audio/jzzTinySynth';
import type { MidiScrubPlayer } from '../audio/midiScrubPlayer';
import type { PitchDetectorService } from '../audio/pitchDetector';
import { summarizeScores } from '../game/scoring';
import {
  createInitialRuntimeState,
  type RuntimeTransition,
  type RuntimeUpdate
} from '../game/stateMachine';
import { generateTargetNotes } from '../guitar/targetGenerator';
import { loadMidiFromUrl } from '../midi/midiLoader';
import { TempoMap } from '../midi/tempoMap';
import type { DifficultyProfile, ScoreEvent, SourceNote, TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { BallTrailRingBuffer } from './BallAnimator';
import {
  releaseMicStream,
  type PlaybackClockState
} from './AudioController';
import { FretboardRenderer } from './FretboardRenderer';
import { MinimapRenderer } from './MinimapRenderer';
import { NoteRenderer } from './NoteRenderer';
import {
  filterSourceNotesByOnsetSeconds,
  isGameplayDebugOverlayEnabled,
  sanitizeSelection
} from './playSceneDebug';
import type {
  AudioSeekDebugInfo,
  HeldHitAnalysis,
  HitDebugSnapshot,
  Layout,
  MutablePoint,
  PlaybackMode,
  SceneData,
} from './playSceneTypes';
import { RoundedBox } from './RoundedBox';
import { GameplayController } from './play/controllers/GameplayController';
import { PlaybackController } from './play/controllers/PlaybackController';
import { UIController } from './play/controllers/UIController';

export class PlayScene extends Phaser.Scene {
  public static readonly PAUSE_BUTTON_SIZE = 34;
  public static readonly PAUSE_BUTTON_GAP = 10;
  public static readonly PLAYBACK_SPEED_MIN = 0.25;
  public static readonly PLAYBACK_SPEED_MAX = 1.25;
  public static readonly PLAYBACK_SPEED_DEFAULT = 1;
  public static readonly POST_SONG_END_SCREEN_DELAY_MS = 2000;
  public static readonly PRE_PLAYBACK_DELAY_MS = 3500;
  public static readonly BALL_TRAIL_HISTORY_CAPACITY =
    BALL_GHOST_TRAIL_COUNT * BALL_GHOST_TRAIL_SAMPLE_STEP * 12 + BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS * 4 + 96;

  public sceneData?: SceneData;
  public targets: TargetNote[] = [];
  public targetOnsetSeconds: number[] = [];
  public runtime = createInitialRuntimeState();
  public scoreEvents: ScoreEvent[] = [];
  public totalScore = 0;
  public currentComboStreak = 0;
  public correctlyHitTargetIds = new Set<string>();
  public readonly latestFrames = new PitchFrameRingBuffer(64);
  public readonly heldHitAnalysisScratch: HeldHitAnalysis = {
    valid: false,
    streakMs: 0,
    validFrameCount: 0,
    sampleCount: 0,
    latestFrame: undefined
  };
  public waitingStartMs: number | null = null;
  public ticksPerQuarter = 480;
  public tempoMap: TempoMap | null = null;
  public playbackStartAudioTime: number | null = null;
  public playbackStartSongSeconds = 0;
  public pausedSongSeconds = 0;
  public profile: DifficultyProfile = DIFFICULTY_PRESETS.Easy;
  public fallbackTimeoutSeconds: number | undefined;
  public feedbackText = '';
  public feedbackUntilMs = 0;
  public playbackMode: PlaybackMode = 'midi';
  public backingTrackBuffer?: AudioBuffer;
  public backingTrackSource?: AudioBufferSourceNode;
  public backingTrackGain?: GainNode;
  public backingTrackSourceStartedAtAudioTime?: number;
  public backingTrackSourceStartSongSeconds = 0;
  public backingTrackIsPlaying = false;
  public backingTrackAudioUrl?: string;
  public pausedBackingAudioSeconds?: number;
  public lastKnownBackingAudioSeconds = 0;
  public playbackSpeedMultiplier = PlayScene.PLAYBACK_SPEED_DEFAULT;

  public laneLayer?: Phaser.GameObjects.Graphics;
  public ball?: Phaser.GameObjects.Arc;
  public ballTrailSegments: Array<{ shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line }> = [];
  public readonly ballTrailHistory = new BallTrailRingBuffer(PlayScene.BALL_TRAIL_HISTORY_CAPACITY);
  public readonly ballPositionScratch: MutablePoint = { x: 0, y: 0 };
  public hasLastBallTrailPoint = false;
  public lastBallTrailX = 0;
  public lastBallTrailY = 0;
  public readonly fretboardRenderer = new FretboardRenderer(this);
  public readonly minimapRenderer = new MinimapRenderer(this);
  public readonly noteRenderer = new NoteRenderer(this);
  public handReminderImage?: Phaser.GameObjects.Image;
  public statusText?: Phaser.GameObjects.Text;
  public feedbackMessageText?: Phaser.GameObjects.Text;
  public liveScoreText?: Phaser.GameObjects.Text;
  public debugButton?: RoundedBox;
  public debugButtonLabel?: Phaser.GameObjects.Text;
  public resultsOverlay?: Phaser.GameObjects.Container;
  public pauseOverlay?: Phaser.GameObjects.Container;
  public pauseButton?: RoundedBox;
  public pauseButtonLeftBar?: Phaser.GameObjects.Rectangle;
  public pauseButtonRightBar?: Phaser.GameObjects.Rectangle;
  public pauseButtonPlayIcon?: Phaser.GameObjects.Triangle;
  public playbackSpeedPanel?: RoundedBox;
  public playbackSpeedTrack?: Phaser.GameObjects.Rectangle;
  public playbackSpeedKnob?: Phaser.GameObjects.Arc;
  public playbackSpeedLabel?: Phaser.GameObjects.Text;
  public playbackSpeedValueText?: Phaser.GameObjects.Text;
  public playbackSpeedAdjusting = false;
  public playbackSpeedDragPointerId?: number;
  public pendingPlaybackSpeedMultiplier?: number;
  public playbackWasRunningBeforeSpeedAdjust = false;
  public runtimeTimer?: Phaser.Time.TimerEvent;
  public finishDelayTimer?: Phaser.Time.TimerEvent;
  public finishQueuedAtMs?: number;
  public playbackIntroTimer?: Phaser.Time.TimerEvent;
  public playbackStarted = false;
  public prePlaybackStartAtMs?: number;

  public audioCtx?: AudioContext;
  public debugSynth?: JzzTinySynth;
  public scrubPlayer?: MidiScrubPlayer;
  public detector?: PitchDetectorService;
  public micStream?: MediaStream;
  public onResize?: () => void;
  public cachedLayout?: Layout;
  public pauseMenuBackListener?: (event: Event) => void;
  public pauseMenuPopStateListener?: (event: PopStateEvent) => void;
  public playbackWasRunningBeforePauseMenu = false;
  public pauseMenuResumeSongSeconds?: number;
  public playbackPausedByButton = false;
  public playbackWasRunningBeforeButtonPause = false;
  public waitingPauseStartedAtAudioTime?: number;
  public debugOverlayEnabled = false;
  public debugOverlayContainer?: Phaser.GameObjects.Container;
  public debugOverlayPanel?: RoundedBox;
  public debugOverlayText?: Phaser.GameObjects.Text;
  public hitDebugSnapshot?: HitDebugSnapshot;
  public lastRuntimeTransition: RuntimeTransition = 'none';
  public lastRuntimeTransitionAtMs = 0;
  public lastAudioSeekDebug?: AudioSeekDebugInfo;
  public runtimeUpdateScratch: RuntimeUpdate = {
    state: this.runtime,
    transition: 'none'
  };
  public readonly gameplayController = new GameplayController(this);
  public readonly playbackController = new PlaybackController(this);
  public readonly uiController = new UIController(this);

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
    this.latestFrames.clear();
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

  public async setupAudioStack(sourceNotes: SourceNote[]): Promise<void> {
    await this.playbackController.setupAudioStack(sourceNotes);
  }

  public schedulePlaybackStart(delayMs: number = PlayScene.PRE_PLAYBACK_DELAY_MS): void {
    this.playbackController.schedulePlaybackStart(delayMs);
  }

  public async beginSessionPlayback(): Promise<void> {
    await this.playbackController.beginSessionPlayback();
  }

  public tickRuntime(): void {
    this.gameplayController.tickRuntime();
  }

  public writeInvalidHeldHitAnalysis(): HeldHitAnalysis {
    this.heldHitAnalysisScratch.valid = false;
    this.heldHitAnalysisScratch.streakMs = 0;
    this.heldHitAnalysisScratch.validFrameCount = 0;
    this.heldHitAnalysisScratch.sampleCount = this.latestFrames.length;
    this.heldHitAnalysisScratch.latestFrame = this.latestFrames.latest();
    return this.heldHitAnalysisScratch;
  }

  public handleTransition(transition: RuntimeTransition, target: TargetNote | undefined, previousState: PlayState): void {
    this.gameplayController.handleTransition(transition, target, previousState);
  }

  public recordScoreEvent(event: ScoreEvent): void {
    this.gameplayController.recordScoreEvent(event);
  }

  public finishSong(): void {
    this.uiController.finishSong();
  }

  public computeEndScreenStars(summary: ReturnType<typeof summarizeScores>): number {
    return this.uiController.computeEndScreenStars(summary);
  }

  public createEndScreenStars(
    centerX: number,
    centerY: number,
    earnedStars: number,
    width: number
  ): Phaser.GameObjects.GameObject[] {
    return this.uiController.createEndScreenStars(centerX, centerY, earnedStars, width);
  }

  public attachBackHandlers(): void {
    this.uiController.attachBackHandlers();
  }

  public onBackRequested(): void {
    this.uiController.onBackRequested();
  }

  public openPauseMenu(): void {
    this.uiController.openPauseMenu();
  }

  public closePauseMenu(): void {
    this.uiController.closePauseMenu();
  }

  public toggleGameplayPauseFromButton(): void {
    this.uiController.toggleGameplayPauseFromButton();
  }

  public pauseGameplayFromButton(): void {
    this.uiController.pauseGameplayFromButton();
  }

  public resumeGameplayFromButtonPause(): void {
    this.uiController.resumeGameplayFromButtonPause();
  }

  public isWaitingPausedByButton(): boolean {
    return this.uiController.isWaitingPausedByButton();
  }

  public relayoutPauseOverlay(): void {
    this.uiController.relayoutPauseOverlay();
  }

  public resetSession(): void {
    this.uiController.resetSession();
  }

  public goBackToStart(): void {
    this.uiController.goBackToStart();
  }

  public resolveSongScoreKey(): string {
    return this.uiController.resolveSongScoreKey();
  }

  public persistNativeSongHighScore(songScoreKey: string, bestScore: number): void {
    this.uiController.persistNativeSongHighScore(songScoreKey, bestScore);
  }

  public createDebugOverlay(): void {
    this.uiController.createDebugOverlay();
  }

  public relayoutDebugOverlay(): void {
    this.uiController.relayoutDebugOverlay();
  }

  public toggleDebugOverlay(): void {
    this.uiController.toggleDebugOverlay();
  }

  public updateDebugOverlay(): void {
    this.uiController.updateDebugOverlay();
  }

  public drawStaticLanes(): void {
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

  public layoutSongMinimap(): void {
    this.minimapRenderer.layoutMinimap(
      this.targets,
      this.ticksPerQuarter,
      this.pauseButton,
      this.handReminderImage,
      PlayScene.PAUSE_BUTTON_SIZE,
      PlayScene.PAUSE_BUTTON_GAP
    );
  }

  public layoutPauseButton(): void {
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

  public createPlaybackSpeedSlider(): void {
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

  public layoutPlaybackSpeedSlider(): void {
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

  public applyPlaybackSpeedFromSliderX(pointerX: number, previewOnly = false): void {
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

  public beginPlaybackSpeedAdjustment(pointerId: number): void {
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

  public handlePlaybackSpeedPointerUp(pointer: Phaser.Input.Pointer): void {
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

  public setPendingPlaybackSpeed(speedMultiplier: number): void {
    this.pendingPlaybackSpeedMultiplier = Phaser.Math.Clamp(
      speedMultiplier,
      PlayScene.PLAYBACK_SPEED_MIN,
      PlayScene.PLAYBACK_SPEED_MAX
    );
    this.updatePlaybackSpeedSliderVisuals();
  }

  public setPlaybackSpeed(speedMultiplier: number): void {
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

  public updatePlaybackSpeedSliderVisuals(): void {
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

  public setPauseButtonIconMode(showPlay: boolean): void {
    this.pauseButtonLeftBar?.setVisible(!showPlay);
    this.pauseButtonRightBar?.setVisible(!showPlay);
    this.pauseButtonPlayIcon?.setVisible(showPlay);
  }

  public syncPauseButtonIcon(): void {
    this.setPauseButtonIconMode(this.pauseOverlay !== undefined || this.playbackPausedByButton);
  }

  public redrawSongMinimapStatic(): void {
    this.minimapRenderer.redrawStatic(this.targets, this.ticksPerQuarter);
  }

  public updateSongMinimapProgress(): void {
    this.minimapRenderer.updateProgress(this.runtime.current_tick, this.targets, this.correctlyHitTargetIds);
  }

  public drawTopStarfield(): void {
    const layout = this.layout();
    this.fretboardRenderer.drawTopStarfield(layout, this.runtime.current_tick);
  }

  public layoutHandReminder(): void {
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

  public async playDebugTargetNote(): Promise<void> {
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

  public consumeDebugHit(): void {
    this.gameplayController.consumeDebugHit();
  }

  public queueFinishSong(): void {
    this.gameplayController.queueFinishSong();
  }

  public clearFinishSongQueue(): void {
    this.gameplayController.clearFinishSongQueue();
  }

  public redrawTargetsAndBall(): void {
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

  public writeBallPosition(x: number, y: number): MutablePoint {
    this.ballPositionScratch.x = x;
    this.ballPositionScratch.y = y;
    return this.ballPositionScratch;
  }

  public resolveBallPosition(layout: Layout): MutablePoint {
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

  public resolvePrePlaybackBallPosition(
    layout: Layout,
    firstTarget: TargetNote,
    firstTargetSeconds: number
  ): MutablePoint {
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

  public resolveIntroBallPosition(
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

  public findTargetIndexAtOrAfterSongSeconds(songSeconds: number): number {
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

  public getStringCenterY(layout: Layout, stringNumber: number): number {
    const laneIndex = Phaser.Math.Clamp(Math.round(stringNumber) - 1, 0, 5);
    return layout.top + laneIndex * layout.laneSpacing;
  }

  public resolveBallArcHeight(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
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

  public resolveBallLateralExcursion(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
    const laneDistance = Math.abs(endY - startY) / Math.max(layout.laneSpacing, 1);
    const laneFactor = Phaser.Math.Clamp(0.7 + laneDistance * 0.16, 0.7, 1.45);
    const timeFactor = Phaser.Math.Clamp(intervalSeconds / 0.55, 0.42, 1.05);
    const baseExcursion = Math.max(layout.laneSpacing * 0.62, 16);
    const halfScreenBoundary = this.scale.width * 0.5;
    const maxExcursion = Math.max(0, halfScreenBoundary - layout.hitLineX - 6);
    const minExcursion = Math.min(28, maxExcursion);
    return Phaser.Math.Clamp(baseExcursion * laneFactor * timeFactor, minExcursion, maxExcursion);
  }

  public updateHud(): void {
    this.uiController.updateHud();
  }

  public resolveTopFeedbackMessage(now: number): string {
    return this.uiController.resolveTopFeedbackMessage(now);
  }

  public layout(): Layout {
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

  public createBallTrail(): void {
    this.destroyBallTrail();
  }

  public destroyBallTrail(): void {
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

  public pushBallTrailPoint(x: number, y: number): void {
    this.ballTrailHistory.push(x, y);
  }

  public updateBallTrail(x: number, y: number, laneSpacing: number): void {
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

  public resetBallTrailHistory(): void {
    this.ballTrailHistory.clear();
    this.hasLastBallTrailPoint = false;
    this.lastBallTrailX = 0;
    this.lastBallTrailY = 0;
    this.hideUnusedTrailSegments(0);
  }

  public drawBallDashedTrail(laneSpacing: number): void {
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

  public getOrCreateTrailSegment(index: number): { shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line } {
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

  public hideUnusedTrailSegments(startIndex: number): void {
    for (let i = startIndex; i < this.ballTrailSegments.length; i += 1) {
      this.ballTrailSegments[i].shadow.setVisible(false);
      this.ballTrailSegments[i].main.setVisible(false);
    }
  }

  public computeTrailPathLength(startIndex: number, endExclusiveIndex: number): number {
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

  public buildProfileWithSettings(
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

  public cleanup(): void {
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

  public async startBackingTrackAudio(audioUrl: string | undefined, startSongSeconds: number): Promise<boolean> {
    return await this.playbackController.startBackingTrackAudio(audioUrl, startSongSeconds);
  }

  public pauseBackingPlayback(): void {
    this.playbackController.pauseBackingPlayback();
  }

  public resumeBackingPlayback(): void {
    this.playbackController.resumeBackingPlayback();
  }

  public stopBackingPlayback(): void {
    this.playbackController.stopBackingPlayback();
  }

  public async resumeBackingTrackAudio(songSeconds: number): Promise<void> {
    await this.playbackController.resumeBackingTrackAudio(songSeconds);
  }

  public async playBackingTrackAudioFrom(songSeconds: number): Promise<boolean> {
    return await this.playbackController.playBackingTrackAudioFrom(songSeconds);
  }

  public releaseBackingTrackAudio(): void {
    this.playbackController.releaseBackingTrackAudio();
  }

  public syncRuntimeToBackingTrackPosition(songSeconds: number): void {
    this.playbackController.syncRuntimeToBackingTrackPosition(songSeconds);
  }

  public stopBackingTrackSource(): void {
    this.playbackController.stopBackingTrackSource();
  }

  public ensureBackingTrackGainNode(): void {
    this.playbackController.ensureBackingTrackGainNode();
  }

  public getBackingTrackSongSeconds(): number | undefined {
    return this.playbackController.getBackingTrackSongSeconds();
  }

  public async loadBackingTrackBuffer(audioUrl: string): Promise<AudioBuffer> {
    return await this.playbackController.loadBackingTrackBuffer(audioUrl);
  }

  public clampAudioSeekSeconds(songSeconds: number): number {
    return this.playbackController.clampAudioSeekSeconds(songSeconds);
  }

  public createPlaybackClockState(): PlaybackClockState {
    return this.playbackController.createPlaybackClockState();
  }

  public applyPlaybackClockState(state: PlaybackClockState): void {
    this.playbackController.applyPlaybackClockState(state);
  }

  public startPlaybackClock(songSeconds: number): void {
    this.playbackController.startPlaybackClock(songSeconds);
  }

  public pausePlaybackClock(): void {
    this.playbackController.pausePlaybackClock();
  }

  public getSongSecondsNow(): number {
    return this.playbackController.getSongSecondsNow();
  }

  public getSongSecondsFromClock(): number {
    return this.playbackController.getSongSecondsFromClock();
  }

  public getCurrentPlaybackBpm(songSeconds: number | undefined): number | undefined {
    return this.playbackController.getCurrentPlaybackBpm(songSeconds);
  }

  public setBallAndTrailVisible(visible: boolean): void {
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

  public measureHitDeltaMs(target: TargetNote, previousState: PlayState): number {
    return this.gameplayController.measureHitDeltaMs(target, previousState);
  }

  public measureHitSignedDeltaMs(target: TargetNote, previousState: PlayState): number | undefined {
    return this.gameplayController.measureHitSignedDeltaMs(target, previousState);
  }

  public isInsideLiveHitWindow(target: TargetNote): boolean {
    return this.gameplayController.isInsideLiveHitWindow(target);
  }
}
