import { Capacitor } from '@capacitor/core';
import { DIFFICULTY_PRESETS } from '../../../app/config';
import {
  loadSessionSettingsPreference,
  resetAllSongHighScores,
  saveSessionSettingsPreference
} from '../../../app/sessionPersistence';
import { DEFAULT_AUDIO_INPUT_MODE, type AudioInputMode } from '../../../types/audioInputMode';
import { RoundedBox } from '../../RoundedBox';
import type {
  AudioInputModeOption,
  Difficulty,
  SettingsOverlay,
  ToggleOption
} from '../types';
import {
  nextDifficulty,
  previousDifficulty,
  rangeInclusive,
  sanitizeSettingValues,
  sortedValues
} from '../utils/songSelectUtils';

export type SessionSettingsSnapshot = {
  open: boolean;
  difficulty: Difficulty;
  audioInputMode: AudioInputMode;
  selectedStringsCount: number;
  selectedFingersCount: number;
  selectedFretsCount: number;
  valid: boolean;
};

type SongSessionControllerOptions = {
  onStateChanged: () => void;
  onScoresReset?: () => Promise<void> | void;
};

export class SongSessionController {
  private overlay?: SettingsOverlay;
  private open = false;
  private difficulty: Difficulty = 'Medium';
  private audioInputMode: AudioInputMode = DEFAULT_AUDIO_INPUT_MODE;
  private selectedStrings = new Set<number>();
  private selectedFingers = new Set<number>();
  private selectedFrets = new Set<number>();
  private resetScoresConfirmOpen = false;
  private resetScoresInProgress = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly options: SongSessionControllerOptions
  ) {}

  initialize(width: number, height: number, labelSize: number): void {
    this.initializeDefaults();
    this.restoreSessionSettingsPreference();
    this.overlay = this.createOverlay(width, height, labelSize);
    this.bindOverlayEvents();
    this.refresh();
  }

  destroy(): void {
    this.overlay?.container.destroy(true);
    this.overlay = undefined;
  }

  isOpen(): boolean {
    return this.open;
  }

  openOverlay(): void {
    if (!this.overlay) return;
    this.open = true;
    this.closeResetScoresConfirm();
    this.overlay.container.setVisible(true);
    this.refresh();
    this.options.onStateChanged();
  }

  closeOverlay(): void {
    if (!this.overlay) return;
    this.closeResetScoresConfirm();
    this.open = false;
    this.overlay.container.setVisible(false);
    this.refresh();
    this.options.onStateChanged();
  }

  cycleDifficultyNext(): void {
    if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
    this.difficulty = nextDifficulty(this.difficulty);
    this.persistSessionSettingsPreference();
    this.refresh();
    this.options.onStateChanged();
  }

  cycleDifficultyPrevious(): void {
    if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
    this.difficulty = previousDifficulty(this.difficulty);
    this.persistSessionSettingsPreference();
    this.refresh();
    this.options.onStateChanged();
  }

  getDifficulty(): Difficulty {
    return this.difficulty;
  }

  getAudioInputMode(): AudioInputMode {
    return this.audioInputMode;
  }

  cycleAudioInputMode(): void {
    if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
    this.audioInputMode = this.audioInputMode === 'speaker' ? 'headphones' : 'speaker';
    this.persistSessionSettingsPreference();
    this.refresh();
    this.options.onStateChanged();
  }

  getAllowedStrings(): number[] {
    return sortedValues(this.selectedStrings);
  }

  getAllowedFingers(): number[] {
    return sortedValues(this.selectedFingers);
  }

  getAllowedFrets(): number[] {
    return sortedValues(this.selectedFrets);
  }

  getSnapshot(): SessionSettingsSnapshot {
    return {
      open: this.open,
      difficulty: this.difficulty,
      audioInputMode: this.audioInputMode,
      selectedStringsCount: this.selectedStrings.size,
      selectedFingersCount: this.selectedFingers.size,
      selectedFretsCount: this.selectedFrets.size,
      valid: this.isValid()
    };
  }

  isValid(): boolean {
    return this.selectedStrings.size > 0 && this.selectedFingers.size > 0 && this.selectedFrets.size > 0;
  }

  refresh(): void {
    const overlay = this.overlay;
    if (!overlay) return;

    overlay.stringToggles.forEach((option) => {
      const active = this.selectedStrings.has(option.value);
      option.background.setFillStyle(active ? 0x1d4ed8 : 0x1a2a53, active ? 0.92 : 0.68);
      option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155, active ? 0.75 : 0.45);
      option.label.setColor(active ? '#ffffff' : '#cbd5e1');
    });

    overlay.fingerToggles.forEach((option) => {
      const active = this.selectedFingers.has(option.value);
      option.background.setFillStyle(active ? 0x7c3aed : 0x1a2a53, active ? 0.92 : 0.68);
      option.background.setStrokeStyle(2, active ? 0xd8b4fe : 0x334155, active ? 0.75 : 0.45);
      option.label.setColor(active ? '#faf5ff' : '#cbd5e1');
    });

    overlay.fretToggles.forEach((option) => {
      const active = this.selectedFrets.has(option.value);
      option.background.setFillStyle(active ? 0x0ea5a4 : 0x1a2a53, active ? 0.92 : 0.68);
      option.background.setStrokeStyle(2, active ? 0x5eead4 : 0x334155, active ? 0.75 : 0.45);
      option.label.setColor(active ? '#ecfeff' : '#cbd5e1');
    });

    const valid = this.isValid();
    overlay.doneButton.setFillStyle(valid ? 0x2563eb : 0x7f1d1d, 1);
    overlay.doneButton.setStrokeStyle(2, valid ? 0x93c5fd : 0xfca5a5, 0.8);
    overlay.doneLabel.setColor(valid ? '#ecfdf5' : '#ffe4e6');

    const resetButtonDisabled = this.resetScoresInProgress;
    overlay.resetScoresButton.setFillStyle(resetButtonDisabled ? 0x334155 : 0x7f1d1d, 1);
    overlay.resetScoresButton.setStrokeStyle(2, resetButtonDisabled ? 0x64748b : 0xfda4af, 0.84);
    overlay.resetScoresButton.setAlpha(resetButtonDisabled ? 0.78 : 1);
    overlay.resetScoresLabel.setText(resetButtonDisabled ? 'Resetting...' : 'Reset Scores');
    overlay.resetScoresLabel.setColor(resetButtonDisabled ? '#cbd5e1' : '#ffe4e6');
    overlay.resetScoresLabel.setAlpha(resetButtonDisabled ? 0.84 : 1);

    const confirmVisible = this.resetScoresConfirmOpen;
    overlay.resetScoresConfirmBackdrop.setVisible(confirmVisible);
    overlay.resetScoresConfirmPanel.setVisible(confirmVisible);
    overlay.resetScoresConfirmTitle.setVisible(confirmVisible);
    overlay.resetScoresConfirmMessage.setVisible(confirmVisible);
    overlay.resetScoresConfirmCancelButton.setVisible(confirmVisible);
    overlay.resetScoresConfirmCancelLabel.setVisible(confirmVisible);
    overlay.resetScoresConfirmConfirmButton.setVisible(confirmVisible);
    overlay.resetScoresConfirmConfirmLabel.setVisible(confirmVisible);

    const confirmDisabled = this.resetScoresInProgress;
    overlay.resetScoresConfirmCancelButton.setFillStyle(confirmDisabled ? 0x334155 : 0x1e293b, 1);
    overlay.resetScoresConfirmCancelButton.setStrokeStyle(2, confirmDisabled ? 0x64748b : 0x64748b, 0.84);
    overlay.resetScoresConfirmCancelLabel.setColor(confirmDisabled ? '#94a3b8' : '#e2e8f0');
    overlay.resetScoresConfirmCancelButton.setAlpha(confirmDisabled ? 0.8 : 1);
    overlay.resetScoresConfirmCancelLabel.setAlpha(confirmDisabled ? 0.85 : 1);

    overlay.resetScoresConfirmConfirmButton.setFillStyle(confirmDisabled ? 0x334155 : 0x7f1d1d, 1);
    overlay.resetScoresConfirmConfirmButton.setStrokeStyle(2, confirmDisabled ? 0x64748b : 0xfda4af, 0.84);
    overlay.resetScoresConfirmConfirmLabel.setText(confirmDisabled ? 'Resetting...' : 'Reset');
    overlay.resetScoresConfirmConfirmLabel.setColor(confirmDisabled ? '#cbd5e1' : '#ffe4e6');
    overlay.resetScoresConfirmConfirmButton.setAlpha(confirmDisabled ? 0.8 : 1);
    overlay.resetScoresConfirmConfirmLabel.setAlpha(confirmDisabled ? 0.85 : 1);

    const speakerActive = this.audioInputMode === 'speaker';
    overlay.audioInputModeTitle.setText(`Input Mode: ${speakerActive ? 'Speaker' : 'Headphones'}`);
    overlay.audioInputModeSpeakerButton.setFillStyle(speakerActive ? 0x2563eb : 0x1a2a53, speakerActive ? 0.92 : 0.72);
    overlay.audioInputModeSpeakerButton.setStrokeStyle(2, speakerActive ? 0x93c5fd : 0x334155, speakerActive ? 0.8 : 0.5);
    overlay.audioInputModeSpeakerLabel.setColor(speakerActive ? '#eff6ff' : '#cbd5e1');
    overlay.audioInputModeHeadphonesButton.setFillStyle(!speakerActive ? 0x0f766e : 0x1a2a53, !speakerActive ? 0.92 : 0.72);
    overlay.audioInputModeHeadphonesButton.setStrokeStyle(2, !speakerActive ? 0x5eead4 : 0x334155, !speakerActive ? 0.82 : 0.5);
    overlay.audioInputModeHeadphonesLabel.setColor(!speakerActive ? '#ecfeff' : '#cbd5e1');
  }

  private initializeDefaults(): void {
    const defaultPreset = DIFFICULTY_PRESETS[this.difficulty];
    this.audioInputMode = DEFAULT_AUDIO_INPUT_MODE;
    this.selectedStrings = new Set(defaultPreset.allowed_strings);
    this.selectedFingers = new Set(defaultPreset.allowed_fingers);

    const defaultFrets =
      defaultPreset.allowed_fret_list ??
      rangeInclusive(defaultPreset.allowed_frets.min, defaultPreset.allowed_frets.max);
    this.selectedFrets = new Set(defaultFrets);
  }

  private restoreSessionSettingsPreference(): void {
    const stored = loadSessionSettingsPreference();
    if (!stored) return;

    this.difficulty = stored.difficulty;
    this.audioInputMode = stored.audioInputMode ?? DEFAULT_AUDIO_INPUT_MODE;
    this.selectedStrings = new Set(sanitizeSettingValues(stored.selectedStrings, 1, 6));
    this.selectedFingers = new Set(sanitizeSettingValues(stored.selectedFingers, 1, 4));
    this.selectedFrets = new Set(sanitizeSettingValues(stored.selectedFrets, 0, 21));
  }

  private persistSessionSettingsPreference(): void {
    saveSessionSettingsPreference({
      difficulty: this.difficulty,
      audioInputMode: this.audioInputMode,
      selectedStrings: this.getAllowedStrings(),
      selectedFingers: this.getAllowedFingers(),
      selectedFrets: this.getAllowedFrets()
    });
  }

  private openResetScoresConfirm(): void {
    if (!this.overlay || this.resetScoresInProgress) return;
    this.resetScoresConfirmOpen = true;
    this.refresh();
  }

  private closeResetScoresConfirm(): void {
    if (!this.overlay) {
      this.resetScoresConfirmOpen = false;
      return;
    }
    this.resetScoresConfirmOpen = false;
    this.refresh();
  }

  private async confirmResetBestScores(): Promise<void> {
    if (!this.overlay || this.resetScoresInProgress) return;
    this.resetScoresInProgress = true;
    this.refresh();
    try {
      resetAllSongHighScores();
      if (Capacitor.isNativePlatform()) {
        await import('../../../platform/nativeSongLibrary')
          .then(({ resetAllNativeSongHighScores }) => resetAllNativeSongHighScores())
          .catch((error) => {
            console.warn('Failed to reset native song high scores', error);
          });
      }
      await this.options.onScoresReset?.();
      this.closeResetScoresConfirm();
      this.options.onStateChanged();
    } finally {
      this.resetScoresInProgress = false;
      this.refresh();
    }
  }

  private bindOverlayEvents(): void {
    const overlay = this.overlay;
    if (!overlay) return;

    overlay.doneButton.on('pointerdown', () => {
      if (this.resetScoresInProgress) return;
      if (this.resetScoresConfirmOpen) {
        this.closeResetScoresConfirm();
        return;
      }
      this.closeOverlay();
    });
    overlay.doneLabel.on('pointerdown', () => {
      if (this.resetScoresInProgress) return;
      if (this.resetScoresConfirmOpen) {
        this.closeResetScoresConfirm();
        return;
      }
      this.closeOverlay();
    });
    overlay.backdrop.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        if (this.resetScoresInProgress) return;
        if (this.resetScoresConfirmOpen) {
          this.closeResetScoresConfirm();
          return;
        }
        this.closeOverlay();
      }
    );
    overlay.panel.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
      }
    );

    overlay.resetScoresButton.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        if (this.resetScoresInProgress || this.resetScoresConfirmOpen) return;
        this.openResetScoresConfirm();
      }
    );
    overlay.resetScoresLabel.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        if (this.resetScoresInProgress || this.resetScoresConfirmOpen) return;
        this.openResetScoresConfirm();
      }
    );
    overlay.resetScoresConfirmBackdrop.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        if (this.resetScoresInProgress) return;
        this.closeResetScoresConfirm();
      }
    );
    overlay.resetScoresConfirmPanel.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
      }
    );
    overlay.resetScoresConfirmCancelButton.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        if (this.resetScoresInProgress) return;
        this.closeResetScoresConfirm();
      }
    );
    overlay.resetScoresConfirmCancelLabel.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        if (this.resetScoresInProgress) return;
        this.closeResetScoresConfirm();
      }
    );
    overlay.resetScoresConfirmConfirmButton.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        void this.confirmResetBestScores();
      }
    );
    overlay.resetScoresConfirmConfirmLabel.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        void this.confirmResetBestScores();
      }
    );

    const audioInputModeOptions: AudioInputModeOption[] = [
      {
        mode: 'speaker',
        background: overlay.audioInputModeSpeakerButton,
        label: overlay.audioInputModeSpeakerLabel
      },
      {
        mode: 'headphones',
        background: overlay.audioInputModeHeadphonesButton,
        label: overlay.audioInputModeHeadphonesLabel
      }
    ];
    audioInputModeOptions.forEach((option) => {
      const setAudioInputMode = (): void => {
        if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
        this.audioInputMode = option.mode;
        this.persistSessionSettingsPreference();
        this.refresh();
        this.options.onStateChanged();
      };
      option.background.on('pointerdown', setAudioInputMode);
      option.label.on('pointerdown', setAudioInputMode);
    });

    overlay.stringToggles.forEach((option) => {
      const toggleString = (): void => {
        if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
        if (this.selectedStrings.has(option.value)) {
          this.selectedStrings.delete(option.value);
        } else {
          this.selectedStrings.add(option.value);
        }
        this.persistSessionSettingsPreference();
        this.refresh();
        this.options.onStateChanged();
      };
      option.background.on('pointerdown', toggleString);
      option.label.on('pointerdown', toggleString);
    });

    overlay.fingerToggles.forEach((option) => {
      const toggleFinger = (): void => {
        if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
        if (this.selectedFingers.has(option.value)) {
          this.selectedFingers.delete(option.value);
        } else {
          this.selectedFingers.add(option.value);
        }
        this.persistSessionSettingsPreference();
        this.refresh();
        this.options.onStateChanged();
      };
      option.background.on('pointerdown', toggleFinger);
      option.label.on('pointerdown', toggleFinger);
    });

    overlay.fretToggles.forEach((option) => {
      const toggleFret = (): void => {
        if (this.resetScoresConfirmOpen || this.resetScoresInProgress) return;
        if (this.selectedFrets.has(option.value)) {
          this.selectedFrets.delete(option.value);
        } else {
          this.selectedFrets.add(option.value);
        }
        this.persistSessionSettingsPreference();
        this.refresh();
        this.options.onStateChanged();
      };
      option.background.on('pointerdown', toggleFret);
      option.label.on('pointerdown', toggleFret);
    });
  }

  private createOverlay(width: number, height: number, labelSize: number): SettingsOverlay {
    const backdrop = new RoundedBox(this.scene, width / 2, height / 2, width, height, 0x020617, 0.82, 0)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(980, width * 0.9);
    const panelHeight = Math.min(520, height * 0.82);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = new RoundedBox(this.scene, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.96)
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: false });

    const title = this.scene.add
      .text(panelX, panelY - panelHeight * 0.41, 'Session Settings', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 6)}px`
      })
      .setOrigin(0.5);
    const resetScoresButton = new RoundedBox(
      this.scene,
      panelX + panelWidth * 0.33 + 25,
      panelY - panelHeight * 0.41 - 10,
      Math.min(212, panelWidth * 0.24),
      40,
      0x7f1d1d,
      1
    )
      .setStrokeStyle(2, 0xfda4af, 0.84)
      .setInteractive({ useHandCursor: true });
    const resetScoresLabel = this.scene.add
      .text(resetScoresButton.x, resetScoresButton.y, 'Reset Scores', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const audioInputModeTitleY = panelY - panelHeight * 0.31;
    const audioInputModeTitle = this.scene.add
      .text(panelX + panelWidth * 0.07, audioInputModeTitleY, 'Input Mode: Speaker', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(13, labelSize - 1)}px`
      })
      .setOrigin(0.5, 0.5);
    const audioInputModeSpeakerButton = new RoundedBox(
      this.scene,
      panelX + panelWidth * 0.23,
      audioInputModeTitleY + 34,
      Math.min(150, panelWidth * 0.17),
      34,
      0x2563eb,
      0.9
    )
      .setStrokeStyle(2, 0x93c5fd, 0.8)
      .setInteractive({ useHandCursor: true });
    const audioInputModeSpeakerLabel = this.scene.add
      .text(audioInputModeSpeakerButton.x, audioInputModeSpeakerButton.y, 'Speaker', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const audioInputModeHeadphonesButton = new RoundedBox(
      this.scene,
      panelX + panelWidth * 0.41,
      audioInputModeTitleY + 34,
      Math.min(170, panelWidth * 0.2),
      34,
      0x1a2a53,
      0.72
    )
      .setStrokeStyle(2, 0x334155, 0.5)
      .setInteractive({ useHandCursor: true });
    const audioInputModeHeadphonesLabel = this.scene.add
      .text(audioInputModeHeadphonesButton.x, audioInputModeHeadphonesButton.y, 'Headphones', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const stringsTitleY = panelY - panelHeight * 0.17;
    const stringsTitle = this.scene.add
      .text(panelX - panelWidth * 0.42, stringsTitleY, 'Strings', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(14, labelSize)}px`
      })
      .setOrigin(0, 0.5);

    const stringToggles = this.createStringToggles(
      panelX - panelWidth * 0.14,
      stringsTitleY,
      Math.min(86, panelWidth * 0.09),
      Math.min(66, panelWidth * 0.075),
      42,
      labelSize
    );

    const fingersTitleY = panelY - panelHeight * 0.04;
    const fingersTitle = this.scene.add
      .text(panelX - panelWidth * 0.42, fingersTitleY, 'Fingers (1-4)', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(14, labelSize)}px`
      })
      .setOrigin(0, 0.5);

    const fingerToggles = this.createFingerToggles(
      panelX - panelWidth * 0.1,
      fingersTitleY,
      Math.min(84, panelWidth * 0.09),
      Math.min(66, panelWidth * 0.075),
      42,
      labelSize
    );

    const fretsTitleY = panelY + panelHeight * 0.09;
    const fretsTitle = this.scene.add
      .text(panelX - panelWidth * 0.42, fretsTitleY, 'Frets (0-21)', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(14, labelSize)}px`
      })
      .setOrigin(0, 0.5);

    const fretToggles = this.createFretToggles(
      panelX - panelWidth * 0.36,
      panelY + panelHeight * 0.07,
      11,
      Math.min(72, panelWidth * 0.08),
      52,
      Math.min(56, panelWidth * 0.062),
      38,
      labelSize
    );

    const doneButton = new RoundedBox(
      this.scene,
      panelX,
      panelY + panelHeight * 0.4,
      Math.min(260, panelWidth * 0.32),
      52,
      0x2563eb,
      1
    )
      .setStrokeStyle(2, 0x93c5fd, 0.8)
      .setInteractive({ useHandCursor: true });
    const doneLabel = this.scene.add
      .text(doneButton.x, doneButton.y, 'Done', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(18, labelSize + 2)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const resetScoresConfirmBackdrop = new RoundedBox(this.scene, width / 2, height / 2, width, height, 0x020617, 0.78, 0)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    const resetScoresConfirmPanel = new RoundedBox(
      this.scene,
      panelX,
      panelY,
      Math.min(560, panelWidth * 0.62),
      Math.min(240, panelHeight * 0.46),
      0x101c3c,
      0.98
    )
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    const resetScoresConfirmTitle = this.scene.add
      .text(panelX, resetScoresConfirmPanel.y - resetScoresConfirmPanel.height * 0.28, 'Reset Best Scores?', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(19, labelSize + 4)}px`
      })
      .setOrigin(0.5)
      .setVisible(false);
    const resetScoresConfirmMessage = this.scene.add
      .text(panelX, resetScoresConfirmPanel.y - resetScoresConfirmPanel.height * 0.02, 'This will clear every song best score.\nThis action cannot be undone.', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        align: 'center',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5)
      .setVisible(false);
    const resetScoresConfirmCancelButton = new RoundedBox(
      this.scene,
      panelX - resetScoresConfirmPanel.width * 0.22,
      resetScoresConfirmPanel.y + resetScoresConfirmPanel.height * 0.28,
      Math.min(164, resetScoresConfirmPanel.width * 0.36),
      46,
      0x1e293b,
      1
    )
      .setStrokeStyle(2, 0x64748b, 0.84)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    const resetScoresConfirmCancelLabel = this.scene.add
      .text(resetScoresConfirmCancelButton.x, resetScoresConfirmCancelButton.y, 'Cancel', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(15, labelSize)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    const resetScoresConfirmConfirmButton = new RoundedBox(
      this.scene,
      panelX + resetScoresConfirmPanel.width * 0.22,
      resetScoresConfirmPanel.y + resetScoresConfirmPanel.height * 0.28,
      Math.min(164, resetScoresConfirmPanel.width * 0.36),
      46,
      0x7f1d1d,
      1
    )
      .setStrokeStyle(2, 0xfda4af, 0.84)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    const resetScoresConfirmConfirmLabel = this.scene.add
      .text(resetScoresConfirmConfirmButton.x, resetScoresConfirmConfirmButton.y, 'Reset', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(15, labelSize)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);

    const allObjects: Phaser.GameObjects.GameObject[] = [
      backdrop,
      panel,
      title,
      resetScoresButton,
      resetScoresLabel,
      audioInputModeTitle,
      audioInputModeSpeakerButton,
      audioInputModeSpeakerLabel,
      audioInputModeHeadphonesButton,
      audioInputModeHeadphonesLabel,
      stringsTitle,
      fingersTitle,
      fretsTitle,
      doneButton,
      doneLabel,
      ...stringToggles.flatMap((toggle) => [toggle.background, toggle.label]),
      ...fingerToggles.flatMap((toggle) => [toggle.background, toggle.label]),
      ...fretToggles.flatMap((toggle) => [toggle.background, toggle.label]),
      resetScoresConfirmBackdrop,
      resetScoresConfirmPanel,
      resetScoresConfirmTitle,
      resetScoresConfirmMessage,
      resetScoresConfirmCancelButton,
      resetScoresConfirmCancelLabel,
      resetScoresConfirmConfirmButton,
      resetScoresConfirmConfirmLabel
    ];

    const container = this.scene.add.container(0, 0, allObjects).setDepth(1200).setVisible(false);

    return {
      container,
      backdrop,
      panel,
      doneButton,
      doneLabel,
      resetScoresButton,
      resetScoresLabel,
      resetScoresConfirmBackdrop,
      resetScoresConfirmPanel,
      resetScoresConfirmTitle,
      resetScoresConfirmMessage,
      resetScoresConfirmCancelButton,
      resetScoresConfirmCancelLabel,
      resetScoresConfirmConfirmButton,
      resetScoresConfirmConfirmLabel,
      audioInputModeTitle,
      audioInputModeSpeakerButton,
      audioInputModeSpeakerLabel,
      audioInputModeHeadphonesButton,
      audioInputModeHeadphonesLabel,
      stringToggles,
      fingerToggles,
      fretToggles
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

  private createFingerToggles(
    startX: number,
    centerY: number,
    spacingX: number,
    buttonWidth: number,
    buttonHeight: number,
    labelSize: number
  ): ToggleOption[] {
    const values = [1, 2, 3, 4];
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

  private createFretToggles(
    startX: number,
    startY: number,
    cols: number,
    spacingX: number,
    spacingY: number,
    buttonWidth: number,
    buttonHeight: number,
    labelSize: number
  ): ToggleOption[] {
    const values = rangeInclusive(0, 21);
    const options: ToggleOption[] = [];

    values.forEach((value, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * spacingX;
      const y = startY + row * spacingY;

      const background = new RoundedBox(this.scene, x, y, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.scene.add
        .text(x, y, `${value}`, {
          color: '#cbd5e1',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(12, labelSize - 3)}px`
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      options.push({ value, background, label });
    });

    return options;
  }
}
