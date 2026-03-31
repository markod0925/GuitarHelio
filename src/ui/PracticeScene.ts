import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import type { PitchFrame } from '../types/models';
import { PitchStabilityFilter } from '../audio/pitchStabilityFilter';
import { createMicNode } from '../audio/micInput';
import { PitchDetectorService, type PitchDetectorPreset } from '../audio/pitchDetector';
import { buildPracticeSpectralRuntimeModel } from '../audio/spectralRuntimeModel';
import { midiForStringFret } from '../guitar/tuning';
import { disableAndroidKeepScreenOn, enableAndroidKeepScreenOn } from '../platform/nativeKeepScreenOn';
import { releaseMicStream } from './AudioController';
import { resolvePracticeCellVisual, resolvePracticeStringBandAlpha } from './practiceHighlighting';
import { RoundedBox } from './RoundedBox';
import {
  describeMicFailure,
  midiToNoteName,
  truncateLabel
} from './song-select/utils/songSelectUtils';
import { DEFAULT_AUDIO_INPUT_MODE, type AudioInputMode } from '../types/audioInputMode';
import {
  createPracticePipelineSessionDefault,
  formatPracticePipelineLabel,
  resolvePracticePipelineAvailability,
  resolvePracticePipelineSwitch,
  type PracticePipeline
} from './practicePipeline';

type FretCell = {
  midi: number;
  string: number;
  node: Phaser.GameObjects.Arc;
};

type DetectorState = {
  lockedMidi: number | null;
  rawMidi: number | null;
  confidence: number;
  lockedString: number | null;
  rawString: number | null;
};

type PipelineToggleOption = {
  pipeline: PracticePipeline;
  background: RoundedBox;
  label: Phaser.GameObjects.Text;
};

const MIN_CONFIDENCE = 0.62;
const MAX_FRET = 12;
const MIN_METRONOME_BPM = 40;
const MAX_METRONOME_BPM = 220;
const DEFAULT_METRONOME_BPM = 90;
const PRACTICE_MIN_MIC_RMS = 0.0032;
const PRACTICE_MIN_MIC_RMS_LOCKED = PRACTICE_MIN_MIC_RMS * 0.72;
const PRACTICE_MIN_ONSET_FOR_ACQUIRE = 0.015;

export class PracticeScene extends Phaser.Scene {
  private audioCtx?: AudioContext;
  private micStream?: MediaStream;
  private detector?: PitchDetectorService;
  private offPitch?: () => void;
  private active = false;

  private readonly cellsByMidi = new Map<number, FretCell[]>();
  private readonly stringBands = new Map<number, Phaser.GameObjects.Rectangle>();
  private highlightedMidi: number | null = null;
  private highlightedString: number | null = null;
  private readonly detectorState: DetectorState = createDetectorState();
  private readonly pitchFilter = new PitchStabilityFilter({
    minConfidence: MIN_CONFIDENCE,
    smoothingAlpha: 0.24,
    maxOutlierDeltaSemitones: 2.6,
    switchHysteresisSemitones: 0.72,
    switchConfirmFrames: 4,
    maxMissedFrames: 6,
    emitLockedMidiOnMissedFrames: false
  });

  private toggleButton?: RoundedBox;
  private toggleLabel?: Phaser.GameObjects.Text;
  private statusLabel?: Phaser.GameObjects.Text;
  private micStatusMessage = 'Mic inactive.';
  private audioInputMode: AudioInputMode = DEFAULT_AUDIO_INPUT_MODE;
  private pipelineToggleEnabled = false;
  private practicePipeline: PracticePipeline = createPracticePipelineSessionDefault();
  private pipelineToggleOptions: PipelineToggleOption[] = [];

  private metronomeTrack?: Phaser.GameObjects.Rectangle;
  private metronomeKnob?: Phaser.GameObjects.Arc;
  private metronomeBpmLabel?: Phaser.GameObjects.Text;
  private metronomeButton?: RoundedBox;
  private metronomeButtonLabel?: Phaser.GameObjects.Text;
  private metronomeBpm = DEFAULT_METRONOME_BPM;
  private metronomeRunning = false;
  private metronomeTimer?: Phaser.Time.TimerEvent;
  private metronomeAudioCtx?: AudioContext;
  private activeMetronomePointerId: number | null = null;
  private isShuttingDown = false;
  private nativeBackButtonListener?: { remove: () => Promise<void> };

  constructor() {
    super('PracticeScene');
  }

  create(data?: { audioInputMode?: AudioInputMode }): void {
    this.isShuttingDown = false;
    this.audioInputMode = data?.audioInputMode ?? DEFAULT_AUDIO_INPUT_MODE;
    this.pipelineToggleEnabled = shouldEnablePracticePipelineToggle();
    this.practicePipeline = createPracticePipelineSessionDefault();
    this.pipelineToggleOptions = [];
    void enableAndroidKeepScreenOn();
    const { width, height } = this.scale;
    this.cellsByMidi.clear();
    this.stringBands.clear();
    this.highlightedMidi = null;
    this.highlightedString = null;
    this.drawBackdrop(width, height);
    this.drawFretboard(width, height);

    const title = this.add
      .text(width / 2, Math.max(28, height * 0.06), 'Practice Scene', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(24, Math.floor(width * 0.03))}px`
      })
      .setOrigin(0.5);

    this.createMetronomeControls(width, title.y);

    const topControlsY = title.y + 9;
    const backButton = new RoundedBox(this, width - 86, topControlsY, 140, 42, 0x1e293b, 0.96)
      .setStrokeStyle(2, 0x64748b, 0.84)
      .setInteractive({ useHandCursor: true });
    const backLabel = this.add
      .text(backButton.x, backButton.y, 'Back to Start', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, Math.floor(width * 0.013))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const toggleButtonX = width - backButton.x;
    this.toggleButton = new RoundedBox(this, toggleButtonX, topControlsY, 140, 42, 0x2563eb, 1)
      .setStrokeStyle(2, 0x93c5fd, 0.86)
      .setInteractive({ useHandCursor: true });
    this.toggleLabel = this.add
      .text(this.toggleButton.x, this.toggleButton.y, 'Start Mic', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, Math.floor(width * 0.013))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    if (this.pipelineToggleEnabled) {
      this.createPipelineToggleControls(width, title.y + 136);
    }

    this.statusLabel = this.add
      .text(width / 2, height - 26, 'Mic inactive.', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.0125))}px`
      })
      .setOrigin(0.5);

    const onBack = (): void => {
      void this.leaveToStart();
    };
    backButton.on('pointerdown', onBack);
    backLabel.on('pointerdown', onBack);

    const onToggleMic = (): void => {
      if (this.active) {
        void this.stopListening();
      } else {
        void this.startListening();
      }
    };
    this.toggleButton.on('pointerdown', onToggleMic);
    this.toggleLabel.on('pointerdown', onToggleMic);

    const onEsc = (): void => {
      void this.leaveToStart();
    };
    this.input.keyboard?.on('keydown-ESC', onEsc);
    this.bindNativeBackHandler();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.isShuttingDown = true;
      this.input.keyboard?.off('keydown-ESC', onEsc);
      this.input.off('pointerup', this.handleMetronomePointerRelease, this);
      this.input.off('pointerupoutside', this.handleMetronomePointerRelease, this);
      if (this.nativeBackButtonListener) {
        void this.nativeBackButtonListener.remove();
        this.nativeBackButtonListener = undefined;
      }
      void disableAndroidKeepScreenOn();
      void this.stopMetronome(true);
      void this.stopListening();
    });

    this.updateCellHighlights();
    this.updateToggleVisual();
    this.refreshPipelineToggleVisuals();
    this.refreshMetronomeVisuals();
    this.updateStatusLabel();
    void this.startListening();
  }

  private createMetronomeControls(width: number, titleY: number): void {
    const panelWidth = Math.min(520, width * 0.68);
    const panelHeight = 56;
    const panelX = width / 2;
    const panelY = titleY + 86;
    const sidePadding = 12;
    const buttonWidth = Math.min(172, Math.max(132, panelWidth * 0.33));
    const buttonHeight = 36;
    const bpmLabelWidth = Math.max(78, Math.floor(panelWidth * 0.17));
    const trackWidth = Math.max(110, panelWidth - sidePadding * 2 - bpmLabelWidth - buttonWidth - 18);

    new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x0b1228, 0.9).setStrokeStyle(1, 0x334155, 0.86);
    this.metronomeBpmLabel = this.add
      .text(panelX - panelWidth / 2 + sidePadding, panelY, `BPM ${this.metronomeBpm}`, {
        color: '#f8fafc',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(width * 0.0125))}px`
      })
      .setOrigin(0, 0.5);

    const trackCenterX = panelX - panelWidth / 2 + sidePadding + bpmLabelWidth + trackWidth / 2;
    this.metronomeTrack = this.add
      .rectangle(trackCenterX, panelY, trackWidth, 8, 0x334155, 0.95)
      .setStrokeStyle(1, 0x64748b, 0.86)
      .setInteractive({ useHandCursor: true });
    this.metronomeTrack.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.activeMetronomePointerId = pointer.id;
      this.applyMetronomeBpmFromSliderX(pointer.x);
    });

    this.metronomeKnob = this.add
      .circle(trackCenterX, panelY, Math.max(7, Math.floor(panelHeight * 0.23)), 0xf8fafc, 1)
      .setStrokeStyle(2, 0x38bdf8, 1)
      .setInteractive({ useHandCursor: true, draggable: true });
    this.input.setDraggable(this.metronomeKnob);
    this.metronomeKnob.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.activeMetronomePointerId = pointer.id;
      this.applyMetronomeBpmFromSliderX(pointer.x);
    });
    this.metronomeKnob.on('drag', (pointer: Phaser.Input.Pointer, dragX: number) => {
      if (this.activeMetronomePointerId !== null && pointer.id !== this.activeMetronomePointerId) return;
      this.applyMetronomeBpmFromSliderX(dragX);
    });
    this.input.on('pointerup', this.handleMetronomePointerRelease, this);
    this.input.on('pointerupoutside', this.handleMetronomePointerRelease, this);

    this.metronomeButton = new RoundedBox(
      this,
      panelX + panelWidth / 2 - sidePadding - buttonWidth / 2,
      panelY,
      buttonWidth,
      buttonHeight,
      0x2563eb,
      1
    )
      .setStrokeStyle(2, 0x93c5fd, 0.86)
      .setInteractive({ useHandCursor: true });
    this.metronomeButtonLabel = this.add
      .text(this.metronomeButton.x, this.metronomeButton.y, 'Start Metronome', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(width * 0.0125))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const onToggleMetronome = (): void => {
      if (this.metronomeRunning) {
        void this.stopMetronome();
      } else {
        void this.startMetronome();
      }
    };
    this.metronomeButton.on('pointerdown', onToggleMetronome);
    this.metronomeButtonLabel.on('pointerdown', onToggleMetronome);
  }

  private createPipelineToggleControls(width: number, centerY: number): void {
    const panelWidth = Math.min(320, width * 0.42);
    const panelHeight = 40;
    const panelX = width / 2;
    const gap = 8;
    const buttonWidth = (panelWidth - gap - 10) / 2;

    new RoundedBox(this, panelX, centerY, panelWidth, panelHeight, 0x0b1228, 0.88).setStrokeStyle(1, 0x334155, 0.86);
    const left = panelX - panelWidth / 2 + 5 + buttonWidth / 2;
    const options: Array<{ pipeline: PracticePipeline; label: string }> = [
      { pipeline: 'current', label: 'Current' },
      { pipeline: 'fretnet', label: 'FretNet' }
    ];

    this.pipelineToggleOptions = options.map((option, index) => {
      const x = left + index * (buttonWidth + gap);
      const background = new RoundedBox(this, x, centerY, buttonWidth, panelHeight - 10, 0x1a2a53, 0.74)
        .setStrokeStyle(1, 0x334155, 0.56)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, centerY, option.label, {
          color: '#94a3b8',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(11, Math.floor(width * 0.0115))}px`
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      const onSelectPipeline = (): void => {
        void this.switchPracticePipeline(option.pipeline);
      };
      background.on('pointerdown', onSelectPipeline);
      label.on('pointerdown', onSelectPipeline);
      return { pipeline: option.pipeline, background, label };
    });
  }

  private drawBackdrop(width: number, height: number): void {
    const g = this.add.graphics();
    g.fillGradientStyle(0x060d24, 0x0a1a42, 0x030916, 0x071734, 1, 1, 1, 1);
    g.fillRect(0, 0, width, height);

    g.lineStyle(1, 0x93c5fd, 0.12);
    for (let i = 0; i < 10; i += 1) {
      const y = (i / 9) * height;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.strokePath();
    }
  }

  private drawFretboard(width: number, height: number): void {
    const left = width * 0.085;
    const right = width * 0.95;
    const top = height * 0.42;
    const bottom = height * 0.84;
    const fretCount = MAX_FRET + 1;
    const stringCount = 6;
    const fretSpacing = (right - left) / Math.max(1, fretCount - 1);
    const stringSpacing = (bottom - top) / Math.max(1, stringCount - 1);
    const fretLabelY = top - 24;
    const cellRadius = Math.max(6, Math.floor(width * 0.007));

    const fretGraphics = this.add.graphics();
    for (let fret = 0; fret <= MAX_FRET; fret += 1) {
      const x = left + fret * fretSpacing;
      const alpha = fret === 0 ? 0.85 : fret % 2 === 0 ? 0.32 : 0.18;
      const widthPx = fret === 0 ? 4 : 2;
      fretGraphics.lineStyle(widthPx, fret === 0 ? 0xf8fafc : 0x94a3b8, alpha);
      fretGraphics.beginPath();
      fretGraphics.moveTo(x, top - 10);
      fretGraphics.lineTo(x, bottom + 10);
      fretGraphics.strokePath();

      this.add
        .text(x, fretLabelY, `${fret}`, {
          color: fret === 0 ? '#f8fafc' : '#94a3b8',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(11, Math.floor(width * 0.0115))}px`
        })
        .setOrigin(0.5);
    }

    for (let stringNumber = 1; stringNumber <= stringCount; stringNumber += 1) {
      const y = top + (stringNumber - 1) * stringSpacing;
      const isBassString = stringNumber >= 4;
      const lineWidth = isBassString ? 2.5 + (stringNumber - 4) * 0.4 : 1.8;
      const lineColor = isBassString ? 0xfbbf24 : 0x93c5fd;
      const stringGraphics = this.add.graphics();
      stringGraphics.lineStyle(lineWidth, lineColor, 0.62);
      stringGraphics.beginPath();
      stringGraphics.moveTo(left, y);
      stringGraphics.lineTo(right, y);
      stringGraphics.strokePath();

      const stringBand = this.add
        .rectangle((left + right) / 2, y, right - left, Math.max(12, stringSpacing * 0.65), 0xfacc15, 0)
        .setDepth(10);
      this.stringBands.set(stringNumber, stringBand);

      const openMidi = midiForStringFret(stringNumber, 0);
      this.add
        .text(left - 10, y, `S${stringNumber} ${midiToNoteName(openMidi)}`, {
          color: '#cbd5e1',
          fontFamily: 'Montserrat, sans-serif',
          fontSize: `${Math.max(12, Math.floor(width * 0.0125))}px`
        })
        .setOrigin(1, 0.5);

      for (let fret = 0; fret <= MAX_FRET; fret += 1) {
        const x = left + fret * fretSpacing;
        const midi = midiForStringFret(stringNumber, fret);
        const node = this.add.circle(x, y, cellRadius, 0x64748b, 0.36).setStrokeStyle(1, 0x475569, 0.86).setDepth(20);
        const cell: FretCell = { midi, string: stringNumber, node };
        const list = this.cellsByMidi.get(midi);
        if (list) {
          list.push(cell);
        } else {
          this.cellsByMidi.set(midi, [cell]);
        }
      }
    }
  }

  private async leaveToStart(): Promise<void> {
    await this.stopMetronome(true);
    await this.stopListening();
    await disableAndroidKeepScreenOn();
    if (this.scene.isActive()) {
      this.scene.start('SongSelectScene');
    }
  }

  private bindNativeBackHandler(): void {
    if (!Capacitor.isNativePlatform()) return;
    if (this.nativeBackButtonListener) {
      void this.nativeBackButtonListener.remove();
      this.nativeBackButtonListener = undefined;
    }
    void import('@capacitor/app')
      .then(async ({ App }) => {
        const backListener = await App.addListener('backButton', () => {
          if (!this.scene.isActive()) return;
          void this.leaveToStart();
        });
        this.nativeBackButtonListener = backListener;
      })
      .catch((error) => {
        console.warn('Failed to register native back handler in PracticeScene', error);
      });
  }

  private async startListening(): Promise<void> {
    if (this.active) return;
    const availability = resolvePracticePipelineAvailability(this.practicePipeline);
    const detectorPreset = this.resolvePracticeDetectorPreset();
    if (!availability.available || detectorPreset === null) {
      this.active = false;
      this.resetPitchState();
      this.updateToggleVisual();
      this.micStatusMessage = availability.reason ?? 'Selected pipeline unavailable.';
      this.updateStatusLabel();
      return;
    }
    try {
      this.micStatusMessage = 'Requesting microphone and loading detector...';
      this.updateStatusLabel();
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      if (ctx.state !== 'running') {
        await ctx.resume();
      }

      const detector = new PitchDetectorService(ctx, {
        roundMidi: false,
        smoothingAlpha: 0,
        audioInputMode: this.audioInputMode,
        enableDspCore: true,
        detectorPreset,
        spectralModel: buildPracticeSpectralRuntimeModel(MAX_FRET)
      });
      await detector.init();
      this.detector = detector;

      let micSource: Awaited<ReturnType<typeof createMicNode>> | null = null;
      if (!detector.isUsingNativePitchInput()) {
        micSource = await createMicNode(ctx, {
          echoCancellation: this.audioInputMode === 'speaker',
          noiseSuppression: this.audioInputMode === 'speaker',
          autoGainControl: this.audioInputMode === 'speaker',
          channelCount: 1
        });
        this.micStream = micSource.mediaStream;
      } else {
        this.micStream = undefined;
      }

      this.offPitch = detector.onPitch((frame) => this.handlePitchFrame(frame));
      await detector.start(micSource ?? undefined);

      this.resetPitchState();
      this.active = true;
      this.updateToggleVisual();
      const calibrationBadge =
        detectorPreset === 'spectral_game_runtime_unified_v3' || detectorPreset === 'fretnet'
        ? 'Calibration bypassed (spectral raw)'
        : 'Calibration bypassed';
      const fallbackReason = detector.getLegacyFallbackReason();
      const fallbackBadge = detector.isLegacyFallback()
        ? fallbackReason
          ? ` • legacy fallback (${truncateLabel(fallbackReason, 26)})`
          : ' • legacy fallback'
        : '';
      this.micStatusMessage = `Mic active • ${calibrationBadge}${fallbackBadge}`;
      this.updateStatusLabel();
    } catch (error) {
      console.error('Failed to start practice microphone', error);
      const reason = describeMicFailure(error);
      await this.stopListening();
      this.micStatusMessage = reason ? `Mic unavailable (${truncateLabel(reason, 36)})` : 'Mic unavailable';
      this.updateStatusLabel();
    }
  }

  private async stopListening(): Promise<void> {
    this.detector?.stop();
    this.detector = undefined;
    this.offPitch?.();
    this.offPitch = undefined;

    releaseMicStream(this.micStream);
    this.micStream = undefined;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        await this.audioCtx.close();
      } catch {
        // ignore close failures during scene shutdown
      }
    }
    this.audioCtx = undefined;
    this.active = false;
    this.resetPitchState();
    this.updateToggleVisual();
    this.micStatusMessage = 'Mic inactive.';
    this.updateStatusLabel();
  }

  private async switchPracticePipeline(nextPipeline: PracticePipeline): Promise<void> {
    if (!this.pipelineToggleEnabled) return;
    const transition = resolvePracticePipelineSwitch({
      currentPipeline: this.practicePipeline,
      nextPipeline,
      micActive: this.active
    });
    if (transition.isNoop) return;

    this.practicePipeline = transition.nextPipeline;
    this.refreshPipelineToggleVisuals();
    const pipelineLabel = formatPracticePipelineLabel(this.practicePipeline);
    if (!transition.requiresMicRestart) {
      this.micStatusMessage = 'Mic inactive.';
      this.updateStatusLabel();
      return;
    }

    this.micStatusMessage = `Switching pipeline to ${pipelineLabel}...`;
    this.updateStatusLabel();
    await this.stopListening();
    this.micStatusMessage = `Switching pipeline to ${pipelineLabel}...`;
    this.updateStatusLabel();
    await this.startListening();
  }

  private resolvePracticeDetectorPreset(): PitchDetectorPreset | null {
    if (this.practicePipeline === 'current') return 'spectral_game_runtime_unified_v3';
    return 'fretnet';
  }

  private handlePitchFrame(frame: PitchFrame): void {
    const gatedFrame = this.applyPracticeFrameGate(frame);
    this.detectorState.rawMidi = gatedFrame.midi_estimate;
    this.detectorState.confidence = gatedFrame.confidence;
    this.detectorState.rawString = normalizeDetectedString(gatedFrame.detected_string);

    const stabilized = this.pitchFilter.update(gatedFrame);
    this.detectorState.lockedMidi =
      stabilized.midi_estimate !== null && Number.isFinite(stabilized.midi_estimate)
        ? Math.round(stabilized.midi_estimate)
        : null;
    this.detectorState.lockedString = normalizeDetectedString(stabilized.detected_string);

    if (this.detectorState.lockedMidi === null) {
      this.detectorState.lockedString = null;
    }

    this.updateCellHighlights();
  }

  private applyPracticeFrameGate(frame: PitchFrame): PitchFrame {
    if (this.isPracticeFrameActive(frame)) {
      return frame;
    }
    return {
      ...frame,
      midi_estimate: null,
      confidence: 0,
      detected_string: null,
      detected_fret: null,
      best_note_id: null
    };
  }

  private isPracticeFrameActive(frame: PitchFrame): boolean {
    const micRms = frame.mic_rms;
    if (micRms !== undefined && Number.isFinite(micRms)) {
      const minRms = this.detectorState.lockedMidi === null
        ? PRACTICE_MIN_MIC_RMS
        : PRACTICE_MIN_MIC_RMS_LOCKED;
      if (micRms < minRms) {
        return false;
      }
    }

    if (this.detectorState.lockedMidi !== null) {
      return true;
    }

    const onsetStrength = frame.onset_strength;
    if (onsetStrength !== undefined && Number.isFinite(onsetStrength) && onsetStrength < PRACTICE_MIN_ONSET_FOR_ACQUIRE) {
      return false;
    }

    return true;
  }

  private updateCellHighlights(): void {
    const nextMidi = this.detectorState.lockedMidi;
    const nextString = this.detectorState.lockedString;
    if (this.highlightedMidi === nextMidi && this.highlightedString === nextString) {
      return;
    }

    const touched = new Set<number>();
    if (this.highlightedMidi !== null) touched.add(this.highlightedMidi);
    if (nextMidi !== null) touched.add(nextMidi);

    this.highlightedMidi = nextMidi;
    this.highlightedString = nextString;

    touched.forEach((midi) => this.applyMidiHighlightStyle(midi));
    this.updateStringBandHighlights();
  }

  private applyMidiHighlightStyle(midi: number): void {
    const cells = this.cellsByMidi.get(midi) ?? [];
    if (cells.length === 0) return;

    cells.forEach((cell) => {
      if (!isGameObjectAlive(cell.node)) return;
      const visual = resolvePracticeCellVisual(
        cell.midi,
        cell.string,
        this.highlightedMidi,
        this.highlightedString
      );
      cell.node.setFillStyle(visual.fillColor, visual.fillAlpha);
      cell.node.setStrokeStyle(1, visual.strokeColor, visual.strokeAlpha);
    });
  }

  private updateStringBandHighlights(): void {
    for (const [stringNumber, band] of this.stringBands.entries()) {
      if (!isGameObjectAlive(band)) continue;
      band.setFillStyle(0xfacc15, resolvePracticeStringBandAlpha(stringNumber, this.highlightedString));
    }
  }

  private resetPitchState(): void {
    this.pitchFilter.reset();
    resetDetectorState(this.detectorState);
    this.updateCellHighlights();
  }

  private handleMetronomePointerRelease(pointer: Phaser.Input.Pointer): void {
    if (this.activeMetronomePointerId === null) return;
    if (pointer.id !== this.activeMetronomePointerId) return;
    this.activeMetronomePointerId = null;
  }

  private applyMetronomeBpmFromSliderX(pointerX: number): void {
    if (!this.metronomeTrack) return;
    const left = this.metronomeTrack.x - this.metronomeTrack.displayWidth / 2;
    const ratio = Phaser.Math.Clamp((pointerX - left) / this.metronomeTrack.displayWidth, 0, 1);
    const bpm = Math.round(MIN_METRONOME_BPM + ratio * (MAX_METRONOME_BPM - MIN_METRONOME_BPM));
    if (bpm === this.metronomeBpm) {
      this.refreshMetronomeVisuals();
      return;
    }
    this.metronomeBpm = bpm;
    this.refreshMetronomeVisuals();
    this.updateStatusLabel();
    if (this.metronomeRunning) {
      this.restartMetronomeTimer();
    }
  }

  private refreshMetronomeVisuals(): void {
    if (this.isShuttingDown) return;
    const metronomeTrack = this.metronomeTrack;
    const metronomeKnob = this.metronomeKnob;
    const metronomeButton = this.metronomeButton;
    const metronomeButtonLabel = this.metronomeButtonLabel;
    const metronomeBpmLabel = this.metronomeBpmLabel;
    if (!isGameObjectAlive(metronomeTrack) || !isGameObjectAlive(metronomeKnob)) return;

    const left = metronomeTrack.x - metronomeTrack.displayWidth / 2;
    const ratio = (this.metronomeBpm - MIN_METRONOME_BPM) / (MAX_METRONOME_BPM - MIN_METRONOME_BPM);
    metronomeKnob.setPosition(left + ratio * metronomeTrack.displayWidth, metronomeTrack.y);
    if (isGameObjectAlive(metronomeBpmLabel)) {
      metronomeBpmLabel.setText(`BPM ${this.metronomeBpm}`);
    }
    if (!isGameObjectAlive(metronomeButton) || !isGameObjectAlive(metronomeButtonLabel)) return;
    metronomeButton.setFillStyle(this.metronomeRunning ? 0x7f1d1d : 0x2563eb, 1);
    metronomeButton.setStrokeStyle(2, this.metronomeRunning ? 0xfca5a5 : 0x93c5fd, 0.86);
    metronomeButtonLabel.setText(this.metronomeRunning ? 'Stop Metronome' : 'Start Metronome');
    metronomeButtonLabel.setColor(this.metronomeRunning ? '#ffe4e6' : '#eff6ff');
  }

  private async startMetronome(): Promise<void> {
    if (this.metronomeRunning) return;
    try {
      const ctx = await this.ensureMetronomeAudioContext();
      if (ctx.state !== 'running') {
        await ctx.resume();
      }
      this.metronomeRunning = true;
      this.restartMetronomeTimer();
      this.playMetronomeClick();
    } catch (error) {
      console.error('Failed to start metronome', error);
    } finally {
      this.refreshMetronomeVisuals();
      this.updateStatusLabel();
    }
  }

  private async stopMetronome(closeAudioContext = false): Promise<void> {
    this.metronomeTimer?.remove(false);
    this.metronomeTimer = undefined;
    this.activeMetronomePointerId = null;
    this.metronomeRunning = false;
    if (closeAudioContext && this.metronomeAudioCtx && this.metronomeAudioCtx.state !== 'closed') {
      try {
        await this.metronomeAudioCtx.close();
      } catch {
        // ignore close failures during scene shutdown
      }
      this.metronomeAudioCtx = undefined;
    }
    this.refreshMetronomeVisuals();
    this.updateStatusLabel();
  }

  private restartMetronomeTimer(): void {
    this.metronomeTimer?.remove(false);
    this.metronomeTimer = undefined;
    if (!this.metronomeRunning) return;
    const delayMs = Math.max(40, Math.round(60000 / this.metronomeBpm));
    this.metronomeTimer = this.time.addEvent({
      delay: delayMs,
      loop: true,
      callback: () => this.playMetronomeClick()
    });
  }

  private async ensureMetronomeAudioContext(): Promise<AudioContext> {
    if (!this.metronomeAudioCtx || this.metronomeAudioCtx.state === 'closed') {
      this.metronomeAudioCtx = new AudioContext();
    }
    return this.metronomeAudioCtx;
  }

  private playMetronomeClick(): void {
    const ctx = this.metronomeAudioCtx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1460, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  private updateStatusLabel(): void {
    if (this.isShuttingDown) return;
    if (!isGameObjectAlive(this.statusLabel)) return;
    const pipelineBadge = `Pipeline ${formatPracticePipelineLabel(this.practicePipeline)}`;
    const metronomeStatus = this.metronomeRunning ? ` • Metronome ON (${this.metronomeBpm} BPM)` : '';
    const midiBadge = this.detectorState.lockedMidi !== null ? ` • ${midiToNoteName(this.detectorState.lockedMidi)}` : '';
    const stringBadge = this.detectorState.lockedString !== null ? ` S${this.detectorState.lockedString}` : '';
    this.statusLabel.setText(`${pipelineBadge} • ${this.micStatusMessage}${metronomeStatus}${midiBadge}${stringBadge}`);
  }

  private updateToggleVisual(): void {
    if (this.isShuttingDown) return;
    if (!isGameObjectAlive(this.toggleButton) || !isGameObjectAlive(this.toggleLabel)) return;
    this.toggleButton.setFillStyle(this.active ? 0x7f1d1d : 0x2563eb, 1);
    this.toggleButton.setStrokeStyle(2, this.active ? 0xfca5a5 : 0x93c5fd, 0.86);
    this.toggleLabel.setText(this.active ? 'Stop Mic' : 'Start Mic');
    this.toggleLabel.setColor(this.active ? '#ffe4e6' : '#eff6ff');
  }

  private refreshPipelineToggleVisuals(): void {
    if (this.isShuttingDown) return;
    for (const option of this.pipelineToggleOptions) {
      if (!isGameObjectAlive(option.background) || !isGameObjectAlive(option.label)) continue;
      const active = option.pipeline === this.practicePipeline;
      option.background.setFillStyle(active ? 0x2563eb : 0x1a2a53, active ? 1 : 0.74);
      option.background.setStrokeStyle(1, active ? 0x93c5fd : 0x334155, active ? 0.86 : 0.56);
      option.label.setColor(active ? '#eff6ff' : '#94a3b8');
    }
  }
}

function createDetectorState(): DetectorState {
  return {
    lockedMidi: null,
    rawMidi: null,
    confidence: 0,
    lockedString: null,
    rawString: null
  };
}

function resetDetectorState(state: DetectorState): void {
  state.lockedMidi = null;
  state.rawMidi = null;
  state.confidence = 0;
  state.lockedString = null;
  state.rawString = null;
}

function isGameObjectAlive<T extends Phaser.GameObjects.GameObject>(value: T | undefined): value is T {
  return Boolean(value && value.scene && value.active);
}

function normalizeDetectedString(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 6) return null;
  return rounded;
}

function shouldEnablePracticePipelineToggle(): boolean {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() === 'android';
  }
  return !isElectronRuntime();
}

function isElectronRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /electron/i.test(navigator.userAgent);
}
