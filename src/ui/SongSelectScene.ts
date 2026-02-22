import Phaser from 'phaser';
import { DIFFICULTY_PRESETS } from '../app/config';
import { createMicNode } from '../audio/micInput';
import { PitchDetectorService } from '../audio/pitchDetector';
import { STANDARD_TUNING } from '../guitar/tuning';

type Difficulty = 'Easy' | 'Medium' | 'Hard';

type SongEntry = {
  id: string;
  name: string;
  file: string;
};

type SongOption = {
  song: SongEntry;
  label: Phaser.GameObjects.Text;
  background: Phaser.GameObjects.Rectangle;
};

type DifficultyDropdown = {
  trigger: Phaser.GameObjects.Rectangle;
  triggerLabel: Phaser.GameObjects.Text;
  chevron: Phaser.GameObjects.Text;
  blocker: Phaser.GameObjects.Rectangle;
  menuContainer: Phaser.GameObjects.Container;
  options: Array<{
    difficulty: Difficulty;
    background: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
  }>;
};

type ToggleOption = {
  value: number;
  label: Phaser.GameObjects.Text;
  background: Phaser.GameObjects.Rectangle;
};

type SettingsOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: Phaser.GameObjects.Rectangle;
  panel: Phaser.GameObjects.Rectangle;
  doneButton: Phaser.GameObjects.Rectangle;
  doneLabel: Phaser.GameObjects.Text;
  stringToggles: ToggleOption[];
  fingerToggles: ToggleOption[];
  fretToggles: ToggleOption[];
};

type TunerPanel = {
  container: Phaser.GameObjects.Container;
  backdrop: Phaser.GameObjects.Rectangle;
  panel: Phaser.GameObjects.Rectangle;
  targetLabel: Phaser.GameObjects.Text;
  detectedLabel: Phaser.GameObjects.Text;
  startButton: Phaser.GameObjects.Rectangle;
  startLabel: Phaser.GameObjects.Text;
  closeButton: Phaser.GameObjects.Rectangle;
  closeLabel: Phaser.GameObjects.Text;
  meterNeedle: Phaser.GameObjects.Rectangle;
  meterCenterX: number;
  meterHalfWidth: number;
  stringToggles: ToggleOption[];
};

export class SongSelectScene extends Phaser.Scene {
  private selectedSongIndex = 0;
  private selectedDifficulty: Difficulty = 'Easy';
  private selectedStrings = new Set<number>();
  private selectedFingers = new Set<number>();
  private selectedFrets = new Set<number>();
  private settingsOpen = false;
  private difficultyOpen = false;
  private tunerTargetString = 6;
  private tunerActive = false;
  private tunerCtx?: AudioContext;
  private tunerDetector?: PitchDetectorService;
  private tunerOffPitch?: () => void;
  private tunerPanel?: TunerPanel;
  private tunerOpen = false;

  constructor() {
    super('SongSelectScene');
  }

  create(): void {
    const { width, height } = this.scale;
    const songs = this.readManifestSongs();
    const titleSize = Math.max(28, Math.floor(width * 0.05));
    const sectionSize = Math.max(15, Math.floor(width * 0.022));
    const labelSize = Math.max(14, Math.floor(width * 0.018));
    this.initializeDefaults();

    this.add
      .text(width / 2, height * 0.09, 'GuitarHelio', {
        color: '#ffffff',
        fontSize: `${titleSize}px`
      })
      .setOrigin(0.5);

    this.add
      .text(width * 0.25, height * 0.18, 'Song', {
        color: '#93c5fd',
        fontSize: `${sectionSize}px`
      })
      .setOrigin(0.5);

    const songOptions = this.createSongOptions(songs, width, height, labelSize);

    this.add
      .text(width * 0.76, height * 0.18, 'Difficulty', {
        color: '#93c5fd',
        fontSize: `${sectionSize}px`
      })
      .setOrigin(0.5);

    const difficultyDropdown = this.createDifficultyDropdown(width, height, labelSize);

    const settingsButtonY = height * 0.57;
    const settingsButton = this.add
      .rectangle(width * 0.76, settingsButtonY, Math.min(230, width * 0.24), 52, 0x0f172a, 1)
      .setStrokeStyle(2, 0x334155)
      .setInteractive({ useHandCursor: true });
    const settingsLabel = this.add
      .text(width * 0.76, settingsButtonY, 'Settings', {
        color: '#cbd5e1',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5);

    const tunerButtonY = settingsButtonY + 76;
    const tunerButton = this.add
      .rectangle(width * 0.76, tunerButtonY, Math.min(230, width * 0.24), 52, 0x0f172a, 1)
      .setStrokeStyle(2, 0x334155)
      .setInteractive({ useHandCursor: true });
    const tunerLabel = this.add
      .text(width * 0.76, tunerButtonY, 'Tuner', {
        color: '#cbd5e1',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5);
    const tunerSummary = this.add
      .text(width * 0.76, tunerButtonY + 38, '', {
        color: '#94a3b8',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const settingsSummary = this.add
      .text(width * 0.76, settingsButtonY + 39, '', {
        color: '#94a3b8',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);

    const hint = this.add
      .text(width / 2, height * 0.84, '', {
        color: '#fca5a5',
        fontSize: `${Math.max(13, Math.floor(width * 0.015))}px`
      })
      .setOrigin(0.5);

    const startY = height * 0.92;
    const startButton = this.add
      .rectangle(width / 2, startY, Math.min(360, width * 0.64), 58, 0x1d4ed8, 1)
      .setStrokeStyle(2, 0x93c5fd)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(width / 2, startY, 'Start Session', {
        color: '#ffffff',
        fontSize: `${Math.max(20, labelSize + 4)}px`
      })
      .setOrigin(0.5);

    const settingsOverlay = this.createSettingsOverlay(width, height, labelSize);
    this.tunerPanel = this.createTunerOverlay(width, height, labelSize);

    const closeDifficulty = (): void => {
      this.difficultyOpen = false;
      difficultyDropdown.menuContainer.setVisible(false);
      difficultyDropdown.blocker.setVisible(false);
      difficultyDropdown.blocker.disableInteractive();
    };

    const openDifficulty = (): void => {
      if (this.settingsOpen) return;
      this.difficultyOpen = true;
      difficultyDropdown.menuContainer.setVisible(true);
      difficultyDropdown.blocker.setVisible(true);
      difficultyDropdown.blocker.setInteractive({ useHandCursor: false });
    };

    const toggleDifficulty = (): void => {
      if (this.difficultyOpen) closeDifficulty();
      else openDifficulty();
      refreshSelections();
    };

    const refreshSelections = (): void => {
      const settingsValid = this.selectedStrings.size > 0 && this.selectedFingers.size > 0 && this.selectedFrets.size > 0;

      songOptions.forEach((option, index) => {
        const active = index === this.selectedSongIndex;
        option.background.setFillStyle(active ? 0x2563eb : 0x0f172a, 1);
        option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155);
        option.label.setColor(active ? '#ffffff' : '#cbd5e1');
      });

      difficultyDropdown.trigger.setFillStyle(this.difficultyOpen ? 0x14532d : 0x0f172a, 1);
      difficultyDropdown.trigger.setStrokeStyle(2, this.difficultyOpen ? 0x86efac : 0x334155);
      difficultyDropdown.triggerLabel.setText(this.selectedDifficulty);
      difficultyDropdown.triggerLabel.setColor(this.difficultyOpen ? '#ecfdf5' : '#cbd5e1');
      difficultyDropdown.chevron.setText(this.difficultyOpen ? '▲' : '▼');
      difficultyDropdown.chevron.setColor(this.difficultyOpen ? '#86efac' : '#94a3b8');

      difficultyDropdown.options.forEach((option) => {
        const active = option.difficulty === this.selectedDifficulty;
        option.background.setFillStyle(active ? 0x166534 : 0x0f172a, 1);
        option.background.setStrokeStyle(2, active ? 0x86efac : 0x334155);
        option.label.setColor(active ? '#ecfdf5' : '#cbd5e1');
      });

      settingsButton.setFillStyle(this.settingsOpen ? 0x0b3a72 : 0x0f172a, 1);
      settingsButton.setStrokeStyle(2, this.settingsOpen ? 0x7dd3fc : settingsValid ? 0x334155 : 0xef4444);
      settingsLabel.setColor(this.settingsOpen ? '#e0f2fe' : '#cbd5e1');
      settingsSummary.setText(
        `${this.selectedStrings.size} strings • ${this.selectedFingers.size} fingers • ${this.selectedFrets.size} frets`
      );
      settingsSummary.setColor(settingsValid ? '#94a3b8' : '#fca5a5');

      tunerButton.setFillStyle(this.tunerOpen ? 0x0f3d2e : 0x0f172a, 1);
      tunerButton.setStrokeStyle(2, this.tunerOpen ? 0x86efac : 0x334155);
      tunerLabel.setColor(this.tunerOpen ? '#ecfdf5' : '#cbd5e1');
      tunerSummary.setText(`String ${this.tunerTargetString} • ${this.tunerActive ? 'ON' : 'OFF'}`);
      tunerSummary.setColor(this.tunerActive ? '#86efac' : '#94a3b8');

      settingsOverlay.stringToggles.forEach((option) => {
        const active = this.selectedStrings.has(option.value);
        option.background.setFillStyle(active ? 0x1d4ed8 : 0x0f172a, 1);
        option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155);
        option.label.setColor(active ? '#ffffff' : '#cbd5e1');
      });

      settingsOverlay.fingerToggles.forEach((option) => {
        const active = this.selectedFingers.has(option.value);
        option.background.setFillStyle(active ? 0x7c3aed : 0x0f172a, 1);
        option.background.setStrokeStyle(2, active ? 0xd8b4fe : 0x334155);
        option.label.setColor(active ? '#faf5ff' : '#cbd5e1');
      });

      settingsOverlay.fretToggles.forEach((option) => {
        const active = this.selectedFrets.has(option.value);
        option.background.setFillStyle(active ? 0x0ea5a4 : 0x0f172a, 1);
        option.background.setStrokeStyle(2, active ? 0x5eead4 : 0x334155);
        option.label.setColor(active ? '#ecfeff' : '#cbd5e1');
      });

      settingsOverlay.doneButton.setFillStyle(settingsValid ? 0x166534 : 0x7f1d1d, 1);
      settingsOverlay.doneButton.setStrokeStyle(2, settingsValid ? 0x86efac : 0xfca5a5);
      settingsOverlay.doneLabel.setColor(settingsValid ? '#ecfdf5' : '#ffe4e6');

      hint.setText(settingsValid ? '' : 'Open Settings and select at least one string, one finger and one fret.');

      const tuner = this.tunerPanel;
      if (tuner) {
        const targetMidi = STANDARD_TUNING[this.tunerTargetString];
        tuner.targetLabel.setText(`Target: String ${this.tunerTargetString} • ${midiToNoteName(targetMidi)}`);
        tuner.startButton.setFillStyle(this.tunerActive ? 0x7f1d1d : 0x166534, 1);
        tuner.startButton.setStrokeStyle(2, this.tunerActive ? 0xfca5a5 : 0x86efac);
        tuner.startLabel.setText(this.tunerActive ? 'Stop Tuner' : 'Start Tuner');
        tuner.startLabel.setColor(this.tunerActive ? '#ffe4e6' : '#ecfdf5');

        tuner.stringToggles.forEach((option) => {
          const active = option.value === this.tunerTargetString;
          option.background.setFillStyle(active ? 0x2563eb : 0x0f172a, 1);
          option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155);
          option.label.setColor(active ? '#ffffff' : '#cbd5e1');
        });
      }
    };

    const openSettings = (): void => {
      closeDifficulty();
      closeTuner();
      this.settingsOpen = true;
      settingsOverlay.container.setVisible(true);
      refreshSelections();
    };

    const closeSettings = (): void => {
      this.settingsOpen = false;
      settingsOverlay.container.setVisible(false);
      refreshSelections();
    };

    const openTuner = (): void => {
      if (this.settingsOpen) return;
      closeDifficulty();
      this.tunerOpen = true;
      this.tunerPanel?.container.setVisible(true);
      refreshSelections();
    };

    const closeTuner = (): void => {
      this.tunerOpen = false;
      this.tunerPanel?.container.setVisible(false);
      void this.stopTuner(false).then(() => refreshSelections());
      refreshSelections();
    };

    const startGame = (): void => {
      if (this.settingsOpen) return;
      if (this.difficultyOpen) {
        closeDifficulty();
        refreshSelections();
        return;
      }
      if (this.tunerOpen) {
        closeTuner();
      }
      if (this.selectedStrings.size === 0 || this.selectedFingers.size === 0 || this.selectedFrets.size === 0) {
        refreshSelections();
        openSettings();
        return;
      }

      void this.stopTuner(false);

      const song = songs[this.selectedSongIndex];
      this.scene.start('PlayScene', {
        songUrl: song.file,
        difficulty: this.selectedDifficulty,
        allowedStrings: sortedValues(this.selectedStrings),
        allowedFingers: sortedValues(this.selectedFingers),
        allowedFrets: sortedValues(this.selectedFrets)
      });
    };

    settingsButton.on('pointerdown', openSettings);
    tunerButton.on('pointerdown', openTuner);
    difficultyDropdown.trigger.on('pointerdown', toggleDifficulty);
    difficultyDropdown.blocker.on('pointerdown', () => {
      closeDifficulty();
      refreshSelections();
    });
    difficultyDropdown.options.forEach((option) => {
      option.background.on('pointerdown', () => {
        this.selectedDifficulty = option.difficulty;
        closeDifficulty();
        refreshSelections();
      });
    });
    this.tunerPanel?.startButton.on('pointerdown', () => {
      if (this.tunerActive) {
        void this.stopTuner(true).then(() => refreshSelections());
      } else {
        void this.startTuner().then(() => refreshSelections());
      }
    });
    this.tunerPanel?.closeButton.on('pointerdown', closeTuner);
    this.tunerPanel?.backdrop.on('pointerdown', closeTuner);
    this.tunerPanel?.panel.on('pointerdown', () => undefined);
    this.tunerPanel?.stringToggles.forEach((option) => {
      option.background.on('pointerdown', () => {
        this.tunerTargetString = option.value;
        refreshSelections();
      });
    });
    settingsOverlay.doneButton.on('pointerdown', closeSettings);
    settingsOverlay.backdrop.on('pointerdown', closeSettings);
    settingsOverlay.panel.on('pointerdown', () => undefined);

    settingsOverlay.stringToggles.forEach((option) => {
      option.background.on('pointerdown', () => {
        if (this.selectedStrings.has(option.value)) {
          this.selectedStrings.delete(option.value);
        } else {
          this.selectedStrings.add(option.value);
        }
        refreshSelections();
      });
    });

    settingsOverlay.fingerToggles.forEach((option) => {
      option.background.on('pointerdown', () => {
        if (this.selectedFingers.has(option.value)) {
          this.selectedFingers.delete(option.value);
        } else {
          this.selectedFingers.add(option.value);
        }
        refreshSelections();
      });
    });

    settingsOverlay.fretToggles.forEach((option) => {
      option.background.on('pointerdown', () => {
        if (this.selectedFrets.has(option.value)) {
          this.selectedFrets.delete(option.value);
        } else {
          this.selectedFrets.add(option.value);
        }
        refreshSelections();
      });
    });

    startButton.on('pointerdown', startGame);

    this.input.keyboard?.on('keydown-LEFT', () => {
      if (this.settingsOpen) return;
      this.selectedSongIndex = Math.max(0, this.selectedSongIndex - 1);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-RIGHT', () => {
      if (this.settingsOpen) return;
      this.selectedSongIndex = Math.min(songs.length - 1, this.selectedSongIndex + 1);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-UP', () => {
      if (this.settingsOpen) return;
      this.selectedDifficulty = previousDifficulty(this.selectedDifficulty);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-DOWN', () => {
      if (this.settingsOpen) return;
      this.selectedDifficulty = nextDifficulty(this.selectedDifficulty);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-ENTER', () => {
      if (this.settingsOpen) {
        closeSettings();
        return;
      }
      startGame();
    });
    this.input.keyboard?.on('keydown-SPACE', () => {
      if (this.settingsOpen) return;
      startGame();
    });
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.settingsOpen) {
        closeSettings();
      } else if (this.tunerOpen) {
        closeTuner();
      } else if (this.difficultyOpen) {
        closeDifficulty();
        refreshSelections();
      } else {
        openSettings();
      }
    });

    songOptions.forEach((option, index) => {
      option.background.on('pointerdown', () => {
        if (this.settingsOpen) return;
        if (this.difficultyOpen) closeDifficulty();
        this.selectedSongIndex = index;
        refreshSelections();
      });
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      void this.stopTuner(false);
      this.tunerOpen = false;
      this.tunerPanel = undefined;
    });

    refreshSelections();
  }

  private createSettingsOverlay(width: number, height: number, labelSize: number): SettingsOverlay {
    const backdrop = this.add
      .rectangle(width / 2, height / 2, width, height, 0x020617, 0.76)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(980, width * 0.9);
    const panelHeight = Math.min(520, height * 0.82);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = this.add
      .rectangle(panelX, panelY, panelWidth, panelHeight, 0x0b1220, 0.98)
      .setStrokeStyle(2, 0x334155)
      .setInteractive({ useHandCursor: false });

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.41, 'Session Settings', {
        color: '#e2e8f0',
        fontSize: `${Math.max(20, labelSize + 6)}px`
      })
      .setOrigin(0.5);

    const stringsTitleY = panelY - panelHeight * 0.31;
    const stringsTitle = this.add
      .text(panelX - panelWidth * 0.42, stringsTitleY, 'Strings', {
        color: '#cbd5e1',
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
    const fingersTitle = this.add
      .text(panelX - panelWidth * 0.42, fingersTitleY, 'Fingers (1-4)', {
        color: '#cbd5e1',
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
    const fretsTitle = this.add
      .text(panelX - panelWidth * 0.42, fretsTitleY, 'Frets (0-21)', {
        color: '#cbd5e1',
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

    const doneButton = this.add
      .rectangle(panelX, panelY + panelHeight * 0.4, Math.min(260, panelWidth * 0.32), 52, 0x166534, 1)
      .setStrokeStyle(2, 0x86efac)
      .setInteractive({ useHandCursor: true });
    const doneLabel = this.add
      .text(doneButton.x, doneButton.y, 'Done', {
        color: '#ecfdf5',
        fontSize: `${Math.max(18, labelSize + 2)}px`
      })
      .setOrigin(0.5);

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

    const container = this.add.container(0, 0, allObjects).setDepth(1200).setVisible(false);

    return { container, backdrop, panel, doneButton, doneLabel, stringToggles, fingerToggles, fretToggles };
  }

  private createTunerOverlay(width: number, height: number, labelSize: number): TunerPanel {
    const backdrop = this.add
      .rectangle(width / 2, height / 2, width, height, 0x020617, 0.76)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(560, width * 0.72);
    const panelHeight = Math.min(340, height * 0.56);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = this.add
      .rectangle(panelX, panelY, panelWidth, panelHeight, 0x0b1220, 0.98)
      .setStrokeStyle(2, 0x334155)
      .setInteractive({ useHandCursor: false });

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.4, 'Tuner', {
        color: '#e2e8f0',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const targetLabel = this.add
      .text(panelX, panelY - panelHeight * 0.26, '', {
        color: '#bae6fd',
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

    const meterBase = this.add.rectangle(meterCenterX, meterY, meterHalfWidth * 2, 12, 0x1e293b, 1).setStrokeStyle(1, 0x334155);
    const meterCenter = this.add.rectangle(meterCenterX, meterY, 2, 22, 0x64748b, 1);
    const meterNeedle = this.add.rectangle(meterCenterX, meterY, 8, 24, 0x9ca3af, 1).setStrokeStyle(1, 0x0f172a);

    const detectedLabel = this.add
      .text(panelX, panelY + panelHeight * 0.22, 'Detected: --', {
        color: '#cbd5e1',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const startButton = this.add
      .rectangle(panelX - panelWidth * 0.16, panelY + panelHeight * 0.38, Math.min(170, panelWidth * 0.34), 40, 0x166534, 1)
      .setStrokeStyle(2, 0x86efac)
      .setInteractive({ useHandCursor: true });
    const startLabel = this.add
      .text(startButton.x, startButton.y, 'Start Tuner', {
        color: '#ecfdf5',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const closeButton = this.add
      .rectangle(panelX + panelWidth * 0.2, panelY + panelHeight * 0.38, Math.min(140, panelWidth * 0.28), 40, 0x334155, 1)
      .setStrokeStyle(2, 0x94a3b8)
      .setInteractive({ useHandCursor: true });
    const closeLabel = this.add
      .text(closeButton.x, closeButton.y, 'Close', {
        color: '#e2e8f0',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const allObjects: Phaser.GameObjects.GameObject[] = [
      backdrop,
      panel,
      title,
      targetLabel,
      meterBase,
      meterCenter,
      meterNeedle,
      detectedLabel,
      startButton,
      startLabel,
      closeButton,
      closeLabel,
      ...stringToggles.flatMap((toggle) => [toggle.background, toggle.label])
    ];
    const container = this.add.container(0, 0, allObjects).setDepth(1150).setVisible(false);

    return {
      container,
      backdrop,
      panel,
      targetLabel,
      detectedLabel,
      startButton,
      startLabel,
      closeButton,
      closeLabel,
      meterNeedle,
      meterCenterX,
      meterHalfWidth,
      stringToggles
    };
  }

  private setTunerNeedleFromCents(cents: number | null): void {
    if (!this.tunerPanel) return;
    const needle = this.tunerPanel.meterNeedle;
    if (cents === null || Number.isNaN(cents)) {
      needle.x = this.tunerPanel.meterCenterX;
      needle.setFillStyle(0x9ca3af, 1);
      return;
    }

    const clamped = Phaser.Math.Clamp(cents, -50, 50);
    needle.x = this.tunerPanel.meterCenterX + (clamped / 50) * this.tunerPanel.meterHalfWidth;

    const abs = Math.abs(clamped);
    const color = abs <= 5 ? 0x22c55e : abs <= 15 ? 0xf59e0b : 0xef4444;
    needle.setFillStyle(color, 1);
  }

  private async startTuner(): Promise<void> {
    if (this.tunerActive) return;
    const panel = this.tunerPanel;
    if (!panel) return;

    try {
      const ctx = new AudioContext();
      this.tunerCtx = ctx;

      const micSource = await createMicNode(ctx);
      const detector = new PitchDetectorService(ctx, { roundMidi: false });
      await detector.init();
      this.tunerDetector = detector;
      this.tunerOffPitch = detector.onPitch((frame) => {
        const targetMidi = STANDARD_TUNING[this.tunerTargetString];
        if (frame.midi_estimate === null) {
          panel.detectedLabel.setText('Detected: --');
          this.setTunerNeedleFromCents(null);
          return;
        }

        const cents = (frame.midi_estimate - targetMidi) * 100;
        const sign = cents >= 0 ? '+' : '';
        const detected = midiToNoteName(Math.round(frame.midi_estimate));
        panel.detectedLabel.setText(`Detected: ${detected} (${sign}${Math.round(cents)}c)`);
        this.setTunerNeedleFromCents(cents);
      });
      detector.start(micSource);

      await ctx.resume();
      this.tunerActive = true;
      panel.detectedLabel.setText('Detected: listening...');
      this.setTunerNeedleFromCents(null);
    } catch (error) {
      console.error('Failed to start tuner', error);
      await this.stopTuner(false);
      panel.detectedLabel.setText('Mic unavailable');
      this.setTunerNeedleFromCents(null);
    }
  }

  private async stopTuner(clearDetectedText: boolean): Promise<void> {
    this.tunerDetector?.stop();
    this.tunerDetector = undefined;
    this.tunerOffPitch?.();
    this.tunerOffPitch = undefined;

    if (this.tunerCtx && this.tunerCtx.state !== 'closed') {
      try {
        await this.tunerCtx.close();
      } catch {
        // ignore close failures during scene shutdown
      }
    }
    this.tunerCtx = undefined;
    this.tunerActive = false;

    if (this.tunerPanel) {
      if (clearDetectedText) this.tunerPanel.detectedLabel.setText('Detected: --');
      this.setTunerNeedleFromCents(null);
    }
  }

  private initializeDefaults(): void {
    this.selectedStrings = new Set(DIFFICULTY_PRESETS.Easy.allowed_strings);
    this.selectedFingers = new Set(DIFFICULTY_PRESETS.Easy.allowed_fingers);

    const defaultFrets =
      DIFFICULTY_PRESETS.Easy.allowed_fret_list ??
      rangeInclusive(DIFFICULTY_PRESETS.Easy.allowed_frets.min, DIFFICULTY_PRESETS.Easy.allowed_frets.max);
    this.selectedFrets = new Set(defaultFrets);
  }

  private readManifestSongs(): SongEntry[] {
    const fallback: SongEntry[] = [{ id: 'example', name: 'Example Song', file: '/songs/example.mid' }];
    const manifestRaw = this.cache.text.get('songManifest');
    if (typeof manifestRaw !== 'string') return fallback;

    try {
      const parsed = JSON.parse(manifestRaw) as { songs?: unknown };
      if (!Array.isArray(parsed.songs)) return fallback;

      const songs = parsed.songs.filter(isSongEntry);
      return songs.length > 0 ? songs : fallback;
    } catch {
      return fallback;
    }
  }

  private createSongOptions(songs: SongEntry[], width: number, height: number, labelSize: number): SongOption[] {
    const options: SongOption[] = [];
    const buttonWidth = Math.min(420, width * 0.48);
    const buttonHeight = Math.min(56, height * 0.1);
    const spacing = Math.max(12, buttonHeight * 0.22);
    const firstY = height * 0.27;

    songs.forEach((song, index) => {
      const y = firstY + index * (buttonHeight + spacing);
      const background = this.add
        .rectangle(width * 0.25, y, buttonWidth, buttonHeight, 0x0f172a, 1)
        .setStrokeStyle(2, 0x334155)
        .setInteractive({ useHandCursor: true });

      const label = this.add
        .text(width * 0.25, y, song.name, {
          color: '#cbd5e1',
          fontSize: `${labelSize}px`
        })
        .setOrigin(0.5);

      options.push({ song, label, background });
    });

    return options;
  }

  private createDifficultyDropdown(width: number, height: number, labelSize: number): DifficultyDropdown {
    const difficulties: Difficulty[] = ['Easy', 'Medium', 'Hard'];
    const triggerX = width * 0.76;
    const triggerY = height * 0.27;
    const buttonWidth = Math.min(220, width * 0.24);
    const buttonHeight = Math.min(52, height * 0.09);
    const optionHeight = Math.min(46, height * 0.075);
    const optionGap = 7;

    const trigger = this.add
      .rectangle(triggerX, triggerY, buttonWidth, buttonHeight, 0x0f172a, 1)
      .setStrokeStyle(2, 0x334155)
      .setInteractive({ useHandCursor: true })
      .setDepth(90);
    const triggerLabel = this.add
      .text(triggerX - buttonWidth * 0.08, triggerY, this.selectedDifficulty, {
        color: '#cbd5e1',
        fontSize: `${labelSize}px`
      })
      .setOrigin(0.5)
      .setDepth(91);
    const chevron = this.add
      .text(triggerX + buttonWidth * 0.34, triggerY, '▼', {
        color: '#94a3b8',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5)
      .setDepth(91);

    const blocker = this.add
      .rectangle(width / 2, height / 2, width, height, 0x000000, 0.001)
      .setVisible(false)
      .setDepth(92);

    const optionItems: Array<{ difficulty: Difficulty; background: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }> = [];
    const optionObjects: Phaser.GameObjects.GameObject[] = [];
    difficulties.forEach((difficulty, index) => {
      const y = triggerY + buttonHeight * 0.5 + 8 + optionHeight * 0.5 + index * (optionHeight + optionGap);
      const background = this.add
        .rectangle(triggerX, y, buttonWidth, optionHeight, 0x0f172a, 1)
        .setStrokeStyle(2, 0x334155)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(triggerX, y, difficulty, {
          color: '#cbd5e1',
          fontSize: `${Math.max(13, labelSize - 1)}px`
        })
        .setOrigin(0.5);
      optionItems.push({ difficulty, background, label });
      optionObjects.push(background, label);
    });

    const menuContainer = this.add.container(0, 0, optionObjects).setDepth(93).setVisible(false);
    return { trigger, triggerLabel, chevron, blocker, menuContainer, options: optionItems };
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
      const background = this.add
        .rectangle(x, centerY, buttonWidth, buttonHeight, 0x0f172a, 1)
        .setStrokeStyle(2, 0x334155)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, centerY, `${value}`, {
          color: '#cbd5e1',
          fontSize: `${Math.max(14, labelSize - 1)}px`
        })
        .setOrigin(0.5);
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
      const background = this.add
        .rectangle(x, centerY, buttonWidth, buttonHeight, 0x0f172a, 1)
        .setStrokeStyle(2, 0x334155)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, centerY, `${value}`, {
          color: '#cbd5e1',
          fontSize: `${Math.max(14, labelSize - 1)}px`
        })
        .setOrigin(0.5);
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

      const background = this.add
        .rectangle(x, y, buttonWidth, buttonHeight, 0x0f172a, 1)
        .setStrokeStyle(2, 0x334155)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, y, `${value}`, {
          color: '#cbd5e1',
          fontSize: `${Math.max(12, labelSize - 3)}px`
        })
        .setOrigin(0.5);
      options.push({ value, background, label });
    });

    return options;
  }
}

function isSongEntry(value: unknown): value is SongEntry {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.id === 'string' && typeof data.name === 'string' && typeof data.file === 'string';
}

function midiToNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const note = names[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function nextDifficulty(difficulty: Difficulty): Difficulty {
  if (difficulty === 'Easy') return 'Medium';
  if (difficulty === 'Medium') return 'Hard';
  return 'Easy';
}

function previousDifficulty(difficulty: Difficulty): Difficulty {
  if (difficulty === 'Hard') return 'Medium';
  if (difficulty === 'Medium') return 'Easy';
  return 'Hard';
}

function sortedValues(values: Set<number>): number[] {
  return Array.from(values).sort((a, b) => a - b);
}

function rangeInclusive(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}
