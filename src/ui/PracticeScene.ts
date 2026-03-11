import Phaser from 'phaser';
import type { PitchFrame } from '../types/models';
import { AubioPitchDetectorService } from '../audio/aubioPitchDetector';
import { PitchStabilityFilter } from '../audio/pitchStabilityFilter';
import { createMicNode } from '../audio/micInput';
import { loadPitchCalibrationProfile } from '../audio/pitchCalibration';
import { PitchDetectorService } from '../audio/pitchDetector';
import { midiForStringFret } from '../guitar/tuning';
import { releaseMicStream } from './AudioController';
import { RoundedBox } from './RoundedBox';
import {
  describeMicFailure,
  midiToNoteName,
  truncateLabel
} from './song-select/utils/songSelectUtils';

type FretCell = {
  midi: number;
  node: Phaser.GameObjects.Arc;
};

type DetectorState = {
  lockedMidi: number | null;
  rawMidi: number | null;
  confidence: number;
};

const MIN_CONFIDENCE = 0.62;
const MAX_FRET = 12;
const MIN_METRONOME_BPM = 40;
const MAX_METRONOME_BPM = 220;
const DEFAULT_METRONOME_BPM = 90;

export class PracticeScene extends Phaser.Scene {
  private audioCtx?: AudioContext;
  private micStream?: MediaStream;
  private customDetector?: PitchDetectorService;
  private aubioDetector?: AubioPitchDetectorService;
  private offCustomPitch?: () => void;
  private offAubioPitch?: () => void;
  private aubioAvailable = false;
  private active = false;

  private readonly cellsByMidi = new Map<number, FretCell[]>();
  private customHighlightedMidi: number | null = null;
  private aubioHighlightedMidi: number | null = null;
  private readonly customState: DetectorState = createDetectorState();
  private readonly aubioState: DetectorState = createDetectorState();
  private readonly customPitchFilter = new PitchStabilityFilter({
    minConfidence: MIN_CONFIDENCE,
    smoothingAlpha: 0.24,
    maxOutlierDeltaSemitones: 2.6,
    switchHysteresisSemitones: 0.72,
    switchConfirmFrames: 4,
    maxMissedFrames: 4,
    emitLockedMidiOnMissedFrames: true
  });
  private readonly aubioPitchFilter = new PitchStabilityFilter({
    minConfidence: MIN_CONFIDENCE,
    smoothingAlpha: 0.16,
    maxOutlierDeltaSemitones: 3.2,
    switchHysteresisSemitones: 0.64,
    switchConfirmFrames: 3,
    maxMissedFrames: 4,
    emitLockedMidiOnMissedFrames: true
  });

  private toggleButton?: RoundedBox;
  private toggleLabel?: Phaser.GameObjects.Text;
  private customDetectedLabel?: Phaser.GameObjects.Text;
  private aubioDetectedLabel?: Phaser.GameObjects.Text;
  private customDetailsLabel?: Phaser.GameObjects.Text;
  private aubioDetailsLabel?: Phaser.GameObjects.Text;
  private compareLabel?: Phaser.GameObjects.Text;
  private statusLabel?: Phaser.GameObjects.Text;
  private micStatusMessage = 'Mic inactive.';

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

  constructor() {
    super('PracticeScene');
  }

  create(): void {
    const { width, height } = this.scale;
    this.cellsByMidi.clear();
    this.customHighlightedMidi = null;
    this.aubioHighlightedMidi = null;
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

    this.add
      .text(width / 2, title.y + 28, 'A/B live compare: A=custom, B=aubio(yinfft).', {
        color: '#93c5fd',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(13, Math.floor(width * 0.013))}px`
      })
      .setOrigin(0.5);
    this.add
      .text(width / 2, title.y + 48, 'Green=A  •  Amber=B  •  Lime=A+B', {
        color: '#bfdbfe',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.012))}px`
      })
      .setOrigin(0.5);

    this.createMetronomeControls(width, title.y);

    const backButton = new RoundedBox(this, width - 86, title.y + 4, 140, 42, 0x1e293b, 0.96)
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

    this.toggleButton = new RoundedBox(this, 120, title.y + 4, 160, 44, 0x2563eb, 1)
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

    this.customDetectedLabel = this.add
      .text(width / 2, height * 0.24, 'A Custom: --', {
        color: '#86efac',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(15, Math.floor(width * 0.017))}px`
      })
      .setOrigin(0.5);
    this.customDetailsLabel = this.add
      .text(width / 2, height * 0.27, 'A raw: --  •  A conf: --', {
        color: '#94a3b8',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.013))}px`
      })
      .setOrigin(0.5);
    this.aubioDetectedLabel = this.add
      .text(width / 2, height * 0.3, 'B Aubio: --', {
        color: '#fbbf24',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(15, Math.floor(width * 0.017))}px`
      })
      .setOrigin(0.5);
    this.aubioDetailsLabel = this.add
      .text(width / 2, height * 0.33, 'B raw: --  •  B conf: --', {
        color: '#94a3b8',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.013))}px`
      })
      .setOrigin(0.5);
    this.compareLabel = this.add
      .text(width / 2, height * 0.36, 'A/B delta: --', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, Math.floor(width * 0.014))}px`
      })
      .setOrigin(0.5);
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

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-ESC', onEsc);
      this.input.off('pointerup', this.handleMetronomePointerRelease, this);
      this.input.off('pointerupoutside', this.handleMetronomePointerRelease, this);
      void this.stopMetronome(true);
      void this.stopListening();
    });

    this.updateDetectorLabels();
    this.updateCellHighlights();
    this.updateToggleVisual();
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
      .text(this.metronomeButton.x, this.metronomeButton.y, 'Avvio Metronomo', {
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
        const node = this.add.circle(x, y, cellRadius, 0x64748b, 0.36).setStrokeStyle(1, 0x475569, 0.86);
        const cell: FretCell = { midi, node };
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
    if (this.scene.isActive()) {
      this.scene.start('SongSelectScene');
    }
  }

  private async startListening(): Promise<void> {
    if (this.active) return;
    try {
      this.micStatusMessage = 'Requesting microphone and loading detectors...';
      this.updateStatusLabel();
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      if (ctx.state !== 'running') {
        await ctx.resume();
      }

      const micSource = await createMicNode(ctx, {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      });
      this.micStream = micSource.mediaStream;

      const calibrationProfile = loadPitchCalibrationProfile();
      const customDetector = new PitchDetectorService(ctx, {
        roundMidi: false,
        smoothingAlpha: 0,
        calibrationProfile: calibrationProfile ?? undefined
      });
      await customDetector.init();
      this.customDetector = customDetector;
      this.offCustomPitch = customDetector.onPitch((frame) => this.handlePitchFrame(this.customState, frame, true));
      customDetector.start(micSource);

      this.aubioAvailable = false;
      try {
        const aubioDetector = new AubioPitchDetectorService(ctx, {
          method: 'yinfft',
          calibrationProfile: calibrationProfile ?? undefined
        });
        await aubioDetector.init();
        this.aubioDetector = aubioDetector;
        this.offAubioPitch = aubioDetector.onPitch((frame) => this.handlePitchFrame(this.aubioState, frame, false));
        aubioDetector.start(micSource);
        this.aubioAvailable = true;
      } catch (error) {
        console.warn('Aubio detector unavailable in practice scene', error);
        this.aubioDetector = undefined;
        this.offAubioPitch = undefined;
        this.aubioAvailable = false;
      }

      this.resetPitchState();
      this.active = true;
      this.updateToggleVisual();
      const calibrationBadge = calibrationProfile ? 'Calibration ON' : 'Calibration OFF';
      this.micStatusMessage =
        this.aubioAvailable
          ? `Mic active • A/B compare running • ${calibrationBadge}`
          : `Mic active • A only (aubio unavailable) • ${calibrationBadge}`;
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
    this.customDetector?.stop();
    this.customDetector = undefined;
    this.offCustomPitch?.();
    this.offCustomPitch = undefined;

    this.aubioDetector?.stop();
    this.aubioDetector = undefined;
    this.offAubioPitch?.();
    this.offAubioPitch = undefined;
    this.aubioAvailable = false;

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
    this.updateDetectorLabels();
    this.micStatusMessage = 'Mic inactive.';
    this.updateStatusLabel();
  }

  private handlePitchFrame(state: DetectorState, frame: PitchFrame, isCustomDetector: boolean): void {
    state.rawMidi = frame.midi_estimate;
    state.confidence = frame.confidence;
    const stabilized = isCustomDetector
      ? this.customPitchFilter.update(frame)
      : this.aubioPitchFilter.update(frame);
    state.lockedMidi =
      stabilized.midi_estimate !== null && Number.isFinite(stabilized.midi_estimate)
        ? Math.round(stabilized.midi_estimate)
        : null;
    this.updateCellHighlights();
    this.updateDetectorLabels();
  }

  private updateCellHighlights(): void {
    const nextCustom = this.customState.lockedMidi;
    const nextAubio = this.aubioState.lockedMidi;
    if (this.customHighlightedMidi === nextCustom && this.aubioHighlightedMidi === nextAubio) {
      return;
    }

    const touched = new Set<number>();
    if (this.customHighlightedMidi !== null) touched.add(this.customHighlightedMidi);
    if (this.aubioHighlightedMidi !== null) touched.add(this.aubioHighlightedMidi);
    if (nextCustom !== null) touched.add(nextCustom);
    if (nextAubio !== null) touched.add(nextAubio);

    this.customHighlightedMidi = nextCustom;
    this.aubioHighlightedMidi = nextAubio;

    touched.forEach((midi) => this.applyMidiHighlightStyle(midi));
  }

  private applyMidiHighlightStyle(midi: number): void {
    const cells = this.cellsByMidi.get(midi) ?? [];
    if (cells.length === 0) return;

    const customMatch = this.customHighlightedMidi === midi;
    const aubioMatch = this.aubioHighlightedMidi === midi;

    let fillColor = 0x64748b;
    let fillAlpha = 0.36;
    let strokeColor = 0x475569;
    let strokeAlpha = 0.86;

    if (customMatch && aubioMatch) {
      fillColor = 0x84cc16;
      fillAlpha = 0.98;
      strokeColor = 0xd9f99d;
      strokeAlpha = 0.98;
    } else if (customMatch) {
      fillColor = 0x22c55e;
      fillAlpha = 0.94;
      strokeColor = 0xbbf7d0;
      strokeAlpha = 0.95;
    } else if (aubioMatch) {
      fillColor = 0xf59e0b;
      fillAlpha = 0.94;
      strokeColor = 0xfef3c7;
      strokeAlpha = 0.95;
    }

    cells.forEach((cell) => {
      if (customMatch || aubioMatch) {
        cell.node.setFillStyle(fillColor, fillAlpha);
        cell.node.setStrokeStyle(1, strokeColor, strokeAlpha);
        return;
      }
      cell.node.setFillStyle(0x64748b, 0.36);
      cell.node.setStrokeStyle(1, 0x475569, 0.86);
    });
  }

  private resetPitchState(): void {
    this.customPitchFilter.reset();
    this.aubioPitchFilter.reset();
    resetDetectorState(this.customState);
    resetDetectorState(this.aubioState);
    this.updateCellHighlights();
    this.updateDetectorLabels();
  }

  private updateDetectorLabels(): void {
    const customStable = formatStableMidi(this.customState.lockedMidi);
    const aubioStable = this.aubioAvailable
      ? formatStableMidi(this.aubioState.lockedMidi)
      : 'unavailable';

    this.customDetectedLabel?.setText(`A Custom: ${customStable}`);
    this.aubioDetectedLabel?.setText(`B Aubio: ${aubioStable}`);
    this.customDetailsLabel?.setText(
      `A raw: ${formatRawMidi(this.customState.rawMidi)}  •  A conf: ${formatConfidence(this.customState.confidence)}`
    );
    this.aubioDetailsLabel?.setText(
      `B raw: ${formatRawMidi(this.aubioState.rawMidi)}  •  B conf: ${formatConfidence(this.aubioState.confidence)}`
    );

    if (!this.aubioAvailable) {
      this.compareLabel?.setText('A/B delta: aubio unavailable');
      this.compareLabel?.setColor('#fca5a5');
      return;
    }

    const customMidi = this.customState.lockedMidi;
    const aubioMidi = this.aubioState.lockedMidi;
    if (customMidi === null || aubioMidi === null) {
      this.compareLabel?.setText('A/B delta: waiting...');
      this.compareLabel?.setColor('#cbd5e1');
      return;
    }

    const delta = customMidi - aubioMidi;
    if (delta === 0) {
      this.compareLabel?.setText('A/B delta: 0 semitones (match)');
      this.compareLabel?.setColor('#86efac');
      return;
    }

    const sign = delta > 0 ? '+' : '';
    this.compareLabel?.setText(`A/B delta: ${sign}${delta} semitones`);
    this.compareLabel?.setColor('#fda4af');
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
    if (!this.metronomeTrack || !this.metronomeKnob) return;
    const left = this.metronomeTrack.x - this.metronomeTrack.displayWidth / 2;
    const ratio = (this.metronomeBpm - MIN_METRONOME_BPM) / (MAX_METRONOME_BPM - MIN_METRONOME_BPM);
    this.metronomeKnob.setPosition(left + ratio * this.metronomeTrack.displayWidth, this.metronomeTrack.y);
    this.metronomeBpmLabel?.setText(`BPM ${this.metronomeBpm}`);
    if (!this.metronomeButton || !this.metronomeButtonLabel) return;
    this.metronomeButton.setFillStyle(this.metronomeRunning ? 0x7f1d1d : 0x2563eb, 1);
    this.metronomeButton.setStrokeStyle(2, this.metronomeRunning ? 0xfca5a5 : 0x93c5fd, 0.86);
    this.metronomeButtonLabel.setText(this.metronomeRunning ? 'Stop Metronomo' : 'Avvio Metronomo');
    this.metronomeButtonLabel.setColor(this.metronomeRunning ? '#ffe4e6' : '#eff6ff');
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
    if (!this.statusLabel) return;
    const metronomeStatus = this.metronomeRunning ? ` • Metronome ON (${this.metronomeBpm} BPM)` : '';
    this.statusLabel.setText(`${this.micStatusMessage}${metronomeStatus}`);
  }

  private updateToggleVisual(): void {
    if (!this.toggleButton || !this.toggleLabel) return;
    this.toggleButton.setFillStyle(this.active ? 0x7f1d1d : 0x2563eb, 1);
    this.toggleButton.setStrokeStyle(2, this.active ? 0xfca5a5 : 0x93c5fd, 0.86);
    this.toggleLabel.setText(this.active ? 'Stop Mic' : 'Start Mic');
    this.toggleLabel.setColor(this.active ? '#ffe4e6' : '#eff6ff');
  }
}

function createDetectorState(): DetectorState {
  return {
    lockedMidi: null,
    rawMidi: null,
    confidence: 0
  };
}

function resetDetectorState(state: DetectorState): void {
  state.lockedMidi = null;
  state.rawMidi = null;
  state.confidence = 0;
}

function formatStableMidi(midi: number | null): string {
  if (midi === null || !Number.isFinite(midi)) return '--';
  return `${midiToNoteName(midi)} (${midi})`;
}

function formatRawMidi(midi: number | null): string {
  if (midi === null || !Number.isFinite(midi)) return '--';
  return midi.toFixed(2);
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return '--';
  return confidence.toFixed(2);
}
