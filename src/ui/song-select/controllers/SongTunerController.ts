import Phaser from 'phaser';
import { createMicNode } from '../../../audio/micInput';
import {
  buildPitchCalibrationProfile,
  clearPitchCalibrationProfile,
  DEFAULT_PITCH_CALIBRATION_REFERENCE_MIDI,
  estimatePitchCalibrationMeasurement,
  loadPitchCalibrationProfile,
  savePitchCalibrationProfile,
  type PitchCalibrationMeasurement,
  type PitchCalibrationProfile
} from '../../../audio/pitchCalibration';
import { PitchDetectorService } from '../../../audio/pitchDetector';
import { TunerPitchStabilizer } from '../../../audio/tunerPitchStabilizer';
import { STANDARD_TUNING } from '../../../guitar/tuning';
import { releaseMicStream } from '../../AudioController';
import { RoundedBox } from '../../RoundedBox';
import {
  TUNER_AUTO_ADVANCE_HOLD_SECONDS,
  TUNER_IN_TUNE_CENTS,
  TUNER_SEQUENCE
} from '../constants';
import type { ToggleOption, TunerPanel } from '../types';
import {
  describeMicFailure,
  midiToHz,
  midiToNoteName,
  toErrorMessage,
  truncateLabel,
  waitMs
} from '../utils/songSelectUtils';

export type SongTunerSnapshot = {
  targetString: number;
  active: boolean;
  open: boolean;
  calibrating: boolean;
  tunedCount: number;
  tunedTotal: number;
  calibrationPoints: number;
};

export class SongTunerController {
  private panel?: TunerPanel;
  private targetString = 6;
  private active = false;
  private audioCtx?: AudioContext;
  private micStream?: MediaStream;
  private detector?: PitchDetectorService;
  private offPitch?: () => void;
  private open = false;
  private readonly pitchStabilizer = new TunerPitchStabilizer();
  private calibrating = false;
  private readonly tunedStrings = new Set<number>();
  private inTuneStreakStartSeconds: number | null = null;
  private pitchCalibrationProfile: PitchCalibrationProfile | null = loadPitchCalibrationProfile();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onStateChanged: () => void
  ) {}

  initialize(width: number, height: number, labelSize: number): void {
    this.panel = this.createOverlay(width, height, labelSize);
    this.bindPanelEvents();
    this.refresh();
  }

  getSnapshot(): SongTunerSnapshot {
    return {
      targetString: this.targetString,
      active: this.active,
      open: this.open,
      calibrating: this.calibrating,
      tunedCount: this.tunedStrings.size,
      tunedTotal: TUNER_SEQUENCE.length,
      calibrationPoints: this.pitchCalibrationProfile?.points.length ?? 0
    };
  }

  isOpen(): boolean {
    return this.open;
  }

  isCalibrating(): boolean {
    return this.calibrating;
  }

  openOverlay(): void {
    if (!this.panel) return;
    this.open = true;
    this.panel.container.setVisible(true);
    this.refresh();
    this.requestRefresh();
  }

  closeOverlay(): void {
    if (this.calibrating) return;
    if (!this.panel) return;
    this.open = false;
    this.panel.container.setVisible(false);
    void this.stop(false).then(() => this.requestRefresh());
    this.refresh();
    this.requestRefresh();
  }

  handleAppInactive(): void {
    void this.stop(false).then(() => this.requestRefresh());
  }

  refresh(): void {
    const panel = this.panel;
    if (!panel) return;

    const tunerBusy = this.calibrating;
    const targetMidi = STANDARD_TUNING[this.targetString];
    panel.targetLabel.setText(`Target: String ${this.targetString} • ${midiToNoteName(targetMidi)}`);
    panel.startButton.setFillStyle(tunerBusy ? 0x334155 : this.active ? 0x7f1d1d : 0x2563eb, 1);
    panel.startButton.setStrokeStyle(2, tunerBusy ? 0x94a3b8 : this.active ? 0xfca5a5 : 0x93c5fd, 0.8);
    panel.startLabel.setText(tunerBusy ? 'Tuner Locked' : this.active ? 'Stop Tuner' : 'Start Tuner');
    panel.startLabel.setColor(tunerBusy ? '#cbd5e1' : this.active ? '#ffe4e6' : '#eff6ff');

    panel.calibrateButton.setFillStyle(tunerBusy ? 0x7c2d12 : 0x0f766e, 1);
    panel.calibrateButton.setStrokeStyle(2, tunerBusy ? 0xfdba74 : 0x5eead4, 0.82);
    panel.calibrateLabel.setText(tunerBusy ? 'Calibrating...' : 'Calibrate');
    panel.calibrateLabel.setColor(tunerBusy ? '#ffedd5' : '#ecfeff');

    const hasCalibration = Boolean(this.pitchCalibrationProfile);
    panel.resetCalibrationButton.setFillStyle(hasCalibration ? 0x7f1d1d : 0x334155, 1);
    panel.resetCalibrationButton.setStrokeStyle(2, hasCalibration ? 0xfca5a5 : 0x64748b, 0.8);
    panel.resetCalibrationLabel.setColor(hasCalibration ? '#ffe4e6' : '#cbd5e1');
    panel.resetCalibrationButton.setAlpha(hasCalibration ? 1 : 0.75);
    panel.resetCalibrationLabel.setAlpha(hasCalibration ? 1 : 0.75);
    panel.calibrationStatus.setText(
      tunerBusy
        ? 'Calibration in progress... keep the phone still.'
        : this.pitchCalibrationProfile
          ? `Calibration active • ${this.pitchCalibrationProfile.points.length} points`
          : 'Calibration inactive'
    );
    panel.calibrationStatus.setColor(tunerBusy ? '#fde68a' : this.pitchCalibrationProfile ? '#86efac' : '#94a3b8');

    panel.stringToggles.forEach((option) => {
      const active = option.value === this.targetString;
      const tuned = this.tunedStrings.has(option.value);
      if (tuned) {
        option.background.setFillStyle(active ? 0x15803d : 0x166534, active ? 0.94 : 0.82);
        option.background.setStrokeStyle(2, active ? 0xbbf7d0 : 0x86efac, active ? 0.9 : 0.78);
        option.label.setColor('#ecfdf5');
      } else {
        option.background.setFillStyle(active ? 0x2563eb : 0x1a2a53, active ? 0.92 : 0.68);
        option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155, active ? 0.75 : 0.45);
        option.label.setColor(active ? '#ffffff' : '#cbd5e1');
      }
      option.background.setAlpha(tunerBusy ? 0.65 : 1);
      option.label.setAlpha(tunerBusy ? 0.65 : 1);
    });
  }

  async stop(clearDetectedText: boolean): Promise<void> {
    this.detector?.stop();
    this.detector = undefined;
    this.inTuneStreakStartSeconds = null;
    this.pitchStabilizer.reset();
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

    if (this.panel) {
      if (clearDetectedText) this.panel.detectedLabel.setText('Detected: --');
      this.setNeedleFromCents(null);
    }
    this.refresh();
  }

  destroy(): void {
    void this.stop(false);
    this.open = false;
    this.panel?.container.destroy(true);
    this.panel = undefined;
  }

  private bindPanelEvents(): void {
    const panel = this.panel;
    if (!panel) return;

    const toggleTunerState = (): void => {
      if (this.calibrating) return;
      if (this.active) {
        void this.stop(true).then(() => this.requestRefresh());
      } else {
        void this.start().then(() => this.requestRefresh());
      }
      this.refresh();
      this.requestRefresh();
    };
    const calibrateTuner = (): void => {
      if (this.calibrating) return;
      void this.runCalibration()
        .then(() => this.requestRefresh())
        .catch(() => this.requestRefresh());
      this.refresh();
      this.requestRefresh();
    };
    const resetTunerCalibration = (): void => {
      if (this.calibrating) return;
      if (!this.pitchCalibrationProfile) return;
      clearPitchCalibrationProfile();
      this.pitchCalibrationProfile = null;
      this.panel?.detectedLabel.setText('Detected: calibration reset');
      this.setNeedleFromCents(null);
      if (this.active) {
        void this.stop(false).then(() => this.requestRefresh());
      }
      this.refresh();
      this.requestRefresh();
    };

    panel.startButton.on('pointerdown', toggleTunerState);
    panel.startLabel.on('pointerdown', toggleTunerState);
    panel.calibrateButton.on('pointerdown', calibrateTuner);
    panel.calibrateLabel.on('pointerdown', calibrateTuner);
    panel.resetCalibrationButton.on('pointerdown', resetTunerCalibration);
    panel.resetCalibrationLabel.on('pointerdown', resetTunerCalibration);
    panel.closeButton.on('pointerdown', () => this.closeOverlay());
    panel.closeLabel.on('pointerdown', () => this.closeOverlay());
    panel.backdrop.on('pointerdown', () => this.closeOverlay());
    panel.panel.on('pointerdown', () => undefined);

    panel.stringToggles.forEach((option) => {
      const selectTunerString = (): void => {
        if (this.calibrating) return;
        this.targetString = option.value;
        this.pitchStabilizer.reset();
        this.inTuneStreakStartSeconds = null;
        if (this.active) {
          this.panel?.detectedLabel.setText('Detected: listening...');
          this.setNeedleFromCents(null);
        }
        this.refresh();
        this.requestRefresh();
      };
      option.background.on('pointerdown', selectTunerString);
      option.label.on('pointerdown', selectTunerString);
    });
  }

  private createOverlay(width: number, height: number, labelSize: number): TunerPanel {
    const backdrop = new RoundedBox(this.scene, width / 2, height / 2, width, height, 0x020617, 0.82, 0)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(560, width * 0.72);
    const panelHeight = Math.min(340, height * 0.56);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = new RoundedBox(this.scene, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.96)
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: false });

    const title = this.scene.add
      .text(panelX, panelY - panelHeight * 0.4, 'Tuner', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const targetLabel = this.scene.add
      .text(panelX, panelY - panelHeight * 0.26, '', {
        color: '#bae6fd',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const stringToggles = this.createStringToggles(
      panelX - panelWidth * 0.28,
      panelY - panelHeight * 0.09,
      panelWidth * 0.113,
      Math.min(62, panelWidth * 0.1),
      36,
      labelSize - 1
    );

    const meterCenterX = panelX;
    const meterY = panelY + panelHeight * 0.08;
    const meterHalfWidth = panelWidth * 0.33;
    const meterGreenBandHalfWidth = (5 / 50) * meterHalfWidth;

    const meterBase = new RoundedBox(this.scene, meterCenterX, meterY, meterHalfWidth * 2, 12, 0x1f2937, 0.95)
      .setStrokeStyle(1, 0x60a5fa, 0.35);
    const meterGreenBand = new RoundedBox(this.scene, meterCenterX, meterY, meterGreenBandHalfWidth * 2, 16, 0x22c55e, 0.45)
      .setStrokeStyle(1, 0x86efac, 0.75);
    const meterCenter = new RoundedBox(this.scene, meterCenterX, meterY, 2, 22, 0xbfdbfe, 0.75);
    const meterNeedle = new RoundedBox(this.scene, meterCenterX, meterY, 8, 24, 0x9ca3af, 1).setStrokeStyle(1, 0x0f172a);

    const detectedLabel = this.scene.add
      .text(panelX, panelY + panelHeight * 0.22, 'Detected: --', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const calibrationStatus = this.scene.add
      .text(panelX, panelY + panelHeight * 0.3 - 5, 'Calibration inactive', {
        color: '#94a3b8',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(11, labelSize - 4)}px`
      })
      .setOrigin(0.5);

    const startButton = new RoundedBox(
      this.scene,
      panelX - panelWidth * 0.29,
      panelY + panelHeight * 0.38,
      Math.min(150, panelWidth * 0.26),
      40,
      0x2563eb,
      1
    )
      .setStrokeStyle(2, 0x93c5fd, 0.8)
      .setInteractive({ useHandCursor: true });
    const startLabel = this.scene.add
      .text(startButton.x, startButton.y, 'Start Tuner', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const calibrateButton = new RoundedBox(
      this.scene,
      panelX,
      panelY + panelHeight * 0.38,
      Math.min(160, panelWidth * 0.3),
      40,
      0x0f766e,
      1
    )
      .setStrokeStyle(2, 0x5eead4, 0.82)
      .setInteractive({ useHandCursor: true });
    const calibrateLabel = this.scene.add
      .text(calibrateButton.x, calibrateButton.y, 'Calibrate', {
        color: '#ecfeff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const resetCalibrationButton = new RoundedBox(
      this.scene,
      panelX + panelWidth * 0.28,
      panelY + panelHeight * 0.38,
      Math.min(150, panelWidth * 0.26),
      40,
      0x7f1d1d,
      1
    )
      .setStrokeStyle(2, 0xfca5a5, 0.8)
      .setInteractive({ useHandCursor: true });
    const resetCalibrationLabel = this.scene.add
      .text(resetCalibrationButton.x, resetCalibrationButton.y, 'Reset Cal', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const closeButton = new RoundedBox(
      this.scene,
      panelX + panelWidth * 0.37,
      panelY - panelHeight * 0.4,
      86,
      32,
      0x1e293b,
      1
    )
      .setStrokeStyle(2, 0x64748b, 0.85)
      .setInteractive({ useHandCursor: true });
    const closeLabel = this.scene.add
      .text(closeButton.x, closeButton.y, 'Close', {
        color: '#e2e8f0',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const allObjects: Phaser.GameObjects.GameObject[] = [
      backdrop,
      panel,
      title,
      targetLabel,
      meterBase,
      meterGreenBand,
      meterCenter,
      meterNeedle,
      detectedLabel,
      calibrationStatus,
      startButton,
      startLabel,
      calibrateButton,
      calibrateLabel,
      resetCalibrationButton,
      resetCalibrationLabel,
      closeButton,
      closeLabel,
      ...stringToggles.flatMap((toggle) => [toggle.background, toggle.label])
    ];
    const container = this.scene.add.container(0, 0, allObjects).setDepth(1150).setVisible(false);

    return {
      container,
      backdrop,
      panel,
      targetLabel,
      detectedLabel,
      calibrationStatus,
      startButton,
      startLabel,
      calibrateButton,
      calibrateLabel,
      resetCalibrationButton,
      resetCalibrationLabel,
      closeButton,
      closeLabel,
      meterNeedle,
      meterCenterX,
      meterHalfWidth,
      stringToggles
    };
  }

  private createStringToggles(
    startX: number,
    centerY: number,
    spacingX: number,
    buttonWidth: number,
    buttonHeight: number,
    labelSize: number
  ): ToggleOption[] {
    const values = [1, 2, 3, 4, 5, 6];
    const options: ToggleOption[] = [];

    values.forEach((value, index) => {
      const x = startX + index * spacingX;
      const background = new RoundedBox(this.scene, x, centerY, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.scene.add
        .text(x, centerY, `${value}`, {
          color: '#cbd5e1',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(14, labelSize - 1)}px`
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      options.push({ value, background, label });
    });

    return options;
  }

  private setNeedleFromCents(cents: number | null): void {
    if (!this.panel) return;
    const needle = this.panel.meterNeedle;
    if (cents === null || Number.isNaN(cents)) {
      needle.x = this.panel.meterCenterX;
      needle.setFillStyle(0x9ca3af, 1);
      return;
    }

    const clamped = Phaser.Math.Clamp(cents, -50, 50);
    needle.x = this.panel.meterCenterX + (clamped / 50) * this.panel.meterHalfWidth;

    const abs = Math.abs(clamped);
    const color = abs <= TUNER_IN_TUNE_CENTS ? 0x22c55e : abs <= 15 ? 0xf59e0b : 0xef4444;
    needle.setFillStyle(color, 1);
  }

  private resolveNextString(current: number): number | null {
    const currentIndex = TUNER_SEQUENCE.indexOf(current);
    if (currentIndex >= 0) {
      for (let i = currentIndex + 1; i < TUNER_SEQUENCE.length; i += 1) {
        const candidate = TUNER_SEQUENCE[i];
        if (!this.tunedStrings.has(candidate)) return candidate;
      }
    }

    for (const candidate of TUNER_SEQUENCE) {
      if (!this.tunedStrings.has(candidate)) return candidate;
    }
    return null;
  }

  private async runCalibration(): Promise<void> {
    if (this.calibrating) return;
    const panel = this.panel;
    if (!panel) return;

    this.calibrating = true;
    const wasTunerActive = this.active;
    let calibrationCtx: AudioContext | undefined;
    let calibrationMicStream: MediaStream | undefined;
    let calibrationDetector: PitchDetectorService | undefined;
    let offPitch: (() => void) | undefined;

    try {
      panel.detectedLabel.setText('Calibration: preparing...');
      panel.calibrationStatus.setText('Requesting microphone and preparing reference tones...');
      this.setNeedleFromCents(null);
      await this.stop(false);

      const ctx = new AudioContext();
      calibrationCtx = ctx;
      if (ctx.state !== 'running') {
        await ctx.resume();
      }

      const micSource = await createMicNode(ctx, {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      });
      calibrationMicStream = micSource.mediaStream;

      const detector = new PitchDetectorService(ctx, {
        roundMidi: false,
        smoothingAlpha: 0
      });
      await detector.init();
      calibrationDetector = detector;

      let collecting = false;
      let currentSamples: number[] = [];
      offPitch = detector.onPitch((frame) => {
        if (!collecting) return;
        if (frame.midi_estimate === null || frame.confidence < 0.55) return;
        currentSamples.push(frame.midi_estimate);
      });
      detector.start(micSource);

      const measurements: PitchCalibrationMeasurement[] = [];
      const points = DEFAULT_PITCH_CALIBRATION_REFERENCE_MIDI;

      for (let i = 0; i < points.length; i += 1) {
        const midi = points[i];
        panel.detectedLabel.setText(`Calibration: ${midiToNoteName(midi)} (${i + 1}/${points.length})`);
        panel.calibrationStatus.setText('Listening to reference tone...');
        this.setNeedleFromCents(null);

        currentSamples = [];
        collecting = true;
        await waitMs(120);
        await this.playCalibrationReferenceTone(ctx, midi, 1150);
        collecting = false;

        const measurement = estimatePitchCalibrationMeasurement(currentSamples, midi);
        if (measurement) {
          measurements.push(measurement);
          panel.calibrationStatus.setText(
            `${midiToNoteName(midi)}: offset ${measurement.offsetCents >= 0 ? '+' : ''}${Math.round(measurement.offsetCents)}c`
          );
        } else {
          panel.calibrationStatus.setText(`${midiToNoteName(midi)}: sample rejected`);
        }
        await waitMs(160);
      }

      const profile = buildPitchCalibrationProfile(measurements);
      if (!profile || profile.points.length < 4) {
        throw new Error('Calibration quality too low. Keep device still and retry.');
      }

      this.pitchCalibrationProfile = profile;
      savePitchCalibrationProfile(profile);
      panel.detectedLabel.setText(`Detected: calibration saved (${profile.points.length} points)`);
      panel.calibrationStatus.setText('Calibration active.');
      this.showCalibrationSummaryPopup(profile);
    } catch (error) {
      console.error('Tuner calibration failed', error);
      panel.detectedLabel.setText('Detected: calibration failed');
      panel.calibrationStatus.setText(truncateLabel(toErrorMessage(error), 64));
    } finally {
      offPitch?.();
      calibrationDetector?.stop();
      releaseMicStream(calibrationMicStream);
      if (calibrationCtx && calibrationCtx.state !== 'closed') {
        try {
          await calibrationCtx.close();
        } catch {
          // ignore close failures
        }
      }
      this.calibrating = false;
      if (wasTunerActive && this.scene.scene.isActive()) {
        await this.start();
      }
      this.refresh();
      this.requestRefresh();
    }
  }

  private showCalibrationSummaryPopup(profile: PitchCalibrationProfile): void {
    const width = this.scene.scale.width;
    const height = this.scene.scale.height;
    const panelWidth = Math.min(700, width * 0.9);
    const panelHeight = Math.min(520, height * 0.84);
    const panelX = width / 2;
    const panelY = height / 2;

    const createdAtText = new Date(profile.createdAtMs).toLocaleString();
    const avgAbsOffset =
      profile.points.reduce((sum, point) => sum + Math.abs(point.offsetCents), 0) / Math.max(1, profile.points.length);
    const avgScatter =
      profile.points.reduce((sum, point) => sum + point.scatterCents, 0) / Math.max(1, profile.points.length);
    const rows = profile.points.map((point) => {
      const note = midiToNoteName(point.midi).padEnd(3, ' ');
      const offset = `${point.offsetCents >= 0 ? '+' : ''}${Math.round(point.offsetCents)}c`.padStart(5, ' ');
      const samples = `${point.sampleCount}`.padStart(2, ' ');
      const scatter = `${Math.round(point.scatterCents)}c`.padStart(4, ' ');
      return `${note}  ${offset}  samples:${samples}  scatter:${scatter}`;
    });
    const bodyText = [
      `Created: ${createdAtText}`,
      `Points: ${profile.points.length}`,
      `Avg |offset|: ${avgAbsOffset.toFixed(1)}c`,
      `Avg scatter: ${avgScatter.toFixed(1)}c`,
      '',
      ...rows,
      '',
      'Tap anywhere to close'
    ].join('\n');

    const backdrop = new RoundedBox(this.scene, panelX, panelY, width, height, 0x020617, 0.72, 0).setDepth(1410);
    const panel = new RoundedBox(this.scene, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.98)
      .setStrokeStyle(2, 0x3b82f6, 0.55)
      .setDepth(1411);
    const title = this.scene.add
      .text(panelX, panelY - panelHeight * 0.42, 'Calibration Summary', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, Math.floor(width * 0.028))}px`
      })
      .setOrigin(0.5)
      .setDepth(1412);
    const body = this.scene.add
      .text(panelX, panelY - panelHeight * 0.34, bodyText, {
        color: '#cbd5e1',
        fontFamily: 'monospace',
        fontSize: `${Math.max(12, Math.floor(width * 0.014))}px`,
        align: 'left',
        lineSpacing: 4
      })
      .setOrigin(0.5, 0)
      .setDepth(1412);

    const close = (): void => {
      this.scene.input.off('pointerdown', onAnyPointerDown);
      backdrop.destroy();
      panel.destroy();
      title.destroy();
      body.destroy();
    };

    const onAnyPointerDown = (): void => {
      close();
    };
    this.scene.input.on('pointerdown', onAnyPointerDown);
  }

  private async playCalibrationReferenceTone(ctx: AudioContext, midi: number, durationMs: number): Promise<void> {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = midiToHz(midi);
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(ctx.destination);

    const startAt = ctx.currentTime + 0.02;
    const durationSeconds = Math.max(0.2, durationMs / 1000);
    const peak = 0.048;
    const attackEnd = startAt + 0.05;
    const releaseStart = startAt + Math.max(0.08, durationSeconds - 0.08);
    const stopAt = startAt + durationSeconds;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(peak, attackEnd);
    gain.gain.setValueAtTime(peak, releaseStart);
    gain.gain.linearRampToValueAtTime(0, stopAt);

    oscillator.start(startAt);
    oscillator.stop(stopAt + 0.02);
    await waitMs(Math.round(durationSeconds * 1000 + 110));
    oscillator.disconnect();
    gain.disconnect();
  }

  private async start(): Promise<void> {
    if (this.active || this.calibrating) return;
    const panel = this.panel;
    if (!panel) return;

    try {
      panel.detectedLabel.setText('Detected: requesting mic...');
      this.setNeedleFromCents(null);
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      if (ctx.state !== 'running') {
        await ctx.resume();
      }

      const micSource = await createMicNode(ctx);
      this.micStream = micSource.mediaStream;
      const detector = new PitchDetectorService(ctx, {
        roundMidi: false,
        calibrationProfile: this.pitchCalibrationProfile ?? undefined
      });
      await detector.init();
      this.detector = detector;
      this.tunedStrings.clear();
      this.inTuneStreakStartSeconds = null;
      this.pitchStabilizer.reset();
      this.offPitch = detector.onPitch((frame) => {
        const targetMidi = STANDARD_TUNING[this.targetString];
        const stabilized = this.pitchStabilizer.update(frame, targetMidi);
        if (!stabilized) {
          this.inTuneStreakStartSeconds = null;
          panel.detectedLabel.setText('Detected: --');
          this.setNeedleFromCents(null);
          return;
        }

        const cents = stabilized.cents;
        const inTuneZone = Math.abs(cents) <= TUNER_IN_TUNE_CENTS;
        if (inTuneZone) {
          if (this.inTuneStreakStartSeconds === null) {
            this.inTuneStreakStartSeconds = frame.t_seconds;
          }
          const heldInTuneSeconds = Math.max(0, frame.t_seconds - this.inTuneStreakStartSeconds);
          if (
            heldInTuneSeconds >= TUNER_AUTO_ADVANCE_HOLD_SECONDS &&
            !this.tunedStrings.has(this.targetString)
          ) {
            const tunedString = this.targetString;
            this.tunedStrings.add(tunedString);
            this.inTuneStreakStartSeconds = null;
            const nextString = this.resolveNextString(tunedString);
            if (nextString !== null) {
              this.targetString = nextString;
              this.pitchStabilizer.reset();
              panel.detectedLabel.setText(`Detected: String ${tunedString} tuned OK -> String ${nextString}`);
              this.setNeedleFromCents(null);
            } else {
              panel.detectedLabel.setText('Detected: all strings tuned');
              this.setNeedleFromCents(0);
            }
            this.refresh();
            this.requestRefresh();
            return;
          }
        } else {
          this.inTuneStreakStartSeconds = null;
        }

        const sign = cents >= 0 ? '+' : '';
        const detected = midiToNoteName(stabilized.detectedMidi);
        panel.detectedLabel.setText(`Detected: ${detected} (${sign}${Math.round(cents)}c)`);
        this.setNeedleFromCents(cents);
      });
      detector.start(micSource);

      this.active = true;
      panel.detectedLabel.setText('Detected: listening...');
      this.setNeedleFromCents(null);
      this.refresh();
    } catch (error) {
      console.error('Failed to start tuner', error);
      const reason = describeMicFailure(error);
      await this.stop(false);
      panel.detectedLabel.setText(
        reason ? `Mic unavailable (${truncateLabel(reason, 26)})` : 'Mic unavailable'
      );
      this.setNeedleFromCents(null);
    }
  }

  private requestRefresh(): void {
    if (!this.scene.scene.isActive()) return;
    this.onStateChanged();
  }
}
