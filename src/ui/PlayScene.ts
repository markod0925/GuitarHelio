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
import { createMicNode } from '../audio/micInput';
import { JzzTinySynth } from '../audio/jzzTinySynth';
import { MidiScrubPlayer } from '../audio/midiScrubPlayer';
import { PitchDetectorService, isValidHeldHit } from '../audio/pitchDetector';
import { buildPlaybackNotes } from '../audio/playbackNotes';
import { rateHit, summarizeScores } from '../game/scoring';
import { createInitialRuntimeState, type RuntimeTransition, updateRuntimeState } from '../game/stateMachine';
import { generateTargetNotes } from '../guitar/targetGenerator';
import { loadMidiFromUrl } from '../midi/midiLoader';
import { TempoMap } from '../midi/tempoMap';
import type { DifficultyProfile, PitchFrame, ScoreEvent, SourceNote, TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { formatSummary } from './hud';
import { RoundedBox } from './RoundedBox';

type SceneData = {
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

export class PlayScene extends Phaser.Scene {
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
  private targetLayer?: Phaser.GameObjects.Graphics;
  private ball?: Phaser.GameObjects.Arc;
  private ballTrail: Phaser.GameObjects.Arc[] = [];
  private ballTrailHistory: Array<{ x: number; y: number }> = [];
  private lastBallTrailPoint?: { x: number; y: number };
  private handReminderImage?: Phaser.GameObjects.Image;
  private fretLabels: Phaser.GameObjects.Text[] = [];
  private statusText?: Phaser.GameObjects.Text;
  private liveScoreText?: Phaser.GameObjects.Text;
  private debugButton?: RoundedBox;
  private debugButtonLabel?: Phaser.GameObjects.Text;
  private resultsOverlay?: Phaser.GameObjects.Container;
  private pauseOverlay?: Phaser.GameObjects.Container;
  private runtimeTimer?: Phaser.Time.TimerEvent;

  private audioCtx?: AudioContext;
  private debugSynth?: JzzTinySynth;
  private scrubPlayer?: MidiScrubPlayer;
  private detector?: PitchDetectorService;
  private onResize?: () => void;
  private pauseMenuBackListener?: (event: Event) => void;
  private pauseMenuPopStateListener?: (event: PopStateEvent) => void;
  private playbackWasRunningBeforePauseMenu = false;

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

    this.laneLayer = this.add.graphics();
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

    this.drawStaticLanes();
    this.redrawTargetsAndBall();
    this.updateHud();

    this.onResize = () => {
      this.drawStaticLanes();
      this.redrawTargetsAndBall();
      this.updateHud();
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
    const validHit =
      active !== undefined &&
      canValidateHit &&
      isValidHeldHit(
        this.latestFrames,
        active.expected_midi,
        this.profile.pitch_tolerance_semitones,
        DEFAULT_HOLD_MS,
        DEFAULT_MIN_CONFIDENCE
      );

    const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, validHit, {
      gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
      targetTimeSeconds: targetSeconds,
      lateHitWindowSeconds: TARGET_HIT_GRACE_SECONDS
    });

    this.runtime = update.state;
    this.handleTransition(update.transition, update.target, previousState);

    this.redrawTargetsAndBall();
    this.updateHud();

    if (update.transition === 'finished') {
      this.finishSong();
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
    this.closePauseMenu();
    this.setBallAndTrailVisible(false);
    this.debugButton?.disableInteractive().setVisible(false);
    this.debugButtonLabel?.setVisible(false);

    this.runtimeTimer?.remove(false);
    this.runtimeTimer = undefined;

    this.stopBackingPlayback();
    this.detector?.stop();

    const summary = summarizeScores(this.scoreEvents);
    const { width, height } = this.scale;
    const panelWidth = Math.min(620, width * 0.82);
    const panelHeight = Math.min(380, height * 0.72);

    const panelGlow = new RoundedBox(this, width / 2, height / 2, panelWidth + 10, panelHeight + 10, 0x60a5fa, 0.16);
    const panel = new RoundedBox(this, width / 2, height / 2, panelWidth, panelHeight, 0x101c3c, 0.95)
      .setStrokeStyle(2, 0x60a5fa, 0.58);
    const title = this.add.text(width / 2, height * 0.26, 'Session Complete', {
      color: '#f8fafc',
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
      fontStyle: 'bold',
      fontSize: `${Math.max(24, Math.floor(width * 0.035))}px`
    }).setOrigin(0.5);
    const summaryText = this.add.text(width / 2, height * 0.34, formatSummary(summary), {
      color: '#e2e8f0',
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
      align: 'left',
      fontSize: `${Math.max(16, Math.floor(width * 0.02))}px`
    }).setOrigin(0.5, 0);
    const hint = this.add.text(width / 2, height * 0.73, 'Tap or press Enter to return', {
      color: '#bfdbfe',
      fontFamily: 'Trebuchet MS, Verdana, sans-serif',
      fontSize: `${Math.max(15, Math.floor(width * 0.017))}px`
    }).setOrigin(0.5);

    this.resultsOverlay = this.add.container(0, 0, [panelGlow, panel, title, summaryText, hint]);

    const goBack = (): void => {
      this.scene.start('SongSelectScene');
    };
    this.input.once('pointerdown', goBack);
    this.input.keyboard?.once('keydown-ENTER', goBack);
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

    this.laneLayer.fillStyle(0xbfdbfe, 0.18);
    for (let i = 0; i < 65; i += 1) {
      const x = ((i * 137) % width) + (i % 3) * 0.35;
      const y = (i * 97) % Math.max(40, Math.floor(layout.top - 14));
      const r = i % 11 === 0 ? 2 : 1;
      this.laneLayer.fillCircle(x, y, r);
    }

    this.laneLayer.lineStyle(1.8, 0x93c5fd, 0.22);
    for (let i = 0; i < 4; i += 1) {
      const y = layout.top - 20 + i * (layout.laneSpacing * 1.2);
      this.laneLayer.beginPath();
      this.laneLayer.moveTo(0, y);
      this.laneLayer.lineTo(width, y);
      this.laneLayer.strokePath();
    }

    const fretTopY = layout.top + 6;
    const fretBottomY = layout.bottom + 28;
    const fretTopLeft = layout.left + 44;
    const fretTopRight = layout.right - 44;
    const fretBottomLeft = layout.left - 18;
    const fretBottomRight = layout.right + 18;

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

    this.laneLayer.lineStyle(2, 0xcbd5e1, 0.86);
    for (let i = 0; i < 6; i += 1) {
      const y = layout.top + i * layout.laneSpacing + 10;
      this.laneLayer.beginPath();
      this.laneLayer.moveTo(layout.left - 8, y);
      this.laneLayer.lineTo(layout.right + 8, y);
      this.laneLayer.strokePath();
    }

    this.laneLayer.lineStyle(2.6, 0xfef3c7, 0.95);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(layout.hitLineX, layout.top - 18);
    this.laneLayer.lineTo(layout.hitLineX, layout.bottom + 26);
    this.laneLayer.strokePath();

    this.layoutHandReminder();

    this.statusText.setPosition(layout.left, 16);
    this.liveScoreText.setPosition(layout.right, 16);
    if (this.debugButton && this.debugButtonLabel) {
      this.debugButton.setPosition(layout.right - 62, 52);
      this.debugButtonLabel.setPosition(this.debugButton.x, this.debugButton.y);
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
    }
  }

  private consumeDebugHit(): void {
    if (!this.audioCtx) return;
    const previousState = this.runtime.state;
    const active = this.targets[this.runtime.active_target_index];
    const targetTimeSeconds = active && this.tempoMap ? this.tempoMap.tickToSeconds(active.tick) : undefined;
    const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, true, {
      gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds,
      targetTimeSeconds,
      lateHitWindowSeconds: TARGET_HIT_GRACE_SECONDS
    });
    this.runtime = update.state;
    this.handleTransition(update.transition, update.target, previousState);
    this.redrawTargetsAndBall();
    this.updateHud();
    if (update.transition === 'finished') {
      this.finishSong();
    }
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
      const width = Math.max(18, target.duration_ticks * layout.pxPerTick);
      if (x + width < viewLeft || x > viewRight) continue;

      const y = layout.top + (target.string - 1) * layout.laneSpacing;
      const isWaitingTarget = waitingTargetId === target.id;
      const isPast = target.tick < currentTick;
      const alpha = isWaitingTarget ? 1 : isPast ? 0.28 : 0.95;

      this.targetLayer.fillStyle(FINGER_COLORS[target.finger] ?? 0xffffff, alpha);
      this.targetLayer.fillRoundedRect(x, y - layout.noteHeight / 2, width, layout.noteHeight, layout.noteHeight / 3);

      const fretLabel = this.add
        .text(x + width / 2, y, `${target.fret}`, {
          color: '#0b1020',
          fontSize: labelFontSize,
          fontStyle: 'bold'
        })
        .setOrigin(0.5)
        .setAlpha(alpha);
      this.fretLabels.push(fretLabel);

      if (isWaitingTarget) {
        this.targetLayer.lineStyle(2, 0xffffff, 1);
        this.targetLayer.strokeRoundedRect(x, y - layout.noteHeight / 2, width, layout.noteHeight, layout.noteHeight / 3);
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
  }

  private layout(): Layout {
    const { width, height } = this.scale;
    const left = width * 0.08;
    const right = width * 0.96;
    const top = height * 0.2;
    const bottom = height * 0.84;
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

    this.handReminderImage?.destroy();
    this.handReminderImage = undefined;
    this.destroyBallTrail();
    this.debugButton?.destroy();
    this.debugButton = undefined;
    this.debugButtonLabel?.destroy();
    this.debugButtonLabel = undefined;

    this.clearFretLabels();

    this.runtimeTimer?.remove(false);
    this.runtimeTimer = undefined;

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
