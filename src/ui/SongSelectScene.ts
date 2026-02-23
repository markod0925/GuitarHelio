import Phaser from 'phaser';
import { DIFFICULTY_PRESETS } from '../app/config';
import { createMicNode } from '../audio/micInput';
import { PitchDetectorService } from '../audio/pitchDetector';
import { STANDARD_TUNING } from '../guitar/tuning';
import { readNativeSongCatalogEntries } from '../platform/nativeSongCatalog';
import { importAudioSongNative } from '../platform/nativeSongImport';
import { isNativeSongLibraryAvailable } from '../platform/nativeSongLibrary';
import { RoundedBox } from './RoundedBox';

type Difficulty = 'Easy' | 'Medium' | 'Hard';
type ImportSourceMode = 'auto' | 'server' | 'native';

type SongEntry = {
  id: string;
  name: string;
  folder: string;
  cover: string;
  midi: string;
  audio: string;
  coverTextureKey: string;
};

type SongOption = {
  song: SongEntry;
  label: Phaser.GameObjects.Text;
  subLabel: Phaser.GameObjects.Text;
  background: RoundedBox;
  glow: RoundedBox;
  thumbnail: RoundedBox;
  thumbnailImage?: Phaser.GameObjects.Image;
  thumbLabel?: Phaser.GameObjects.Text;
};

type SongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi?: string;
  audio?: string;
  file?: string;
};

type DifficultyDropdown = {
  trigger: RoundedBox;
  triggerLabel: Phaser.GameObjects.Text;
  chevron: Phaser.GameObjects.Text;
  blocker: RoundedBox;
  menuContainer: Phaser.GameObjects.Container;
  options: Array<{
    difficulty: Difficulty;
    background: RoundedBox;
    label: Phaser.GameObjects.Text;
  }>;
};

type ToggleOption = {
  value: number;
  label: Phaser.GameObjects.Text;
  background: RoundedBox;
};

type SettingsOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  doneButton: RoundedBox;
  doneLabel: Phaser.GameObjects.Text;
  stringToggles: ToggleOption[];
  fingerToggles: ToggleOption[];
  fretToggles: ToggleOption[];
};

type TunerPanel = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  targetLabel: Phaser.GameObjects.Text;
  detectedLabel: Phaser.GameObjects.Text;
  startButton: RoundedBox;
  startLabel: Phaser.GameObjects.Text;
  closeButton: RoundedBox;
  closeLabel: Phaser.GameObjects.Text;
  meterNeedle: RoundedBox;
  meterCenterX: number;
  meterHalfWidth: number;
  stringToggles: ToggleOption[];
};

type SongImportOverlay = {
  container: Phaser.GameObjects.Container;
  panel: RoundedBox;
  stageLabel: Phaser.GameObjects.Text;
  percentLabel: Phaser.GameObjects.Text;
  progressFill: RoundedBox;
  progressTrackLeft: number;
  progressTrackWidth: number;
  progressTrackHeight: number;
};

type SongImportJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type SongImportStatusResponse = {
  id: string;
  status: SongImportJobStatus;
  stage?: string;
  progress?: number;
  error?: string;
};

type ImportSourceToggleOption = {
  mode: ImportSourceMode;
  background: RoundedBox;
  label: Phaser.GameObjects.Text;
};

const DEFAULT_SONG_COVER_TEXTURE_KEY = 'defaultSongCover';
const DEFAULT_SONG_COVER_URL = '/ui/song-cover-placeholder-neon.png';
const IMPORT_STATUS_POLL_MS = 700;
const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
const IMPORT_SOURCE_STORAGE_KEY = 'gh_import_source_mode';

export class SongSelectScene extends Phaser.Scene {
  private readonly assetExistenceCache = new Map<string, boolean>();
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
  private importInput?: HTMLInputElement;
  private importInProgress = false;
  private importSourceMode: ImportSourceMode = 'auto';

  constructor() {
    super('SongSelectScene');
  }

  async create(): Promise<void> {
    const { width, height } = this.scale;
    const titleSize = Math.max(34, Math.floor(width * 0.058));
    const sectionSize = Math.max(16, Math.floor(width * 0.023));
    const labelSize = Math.max(14, Math.floor(width * 0.017));
    this.initializeDefaults();

    this.drawNeonStartBackdrop(width, height);

    const loadingSongsLabel = this.add
      .text(width * 0.27, height * 0.24, 'Loading songs...', {
        color: '#cbd5e1',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontSize: `${Math.max(14, labelSize)}px`
      })
      .setOrigin(0.5);
    const songs = await this.readManifestSongs();
    await this.preloadSongCoverTextures(songs);
    if (!this.scene.isActive()) return;
    loadingSongsLabel.destroy();
    this.selectedSongIndex = Phaser.Math.Clamp(this.selectedSongIndex, 0, Math.max(0, songs.length - 1));

    if (this.textures.exists('logoGuitarHelio')) {
      const logoWidth = Math.min(420, width * 0.46);
      const logoHeight = Math.round(logoWidth * 0.3125);
      this.add
        .image(width / 2, height * 0.095, 'logoGuitarHelio')
        .setDisplaySize(logoWidth, logoHeight)
        .setOrigin(0.5)
        .setAlpha(0.98);
    } else {
      this.add
        .text(width / 2, height * 0.09, 'GuitarHelio', {
          color: '#dbeafe',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
          fontSize: `${titleSize}px`
        })
        .setStroke('#0f172a', 4)
        .setShadow(0, 3, '#0ea5e9', 12, true, true)
        .setOrigin(0.5);
    }

    this.add
      .text(width * 0.27, height * 0.18, 'Song', {
        color: '#cbd5e1',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${sectionSize}px`
      })
      .setOrigin(0.5);

    const songOptions = this.createSongOptions(songs, width, height, labelSize);

    this.add
      .text(width * 0.79, height * 0.18, 'Difficulty', {
        color: '#cbd5e1',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${sectionSize}px`
      })
      .setOrigin(0.5);

    const difficultyDropdown = this.createDifficultyDropdown(width, height, labelSize);

    const settingsButtonY = height * 0.60;
    const sideButtonWidth = Math.min(300, width * 0.3);
    const sideButtonHeight = 56;
    const sideIconSize = Math.min(26, Math.floor(labelSize * 1.5));
    const settingsButton = new RoundedBox(this, width * 0.79, settingsButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const settingsIcon = this.textures.exists('uiSettingsIcon')
      ? this.add
          .image(settingsButton.x - sideButtonWidth * 0.33, settingsButtonY, 'uiSettingsIcon')
          .setDisplaySize(sideIconSize, sideIconSize)
      : undefined;
    const settingsLabel = this.add
      .text(settingsButton.x + (settingsIcon ? sideButtonWidth * 0.04 : 0), settingsButtonY, 'Settings', {
        color: '#f1f5f9',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(17, labelSize + 2)}px`
      })
      .setOrigin(0.5);

    const tunerButtonY = settingsButtonY + 86;
    const tunerButton = new RoundedBox(this, width * 0.79, tunerButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const tunerIcon = this.textures.exists('uiTunerIcon')
      ? this.add
          .image(tunerButton.x - sideButtonWidth * 0.33, tunerButtonY, 'uiTunerIcon')
          .setDisplaySize(sideIconSize, sideIconSize)
      : undefined;
    const tunerLabel = this.add
      .text(tunerButton.x + (tunerIcon ? sideButtonWidth * 0.04 : 0), tunerButtonY, 'Tuner', {
        color: '#f1f5f9',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(17, labelSize + 2)}px`
      })
      .setOrigin(0.5);
    const tunerSummary = this.add
      .text(tunerButton.x, tunerButtonY + 38, '', {
        color: '#a5b4fc',
        fontFamily: 'Courier New, monospace',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const settingsSummary = this.add
      .text(settingsButton.x, settingsButtonY + 39, '', {
        color: '#a5b4fc',
        fontFamily: 'Courier New, monospace',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const importButtonY = height * 0.43;
    const importButton = new RoundedBox(this, width * 0.79, importButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const importLabel = this.add
      .text(importButton.x, importButtonY, 'Import MP3/OGG', {
        color: '#f1f5f9',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5);
    const importSummary = this.add
      .text(importButton.x, importButtonY + 39, '', {
        color: '#a5b4fc',
        fontFamily: 'Courier New, monospace',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const showImportSourceDebug = isImportSourceDebugEnabled();
    this.importSourceMode = showImportSourceDebug ? loadImportSourceModePreference() : 'auto';
    const importSourceTitle = showImportSourceDebug
      ? this.add
          .text(importButton.x, importButtonY + 64, 'Import Source (debug)', {
            color: '#94a3b8',
            fontFamily: 'Trebuchet MS, Verdana, sans-serif',
            fontSize: `${Math.max(11, labelSize - 4)}px`
          })
          .setOrigin(0.5)
      : undefined;
    const importSourceToggleOptions = showImportSourceDebug
      ? this.createImportSourceToggleOptions(importButton.x, importButtonY + 88, sideButtonWidth, 30, labelSize)
      : [];
    let importSummaryMessage =
      this.importSourceMode === 'auto' ? 'Adds song folder + MIDI + cover' : `Forced source: ${this.importSourceMode}`;
    let importSummaryColor = '#a5b4fc';
    const importOverlay = this.createSongImportOverlay(width, height, labelSize);

    const hint = this.add
      .text(width / 2, height * 0.84, '', {
        color: '#fca5a5',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontSize: `${Math.max(13, Math.floor(width * 0.015))}px`
      })
      .setOrigin(0.5);

    const startY = height * 0.93;
    const startButtonWidth = Math.min(388, width * 0.68);
    const startButtonHeight = 62;
    const startGlow = this.add
      .ellipse(width / 2, startY + 2, Math.min(404, width * 0.72), 88, 0xfb7185, 0.26)
      .setDepth(20);
    const startButton = new RoundedBox(this, width / 2, startY, startButtonWidth, startButtonHeight, 0xf97316, 1)
      .setStrokeStyle(2, 0xfecaca, 0.8)
      .setInteractive({ useHandCursor: true });
    const playIcon = this.textures.exists('uiPlayIcon')
      ? this.add
          .image(width / 2 - startButtonWidth * 0.3, startY, 'uiPlayIcon')
          .setDisplaySize(Math.min(32, labelSize + 10), Math.min(32, labelSize + 10))
      : undefined;
    const startLabel = this.add
      .text(width / 2 + (playIcon ? startButtonWidth * 0.06 : 0), startY, 'Start Session', {
        color: '#fff7ed',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(21, labelSize + 4)}px`
      })
      .setOrigin(0.5)
      .setShadow(0, 2, '#7f1d1d', 6, true, true);
    startGlow.setDepth(startButton.depth - 1);
    playIcon?.setDepth(startButton.depth + 1);
    startLabel.setDepth(startButton.depth + 1);

    const settingsOverlay = this.createSettingsOverlay(width, height, labelSize);
    this.tunerPanel = this.createTunerOverlay(width, height, labelSize);

    const closeDifficulty = (): void => {
      this.difficultyOpen = false;
      difficultyDropdown.menuContainer.setVisible(true);
      difficultyDropdown.blocker.setVisible(false);
      difficultyDropdown.blocker.disableInteractive();
    };

    const openDifficulty = (): void => {
      this.difficultyOpen = false;
      difficultyDropdown.menuContainer.setVisible(true);
    };

    const toggleDifficulty = (): void => {
      openDifficulty();
      refreshSelections();
    };

    const refreshSelections = (): void => {
      const settingsValid = this.selectedStrings.size > 0 && this.selectedFingers.size > 0 && this.selectedFrets.size > 0;
      const hasPlayableSongs = songs.length > 0;
      const canStartSession = settingsValid && hasPlayableSongs && !this.importInProgress;

      songOptions.forEach((option, index) => {
        const active = index === this.selectedSongIndex;
        option.glow.setAlpha(active ? 0.38 : 0);
        option.background.setFillStyle(active ? 0x1e3a8a : 0x162447, active ? 0.78 : 0.55);
        option.background.setStrokeStyle(2, active ? 0x60a5fa : 0x334155, active ? 0.9 : 0.45);
        option.label.setColor(active ? '#f8fafc' : '#cbd5e1');
        option.subLabel.setColor(active ? '#bfdbfe' : '#64748b');
        option.thumbnail.setFillStyle(active ? 0x1d4f91 : 0x121a33, 0.85);
        option.thumbnail.setStrokeStyle(1, active ? 0x93c5fd : 0x475569, active ? 0.75 : 0.45);
        option.thumbnailImage?.setAlpha(active ? 1 : 0.88);
        option.thumbLabel?.setColor(active ? '#dbeafe' : '#94a3b8');
      });

      difficultyDropdown.trigger.setFillStyle(0x1a2a53, 0.72);
      difficultyDropdown.trigger.setStrokeStyle(2, 0x3b82f6, 0.35);
      difficultyDropdown.triggerLabel.setText(this.selectedDifficulty);
      difficultyDropdown.triggerLabel.setColor('#bfdbfe');
      difficultyDropdown.chevron.setText('');
      difficultyDropdown.chevron.setColor('#94a3b8');

      difficultyDropdown.options.forEach((option) => {
        const active = option.difficulty === this.selectedDifficulty;
        option.background.setFillStyle(active ? 0x7c92b6 : 0x1e2f58, active ? 0.95 : 0.65);
        option.background.setStrokeStyle(1, active ? 0xdbeafe : 0x334155, active ? 0.85 : 0.5);
        option.label.setColor(active ? '#f8fafc' : '#94a3b8');
      });

      settingsButton.setFillStyle(this.settingsOpen ? 0x27457c : 0x1a2a53, this.settingsOpen ? 0.9 : 0.74);
      settingsButton.setStrokeStyle(2, this.settingsOpen ? 0x60a5fa : settingsValid ? 0x3b82f6 : 0xfb7185, 0.52);
      settingsLabel.setColor(this.settingsOpen ? '#e0f2fe' : '#f1f5f9');
      settingsIcon?.setAlpha(this.settingsOpen ? 1 : 0.94);
      settingsSummary.setText(
        `${this.selectedStrings.size} strings • ${this.selectedFingers.size} fingers • ${this.selectedFrets.size} frets`
      );
      settingsSummary.setColor(settingsValid ? '#a5b4fc' : '#fca5a5');

      tunerButton.setFillStyle(this.tunerOpen ? 0x27457c : 0x1a2a53, this.tunerOpen ? 0.9 : 0.74);
      tunerButton.setStrokeStyle(2, this.tunerOpen ? 0x60a5fa : 0x3b82f6, 0.52);
      tunerLabel.setColor(this.tunerOpen ? '#e0f2fe' : '#f1f5f9');
      tunerIcon?.setAlpha(this.tunerOpen ? 1 : 0.94);
      tunerSummary.setText(`String ${this.tunerTargetString} • ${this.tunerActive ? 'ON' : 'OFF'}`);
      tunerSummary.setColor(this.tunerActive ? '#86efac' : '#a5b4fc');

      importButton.setFillStyle(this.importInProgress ? 0x334155 : 0x1a2a53, this.importInProgress ? 0.9 : 0.74);
      importButton.setStrokeStyle(2, this.importInProgress ? 0xf59e0b : 0x3b82f6, this.importInProgress ? 0.82 : 0.52);
      importLabel.setColor(this.importInProgress ? '#fef3c7' : '#f1f5f9');
      importSummary.setText(
        truncateLabel(this.importInProgress ? 'Converting audio to MIDI...' : importSummaryMessage, Math.max(28, Math.floor(width * 0.036)))
      );
      importSummary.setColor(this.importInProgress ? '#fde68a' : importSummaryColor);
      importSourceTitle?.setColor(this.importInProgress ? '#fcd34d' : '#94a3b8');
      importSourceToggleOptions.forEach((option) => {
        const active = option.mode === this.importSourceMode;
        option.background.setFillStyle(active ? 0x2563eb : 0x1a2a53, active ? 0.92 : 0.72);
        option.background.setStrokeStyle(1, active ? 0x93c5fd : 0x334155, active ? 0.82 : 0.46);
        option.background.setAlpha(this.importInProgress ? 0.7 : 1);
        option.label.setColor(active ? '#eff6ff' : '#94a3b8');
        option.label.setAlpha(this.importInProgress ? 0.75 : 1);
      });

      settingsOverlay.stringToggles.forEach((option) => {
        const active = this.selectedStrings.has(option.value);
        option.background.setFillStyle(active ? 0x1d4ed8 : 0x1a2a53, active ? 0.92 : 0.68);
        option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155, active ? 0.75 : 0.45);
        option.label.setColor(active ? '#ffffff' : '#cbd5e1');
      });

      settingsOverlay.fingerToggles.forEach((option) => {
        const active = this.selectedFingers.has(option.value);
        option.background.setFillStyle(active ? 0x7c3aed : 0x1a2a53, active ? 0.92 : 0.68);
        option.background.setStrokeStyle(2, active ? 0xd8b4fe : 0x334155, active ? 0.75 : 0.45);
        option.label.setColor(active ? '#faf5ff' : '#cbd5e1');
      });

      settingsOverlay.fretToggles.forEach((option) => {
        const active = this.selectedFrets.has(option.value);
        option.background.setFillStyle(active ? 0x0ea5a4 : 0x1a2a53, active ? 0.92 : 0.68);
        option.background.setStrokeStyle(2, active ? 0x5eead4 : 0x334155, active ? 0.75 : 0.45);
        option.label.setColor(active ? '#ecfeff' : '#cbd5e1');
      });

      settingsOverlay.doneButton.setFillStyle(settingsValid ? 0x2563eb : 0x7f1d1d, 1);
      settingsOverlay.doneButton.setStrokeStyle(2, settingsValid ? 0x93c5fd : 0xfca5a5, 0.8);
      settingsOverlay.doneLabel.setColor(settingsValid ? '#ecfdf5' : '#ffe4e6');

      startButton.setFillStyle(canStartSession ? 0xf97316 : 0x9f1239, 1);
      startButton.setStrokeStyle(2, canStartSession ? 0xfecaca : 0xfda4af, canStartSession ? 0.8 : 0.75);
      startGlow.setFillStyle(canStartSession ? 0xfb7185 : 0xf43f5e, canStartSession ? 0.26 : 0.2);
      startLabel.setColor(canStartSession ? '#fff7ed' : '#ffe4e6');
      startLabel.setText(this.importInProgress ? 'Import in progress...' : canStartSession ? 'Start Session' : 'Fix Song Setup');
      playIcon?.setAlpha(canStartSession ? 0.98 : 0.72);

      if (!hasPlayableSongs) {
        hint.setText('No songs with a valid MIDI file found in /public/songs.');
      } else if (this.importInProgress) {
        hint.setText('Importing song: keep this screen open until conversion finishes.');
      } else {
        hint.setText(settingsValid ? '' : 'Open Settings and select at least one string, one finger and one fret.');
      }

      const tuner = this.tunerPanel;
      if (tuner) {
        const targetMidi = STANDARD_TUNING[this.tunerTargetString];
        tuner.targetLabel.setText(`Target: String ${this.tunerTargetString} • ${midiToNoteName(targetMidi)}`);
        tuner.startButton.setFillStyle(this.tunerActive ? 0x7f1d1d : 0x2563eb, 1);
        tuner.startButton.setStrokeStyle(2, this.tunerActive ? 0xfca5a5 : 0x93c5fd, 0.8);
        tuner.startLabel.setText(this.tunerActive ? 'Stop Tuner' : 'Start Tuner');
        tuner.startLabel.setColor(this.tunerActive ? '#ffe4e6' : '#eff6ff');

        tuner.stringToggles.forEach((option) => {
          const active = option.value === this.tunerTargetString;
          option.background.setFillStyle(active ? 0x2563eb : 0x1a2a53, active ? 0.92 : 0.68);
          option.background.setStrokeStyle(2, active ? 0x93c5fd : 0x334155, active ? 0.75 : 0.45);
          option.label.setColor(active ? '#ffffff' : '#cbd5e1');
        });
      }
    };

    const setImportOverlayProgress = (stage: string, progress: number): void => {
      this.setSongImportOverlayProgress(importOverlay, stage, progress);
    };

    const runSongImport = async (file: File): Promise<void> => {
      if (this.importInProgress) return;

      const importRoute = this.resolveImportRoute();
      this.importInProgress = true;
      importSummaryMessage = `Importing ${file.name} (${importRoute})`;
      importSummaryColor = '#fde68a';
      importOverlay.container.setVisible(true);
      setImportOverlayProgress('Uploading audio...', 0.02);
      refreshSelections();

      try {
        await this.importSongFile(file, (stage, progress) => {
          importSummaryMessage = stage;
          setImportOverlayProgress(stage, progress);
          refreshSelections();
        });

        importSummaryMessage = `Imported ${stripFileExtension(file.name)}`;
        importSummaryColor = '#86efac';
        setImportOverlayProgress('Import completed.', 1);
        refreshSelections();

        await waitMs(480);
        if (this.scene.isActive()) {
          this.scene.restart();
        }
        return;
      } catch (error) {
        const message = toErrorMessage(error);
        importSummaryMessage = truncateLabel(message, 46);
        importSummaryColor = '#fca5a5';
        setImportOverlayProgress('Import failed.', 1);
        refreshSelections();
        await waitMs(900);
      } finally {
        this.importInProgress = false;
        if (this.scene.isActive()) {
          importOverlay.container.setVisible(false);
          refreshSelections();
        }
      }
    };

    const openSettings = (): void => {
      if (this.importInProgress) return;
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
      if (this.importInProgress) return;
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

    const importInput = this.ensureImportInput();
    importInput.onchange = () => {
      const selectedFile = importInput.files?.[0];
      importInput.value = '';
      if (!selectedFile) return;
      void runSongImport(selectedFile);
    };

    const openImportPicker = (): void => {
      if (this.importInProgress) return;
      if (this.settingsOpen) closeSettings();
      if (this.tunerOpen) closeTuner();
      closeDifficulty();
      importInput.value = '';
      importInput.click();
      refreshSelections();
    };

    const startGame = (): void => {
      if (this.importInProgress) return;
      if (this.settingsOpen) return;
      if (this.difficultyOpen) {
        closeDifficulty();
        refreshSelections();
        return;
      }
      if (this.tunerOpen) {
        closeTuner();
      }
      if (songs.length === 0) {
        refreshSelections();
        return;
      }
      if (this.selectedStrings.size === 0 || this.selectedFingers.size === 0 || this.selectedFrets.size === 0) {
        refreshSelections();
        openSettings();
        return;
      }

      void this.stopTuner(false);

      const song = songs[this.selectedSongIndex];
      if (!song) {
        hint.setText('No playable songs found: add a song folder with a valid MIDI file.');
        return;
      }
      this.scene.start('PlayScene', {
        midiUrl: song.midi,
        audioUrl: song.audio,
        difficulty: this.selectedDifficulty,
        allowedStrings: sortedValues(this.selectedStrings),
        allowedFingers: sortedValues(this.selectedFingers),
        allowedFrets: sortedValues(this.selectedFrets)
      });
    };

    settingsButton.on('pointerdown', openSettings);
    tunerButton.on('pointerdown', openTuner);
    importButton.on('pointerdown', openImportPicker);
    importSourceToggleOptions.forEach((option) => {
      const applyImportSourceMode = (): void => {
        if (this.importInProgress) return;
        this.importSourceMode = option.mode;
        if (showImportSourceDebug) {
          saveImportSourceModePreference(this.importSourceMode);
        }
        importSummaryMessage = option.mode === 'auto' ? 'Adds song folder + MIDI + cover' : `Forced source: ${option.mode}`;
        importSummaryColor = '#a5b4fc';
        refreshSelections();
      };
      option.background.on('pointerdown', applyImportSourceMode);
      option.label.on('pointerdown', applyImportSourceMode);
    });
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
      if (this.settingsOpen || songs.length === 0) return;
      this.selectedSongIndex = Math.max(0, this.selectedSongIndex - 1);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-RIGHT', () => {
      if (this.settingsOpen || songs.length === 0) return;
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
      const selectSong = (): void => {
        if (this.settingsOpen || songs.length === 0) return;
        if (this.difficultyOpen) closeDifficulty();
        this.selectedSongIndex = index;
        refreshSelections();
      };
      option.background.on('pointerdown', selectSong);
      option.thumbnail.on('pointerdown', selectSong);
      option.thumbnailImage?.on('pointerdown', selectSong);
      option.thumbLabel?.on('pointerdown', selectSong);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      void this.stopTuner(false);
      this.tunerOpen = false;
      this.tunerPanel = undefined;
      this.importInProgress = false;
      this.importInput?.remove();
      this.importInput = undefined;
    });

    refreshSelections();
  }

  private drawNeonStartBackdrop(width: number, height: number): void {
    const g = this.add.graphics();
    g.fillGradientStyle(0x060d24, 0x0a1a42, 0x040a1a, 0x071734, 1, 1, 1, 1);
    g.fillRect(0, 0, width, height);

    const ringX = width * 0.47;
    const ringY = height * 0.56;
    g.lineStyle(2, 0x7dd3fc, 0.2);
    g.strokeCircle(ringX, ringY, Math.min(width, height) * 0.2);
    g.lineStyle(1, 0x93c5fd, 0.18);
    g.strokeCircle(ringX, ringY, Math.min(width, height) * 0.235);
    g.strokeCircle(ringX, ringY, Math.min(width, height) * 0.17);

    const lineYBase = height * 0.365;
    const spacing = height * 0.083;
    g.lineStyle(1.7, 0x93c5fd, 0.28);
    for (let i = 0; i < 4; i += 1) {
      const y = lineYBase + i * spacing;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.strokePath();
    }

    g.lineStyle(2.4, 0xfdba74, 0.24);
    g.beginPath();
    g.moveTo(0, lineYBase + spacing);
    g.lineTo(width, lineYBase + spacing);
    g.strokePath();

    const vignette = this.add.graphics();
    vignette.fillStyle(0x020617, 0.48);
    vignette.fillRect(0, height * 0.84, width, height * 0.2);
    vignette.fillStyle(0x020617, 0.2);
    vignette.fillRect(0, height * 0.76, width, height * 0.08);

  }

  private createSettingsOverlay(width: number, height: number, labelSize: number): SettingsOverlay {
    const backdrop = new RoundedBox(this, width / 2, height / 2, width, height, 0x020617, 0.82, 0)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(980, width * 0.9);
    const panelHeight = Math.min(520, height * 0.82);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.96)
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: false });

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.41, 'Session Settings', {
        color: '#e2e8f0',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 6)}px`
      })
      .setOrigin(0.5);

    const stringsTitleY = panelY - panelHeight * 0.31;
    const stringsTitle = this.add
      .text(panelX - panelWidth * 0.42, stringsTitleY, 'Strings', {
        color: '#cbd5e1',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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
      this,
      panelX,
      panelY + panelHeight * 0.4,
      Math.min(260, panelWidth * 0.32),
      52,
      0x2563eb,
      1
    )
      .setStrokeStyle(2, 0x93c5fd, 0.8)
      .setInteractive({ useHandCursor: true });
    const doneLabel = this.add
      .text(doneButton.x, doneButton.y, 'Done', {
        color: '#eff6ff',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
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
    const backdrop = new RoundedBox(this, width / 2, height / 2, width, height, 0x020617, 0.82, 0)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(560, width * 0.72);
    const panelHeight = Math.min(340, height * 0.56);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.96)
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: false });

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.4, 'Tuner', {
        color: '#e2e8f0',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const targetLabel = this.add
      .text(panelX, panelY - panelHeight * 0.26, '', {
        color: '#bae6fd',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
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

    const meterBase = new RoundedBox(this, meterCenterX, meterY, meterHalfWidth * 2, 12, 0x1f2937, 0.95).setStrokeStyle(1, 0x60a5fa, 0.35);
    const meterCenter = new RoundedBox(this, meterCenterX, meterY, 2, 22, 0xbfdbfe, 0.75);
    const meterNeedle = new RoundedBox(this, meterCenterX, meterY, 8, 24, 0x9ca3af, 1).setStrokeStyle(1, 0x0f172a);

    const detectedLabel = this.add
      .text(panelX, panelY + panelHeight * 0.22, 'Detected: --', {
        color: '#cbd5e1',
        fontFamily: 'Courier New, monospace',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const startButton = new RoundedBox(
      this,
      panelX - panelWidth * 0.16,
      panelY + panelHeight * 0.38,
      Math.min(170, panelWidth * 0.34),
      40,
      0x2563eb,
      1
    )
      .setStrokeStyle(2, 0x93c5fd, 0.8)
      .setInteractive({ useHandCursor: true });
    const startLabel = this.add
      .text(startButton.x, startButton.y, 'Start Tuner', {
        color: '#eff6ff',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const closeButton = new RoundedBox(
      this,
      panelX + panelWidth * 0.2,
      panelY + panelHeight * 0.38,
      Math.min(140, panelWidth * 0.28),
      40,
      0x1e293b,
      1
    )
      .setStrokeStyle(2, 0x64748b, 0.85)
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

  private createSongImportOverlay(width: number, height: number, labelSize: number): SongImportOverlay {
    const panelWidth = Math.min(640, width * 0.7);
    const panelHeight = Math.min(240, height * 0.38);
    const panelX = width / 2;
    const panelY = height / 2;

    const backdrop = new RoundedBox(this, panelX, panelY, width, height, 0x020617, 0.76, 0).setDepth(1300);
    const panel = new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.97)
      .setStrokeStyle(2, 0x3b82f6, 0.5);

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.3, 'Import Song', {
        color: '#e2e8f0',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const stageLabel = this.add
      .text(panelX, panelY - panelHeight * 0.05, 'Preparing import...', {
        color: '#cbd5e1',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const progressTrackWidth = Math.min(470, panelWidth * 0.82);
    const progressTrackHeight = 24;
    const progressTrackY = panelY + panelHeight * 0.08;
    const progressTrackLeft = panelX - progressTrackWidth / 2;
    const progressTrack = new RoundedBox(this, panelX, progressTrackY, progressTrackWidth, progressTrackHeight, 0x0f172a, 0.92)
      .setStrokeStyle(1, 0x60a5fa, 0.45);
    const progressFill = new RoundedBox(
      this,
      progressTrackLeft + 6,
      progressTrackY,
      12,
      progressTrackHeight - 6,
      0x38bdf8,
      0.96
    ).setStrokeStyle(1, 0x93c5fd, 0.78);

    const percentLabel = this.add
      .text(panelX, panelY + panelHeight * 0.27, '0%', {
        color: '#fde68a',
        fontFamily: 'Courier New, monospace',
        fontStyle: 'bold',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const tip = this.add
      .text(panelX, panelY + panelHeight * 0.39, 'Keep this window open during conversion.', {
        color: '#94a3b8',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);

    const container = this.add
      .container(0, 0, [backdrop, panel, title, stageLabel, progressTrack, progressFill, percentLabel, tip])
      .setDepth(1300)
      .setVisible(false);

    return {
      container,
      panel,
      stageLabel,
      percentLabel,
      progressFill,
      progressTrackLeft,
      progressTrackWidth,
      progressTrackHeight
    };
  }

  private setSongImportOverlayProgress(overlay: SongImportOverlay, stage: string, progress: number): void {
    const clamped = Phaser.Math.Clamp(progress, 0, 1);
    const fillWidth = Math.max(10, overlay.progressTrackWidth * clamped);
    overlay.progressFill.setBoxSize(fillWidth, overlay.progressTrackHeight - 6);
    overlay.progressFill.x = overlay.progressTrackLeft + fillWidth / 2;
    overlay.stageLabel.setText(truncateLabel(stage, 64));
    overlay.percentLabel.setText(`${Math.round(clamped * 100)}%`);
  }

  private ensureImportInput(): HTMLInputElement {
    if (this.importInput && document.body.contains(this.importInput)) {
      return this.importInput;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mp3,.ogg,audio/mpeg,audio/ogg';
    input.style.display = 'none';
    document.body.appendChild(input);
    this.importInput = input;
    return input;
  }

  private async importSongFile(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    if (this.resolveImportRoute() === 'native') {
      await this.importSongFileNative(file, onProgress);
      return;
    }

    await this.importSongFileViaServer(file, onProgress);
  }

  private resolveImportRoute(): 'native' | 'server' {
    if (this.importSourceMode === 'native') return 'native';
    if (this.importSourceMode === 'server') return 'server';
    return isNativeSongLibraryAvailable() ? 'native' : 'server';
  }

  private async importSongFileNative(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    const mimeType = file.type && file.type.trim().length > 0 ? file.type : inferAudioMimeType(file.name);
    if (!/\.(mp3|ogg|wav)$/i.test(file.name) && !/^audio\/(mpeg|mp3|ogg|wav|wave|x-wav)/i.test(mimeType)) {
      throw new Error('Unsupported audio format. Please upload MP3, OGG, or WAV.');
    }

    await importAudioSongNative(file, ({ stage, progress }) => {
      onProgress(stage, progress);
    });
  }

  private async importSongFileViaServer(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    const mimeType = file.type && file.type.trim().length > 0 ? file.type : inferAudioMimeType(file.name);
    const body = await file.arrayBuffer();
    if (body.byteLength <= 0) {
      throw new Error('The selected file is empty.');
    }

    const startResponse = await fetch('/api/song-import/start', {
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        'X-Song-File-Name': encodeURIComponent(file.name)
      },
      body
    });

    const startPayload = (await parseJsonSafe(startResponse)) as { jobId?: string; error?: string } | null;
    if (!startResponse.ok) {
      throw new Error(firstNonEmpty(startPayload?.error, `Import request failed (${startResponse.status}).`));
    }

    const jobId = startPayload?.jobId;
    if (!jobId) {
      throw new Error('Import server did not return a valid job id.');
    }

    await this.pollSongImportStatus(jobId, onProgress);
  }

  private async pollSongImportStatus(
    jobId: string,
    onProgress: (stage: string, progress: number) => void
  ): Promise<void> {
    const startedAt = Date.now();

    while (true) {
      const response = await fetch(`/api/song-import/status/${encodeURIComponent(jobId)}?t=${Date.now()}`, {
        cache: 'no-store'
      });

      const payload = (await parseJsonSafe(response)) as SongImportStatusResponse | null;
      if (!response.ok || !payload) {
        throw new Error(firstNonEmpty(payload?.error, `Import status failed (${response.status}).`));
      }

      onProgress(firstNonEmpty(payload.stage, 'Converting audio to MIDI...') ?? 'Converting audio to MIDI...', clamp01(payload.progress ?? 0));

      if (payload.status === 'completed') {
        onProgress('Import completed.', 1);
        return;
      }

      if (payload.status === 'failed') {
        throw new Error(firstNonEmpty(payload.error, 'Audio import failed.') ?? 'Audio import failed.');
      }

      if (Date.now() - startedAt > IMPORT_TIMEOUT_MS) {
        throw new Error('Import timed out. Try again with a shorter track.');
      }

      await waitMs(IMPORT_STATUS_POLL_MS);
    }
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

  private async fetchManifestText(): Promise<string | null> {
    try {
      const response = await fetch(`/songs/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
      if (response.ok) {
        const manifestRaw = await response.text();
        if (this.cache.text.exists('songManifest')) {
          this.cache.text.remove('songManifest');
        }
        this.cache.text.add('songManifest', manifestRaw);
        return manifestRaw;
      }
    } catch {
      // Ignore network issues and fallback to cached manifest.
    }

    const cached = this.cache.text.get('songManifest');
    return typeof cached === 'string' ? cached : null;
  }

  private async readManifestSongs(): Promise<SongEntry[]> {
    const fallbackManifestSongs: SongManifestEntry[] = [
      {
        id: 'example',
        name: 'Example Song',
        folder: 'example',
        cover: 'cover.svg',
        midi: 'song.mid',
        audio: 'song.mp3'
      }
    ];

    const manifestRaw = await this.fetchManifestText();
    let sourceSongs: SongManifestEntry[] = fallbackManifestSongs;
    if (typeof manifestRaw === 'string') {
      try {
        const parsed = JSON.parse(manifestRaw) as { songs?: unknown };
        if (Array.isArray(parsed.songs)) {
          const parsedSongs = parsed.songs
            .map((item) => toSongManifestEntry(item))
            .filter((item): item is SongManifestEntry => item !== null);
          if (parsedSongs.length > 0) {
            sourceSongs = parsedSongs;
          }
        }
      } catch {
        sourceSongs = fallbackManifestSongs;
      }
    }

    const nativeSongs = await this.readNativeManifestSongs();
    const mergedSongs = [...sourceSongs, ...nativeSongs];

    const songs = (
      await Promise.all(mergedSongs.map((rawSong, index) => this.resolveSongEntry(rawSong, index)))
    ).filter((song): song is SongEntry => song !== null);

    if (songs.length > 0) return songs;

    // Last-resort fallback in case the manifest exists but all entries are invalid/missing MIDI.
    const fallbackSongs = (
      await Promise.all(
        fallbackManifestSongs.map((rawSong, index) => this.resolveSongEntry(rawSong, mergedSongs.length + index))
      )
    ).filter((song): song is SongEntry => song !== null);
    return fallbackSongs;
  }

  private async readNativeManifestSongs(): Promise<SongManifestEntry[]> {
    if (!isNativeSongLibraryAvailable()) return [];

    try {
      const nativeEntries = await readNativeSongCatalogEntries();
      return nativeEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        folder: entry.folder,
        cover: entry.cover,
        midi: entry.midi,
        audio: entry.audio
      }));
    } catch (error) {
      console.warn('Failed to load native song catalog', error);
      return [];
    }
  }

  private async resolveSongEntry(rawSong: SongManifestEntry, index: number): Promise<SongEntry | null> {
    const folder = normalizeFolder(rawSong.folder);
    if (!folder) return null;

    const midiField = firstNonEmpty(rawSong.midi, rawSong.file);
    if (!midiField) return null;
    const midiUrl = this.resolveSongAssetPath(folder, midiField);
    if (!(await this.assetExists(midiUrl))) return null;

    let coverUrl = DEFAULT_SONG_COVER_URL;
    if (rawSong.cover && rawSong.cover.trim().length > 0) {
      const requestedCover = this.resolveSongAssetPath(folder, rawSong.cover);
      if (await this.assetExists(requestedCover)) {
        coverUrl = requestedCover;
      }
    }

    let audioUrl = midiUrl;
    if (rawSong.audio && rawSong.audio.trim().length > 0) {
      const requestedAudio = this.resolveSongAssetPath(folder, rawSong.audio);
      if (await this.assetExists(requestedAudio)) {
        audioUrl = requestedAudio;
      }
    }

    const coverTextureKey =
      coverUrl === DEFAULT_SONG_COVER_URL ? DEFAULT_SONG_COVER_TEXTURE_KEY : `song-cover-${sanitizeKey(rawSong.id)}-${index}`;

    return {
      id: rawSong.id,
      name: rawSong.name,
      folder,
      cover: coverUrl,
      midi: midiUrl,
      audio: audioUrl,
      coverTextureKey
    };
  }

  private resolveSongAssetPath(folder: string, value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
      return trimmed;
    }

    const relativeValue = trimmed.replace(/^\.?\//, '');
    return `/songs/${encodePathSegments(folder)}/${encodePathSegments(relativeValue)}`;
  }

  private async assetExists(url: string): Promise<boolean> {
    const cached = this.assetExistenceCache.get(url);
    if (cached !== undefined) return cached;

    if (!isCapacitorFileUrl(url)) {
      try {
        const headResponse = await fetch(url, { method: 'HEAD' });
        if (headResponse.ok) {
          const exists = isValidAssetResponse(url, headResponse);
          this.assetExistenceCache.set(url, exists);
          return exists;
        }
        if (headResponse.status !== 405 && headResponse.status !== 501) {
          this.assetExistenceCache.set(url, false);
          return false;
        }
      } catch {
        // Ignore and fallback to GET.
      }
    }

    try {
      const getResponse = await fetch(url, { method: 'GET' });
      const exists = getResponse.ok && isValidAssetResponse(url, getResponse);
      this.assetExistenceCache.set(url, exists);
      return exists;
    } catch {
      this.assetExistenceCache.set(url, false);
      return false;
    }
  }

  private async preloadSongCoverTextures(songs: SongEntry[]): Promise<void> {
    const coversToLoad = songs.filter(
      (song) =>
        song.coverTextureKey !== DEFAULT_SONG_COVER_TEXTURE_KEY &&
        !this.textures.exists(song.coverTextureKey) &&
        song.cover.trim().length > 0
    );
    if (coversToLoad.length === 0) return;

    await new Promise<void>((resolve) => {
      const onFileError = (file: Phaser.Loader.File): void => {
        const failedSong = coversToLoad.find((song) => song.coverTextureKey === file.key);
        if (!failedSong) return;
        failedSong.cover = DEFAULT_SONG_COVER_URL;
        failedSong.coverTextureKey = DEFAULT_SONG_COVER_TEXTURE_KEY;
      };
      const onComplete = (): void => {
        this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileError);
        resolve();
      };

      this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileError);
      this.load.once(Phaser.Loader.Events.COMPLETE, onComplete);
      coversToLoad.forEach((song) => {
        if (song.cover.toLowerCase().endsWith('.svg')) {
          this.load.svg(song.coverTextureKey, song.cover);
        } else {
          this.load.image(song.coverTextureKey, song.cover);
        }
      });
      this.load.start();
    });
  }

  private createSongOptions(songs: SongEntry[], width: number, height: number, labelSize: number): SongOption[] {
    const options: SongOption[] = [];
    const cols = 2;
    const gridLeft = width * 0.04;
    const gridTop = height * 0.24;
    const gridWidth = width * 0.56;
    const buttonWidth = Math.min(266, gridWidth / cols - 14);
    const buttonHeight = Math.min(122, height * 0.22);
    const gapX = Math.max(12, width * 0.014);
    const gapY = Math.max(14, height * 0.028);

    songs.forEach((song, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = gridLeft + buttonWidth / 2 + col * (buttonWidth + gapX);
      const y = gridTop + buttonHeight / 2 + row * (buttonHeight + gapY);
      const glow = new RoundedBox(this, x, y, buttonWidth + 6, buttonHeight + 6, 0x60a5fa, 0.3)
        .setStrokeStyle(1, 0x93c5fd, 0.3)
        .setAlpha(0);
      const background = new RoundedBox(this, x, y, buttonWidth, buttonHeight, 0x162447, 0.55)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const thumbnailSize = buttonHeight * 0.82;
      const thumbnail = new RoundedBox(this, x - buttonWidth * 0.28, y, thumbnailSize, thumbnailSize, 0x121a33, 0.85)
        .setStrokeStyle(1, 0x475569, 0.55)
        .setInteractive({ useHandCursor: true });

      const thumbnailImage = this.textures.exists(song.coverTextureKey)
        ? this.add
            .image(thumbnail.x, thumbnail.y, song.coverTextureKey)
            .setDisplaySize(thumbnailSize - 8, thumbnailSize - 8)
            .setInteractive({ useHandCursor: true })
        : undefined;
      const thumbLabel = thumbnailImage
        ? undefined
        : this.add
            .text(thumbnail.x, thumbnail.y, song.name.toLowerCase().includes('star wars') ? '✦' : '♪', {
              color: '#94a3b8',
              fontFamily: 'Trebuchet MS, Verdana, sans-serif',
              fontStyle: 'bold',
              fontSize: `${Math.max(26, labelSize + 10)}px`
            })
            .setOrigin(0.5)
            .setInteractive({ useHandCursor: true });

      const label = this.add
        .text(x - buttonWidth * 0.02, y - buttonHeight * 0.12, song.name, {
          color: '#cbd5e1',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(17, labelSize + 2)}px`,
          wordWrap: { width: buttonWidth * 0.38, useAdvancedWrap: true }
        })
        .setOrigin(0, 0.5);

      const subLabel = this.add
        .text(x - buttonWidth * 0.02, y + buttonHeight * 0.2, song.audio === song.midi ? 'MIDI fallback' : 'Audio file', {
          color: '#64748b',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontSize: `${Math.max(12, labelSize - 2)}px`
        })
        .setOrigin(0, 0.5);

      options.push({ song, label, subLabel, background, glow, thumbnail, thumbnailImage, thumbLabel });
    });

    return options;
  }

  private createDifficultyDropdown(width: number, height: number, labelSize: number): DifficultyDropdown {
    const difficulties: Difficulty[] = ['Easy', 'Medium', 'Hard'];
    const triggerX = width * 0.79;
    const triggerY = height * 0.27;
    const buttonWidth = Math.min(348, width * 0.34);
    const buttonHeight = Math.min(62, height * 0.1);
    const optionHeight = buttonHeight * 0.76;
    const optionGap = 8;
    const optionWidth = (buttonWidth - optionGap * 4) / 3;

    const trigger = new RoundedBox(this, triggerX, triggerY, buttonWidth, buttonHeight, 0x1a2a53, 0.72)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setDepth(90);
    const triggerLabel = this.add
      .text(triggerX, triggerY - buttonHeight * 0.72, this.selectedDifficulty, {
        color: '#bfdbfe',
        fontFamily: 'Trebuchet MS, Verdana, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, labelSize - 1)}px`
      })
      .setOrigin(0.5)
      .setDepth(91);
    const chevron = this.add
      .text(triggerX + buttonWidth * 0.34, triggerY, '', {
        color: '#94a3b8',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5)
      .setDepth(91);

    const blocker = new RoundedBox(this, width / 2, height / 2, width, height, 0x000000, 0.001, 0)
      .setVisible(false)
      .setDepth(92);

    const optionItems: Array<{ difficulty: Difficulty; background: RoundedBox; label: Phaser.GameObjects.Text }> = [];
    const optionObjects: Phaser.GameObjects.GameObject[] = [];
    difficulties.forEach((difficulty, index) => {
      const x = triggerX - buttonWidth * 0.5 + optionGap * 2 + optionWidth * 0.5 + index * (optionWidth + optionGap);
      const y = triggerY;
      const background = new RoundedBox(this, x, y, optionWidth, optionHeight, 0x1e2f58, 0.66)
        .setStrokeStyle(1, 0x334155, 0.5)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, y, difficulty, {
          color: '#cbd5e1',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(13, labelSize - 1)}px`
        })
        .setOrigin(0.5);
      optionItems.push({ difficulty, background, label });
      optionObjects.push(background, label);
    });

    const menuContainer = this.add.container(0, 0, optionObjects).setDepth(93).setVisible(true);
    return { trigger, triggerLabel, chevron, blocker, menuContainer, options: optionItems };
  }

  private createImportSourceToggleOptions(
    centerX: number,
    centerY: number,
    totalWidth: number,
    buttonHeight: number,
    labelSize: number
  ): ImportSourceToggleOption[] {
    const options: Array<{ mode: ImportSourceMode; label: string }> = [
      { mode: 'auto', label: 'Auto' },
      { mode: 'server', label: 'Server' },
      { mode: 'native', label: 'Native' }
    ];
    const gap = 8;
    const buttonWidth = (totalWidth - gap * 2) / 3;
    const left = centerX - totalWidth / 2;

    return options.map((option, index) => {
      const x = left + buttonWidth * 0.5 + index * (buttonWidth + gap);
      const background = new RoundedBox(this, x, centerY, buttonWidth, buttonHeight, 0x1a2a53, 0.72)
        .setStrokeStyle(1, 0x334155, 0.46)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, centerY, option.label, {
          color: '#94a3b8',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(11, labelSize - 5)}px`
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      return {
        mode: option.mode,
        background,
        label
      };
    });
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
      const background = new RoundedBox(this, x, centerY, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, centerY, `${value}`, {
          color: '#cbd5e1',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
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
      const background = new RoundedBox(this, x, centerY, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, centerY, `${value}`, {
          color: '#cbd5e1',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
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

      const background = new RoundedBox(this, x, y, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, y, `${value}`, {
          color: '#cbd5e1',
          fontFamily: 'Trebuchet MS, Verdana, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(12, labelSize - 3)}px`
        })
        .setOrigin(0.5);
      options.push({ value, background, label });
    });

    return options;
  }
}

function toSongManifestEntry(value: unknown): SongManifestEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string' || typeof data.name !== 'string') return null;

  const folder = typeof data.folder === 'string' && data.folder.trim().length > 0 ? data.folder : data.id;
  const cover = typeof data.cover === 'string' ? data.cover : undefined;
  const midi = typeof data.midi === 'string' ? data.midi : undefined;
  const audio = typeof data.audio === 'string' ? data.audio : undefined;
  const file = typeof data.file === 'string' ? data.file : undefined;

  return {
    id: data.id,
    name: data.name,
    folder,
    cover,
    midi,
    audio,
    file
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

async function parseJsonSafe(response: Response): Promise<unknown | null> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function encodePathSegments(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), Math.max(0, ms));
  });
}

function truncateLabel(value: string, maxLength: number): string {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function inferAudioMimeType(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.ogg') || lowered.endsWith('.oga') || lowered.endsWith('.opus')) {
    return 'audio/ogg';
  }
  if (lowered.endsWith('.wav')) {
    return 'audio/wav';
  }
  return 'audio/mpeg';
}

function stripFileExtension(fileName: string): string {
  const sanitized = fileName.trim();
  if (!sanitized) return 'song';
  return sanitized.replace(/\.[^/.]+$/g, '') || sanitized;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return 'Import failed.';
}

function isImportSourceDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  return params.get('debugImportSource') === '1';
}

function loadImportSourceModePreference(): ImportSourceMode {
  if (typeof window === 'undefined') return 'auto';

  const value = window.localStorage.getItem(IMPORT_SOURCE_STORAGE_KEY);
  if (value === 'server' || value === 'native' || value === 'auto') {
    return value;
  }
  return 'auto';
}

function saveImportSourceModePreference(mode: ImportSourceMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(IMPORT_SOURCE_STORAGE_KEY, mode);
}

function sanitizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeFolder(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

function isValidAssetResponse(url: string, response: Response): boolean {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType) return true;
  if (contentType.includes('text/html')) return false;

  const loweredUrl = url.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(loweredUrl)) {
    return contentType.startsWith('image/');
  }
  if (/\.(mp3|wav|ogg|m4a)$/.test(loweredUrl)) {
    return contentType.startsWith('audio/');
  }
  if (/\.(mid|midi)$/.test(loweredUrl)) {
    return contentType.startsWith('audio/') || contentType.includes('midi') || contentType.includes('octet-stream');
  }

  return true;
}

function isCapacitorFileUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return lowered.includes('/_capacitor_file_/') || lowered.startsWith('capacitor://localhost/_capacitor_file_/');
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
