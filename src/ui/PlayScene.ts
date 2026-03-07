import Phaser from 'phaser';
import {
  BALL_GHOST_TRAIL_COUNT,
  BALL_GHOST_TRAIL_JUMP_INTERPOLATION_STEPS,
  BALL_GHOST_TRAIL_SAMPLE_STEP,
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
import { type PlaybackClockState } from './AudioController';
import { FretboardRenderer } from './FretboardRenderer';
import { MinimapRenderer } from './MinimapRenderer';
import { NoteRenderer } from './NoteRenderer';
import {
  filterSourceNotesByOnsetSeconds,
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
import { BallController } from './play/controllers/BallController';
import { LifecycleController } from './play/controllers/LifecycleController';
import { PlayDebugController } from './play/controllers/PlayDebugController';
import { PlayLayoutController } from './play/controllers/PlayLayoutController';
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
  public nativeBackButtonListener?: { remove: () => Promise<void> };
  public nativeAppStateListener?: { remove: () => Promise<void> };
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
  public readonly ballController = new BallController(this);
  public readonly lifecycleController = new LifecycleController(this);
  public readonly layoutController = new PlayLayoutController(this);
  public readonly debugController = new PlayDebugController(this);
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

    this.lifecycleController.initializeSessionState();

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

    this.lifecycleController.registerResizeHandler();

    await this.setupAudioStack(loaded.sourceNotes);
    this.attachBackHandlers();

    this.lifecycleController.startRuntimeLoop();
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
    this.layoutController.drawStaticLanes();
  }

  public layoutSongMinimap(): void {
    this.layoutController.layoutSongMinimap();
  }

  public layoutPauseButton(): void {
    this.layoutController.layoutPauseButton();
  }

  public createPlaybackSpeedSlider(): void {
    this.layoutController.createPlaybackSpeedSlider();
  }

  public layoutPlaybackSpeedSlider(): void {
    this.layoutController.layoutPlaybackSpeedSlider();
  }

  public applyPlaybackSpeedFromSliderX(pointerX: number, previewOnly = false): void {
    this.layoutController.applyPlaybackSpeedFromSliderX(pointerX, previewOnly);
  }

  public beginPlaybackSpeedAdjustment(pointerId: number): void {
    this.layoutController.beginPlaybackSpeedAdjustment(pointerId);
  }

  public handlePlaybackSpeedPointerUp(pointer: Phaser.Input.Pointer): void {
    this.layoutController.handlePlaybackSpeedPointerUp(pointer);
  }

  public setPendingPlaybackSpeed(speedMultiplier: number): void {
    this.layoutController.setPendingPlaybackSpeed(speedMultiplier);
  }

  public setPlaybackSpeed(speedMultiplier: number): void {
    this.layoutController.setPlaybackSpeed(speedMultiplier);
  }

  public updatePlaybackSpeedSliderVisuals(): void {
    this.layoutController.updatePlaybackSpeedSliderVisuals();
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
    this.layoutController.layoutHandReminder();
  }

  public async playDebugTargetNote(): Promise<void> {
    await this.debugController.playDebugTargetNote();
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
    this.ballController.redrawTargetsAndBall();
  }

  public writeBallPosition(x: number, y: number): MutablePoint {
    return this.ballController.writeBallPosition(x, y);
  }

  public resolveBallPosition(layout: Layout): MutablePoint {
    return this.ballController.resolveBallPosition(layout);
  }

  public resolvePrePlaybackBallPosition(
    layout: Layout,
    firstTarget: TargetNote,
    firstTargetSeconds: number
  ): MutablePoint {
    return this.ballController.resolvePrePlaybackBallPosition(layout, firstTarget, firstTargetSeconds);
  }

  public resolveIntroBallPosition(
    layout: Layout,
    firstTarget: TargetNote,
    progress: number,
    firstTargetSeconds: number
  ): MutablePoint {
    return this.ballController.resolveIntroBallPosition(layout, firstTarget, progress, firstTargetSeconds);
  }

  public findTargetIndexAtOrAfterSongSeconds(songSeconds: number): number {
    return this.ballController.findTargetIndexAtOrAfterSongSeconds(songSeconds);
  }

  public getStringCenterY(layout: Layout, stringNumber: number): number {
    return this.ballController.getStringCenterY(layout, stringNumber);
  }

  public resolveBallArcHeight(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
    return this.ballController.resolveBallArcHeight(layout, startY, endY, intervalSeconds);
  }

  public resolveBallLateralExcursion(layout: Layout, startY: number, endY: number, intervalSeconds: number): number {
    return this.ballController.resolveBallLateralExcursion(layout, startY, endY, intervalSeconds);
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
    this.ballController.createBallTrail();
  }

  public destroyBallTrail(): void {
    this.ballController.destroyBallTrail();
  }

  public pushBallTrailPoint(x: number, y: number): void {
    this.ballController.pushBallTrailPoint(x, y);
  }

  public updateBallTrail(x: number, y: number, laneSpacing: number): void {
    this.ballController.updateBallTrail(x, y, laneSpacing);
  }

  public resetBallTrailHistory(): void {
    this.ballController.resetBallTrailHistory();
  }

  public drawBallDashedTrail(laneSpacing: number): void {
    this.ballController.drawBallDashedTrail(laneSpacing);
  }

  public getOrCreateTrailSegment(index: number): { shadow: Phaser.GameObjects.Line; main: Phaser.GameObjects.Line } {
    return this.ballController.getOrCreateTrailSegment(index);
  }

  public hideUnusedTrailSegments(startIndex: number): void {
    this.ballController.hideUnusedTrailSegments(startIndex);
  }

  public computeTrailPathLength(startIndex: number, endExclusiveIndex: number): number {
    return this.ballController.computeTrailPathLength(startIndex, endExclusiveIndex);
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
    this.lifecycleController.cleanup();
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
    this.ballController.setBallAndTrailVisible(visible);
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
