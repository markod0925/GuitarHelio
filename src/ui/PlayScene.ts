import Phaser from 'phaser';
import { DEFAULT_HOLD_MS, DEFAULT_MIN_CONFIDENCE, DIFFICULTY_PRESETS, FINGER_COLORS } from '../app/config';
import { createMicNode } from '../audio/micInput';
import { MidiScrubPlayer } from '../audio/midiScrubPlayer';
import { PitchDetectorService, isValidHeldHit } from '../audio/pitchDetector';
import { SimpleSynth } from '../audio/synth';
import { rateHit, summarizeScores } from '../game/scoring';
import { createInitialRuntimeState, type RuntimeTransition, updateRuntimeState } from '../game/stateMachine';
import { generateTargetNotes } from '../guitar/targetGenerator';
import { loadMidiFromUrl } from '../midi/midiLoader';
import { TempoMap } from '../midi/tempoMap';
import type { DifficultyProfile, PitchFrame, ScoreEvent, SourceNote, TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { formatSummary } from './hud';

type SceneData = {
  songUrl: string;
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
  ballBaseY: number;
};

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

  private laneLayer?: Phaser.GameObjects.Graphics;
  private targetLayer?: Phaser.GameObjects.Graphics;
  private ball?: Phaser.GameObjects.Arc;
  private handReminderImage?: Phaser.GameObjects.Image;
  private fretLabels: Phaser.GameObjects.Text[] = [];
  private statusText?: Phaser.GameObjects.Text;
  private liveScoreText?: Phaser.GameObjects.Text;
  private debugButton?: Phaser.GameObjects.Rectangle;
  private debugButtonLabel?: Phaser.GameObjects.Text;
  private resultsOverlay?: Phaser.GameObjects.Container;
  private pauseOverlay?: Phaser.GameObjects.Container;
  private runtimeTimer?: Phaser.Time.TimerEvent;

  private audioCtx?: AudioContext;
  private debugSynth?: SimpleSynth;
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
      loaded = await loadMidiFromUrl(data.songUrl);
    } catch (error) {
      console.error('Failed to load MIDI', { songUrl: data.songUrl, error });
      this.add
        .text(this.scale.width / 2, this.scale.height / 2, `Could not load song file:\n${data.songUrl}`, {
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

    this.laneLayer = this.add.graphics();
    this.targetLayer = this.add.graphics();
    this.ball = this.add.circle(0, 0, 10, 0xfef08a, 1);
    if (this.textures.exists('handReminder')) {
      this.handReminderImage = this.add.image(0, 0, 'handReminder').setOrigin(1, 1).setDepth(300);
    }

    this.statusText = this.add.text(0, 0, '', {
      color: '#dbeafe',
      fontSize: `${Math.max(14, Math.floor(this.scale.width * 0.016))}px`
    });
    this.liveScoreText = this.add.text(0, 0, '', {
      color: '#e2e8f0',
      fontSize: `${Math.max(13, Math.floor(this.scale.width * 0.015))}px`
    }).setOrigin(1, 0);
    this.debugButton = this.add
      .rectangle(0, 0, Math.max(116, Math.floor(this.scale.width * 0.14)), 34, 0x1e3a8a, 1)
      .setStrokeStyle(2, 0x93c5fd)
      .setInteractive({ useHandCursor: true })
      .setDepth(350);
    this.debugButtonLabel = this.add
      .text(0, 0, 'Play Note', {
        color: '#eff6ff',
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
    const synth = new SimpleSynth(audioCtx);
    this.debugSynth = synth;
    this.scrubPlayer = new MidiScrubPlayer(synth, sourceNotes, Math.max(1, Math.floor(this.ticksPerQuarter / 2)));

    try {
      const micSource = await createMicNode(audioCtx);
      const detector = new PitchDetectorService(audioCtx);
      await detector.init();
      detector.onPitch((frame) => {
        if (this.pauseOverlay) return;
        if (this.runtime.state !== PlayState.WaitingForHit) return;
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
    this.scrubPlayer.resume(0);
  }

  private tickRuntime(): void {
    if (!this.audioCtx || !this.tempoMap || this.runtime.state === PlayState.Finished || this.pauseOverlay) return;

    if (this.runtime.state === PlayState.Playing) {
      const elapsedSongSeconds = this.getSongSecondsNow();
      this.runtime.current_tick = this.tempoMap.secondsToTick(elapsedSongSeconds);
      this.scrubPlayer?.updateToTick(this.runtime.current_tick, this.audioCtx.currentTime);
    }

    const active = this.targets[this.runtime.active_target_index];
    const validHit =
      active !== undefined &&
      this.runtime.state === PlayState.WaitingForHit &&
      isValidHeldHit(
        this.latestFrames,
        active.expected_midi,
        this.profile.pitch_tolerance_semitones,
        DEFAULT_HOLD_MS,
        DEFAULT_MIN_CONFIDENCE
      );

    const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, validHit, {
      gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds
    });

    this.runtime = update.state;
    this.handleTransition(update.transition, update.target);

    this.redrawTargetsAndBall();
    this.updateHud();

    if (update.transition === 'finished') {
      this.finishSong();
    }
  }

  private handleTransition(transition: RuntimeTransition, target?: TargetNote): void {
    if (transition === 'entered_waiting') {
      this.pausePlaybackClock();
      this.scrubPlayer?.pause(this.runtime.current_tick);
      this.waitingStartMs = performance.now();
      this.latestFrames = [];
      this.feedbackText = 'Waiting...';
      this.feedbackUntilMs = performance.now() + 500;
      return;
    }

    if (transition === 'validated_hit' && target) {
      const resumeSeconds = this.tempoMap?.tickToSeconds(this.runtime.current_tick) ?? 0;
      this.startPlaybackClock(resumeSeconds);
      this.scrubPlayer?.resume(this.runtime.current_tick);
      const deltaMs = this.waitingStartMs === null ? 0 : performance.now() - this.waitingStartMs;
      const rated = rateHit(deltaMs);
      this.scoreEvents.push({ targetId: target.id, rating: rated.rating, deltaMs, points: rated.points });
      this.waitingStartMs = null;
      this.latestFrames = [];
      this.feedbackText = `${rated.rating} +${rated.points}`;
      this.feedbackUntilMs = performance.now() + 700;
      return;
    }

    if (transition === 'timeout_miss' && target) {
      const resumeSeconds = this.tempoMap?.tickToSeconds(this.runtime.current_tick) ?? 0;
      this.startPlaybackClock(resumeSeconds);
      this.scrubPlayer?.resume(this.runtime.current_tick);
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
    this.debugButton?.disableInteractive().setVisible(false);
    this.debugButtonLabel?.setVisible(false);

    this.runtimeTimer?.remove(false);
    this.runtimeTimer = undefined;

    this.scrubPlayer?.stop();
    this.detector?.stop();

    const summary = summarizeScores(this.scoreEvents);
    const { width, height } = this.scale;
    const panelWidth = Math.min(620, width * 0.82);
    const panelHeight = Math.min(380, height * 0.72);

    const panel = this.add.rectangle(width / 2, height / 2, panelWidth, panelHeight, 0x020617, 0.94)
      .setStrokeStyle(2, 0x475569);
    const title = this.add.text(width / 2, height * 0.26, 'Session Complete', {
      color: '#f8fafc',
      fontSize: `${Math.max(24, Math.floor(width * 0.035))}px`
    }).setOrigin(0.5);
    const summaryText = this.add.text(width / 2, height * 0.34, formatSummary(summary), {
      color: '#e2e8f0',
      align: 'left',
      fontSize: `${Math.max(16, Math.floor(width * 0.02))}px`
    }).setOrigin(0.5, 0);
    const hint = this.add.text(width / 2, height * 0.73, 'Tap or press Enter to return', {
      color: '#93c5fd',
      fontSize: `${Math.max(15, Math.floor(width * 0.017))}px`
    }).setOrigin(0.5);

    this.resultsOverlay = this.add.container(0, 0, [panel, title, summaryText, hint]);

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
      this.scrubPlayer?.pause(this.runtime.current_tick);
    }
    this.latestFrames = [];

    const { width, height } = this.scale;
    const panelWidth = Math.min(420, width * 0.84);
    const panelHeight = Math.min(300, height * 0.58);
    const centerX = width / 2;
    const centerY = height / 2;

    const backdrop = this.add
      .rectangle(centerX, centerY, width, height, 0x000000, 0.55)
      .setInteractive({ useHandCursor: false });

    const panel = this.add.rectangle(centerX, centerY, panelWidth, panelHeight, 0x020617, 0.96).setStrokeStyle(2, 0x64748b);
    const title = this.add
      .text(centerX, centerY - panelHeight * 0.33, 'Pause Menu', {
        color: '#f8fafc',
        fontSize: `${Math.max(22, Math.floor(width * 0.03))}px`
      })
      .setOrigin(0.5);

    const resetButtonY = centerY - panelHeight * 0.04;
    const backButtonY = centerY + panelHeight * 0.22;

    const resetButton = this.add
      .rectangle(centerX, resetButtonY, panelWidth * 0.72, 54, 0x1d4ed8, 1)
      .setStrokeStyle(1, 0x93c5fd)
      .setInteractive({ useHandCursor: true });
    const resetLabel = this.add
      .text(centerX, resetButtonY, 'Reset', {
        color: '#f8fafc',
        fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
      })
      .setOrigin(0.5);

    const backButton = this.add
      .rectangle(centerX, backButtonY, panelWidth * 0.72, 54, 0x334155, 1)
      .setStrokeStyle(1, 0x94a3b8)
      .setInteractive({ useHandCursor: true });
    const backLabel = this.add
      .text(centerX, backButtonY, 'Back to Start', {
        color: '#f8fafc',
        fontSize: `${Math.max(18, Math.floor(width * 0.022))}px`
      })
      .setOrigin(0.5);

    resetButton.on('pointerdown', () => this.resetSession());
    backButton.on('pointerdown', () => this.goBackToStart());

    this.pauseOverlay = this.add.container(0, 0, [backdrop, panel, title, resetButton, resetLabel, backButton, backLabel]);
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
      this.startPlaybackClock(this.tempoMap?.tickToSeconds(this.runtime.current_tick) ?? this.pausedSongSeconds);
      this.scrubPlayer?.resume(this.runtime.current_tick);
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
    this.laneLayer.fillStyle(0x020409, 1);
    this.laneLayer.fillRect(0, 0, width, height);

    this.laneLayer.fillStyle(0x060b14, 1);
    this.laneLayer.fillRect(0, 0, width, layout.top - 8);
    this.laneLayer.fillStyle(0x0f1624, 1);
    this.laneLayer.fillRect(0, layout.top - 8, width, height - (layout.top - 8));

    this.laneLayer.fillStyle(0xcbd5e1, 0.2);
    for (let i = 0; i < 65; i += 1) {
      const x = ((i * 137) % width) + (i % 3) * 0.35;
      const y = (i * 97) % Math.max(40, Math.floor(layout.top - 14));
      const r = i % 11 === 0 ? 2 : 1;
      this.laneLayer.fillCircle(x, y, r);
    }

    const fretTopY = layout.top + 6;
    const fretBottomY = layout.bottom + 28;
    const fretTopLeft = layout.left + 44;
    const fretTopRight = layout.right - 44;
    const fretBottomLeft = layout.left - 18;
    const fretBottomRight = layout.right + 18;

    this.laneLayer.fillStyle(0x2b2b2b, 1);
    this.laneLayer.beginPath();
    this.laneLayer.moveTo(fretTopLeft, fretTopY);
    this.laneLayer.lineTo(fretTopRight, fretTopY);
    this.laneLayer.lineTo(fretBottomRight, fretBottomY);
    this.laneLayer.lineTo(fretBottomLeft, fretBottomY);
    this.laneLayer.closePath();
    this.laneLayer.fillPath();

    this.laneLayer.lineStyle(1.2, 0x6b7280, 0.85);
    for (let i = 0; i < 16; i += 1) {
      const t = i / 15;
      const xTop = Phaser.Math.Linear(fretTopLeft, fretTopRight, t);
      const xBottom = Phaser.Math.Linear(fretBottomLeft, fretBottomRight, t);
      this.laneLayer.beginPath();
      this.laneLayer.moveTo(xTop, fretTopY);
      this.laneLayer.lineTo(xBottom, fretBottomY);
      this.laneLayer.strokePath();
    }

    this.laneLayer.lineStyle(2, 0xe5e7eb, 0.95);
    for (let i = 0; i < 6; i += 1) {
      const y = layout.top + i * layout.laneSpacing + 10;
      this.laneLayer.beginPath();
      this.laneLayer.moveTo(layout.left - 8, y);
      this.laneLayer.lineTo(layout.right + 8, y);
      this.laneLayer.strokePath();
    }

    this.laneLayer.lineStyle(2.6, 0xffffff, 1);
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

    if (this.runtime.state === PlayState.WaitingForHit && this.audioCtx) {
      this.consumeDebugHit();
    }
  }

  private consumeDebugHit(): void {
    if (!this.audioCtx) return;
    const update = updateRuntimeState(this.runtime, this.targets, this.audioCtx.currentTime, true, {
      gatingTimeoutSeconds: this.profile.gating_timeout_seconds ?? this.fallbackTimeoutSeconds
    });
    this.runtime = update.state;
    this.handleTransition(update.transition, update.target);
    this.redrawTargetsAndBall();
    this.updateHud();
    if (update.transition === 'finished') {
      this.finishSong();
    }
  }

  private redrawTargetsAndBall(): void {
    if (!this.targetLayer || !this.ball) return;

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
    if (this.runtime.state !== PlayState.WaitingForHit && this.runtime.state !== PlayState.Finished) {
      const beatTick = ((this.runtime.current_tick % this.ticksPerQuarter) + this.ticksPerQuarter) % this.ticksPerQuarter;
      const beatPhase = beatTick / this.ticksPerQuarter;
      const amplitude = Math.max(14, layout.laneSpacing * 0.7);
      this.ball.y = layout.ballBaseY - Math.sin(beatPhase * Math.PI) * amplitude;
    }
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
      noteHeight: Math.max(14, laneSpacing * 0.38),
      ballBaseY: top - Math.max(18, height * 0.04)
    };
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
    this.debugButton?.destroy();
    this.debugButton = undefined;
    this.debugButtonLabel?.destroy();
    this.debugButtonLabel = undefined;

    this.clearFretLabels();

    this.runtimeTimer?.remove(false);
    this.runtimeTimer = undefined;

    this.scrubPlayer?.stop();
    this.scrubPlayer = undefined;

    this.debugSynth?.stopAll();
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
