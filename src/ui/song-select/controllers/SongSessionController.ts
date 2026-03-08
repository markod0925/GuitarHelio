import { DIFFICULTY_PRESETS } from '../../../app/config';
import {
  loadSessionSettingsPreference,
  saveSessionSettingsPreference
} from '../../../app/sessionPersistence';
import { RoundedBox } from '../../RoundedBox';
import type {
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
  selectedStringsCount: number;
  selectedFingersCount: number;
  selectedFretsCount: number;
  valid: boolean;
};

export class SongSessionController {
  private overlay?: SettingsOverlay;
  private open = false;
  private difficulty: Difficulty = 'Medium';
  private selectedStrings = new Set<number>();
  private selectedFingers = new Set<number>();
  private selectedFrets = new Set<number>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onStateChanged: () => void
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
    this.overlay.container.setVisible(true);
    this.refresh();
    this.onStateChanged();
  }

  closeOverlay(): void {
    if (!this.overlay) return;
    this.open = false;
    this.overlay.container.setVisible(false);
    this.refresh();
    this.onStateChanged();
  }

  cycleDifficultyNext(): void {
    this.difficulty = nextDifficulty(this.difficulty);
    this.persistSessionSettingsPreference();
    this.refresh();
    this.onStateChanged();
  }

  cycleDifficultyPrevious(): void {
    this.difficulty = previousDifficulty(this.difficulty);
    this.persistSessionSettingsPreference();
    this.refresh();
    this.onStateChanged();
  }

  getDifficulty(): Difficulty {
    return this.difficulty;
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
  }

  private initializeDefaults(): void {
    const defaultPreset = DIFFICULTY_PRESETS[this.difficulty];
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
    this.selectedStrings = new Set(sanitizeSettingValues(stored.selectedStrings, 1, 6));
    this.selectedFingers = new Set(sanitizeSettingValues(stored.selectedFingers, 1, 4));
    this.selectedFrets = new Set(sanitizeSettingValues(stored.selectedFrets, 0, 21));
  }

  private persistSessionSettingsPreference(): void {
    saveSessionSettingsPreference({
      difficulty: this.difficulty,
      selectedStrings: this.getAllowedStrings(),
      selectedFingers: this.getAllowedFingers(),
      selectedFrets: this.getAllowedFrets()
    });
  }

  private bindOverlayEvents(): void {
    const overlay = this.overlay;
    if (!overlay) return;

    overlay.doneButton.on('pointerdown', () => this.closeOverlay());
    overlay.doneLabel.on('pointerdown', () => this.closeOverlay());
    overlay.backdrop.on('pointerdown', () => this.closeOverlay());
    overlay.panel.on('pointerdown', () => undefined);

    overlay.stringToggles.forEach((option) => {
      const toggleString = (): void => {
        if (this.selectedStrings.has(option.value)) {
          this.selectedStrings.delete(option.value);
        } else {
          this.selectedStrings.add(option.value);
        }
        this.persistSessionSettingsPreference();
        this.refresh();
        this.onStateChanged();
      };
      option.background.on('pointerdown', toggleString);
      option.label.on('pointerdown', toggleString);
    });

    overlay.fingerToggles.forEach((option) => {
      const toggleFinger = (): void => {
        if (this.selectedFingers.has(option.value)) {
          this.selectedFingers.delete(option.value);
        } else {
          this.selectedFingers.add(option.value);
        }
        this.persistSessionSettingsPreference();
        this.refresh();
        this.onStateChanged();
      };
      option.background.on('pointerdown', toggleFinger);
      option.label.on('pointerdown', toggleFinger);
    });

    overlay.fretToggles.forEach((option) => {
      const toggleFret = (): void => {
        if (this.selectedFrets.has(option.value)) {
          this.selectedFrets.delete(option.value);
        } else {
          this.selectedFrets.add(option.value);
        }
        this.persistSessionSettingsPreference();
        this.refresh();
        this.onStateChanged();
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

    const stringsTitleY = panelY - panelHeight * 0.31;
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

    const fingersTitleY = panelY - panelHeight * 0.18;
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

    const fretsTitleY = panelY - panelHeight * 0.05;
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

    const allObjects: Phaser.GameObjects.GameObject[] = [
      backdrop,
      panel,
      title,
      stringsTitle,
      fingersTitle,
      fretsTitle,
      doneButton,
      doneLabel,
      ...stringToggles.flatMap((toggle) => [toggle.background, toggle.label]),
      ...fingerToggles.flatMap((toggle) => [toggle.background, toggle.label]),
      ...fretToggles.flatMap((toggle) => [toggle.background, toggle.label])
    ];

    const container = this.scene.add.container(0, 0, allObjects).setDepth(1200).setVisible(false);

    return { container, backdrop, panel, doneButton, doneLabel, stringToggles, fingerToggles, fretToggles };
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
