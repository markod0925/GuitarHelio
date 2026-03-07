import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { DIFFICULTY_PRESETS } from '../app/config';
import {
  loadSessionSettingsPreference,
  resolveSongHighScore,
  saveSessionSettingsPreference
} from '../app/sessionPersistence';
import { createMicNode } from '../audio/micInput';
import {
  buildPitchCalibrationProfile,
  clearPitchCalibrationProfile,
  DEFAULT_PITCH_CALIBRATION_REFERENCE_MIDI,
  estimatePitchCalibrationMeasurement,
  loadPitchCalibrationProfile,
  savePitchCalibrationProfile,
  type PitchCalibrationMeasurement,
  type PitchCalibrationProfile
} from '../audio/pitchCalibration';
import { PitchDetectorService } from '../audio/pitchDetector';
import { TunerPitchStabilizer } from '../audio/tunerPitchStabilizer';
import { STANDARD_TUNING } from '../guitar/tuning';
import { releaseMicStream } from './AudioController';
import { RoundedBox } from './RoundedBox';

type Difficulty = 'Easy' | 'Medium' | 'Hard';
type ImportSourceMode = 'auto' | 'server' | 'native';
type DebugConverterMode = 'legacy' | 'neuralnote' | 'ab';

type SongEntry = {
  id: string;
  name: string;
  folder: string;
  cover: string;
  midi: string;
  audio: string;
  highScore: number;
  usesMidiFallback: boolean;
  coverTextureKey: string;
};

type SongOption = {
  song: SongEntry;
  label: Phaser.GameObjects.Text;
  subLabel: Phaser.GameObjects.Text;
  background: RoundedBox;
  glow: RoundedBox;
  thumbnail: RoundedBox;
  thumbnailImageSize: number;
  thumbnailImage?: Phaser.GameObjects.Image;
  thumbnailImageMaskGraphics?: Phaser.GameObjects.Graphics;
  thumbnailImageFrame?: RoundedBox;
  thumbLabel?: Phaser.GameObjects.Text;
  baseY: number;
  labelBaseY: number;
  subLabelBaseY: number;
  cardHeight: number;
  interactiveObjects: Phaser.GameObjects.GameObject[];
};

type SongGridView = {
  options: SongOption[];
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  contentBottom: number;
};

type SongRemovePrompt = {
  songId: string;
  button: RoundedBox;
  label: Phaser.GameObjects.Text;
};

type SongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi?: string;
  audio?: string;
  file?: string;
  highScore?: number;
};

type SongCatalogLoadPolicy = {
  validateAssetsOnStartup: boolean;
  lazyCoverLoading: 'none' | 'visible-first';
  coverLoadConcurrency: number;
};

type AssetExistenceCacheEntry = {
  exists: boolean;
  expiresAtMs?: number;
};

type DifficultyDropdown = {
  trigger: RoundedBox;
  label: Phaser.GameObjects.Text;
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
  calibrationStatus: Phaser.GameObjects.Text;
  startButton: RoundedBox;
  startLabel: Phaser.GameObjects.Text;
  calibrateButton: RoundedBox;
  calibrateLabel: Phaser.GameObjects.Text;
  resetCalibrationButton: RoundedBox;
  resetCalibrationLabel: Phaser.GameObjects.Text;
  closeButton: RoundedBox;
  closeLabel: Phaser.GameObjects.Text;
  meterNeedle: RoundedBox;
  meterCenterX: number;
  meterHalfWidth: number;
  stringToggles: ToggleOption[];
};

type SongImportOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  stageLabel: Phaser.GameObjects.Text;
  percentLabel: Phaser.GameObjects.Text;
  progressFill: RoundedBox;
  progressTrackLeft: number;
  progressTrackWidth: number;
  progressTrackHeight: number;
};

type QuitConfirmOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  cancelButton: RoundedBox;
  cancelLabel: Phaser.GameObjects.Text;
  quitButton: RoundedBox;
  quitLabel: Phaser.GameObjects.Text;
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
const DEBUG_CONVERTER_MODE_STORAGE_KEY = 'gh_debug_converter_mode';
const ASSET_NEGATIVE_CACHE_TTL_MS = 30_000;
const DEFAULT_COVER_LOAD_CONCURRENCY = 3;
const SONG_REMOVE_LONG_PRESS_MS = 560;
const SONG_REMOVE_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const TUNER_IN_TUNE_CENTS = 5;
const TUNER_AUTO_ADVANCE_HOLD_SECONDS = 2;
const TUNER_SEQUENCE: ReadonlyArray<number> = [6, 5, 4, 3, 2, 1];

const WEB_STARTUP_CATALOG_POLICY: SongCatalogLoadPolicy = {
  validateAssetsOnStartup: false,
  lazyCoverLoading: 'visible-first',
  coverLoadConcurrency: DEFAULT_COVER_LOAD_CONCURRENCY
};

export class SongSelectScene extends Phaser.Scene {
  private readonly assetExistenceCache = new Map<string, AssetExistenceCacheEntry>();
  private songOptions: SongOption[] = [];
  private songScrollOffset = 0;
  private songScrollMax = 0;
  private songViewportRect?: Phaser.Geom.Rectangle;
  private songMaskGraphics?: Phaser.GameObjects.Graphics;
  private songScrollDragPointerId?: number;
  private songScrollDragStartY = 0;
  private songScrollDragStartOffset = 0;
  private songLongPressPointerId?: number;
  private songLongPressStartX = 0;
  private songLongPressStartY = 0;
  private songLongPressTimer?: Phaser.Time.TimerEvent;
  private songRemovePrompt?: SongRemovePrompt;
  private selectedSongIndex = 0;
  private selectedDifficulty: Difficulty = 'Medium';
  private selectedStrings = new Set<number>();
  private selectedFingers = new Set<number>();
  private selectedFrets = new Set<number>();
  private settingsOpen = false;
  private tunerTargetString = 6;
  private tunerActive = false;
  private tunerCtx?: AudioContext;
  private tunerMicStream?: MediaStream;
  private tunerDetector?: PitchDetectorService;
  private tunerOffPitch?: () => void;
  private tunerPanel?: TunerPanel;
  private tunerOpen = false;
  private readonly tunerPitchStabilizer = new TunerPitchStabilizer();
  private tunerCalibrating = false;
  private readonly tunerTunedStrings = new Set<number>();
  private tunerInTuneStreakStartSeconds: number | null = null;
  private pitchCalibrationProfile: PitchCalibrationProfile | null = loadPitchCalibrationProfile();
  private refreshSongSelectUi?: () => void;
  private importInput?: HTMLInputElement;
  private importInProgress = false;
  private importSourceMode: ImportSourceMode = 'auto';
  private debugConverterMode: DebugConverterMode = 'legacy';
  private quitConfirmOverlay?: QuitConfirmOverlay;
  private nativeBackButtonListener?: { remove: () => Promise<void> };
  private nativeAppStateListener?: { remove: () => Promise<void> };
  private reloadSongsTask?: () => Promise<void>;
  private coverLoadGeneration = 0;
  private catalogLoadGeneration = 0;

  constructor() {
    super('SongSelectScene');
  }

  async create(): Promise<void> {
    this.coverLoadGeneration += 1;
    this.catalogLoadGeneration += 1;
    const { width, height } = this.scale;
    const titleSize = Math.max(34, Math.floor(width * 0.058));
    const labelSize = Math.max(14, Math.floor(width * 0.017));
    this.initializeDefaults();
    this.restoreSessionSettingsPreference();
    let songs: SongEntry[] = [];
    let isCatalogLoading = true;

    this.drawNeonStartBackdrop(width, height);

    const loadingSongsLabel = this.add
      .text(width * 0.27, height * 0.24, 'Loading songs...', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(14, labelSize)}px`
      })
      .setOrigin(0.5);

    if (this.textures.exists('logoGuitarHelio')) {
      const logoWidth = Math.min(420, width * 0.46);
      const logoHeight = Math.round(logoWidth * 0.3125);
      const compressedLogoHeight = Math.round(logoHeight * 0.7);
      const logoCenterY = Math.max(compressedLogoHeight / 2 + 10, height * 0.095 - 40);
      this.add
        .image(width / 2, logoCenterY, 'logoGuitarHelio')
        .setDisplaySize(logoWidth, compressedLogoHeight)
        .setOrigin(0.5)
        .setAlpha(0.98);
    } else {
      const fallbackTitleY = Math.max(titleSize * 0.7, height * 0.09 - 30);
      this.add
        .text(width / 2, fallbackTitleY, 'GuitarHelio', {
          color: '#dbeafe',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${titleSize}px`
        })
        .setStroke('#0f172a', 4)
        .setShadow(0, 3, '#0ea5e9', 12, true, true)
        .setOrigin(0.5);
    }

    const songGridView = this.createSongOptions(songs, width, height, labelSize);
    this.songOptions = songGridView.options;
    this.configureSongScroll(songGridView);

    const startScale = Math.SQRT2;
    const startButtonWidth = Math.min(Math.round(388 * startScale), width * 0.82);
    const startButtonHeight = Math.round(62 * 1.08);
    const startY = height - startButtonHeight / 2 - 16;
    const startTopY = startY - startButtonHeight / 2;
    const difficultyToImportGap = 86;
    const importToSettingsGap = 92;
    const settingsToTunerGap = 86;
    const sideButtonWidth = Math.min(300, width * 0.3);
    const sideButtonHeight = 56;
    const sideButtonsBottomGapFromStart = 14;
    let difficultyButtonY = height * 0.27;
    let importButtonY = difficultyButtonY + difficultyToImportGap;
    let settingsButtonY = importButtonY + importToSettingsGap;
    let tunerButtonY = settingsButtonY + settingsToTunerGap;
    const maxTunerButtonBottom = startTopY - sideButtonsBottomGapFromStart;
    const tunerButtonBottom = tunerButtonY + sideButtonHeight / 2;
    if (tunerButtonBottom > maxTunerButtonBottom) {
      const shiftUp = tunerButtonBottom - maxTunerButtonBottom;
      difficultyButtonY -= shiftUp;
      settingsButtonY -= shiftUp;
      tunerButtonY -= shiftUp;
      importButtonY -= shiftUp;
    }
    const difficultyDropdown = this.createDifficultyDropdown(width, labelSize, difficultyButtonY);
    const sideIconSize = Math.min(26, Math.floor(labelSize * 1.5));
    const settingsButton = new RoundedBox(this, width * 0.79, settingsButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const settingsIcon = this.textures.exists('uiSettingsIcon')
      ? this.add
          .image(settingsButton.x - sideButtonWidth * 0.33, settingsButtonY, 'uiSettingsIcon')
          .setDisplaySize(sideIconSize, sideIconSize)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const settingsLabel = this.add
      .text(settingsButton.x + (settingsIcon ? sideButtonWidth * 0.04 : 0), settingsButtonY, 'Settings', {
        color: '#f1f5f9',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(17, labelSize + 2)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const tunerButton = new RoundedBox(this, width * 0.79, tunerButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const tunerIcon = this.textures.exists('uiTunerIcon')
      ? this.add
          .image(tunerButton.x - sideButtonWidth * 0.33, tunerButtonY, 'uiTunerIcon')
          .setDisplaySize(sideIconSize, sideIconSize)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const tunerLabel = this.add
      .text(tunerButton.x + (tunerIcon ? sideButtonWidth * 0.04 : 0), tunerButtonY, 'Tuner', {
        color: '#f1f5f9',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(17, labelSize + 2)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const tunerSummary = this.add
      .text(tunerButton.x, tunerButtonY + 38, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setVisible(false);
    const settingsSummary = this.add
      .text(settingsButton.x, settingsButtonY + 39, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const importButton = new RoundedBox(this, width * 0.79, importButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const importLabel = this.add
      .text(importButton.x, importButtonY, 'Import MIDI/MP3/OGG', {
        color: '#f1f5f9',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const importSummary = this.add
      .text(importButton.x, importButtonY + 39, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const showImportSourceDebug = isImportSourceDebugEnabled();
    this.importSourceMode = showImportSourceDebug ? loadImportSourceModePreference() : 'auto';
    this.debugConverterMode = showImportSourceDebug ? loadDebugConverterModePreference() : 'legacy';
    const importSourceScale = 0.7;
    const importSourceDebugWidth = Math.min(300, width * 0.38) * importSourceScale;
    const importSourceDebugCenterX = 14 + importSourceDebugWidth / 2;
    const importSourceDebugButtonHeight = 30 * importSourceScale;
    const importSourceGapFromSongs = 14;
    const importSourceDebugMinCenterY = importSourceDebugButtonHeight / 2 + 26;
    const importSourceDebugToggleY = Math.max(
      importSourceDebugMinCenterY,
      songGridView.viewportTop - importSourceDebugButtonHeight / 2 - importSourceGapFromSongs
    );
    const importSourceTitle = showImportSourceDebug
      ? this.add
          .text(importSourceDebugCenterX, importSourceDebugToggleY - 24, 'Import Source (debug)', {
            color: '#94a3b8',
            fontFamily: 'Montserrat, sans-serif',
            fontSize: `${Math.max(11, labelSize - 4)}px`
          })
          .setOrigin(0.5)
      : undefined;
    const importSourceToggleOptions = showImportSourceDebug
      ? this.createImportSourceToggleOptions(
          importSourceDebugCenterX,
          importSourceDebugToggleY,
          importSourceDebugWidth,
          importSourceDebugButtonHeight,
          labelSize
        )
      : [];
    const describeImportSummary = (): string => {
      const sourceSummary = this.importSourceMode === 'auto' ? '' : `Forced source: ${this.importSourceMode}`;
      if (!showImportSourceDebug || this.debugConverterMode === 'legacy') {
        return sourceSummary;
      }
      return sourceSummary ? `${sourceSummary} • conv: ${this.debugConverterMode}` : `conv: ${this.debugConverterMode}`;
    };
    let importSummaryMessage = describeImportSummary();
    let importSummaryColor = '#a5b4fc';
    const importOverlay = this.createSongImportOverlay(width, height, labelSize);

    const closeImportOverlay = (
      _pointer: Phaser.Input.Pointer,
      _localX: number,
      _localY: number,
      event: Phaser.Types.Input.EventData
    ): void => {
      event.stopPropagation();
      importOverlay.container.setVisible(false);
    };

    importOverlay.backdrop.on('pointerdown', closeImportOverlay);
    importOverlay.panel.on(
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

    const hint = this.add
      .text(width / 2, height * 0.84, '', {
        color: '#fca5a5',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(13, Math.floor(width * 0.015))}px`
      })
      .setOrigin(0.5)
      .setVisible(false);

    const startGlowHeight = Math.max(92, startButtonHeight + 26);
    const startGlow = this.add
      .ellipse(width / 2, startY + 4, Math.min(Math.round(404 * startScale), width * 0.86), startGlowHeight, 0xfb7185, 0.26)
      .setDepth(20);
    const playIconSize = Math.min(60, labelSize + 24);
    const startButton = new RoundedBox(this, width / 2, startY, startButtonWidth, startButtonHeight, 0xf97316, 1)
      .setStrokeStyle(2, 0xfecaca, 0.8)
      .setInteractive({ useHandCursor: true });
    const playIcon = this.textures.exists('uiPlayIcon')
      ? this.add
          .image(width / 2 - startButtonWidth * 0.3, startY, 'uiPlayIcon')
          .setDisplaySize(playIconSize, playIconSize)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const startLabel = this.add
      .text(width / 2 + (playIcon ? startButtonWidth * 0.06 : 0), startY, 'Start Session', {
        color: '#fff7ed',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(28, labelSize + 10)}px`
      })
      .setOrigin(0.5)
      .setShadow(0, 2, '#7f1d1d', 6, true, true)
      .setInteractive({ useHandCursor: true });
    startGlow.setDepth(startButton.depth - 1);
    playIcon?.setDepth(startButton.depth + 1);
    startLabel.setDepth(startButton.depth + 1);

    const settingsOverlay = this.createSettingsOverlay(width, height, labelSize);
    this.tunerPanel = this.createTunerOverlay(width, height, labelSize);
    this.quitConfirmOverlay = this.createQuitConfirmOverlay(width, height, labelSize);

    const isQuitConfirmOpen = (): boolean => this.quitConfirmOverlay?.container.visible === true;
    const closeQuitConfirm = (): void => {
      if (!this.quitConfirmOverlay) return;
      this.quitConfirmOverlay.container.setVisible(false);
    };
    const openQuitConfirm = (): void => {
      if (this.importInProgress) return;
      if (!this.quitConfirmOverlay) return;
      this.hideSongRemovePrompt();
      this.quitConfirmOverlay.container.setVisible(true);
      refreshSelections();
    };
    const requestQuitConfirm = (): void => {
      if (this.importInProgress) return;
      if (isQuitConfirmOpen()) {
        closeQuitConfirm();
        refreshSelections();
        return;
      }
      openQuitConfirm();
    };
    const quitApplication = async (): Promise<void> => {
      const quitTriggered = await requestQuitApplication();
      if (quitTriggered) return;
      closeQuitConfirm();
      refreshSelections();
    };

    this.quitConfirmOverlay?.cancelButton.on('pointerdown', () => {
      closeQuitConfirm();
      refreshSelections();
    });
    this.quitConfirmOverlay?.cancelLabel.on('pointerdown', () => {
      closeQuitConfirm();
      refreshSelections();
    });
    this.quitConfirmOverlay?.quitButton.on('pointerdown', () => {
      void quitApplication();
    });
    this.quitConfirmOverlay?.quitLabel.on('pointerdown', () => {
      void quitApplication();
    });
    this.quitConfirmOverlay?.backdrop.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        closeQuitConfirm();
        refreshSelections();
      }
    );
    this.quitConfirmOverlay?.panel.on(
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

    const cycleDifficulty = (): void => {
      if (this.settingsOpen || this.importInProgress || isQuitConfirmOpen()) return;
      this.selectedDifficulty = nextDifficulty(this.selectedDifficulty);
      this.persistSessionSettingsPreference();
      refreshSelections();
    };

    const refreshSelections = (): void => {
      const quitPromptOpen = isQuitConfirmOpen();
      const settingsValid = this.selectedStrings.size > 0 && this.selectedFingers.size > 0 && this.selectedFrets.size > 0;
      const hasPlayableSongs = songs.length > 0;
      const canStartSession = settingsValid && hasPlayableSongs && !this.importInProgress && !isCatalogLoading && !quitPromptOpen;
      const difficultyColors: Record<Difficulty, { fill: number; stroke: number }> = {
        Easy: { fill: 0x166534, stroke: 0x4ade80 },
        Medium: { fill: 0x1a2a53, stroke: 0x3b82f6 },
        Hard: { fill: 0x7f1d1d, stroke: 0xfb7185 }
      };
      const difficultyColor = difficultyColors[this.selectedDifficulty];

      this.songOptions.forEach((option, index) => {
        const active = index === this.selectedSongIndex;
        option.glow.setAlpha(active ? 0.38 : 0);
        option.background.setFillStyle(active ? 0x1e3a8a : 0x162447, active ? 0.78 : 0.55);
        option.background.setStrokeStyle(2, active ? 0x60a5fa : 0x334155, active ? 0.9 : 0.45);
        option.label.setColor(active ? '#f8fafc' : '#cbd5e1');
        option.subLabel.setColor(active ? '#bfdbfe' : '#64748b');
        option.thumbnail.setFillStyle(active ? 0x1d4f91 : 0x121a33, 0.85);
        option.thumbnail.setStrokeStyle(1, active ? 0x93c5fd : 0x475569, active ? 0.75 : 0.45);
        option.thumbnailImage?.setAlpha(active ? 1 : 0.88);
        option.thumbnailImageFrame?.setStrokeStyle(3, 0xffffff, active ? 0.9 : 0.76);
        option.thumbLabel?.setColor(active ? '#dbeafe' : '#94a3b8');
      });

      difficultyDropdown.trigger.setFillStyle(difficultyColor.fill, 0.82);
      difficultyDropdown.trigger.setStrokeStyle(2, difficultyColor.stroke, 0.62);
      difficultyDropdown.label.setText(this.selectedDifficulty);
      difficultyDropdown.label.setColor('#f8fafc');

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
      const calibrationBadge = this.pitchCalibrationProfile ? `CAL ${this.pitchCalibrationProfile.points.length}pt` : 'CAL OFF';
      const tunedBadge = `${this.tunerTunedStrings.size}/${TUNER_SEQUENCE.length} tuned`;
      tunerSummary.setText(
        `String ${this.tunerTargetString} • ${this.tunerActive ? 'ON' : 'OFF'}${this.tunerCalibrating ? ' • CAL...' : ''} • ${tunedBadge} • ${calibrationBadge}`
      );
      tunerSummary.setColor(this.tunerCalibrating ? '#fde68a' : this.tunerActive ? '#86efac' : '#a5b4fc');

      importButton.setFillStyle(this.importInProgress || quitPromptOpen ? 0x334155 : 0x1a2a53, this.importInProgress || quitPromptOpen ? 0.9 : 0.74);
      importButton.setStrokeStyle(2, this.importInProgress ? 0xf59e0b : 0x3b82f6, this.importInProgress || quitPromptOpen ? 0.82 : 0.52);
      importLabel.setColor(this.importInProgress || quitPromptOpen ? '#fef3c7' : '#f1f5f9');
      importSummary.setText(
        truncateLabel(this.importInProgress ? 'Import in progress...' : importSummaryMessage, Math.max(28, Math.floor(width * 0.036)))
      );
      importSummary.setColor(this.importInProgress ? '#fde68a' : importSummaryColor);
      importSourceTitle?.setColor(this.importInProgress || quitPromptOpen ? '#fcd34d' : '#94a3b8');
      importSourceToggleOptions.forEach((option) => {
        const active = option.mode === this.importSourceMode;
        option.background.setFillStyle(active ? 0x2563eb : 0x1a2a53, active ? 0.92 : 0.72);
        option.background.setStrokeStyle(1, active ? 0x93c5fd : 0x334155, active ? 0.82 : 0.46);
        option.background.setAlpha(this.importInProgress || quitPromptOpen ? 0.7 : 1);
        option.label.setColor(active ? '#eff6ff' : '#94a3b8');
        option.label.setAlpha(this.importInProgress || quitPromptOpen ? 0.75 : 1);
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

      if (quitPromptOpen) {
        hint.setText('Quit confirmation is open.');
      } else if (isCatalogLoading) {
        hint.setText('Loading songs...');
      } else if (!hasPlayableSongs) {
        hint.setText('No songs with a valid MIDI file found in /public/songs.');
      } else if (this.importInProgress) {
        hint.setText('Importing song: keep this screen open until import finishes.');
      } else {
        hint.setText(settingsValid ? '' : 'Open Settings and select at least one string, one finger and one fret.');
      }

      const tuner = this.tunerPanel;
      if (tuner) {
        const tunerBusy = this.tunerCalibrating;
        const targetMidi = STANDARD_TUNING[this.tunerTargetString];
        tuner.targetLabel.setText(`Target: String ${this.tunerTargetString} • ${midiToNoteName(targetMidi)}`);
        tuner.startButton.setFillStyle(
          tunerBusy ? 0x334155 : this.tunerActive ? 0x7f1d1d : 0x2563eb,
          1
        );
        tuner.startButton.setStrokeStyle(
          2,
          tunerBusy ? 0x94a3b8 : this.tunerActive ? 0xfca5a5 : 0x93c5fd,
          0.8
        );
        tuner.startLabel.setText(tunerBusy ? 'Tuner Locked' : this.tunerActive ? 'Stop Tuner' : 'Start Tuner');
        tuner.startLabel.setColor(tunerBusy ? '#cbd5e1' : this.tunerActive ? '#ffe4e6' : '#eff6ff');

        tuner.calibrateButton.setFillStyle(tunerBusy ? 0x7c2d12 : 0x0f766e, 1);
        tuner.calibrateButton.setStrokeStyle(2, tunerBusy ? 0xfdba74 : 0x5eead4, 0.82);
        tuner.calibrateLabel.setText(tunerBusy ? 'Calibrating...' : 'Calibrate');
        tuner.calibrateLabel.setColor(tunerBusy ? '#ffedd5' : '#ecfeff');

        const hasCalibration = Boolean(this.pitchCalibrationProfile);
        tuner.resetCalibrationButton.setFillStyle(hasCalibration ? 0x7f1d1d : 0x334155, 1);
        tuner.resetCalibrationButton.setStrokeStyle(2, hasCalibration ? 0xfca5a5 : 0x64748b, 0.8);
        tuner.resetCalibrationLabel.setColor(hasCalibration ? '#ffe4e6' : '#cbd5e1');
        tuner.resetCalibrationButton.setAlpha(hasCalibration ? 1 : 0.75);
        tuner.resetCalibrationLabel.setAlpha(hasCalibration ? 1 : 0.75);
        tuner.calibrationStatus.setText(
          tunerBusy
            ? 'Calibration in progress... keep the phone still.'
            : this.pitchCalibrationProfile
              ? `Calibration active • ${this.pitchCalibrationProfile.points.length} points`
              : 'Calibration inactive'
        );
        tuner.calibrationStatus.setColor(tunerBusy ? '#fde68a' : this.pitchCalibrationProfile ? '#86efac' : '#94a3b8');

        tuner.stringToggles.forEach((option) => {
          const active = option.value === this.tunerTargetString;
          const tuned = this.tunerTunedStrings.has(option.value);
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
    };

    this.refreshSongSelectUi = refreshSelections;

    const setImportOverlayProgress = (stage: string, progress: number): void => {
      this.setSongImportOverlayProgress(importOverlay, stage, progress);
    };

    const runSongImport = async (file: File): Promise<void> => {
      if (this.importInProgress) return;

      const importRoute = this.resolveImportRoute();
      let importSucceeded = false;
      this.importInProgress = true;
      importSummaryMessage = `Importing ${file.name} (${importRoute})`;
      importSummaryColor = '#fde68a';
      importOverlay.container.setVisible(true);
      setImportOverlayProgress('Uploading file...', 0.02);
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

        importSucceeded = true;
        await waitMs(480);
        await this.refreshSongListAfterImport();
        return;
      } catch (error) {
        const message = toErrorMessage(error);
        importSummaryMessage = message;
        importSummaryColor = '#fca5a5';
        setImportOverlayProgress(`Import failed: ${message}`, 1);
        refreshSelections();
      } finally {
        this.importInProgress = false;
        if (this.scene.isActive()) {
          if (importSucceeded) {
            importOverlay.container.setVisible(false);
          }
          refreshSelections();
        }
      }
    };

    const openSettings = (): void => {
      if (this.importInProgress || isQuitConfirmOpen()) return;
      this.hideSongRemovePrompt();
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
      if (this.importInProgress || isQuitConfirmOpen()) return;
      if (this.settingsOpen) return;
      this.hideSongRemovePrompt();
      this.tunerOpen = true;
      this.tunerPanel?.container.setVisible(true);
      refreshSelections();
    };

    const closeTuner = (): void => {
      if (this.tunerCalibrating) return;
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
      if (this.importInProgress || isQuitConfirmOpen()) return;
      this.hideSongRemovePrompt();
      if (this.settingsOpen) closeSettings();
      if (this.tunerOpen) closeTuner();
      importInput.value = '';
      importInput.click();
      refreshSelections();
    };

    const startGame = async (): Promise<void> => {
      if (this.importInProgress || isQuitConfirmOpen()) return;
      this.hideSongRemovePrompt();
      if (this.settingsOpen) return;
      if (isCatalogLoading) {
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
      const validatedSong = await this.validateSongBeforeStart(song);
      if (!validatedSong) {
        hint.setText('Selected song has missing assets (MIDI required).');
        refreshSelections();
        return;
      }
      songs[this.selectedSongIndex] = validatedSong;
      const selectedOption = this.songOptions[this.selectedSongIndex];
      if (selectedOption) {
        selectedOption.song = validatedSong;
      }
      this.persistSessionSettingsPreference();
      this.scene.start('PlayScene', {
        songId: validatedSong.id,
        midiUrl: validatedSong.midi,
        audioUrl: validatedSong.audio,
        difficulty: this.selectedDifficulty,
        allowedStrings: sortedValues(this.selectedStrings),
        allowedFingers: sortedValues(this.selectedFingers),
        allowedFrets: sortedValues(this.selectedFrets)
      });
    };

    const removeSong = async (song: SongEntry): Promise<void> => {
      if (this.importInProgress || isQuitConfirmOpen()) return;
      this.cancelSongLongPress();
      this.hideSongRemovePrompt();
      hint.setText(`Removing "${song.name}"...`);
      try {
        await this.removeSongFromLibrary(song);
        this.assetExistenceCache.clear();
        await this.refreshSongListAfterImport();
      } catch (error) {
        hint.setText(`Remove failed: ${truncateLabel(toErrorMessage(error), 62)}`);
        refreshSelections();
      }
    };

    const onSongWheel = (
      pointer: Phaser.Input.Pointer,
      _gameObjects: Phaser.GameObjects.GameObject[],
      _deltaX: number,
      deltaY: number
    ): void => {
      if (isQuitConfirmOpen()) return;
      if (importOverlay.container.visible) return;
      if (!this.songViewportRect || this.songScrollMax <= 0) return;
      if (!this.songViewportRect.contains(pointer.worldX, pointer.worldY)) return;
      this.setSongScrollOffset(this.songScrollOffset + deltaY * 0.8);
      refreshSelections();
    };
    const onSongPointerDown = (pointer: Phaser.Input.Pointer): void => {
      if (isQuitConfirmOpen()) return;
      if (importOverlay.container.visible) return;
      if (this.songRemovePrompt && !this.isPointerInsideObject(pointer, this.songRemovePrompt.button)) {
        this.hideSongRemovePrompt();
      }
      if (!this.songViewportRect || this.songScrollMax <= 0) return;
      if (!this.songViewportRect.contains(pointer.worldX, pointer.worldY)) return;
      this.songScrollDragPointerId = pointer.id;
      this.songScrollDragStartY = pointer.worldY;
      this.songScrollDragStartOffset = this.songScrollOffset;
    };
    const onSongPointerMove = (pointer: Phaser.Input.Pointer): void => {
      if (isQuitConfirmOpen()) return;
      if (
        this.songLongPressPointerId === pointer.id &&
        Phaser.Math.Distance.Between(pointer.worldX, pointer.worldY, this.songLongPressStartX, this.songLongPressStartY) >
          SONG_REMOVE_LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        this.cancelSongLongPress();
      }
      if (this.songScrollDragPointerId !== pointer.id || !pointer.isDown) return;
      const dragDelta = this.songScrollDragStartY - pointer.worldY;
      this.setSongScrollOffset(this.songScrollDragStartOffset + dragDelta);
      refreshSelections();
    };
    const onSongPointerUp = (pointer: Phaser.Input.Pointer): void => {
      if (isQuitConfirmOpen()) return;
      if (this.songLongPressPointerId === pointer.id) {
        this.cancelSongLongPress();
      }
      if (this.songScrollDragPointerId !== pointer.id) return;
      this.songScrollDragPointerId = undefined;
    };

    this.input.on('wheel', onSongWheel);
    this.input.on('pointerdown', onSongPointerDown);
    this.input.on('pointermove', onSongPointerMove);
    this.input.on('pointerup', onSongPointerUp);
    this.input.on('pointerupoutside', onSongPointerUp);

    settingsButton.on('pointerdown', openSettings);
    settingsLabel.on('pointerdown', openSettings);
    settingsIcon?.on('pointerdown', openSettings);
    tunerButton.on('pointerdown', openTuner);
    tunerLabel.on('pointerdown', openTuner);
    tunerIcon?.on('pointerdown', openTuner);
    importButton.on('pointerdown', openImportPicker);
    importLabel.on('pointerdown', openImportPicker);
    importSourceToggleOptions.forEach((option) => {
      const applyImportSourceMode = (): void => {
        if (this.importInProgress) return;
        this.importSourceMode = option.mode;
        if (showImportSourceDebug) {
          saveImportSourceModePreference(this.importSourceMode);
        }
        importSummaryMessage = describeImportSummary();
        importSummaryColor = '#a5b4fc';
        refreshSelections();
      };
      option.background.on('pointerdown', applyImportSourceMode);
      option.label.on('pointerdown', applyImportSourceMode);
    });
    difficultyDropdown.trigger.on('pointerdown', cycleDifficulty);
    difficultyDropdown.label.on('pointerdown', cycleDifficulty);
    const toggleTunerState = (): void => {
      if (this.tunerCalibrating) return;
      if (this.tunerActive) {
        void this.stopTuner(true).then(() => refreshSelections());
      } else {
        void this.startTuner().then(() => refreshSelections());
      }
    };
    const calibrateTuner = (): void => {
      if (this.tunerCalibrating) return;
      void this.runTunerCalibration()
        .then(() => refreshSelections())
        .catch(() => refreshSelections());
      refreshSelections();
    };
    const resetTunerCalibration = (): void => {
      if (this.tunerCalibrating) return;
      if (!this.pitchCalibrationProfile) return;
      clearPitchCalibrationProfile();
      this.pitchCalibrationProfile = null;
      this.tunerPanel?.detectedLabel.setText('Detected: calibration reset');
      this.setTunerNeedleFromCents(null);
      if (this.tunerActive) {
        void this.stopTuner(false).then(() => refreshSelections());
      }
      refreshSelections();
    };
    this.tunerPanel?.startButton.on('pointerdown', toggleTunerState);
    this.tunerPanel?.startLabel.on('pointerdown', toggleTunerState);
    this.tunerPanel?.calibrateButton.on('pointerdown', calibrateTuner);
    this.tunerPanel?.calibrateLabel.on('pointerdown', calibrateTuner);
    this.tunerPanel?.resetCalibrationButton.on('pointerdown', resetTunerCalibration);
    this.tunerPanel?.resetCalibrationLabel.on('pointerdown', resetTunerCalibration);
    this.tunerPanel?.closeButton.on('pointerdown', closeTuner);
    this.tunerPanel?.closeLabel.on('pointerdown', closeTuner);
    this.tunerPanel?.backdrop.on('pointerdown', closeTuner);
    this.tunerPanel?.panel.on('pointerdown', () => undefined);
    this.tunerPanel?.stringToggles.forEach((option) => {
      const selectTunerString = (): void => {
        if (this.tunerCalibrating) return;
        this.tunerTargetString = option.value;
        this.tunerPitchStabilizer.reset();
        this.tunerInTuneStreakStartSeconds = null;
        if (this.tunerActive) {
          this.tunerPanel?.detectedLabel.setText('Detected: listening...');
          this.setTunerNeedleFromCents(null);
        }
        refreshSelections();
      };
      option.background.on('pointerdown', selectTunerString);
      option.label.on('pointerdown', selectTunerString);
    });
    settingsOverlay.doneButton.on('pointerdown', closeSettings);
    settingsOverlay.doneLabel.on('pointerdown', closeSettings);
    settingsOverlay.backdrop.on('pointerdown', closeSettings);
    settingsOverlay.panel.on('pointerdown', () => undefined);

    settingsOverlay.stringToggles.forEach((option) => {
      const toggleString = (): void => {
        if (this.selectedStrings.has(option.value)) {
          this.selectedStrings.delete(option.value);
        } else {
          this.selectedStrings.add(option.value);
        }
        this.persistSessionSettingsPreference();
        refreshSelections();
      };
      option.background.on('pointerdown', toggleString);
      option.label.on('pointerdown', toggleString);
    });

    settingsOverlay.fingerToggles.forEach((option) => {
      const toggleFinger = (): void => {
        if (this.selectedFingers.has(option.value)) {
          this.selectedFingers.delete(option.value);
        } else {
          this.selectedFingers.add(option.value);
        }
        this.persistSessionSettingsPreference();
        refreshSelections();
      };
      option.background.on('pointerdown', toggleFinger);
      option.label.on('pointerdown', toggleFinger);
    });

    settingsOverlay.fretToggles.forEach((option) => {
      const toggleFret = (): void => {
        if (this.selectedFrets.has(option.value)) {
          this.selectedFrets.delete(option.value);
        } else {
          this.selectedFrets.add(option.value);
        }
        this.persistSessionSettingsPreference();
        refreshSelections();
      };
      option.background.on('pointerdown', toggleFret);
      option.label.on('pointerdown', toggleFret);
    });

    startButton.on('pointerdown', () => void startGame());
    startLabel.on('pointerdown', () => void startGame());
    playIcon?.on('pointerdown', () => void startGame());

    this.input.keyboard?.on('keydown-LEFT', () => {
      if (isQuitConfirmOpen() || this.settingsOpen || songs.length === 0) return;
      this.selectedSongIndex = Math.max(0, this.selectedSongIndex - 1);
      this.ensureSelectedSongVisible();
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-RIGHT', () => {
      if (isQuitConfirmOpen() || this.settingsOpen || songs.length === 0) return;
      this.selectedSongIndex = Math.min(songs.length - 1, this.selectedSongIndex + 1);
      this.ensureSelectedSongVisible();
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-UP', () => {
      if (isQuitConfirmOpen() || this.settingsOpen) return;
      this.selectedDifficulty = previousDifficulty(this.selectedDifficulty);
      this.persistSessionSettingsPreference();
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-DOWN', () => {
      if (isQuitConfirmOpen() || this.settingsOpen) return;
      this.selectedDifficulty = nextDifficulty(this.selectedDifficulty);
      this.persistSessionSettingsPreference();
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-ENTER', () => {
      if (isQuitConfirmOpen()) return;
      if (this.settingsOpen) {
        closeSettings();
        return;
      }
      void startGame();
    });
    this.input.keyboard?.on('keydown-SPACE', () => {
      if (isQuitConfirmOpen() || this.settingsOpen) return;
      void startGame();
    });
    this.input.keyboard?.on('keydown-ESC', () => {
      requestQuitConfirm();
    });
    if (Capacitor.isNativePlatform()) {
      void import('@capacitor/app')
        .then(async ({ App }) => {
          const backListener = await App.addListener('backButton', () => {
            if (!this.scene.isActive()) return;
            if (this.importInProgress) return;
            requestQuitConfirm();
          });
          const appStateListener = await App.addListener('appStateChange', ({ isActive }) => {
            if (!this.scene.isActive()) return;
            if (isActive) return;
            void this.stopTuner(false);
          });
          this.nativeBackButtonListener = backListener;
          this.nativeAppStateListener = appStateListener;
        })
        .catch((error) => {
          console.warn('Failed to register native app handlers in SongSelectScene', error);
        });
    }

    const bindSongInteractions = (): void => {
      this.songOptions.forEach((option, index) => {
        const selectSong = (): void => {
          if (this.settingsOpen || songs.length === 0) return;
          this.hideSongRemovePrompt();
          this.selectedSongIndex = index;
          refreshSelections();
        };
        const startLongPress = (pointer: Phaser.Input.Pointer): void => {
          if (this.settingsOpen || songs.length === 0 || this.importInProgress) return;
          this.cancelSongLongPress();
          this.songLongPressPointerId = pointer.id;
          this.songLongPressStartX = pointer.worldX;
          this.songLongPressStartY = pointer.worldY;
          this.songLongPressTimer = this.time.delayedCall(SONG_REMOVE_LONG_PRESS_MS, () => {
            this.songLongPressTimer = undefined;
            if (this.songLongPressPointerId !== pointer.id || !pointer.isDown) return;
            if (
              Phaser.Math.Distance.Between(pointer.worldX, pointer.worldY, this.songLongPressStartX, this.songLongPressStartY) >
              SONG_REMOVE_LONG_PRESS_MOVE_TOLERANCE_PX
            ) {
              return;
            }
            this.showSongRemovePrompt(option, () => {
              const liveSong = songs[index];
              if (!liveSong) return;
              void removeSong(liveSong);
            });
          });
        };
        const stopLongPress = (pointer: Phaser.Input.Pointer): void => {
          if (this.songLongPressPointerId !== pointer.id) return;
          this.cancelSongLongPress();
        };
        option.background.on('pointerdown', selectSong);
        option.thumbnail.on('pointerdown', selectSong);
        option.thumbnailImage?.on('pointerdown', selectSong);
        option.thumbLabel?.on('pointerdown', selectSong);
        option.label.on('pointerdown', selectSong);
        option.subLabel.on('pointerdown', selectSong);
        option.background.on('pointerdown', startLongPress);
        option.thumbnail.on('pointerdown', startLongPress);
        option.thumbnailImage?.on('pointerdown', startLongPress);
        option.thumbLabel?.on('pointerdown', startLongPress);
        option.label.on('pointerdown', startLongPress);
        option.subLabel.on('pointerdown', startLongPress);
        option.background.on('pointerup', stopLongPress);
        option.thumbnail.on('pointerup', stopLongPress);
        option.thumbnailImage?.on('pointerup', stopLongPress);
        option.thumbLabel?.on('pointerup', stopLongPress);
        option.label.on('pointerup', stopLongPress);
        option.subLabel.on('pointerup', stopLongPress);
        option.background.on('pointerout', stopLongPress);
        option.thumbnail.on('pointerout', stopLongPress);
        option.thumbnailImage?.on('pointerout', stopLongPress);
        option.thumbLabel?.on('pointerout', stopLongPress);
        option.label.on('pointerout', stopLongPress);
        option.subLabel.on('pointerout', stopLongPress);
      });
    };
    bindSongInteractions();

    const reloadSongsInBackground = async (): Promise<void> => {
      const loadGeneration = ++this.catalogLoadGeneration;
      isCatalogLoading = true;
      refreshSelections();
      try {
        const loadedSongs = await this.readManifestSongs(WEB_STARTUP_CATALOG_POLICY);
        if (!this.scene.isActive() || loadGeneration !== this.catalogLoadGeneration) return;

        songs = loadedSongs;
        this.selectedSongIndex = Phaser.Math.Clamp(this.selectedSongIndex, 0, Math.max(0, songs.length - 1));
        this.hideSongRemovePrompt();
        this.destroySongOptions();
        const nextSongGrid = this.createSongOptions(songs, width, height, labelSize);
        this.songOptions = nextSongGrid.options;
        this.configureSongScroll(nextSongGrid);
        bindSongInteractions();
        this.ensureSelectedSongVisible();
        isCatalogLoading = false;
        loadingSongsLabel.setVisible(false);
        refreshSelections();
        if (WEB_STARTUP_CATALOG_POLICY.lazyCoverLoading === 'visible-first') {
          void this.preloadSongCoverTexturesLazy(songs, WEB_STARTUP_CATALOG_POLICY.coverLoadConcurrency);
        }
      } catch (error) {
        console.warn('Failed to load songs in background', error);
        if (!this.scene.isActive() || loadGeneration !== this.catalogLoadGeneration) return;
        isCatalogLoading = false;
        loadingSongsLabel.setVisible(false);
        refreshSelections();
      }
    };
    this.reloadSongsTask = reloadSongsInBackground;
    void reloadSongsInBackground();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      void this.stopTuner(false);
      if (this.nativeBackButtonListener) {
        void this.nativeBackButtonListener.remove();
        this.nativeBackButtonListener = undefined;
      }
      if (this.nativeAppStateListener) {
        void this.nativeAppStateListener.remove();
        this.nativeAppStateListener = undefined;
      }
      this.coverLoadGeneration += 1;
      this.catalogLoadGeneration += 1;
      this.reloadSongsTask = undefined;
      this.refreshSongSelectUi = undefined;
      this.tunerOpen = false;
      this.tunerPanel = undefined;
      this.quitConfirmOverlay?.container.destroy(true);
      this.quitConfirmOverlay = undefined;
      this.importInProgress = false;
      this.importInput?.remove();
      this.importInput = undefined;
      this.input.off('wheel', onSongWheel);
      this.input.off('pointerdown', onSongPointerDown);
      this.input.off('pointermove', onSongPointerMove);
      this.input.off('pointerup', onSongPointerUp);
      this.input.off('pointerupoutside', onSongPointerUp);
      this.cancelSongLongPress();
      this.hideSongRemovePrompt();
      this.songMaskGraphics?.destroy();
      this.songMaskGraphics = undefined;
      this.destroySongOptions();
      this.songViewportRect = undefined;
      this.songScrollOffset = 0;
      this.songScrollMax = 0;
      this.songScrollDragPointerId = undefined;
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
    for (let i = 0; i < 6; i += 1) {
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

  private destroySongOptions(): void {
    this.hideSongRemovePrompt();
    this.songOptions.forEach((option) => {
      option.glow.destroy();
      option.background.destroy();
      option.thumbnail.destroy();
      option.thumbnailImage?.destroy();
      option.thumbnailImageMaskGraphics?.destroy();
      option.thumbnailImageFrame?.destroy();
      option.thumbLabel?.destroy();
      option.label.destroy();
      option.subLabel.destroy();
    });
    this.songOptions = [];
  }

  private configureSongScroll(view: SongGridView): void {
    this.songScrollOffset = 0;
    this.songScrollMax = Math.max(0, view.contentBottom - (view.viewportTop + view.viewportHeight));
    this.songViewportRect = new Phaser.Geom.Rectangle(view.viewportLeft, view.viewportTop, view.viewportWidth, view.viewportHeight);
    this.songMaskGraphics?.destroy();

    this.songMaskGraphics = this.add.graphics({ x: 0, y: 0 }).setVisible(false);
    this.songMaskGraphics.fillStyle(0xffffff, 1);
    this.songMaskGraphics.fillRect(view.viewportLeft, view.viewportTop, view.viewportWidth, view.viewportHeight);
    const mask = this.songMaskGraphics.createGeometryMask();

    this.songOptions.forEach((option) => {
      option.glow.setMask(mask);
      option.background.setMask(mask);
      option.thumbnail.setMask(mask);
      option.thumbnailImageFrame?.setMask(mask);
      option.thumbLabel?.setMask(mask);
      option.label.setMask(mask);
      option.subLabel.setMask(mask);
    });

    this.applySongScroll();
  }

  private setSongScrollOffset(offset: number): void {
    const clamped = Phaser.Math.Clamp(offset, 0, this.songScrollMax);
    if (Math.abs(clamped - this.songScrollOffset) < 0.1) return;
    this.songScrollOffset = clamped;
    this.applySongScroll();
  }

  private applySongScroll(): void {
    if (!this.songViewportRect) return;
    const viewportTop = this.songViewportRect.top;
    const viewportBottom = this.songViewportRect.bottom;

    this.songOptions.forEach((option) => {
      const y = option.baseY - this.songScrollOffset;
      option.glow.setY(y);
      option.background.setY(y);
      option.thumbnail.setY(y);
      option.thumbnailImage?.setY(y);
      option.thumbnailImageMaskGraphics?.setY(y);
      option.thumbnailImageFrame?.setY(y);
      option.thumbLabel?.setY(y);
      option.label.setY(option.labelBaseY - this.songScrollOffset);
      option.subLabel.setY(option.subLabelBaseY - this.songScrollOffset);
      this.applySongThumbnailViewportCrop(option, viewportTop, viewportBottom);

      const top = y - option.cardHeight / 2;
      const bottom = y + option.cardHeight / 2;
      const intersectsViewport = bottom >= viewportTop + 2 && top <= viewportBottom - 2;
      option.interactiveObjects.forEach((interactiveObject) => {
        if (interactiveObject.input) interactiveObject.input.enabled = intersectsViewport;
      });
    });
  }

  private applySongThumbnailViewportCrop(option: SongOption, viewportTop: number, viewportBottom: number): void {
    const image = option.thumbnailImage;
    if (!image) return;

    const top = image.y - image.displayHeight / 2;
    const bottom = image.y + image.displayHeight / 2;
    const visibleTop = Math.max(top, viewportTop);
    const visibleBottom = Math.min(bottom, viewportBottom);
    const isVisible = visibleBottom > visibleTop + 0.5;

    image.setVisible(isVisible);
    option.thumbnailImageFrame?.setVisible(isVisible);
    if (!isVisible) return;

    const frameHeight = Math.max(1, image.frame.height);
    const frameWidth = Math.max(1, image.frame.width);
    const scaleY = image.displayHeight / frameHeight;
    const cropY = Math.max(0, (visibleTop - top) / scaleY);
    const cropHeight = Math.max(1, (visibleBottom - visibleTop) / scaleY);
    image.setCrop(0, cropY, frameWidth, cropHeight);
  }

  private ensureSelectedSongVisible(): void {
    if (!this.songViewportRect || this.songOptions.length === 0) return;
    const selectedOption = this.songOptions[this.selectedSongIndex];
    if (!selectedOption) return;

    const viewportTop = this.songViewportRect.top + 4;
    const viewportBottom = this.songViewportRect.bottom - 4;
    const optionTop = selectedOption.baseY - this.songScrollOffset - selectedOption.cardHeight / 2;
    const optionBottom = selectedOption.baseY - this.songScrollOffset + selectedOption.cardHeight / 2;

    if (optionTop < viewportTop) {
      this.setSongScrollOffset(this.songScrollOffset - (viewportTop - optionTop));
    } else if (optionBottom > viewportBottom) {
      this.setSongScrollOffset(this.songScrollOffset + (optionBottom - viewportBottom));
    }
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
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 6)}px`
      })
      .setOrigin(0.5);

    const stringsTitleY = panelY - panelHeight * 0.31;
    const stringsTitle = this.add
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
    const fingersTitle = this.add
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
    const fretsTitle = this.add
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
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const targetLabel = this.add
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

    const meterBase = new RoundedBox(this, meterCenterX, meterY, meterHalfWidth * 2, 12, 0x1f2937, 0.95).setStrokeStyle(1, 0x60a5fa, 0.35);
    const meterGreenBand = new RoundedBox(this, meterCenterX, meterY, meterGreenBandHalfWidth * 2, 16, 0x22c55e, 0.45)
      .setStrokeStyle(1, 0x86efac, 0.75);
    const meterCenter = new RoundedBox(this, meterCenterX, meterY, 2, 22, 0xbfdbfe, 0.75);
    const meterNeedle = new RoundedBox(this, meterCenterX, meterY, 8, 24, 0x9ca3af, 1).setStrokeStyle(1, 0x0f172a);

    const detectedLabel = this.add
      .text(panelX, panelY + panelHeight * 0.22, 'Detected: --', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5);

    const calibrationStatus = this.add
      .text(panelX, panelY + panelHeight * 0.3, 'Calibration inactive', {
        color: '#94a3b8',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(11, labelSize - 4)}px`
      })
      .setOrigin(0.5);

    const startButton = new RoundedBox(
      this,
      panelX - panelWidth * 0.29,
      panelY + panelHeight * 0.38,
      Math.min(150, panelWidth * 0.26),
      40,
      0x2563eb,
      1
    )
      .setStrokeStyle(2, 0x93c5fd, 0.8)
      .setInteractive({ useHandCursor: true });
    const startLabel = this.add
      .text(startButton.x, startButton.y, 'Start Tuner', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, labelSize - 2)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const calibrateButton = new RoundedBox(
      this,
      panelX,
      panelY + panelHeight * 0.38,
      Math.min(160, panelWidth * 0.3),
      40,
      0x0f766e,
      1
    )
      .setStrokeStyle(2, 0x5eead4, 0.82)
      .setInteractive({ useHandCursor: true });
    const calibrateLabel = this.add
      .text(calibrateButton.x, calibrateButton.y, 'Calibrate', {
        color: '#ecfeff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const resetCalibrationButton = new RoundedBox(
      this,
      panelX + panelWidth * 0.28,
      panelY + panelHeight * 0.38,
      Math.min(150, panelWidth * 0.26),
      40,
      0x7f1d1d,
      1
    )
      .setStrokeStyle(2, 0xfca5a5, 0.8)
      .setInteractive({ useHandCursor: true });
    const resetCalibrationLabel = this.add
      .text(resetCalibrationButton.x, resetCalibrationButton.y, 'Reset Cal', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const closeButton = new RoundedBox(
      this,
      panelX + panelWidth * 0.37,
      panelY - panelHeight * 0.4,
      86,
      32,
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
    const container = this.add.container(0, 0, allObjects).setDepth(1150).setVisible(false);

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

  private createQuitConfirmOverlay(width: number, height: number, labelSize: number): QuitConfirmOverlay {
    const backdrop = new RoundedBox(this, width / 2, height / 2, width, height, 0x020617, 0.82, 0)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(520, width * 0.62);
    const panelHeight = Math.min(260, height * 0.45);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.96)
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: true });

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.27, 'Quit Application?', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 5)}px`
      })
      .setOrigin(0.5);

    const message = this.add
      .text(panelX, panelY - panelHeight * 0.08, 'Do you want to close the application?', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        align: 'center',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const buttonY = panelY + panelHeight * 0.24;
    const buttonWidth = Math.min(170, panelWidth * 0.36);
    const buttonHeight = 50;

    const cancelButton = new RoundedBox(this, panelX - panelWidth * 0.2, buttonY, buttonWidth, buttonHeight, 0x1e293b, 1)
      .setStrokeStyle(2, 0x64748b, 0.85)
      .setInteractive({ useHandCursor: true });
    const cancelLabel = this.add
      .text(cancelButton.x, cancelButton.y, 'Cancel', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const quitButton = new RoundedBox(this, panelX + panelWidth * 0.2, buttonY, buttonWidth, buttonHeight, 0xef4444, 1)
      .setStrokeStyle(2, 0xfca5a5, 0.85)
      .setInteractive({ useHandCursor: true });
    const quitLabel = this.add
      .text(quitButton.x, quitButton.y, 'Quit', {
        color: '#fff1f2',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const container = this.add
      .container(0, 0, [backdrop, panel, title, message, cancelButton, cancelLabel, quitButton, quitLabel])
      .setDepth(1400)
      .setVisible(false);

    return {
      container,
      backdrop,
      panel,
      cancelButton,
      cancelLabel,
      quitButton,
      quitLabel
    };
  }

  private createSongImportOverlay(width: number, height: number, labelSize: number): SongImportOverlay {
    const panelWidth = Math.min(720, width * 0.78);
    const panelHeight = Math.min(300, height * 0.44);
    const panelX = width / 2;
    const panelY = height / 2;

    const backdrop = new RoundedBox(this, panelX, panelY, width, height, 0x020617, 0.76, 0)
      .setDepth(1300)
      .setInteractive({ useHandCursor: true });
    const panel = new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.97)
      .setStrokeStyle(2, 0x3b82f6, 0.5)
      .setInteractive({ useHandCursor: true });

    const title = this.add
      .text(panelX, panelY - panelHeight * 0.3, 'Import Song', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const stageWrapWidth = panelWidth * 0.88;
    const stageLabel = this.add
      .text(panelX, panelY - panelHeight * 0.05, 'Preparing import...', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(14, labelSize - 1)}px`,
        align: 'center',
        wordWrap: { width: stageWrapWidth, useAdvancedWrap: true }
      })
      .setOrigin(0.5);

    const progressTrackWidth = Math.min(520, panelWidth * 0.82);
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
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const tip = this.add
      .text(panelX, panelY + panelHeight * 0.39, 'Tap/click outside this window to close.', {
        color: '#94a3b8',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);

    const container = this.add
      .container(0, 0, [backdrop, panel, title, stageLabel, progressTrack, progressFill, percentLabel, tip])
      .setDepth(1300)
      .setVisible(false);

    return {
      container,
      backdrop,
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
    overlay.stageLabel.setText(firstNonEmpty(stage, 'Import in progress...') ?? 'Import in progress...');
    overlay.percentLabel.setText(`${Math.round(clamped * 100)}%`);
  }

  private ensureImportInput(): HTMLInputElement {
    if (this.importInput && document.body.contains(this.importInput)) {
      return this.importInput;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mid,.midi,.mp3,.ogg,audio/midi,audio/mid,audio/x-midi,application/midi,application/x-midi,audio/mpeg,audio/ogg';
    input.style.display = 'none';
    document.body.appendChild(input);
    this.importInput = input;
    return input;
  }

  private async refreshSongListAfterImport(): Promise<void> {
    if (this.scene.isActive() && this.reloadSongsTask) {
      try {
        await this.reloadSongsTask();
        return;
      } catch {
        // Fall back to full restart when incremental refresh fails.
      }
    }

    if (this.scene.isActive()) {
      this.scene.restart();
      return;
    }

    const restartWhenActive = (): void => {
      if (!this.scene.isActive()) return;
      this.scene.restart();
    };

    this.events.once(Phaser.Scenes.Events.WAKE, restartWhenActive);
    this.events.once(Phaser.Scenes.Events.RESUME, restartWhenActive);
  }

  private cancelSongLongPress(): void {
    this.songLongPressPointerId = undefined;
    this.songLongPressTimer?.remove(false);
    this.songLongPressTimer = undefined;
  }

  private hideSongRemovePrompt(): void {
    if (!this.songRemovePrompt) return;
    this.songRemovePrompt.button.destroy();
    this.songRemovePrompt.label.destroy();
    this.songRemovePrompt = undefined;
  }

  private showSongRemovePrompt(option: SongOption, onRemove: () => void): void {
    this.hideSongRemovePrompt();

    const buttonWidth = 84;
    const buttonHeight = 28;
    const x = option.background.x + option.background.width * 0.34;
    const y = option.background.y - option.cardHeight * 0.34;
    const button = new RoundedBox(this, x, y, buttonWidth, buttonHeight, 0x7f1d1d, 0.98)
      .setStrokeStyle(1, 0xfca5a5, 0.95)
      .setInteractive({ useHandCursor: true })
      .setDepth(980);
    const label = this.add
      .text(x, y, 'Remove', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(this.scale.width * 0.012))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(981);

    const remove = (): void => {
      this.cancelSongLongPress();
      this.hideSongRemovePrompt();
      onRemove();
    };
    button.on('pointerdown', remove);
    label.on('pointerdown', remove);
    this.songRemovePrompt = { songId: option.song.id, button, label };
  }

  private isPointerInsideObject(pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject): boolean {
    if (!('getBounds' in object) || typeof object.getBounds !== 'function') return false;
    const bounds = object.getBounds();
    return bounds.contains(pointer.worldX, pointer.worldY);
  }

  private async removeSongFromLibrary(song: SongEntry): Promise<void> {
    if (song.id.startsWith('native-')) {
      const { deleteNativeSongById } = await import('../platform/nativeSongLibrary');
      const removed = await deleteNativeSongById(song.id);
      if (!removed) {
        throw new Error('Song not found in native library.');
      }
      return;
    }
    await this.removeSongViaServer(song);
  }

  private async removeSongViaServer(song: SongEntry): Promise<void> {
    const response = await fetch('/api/song-remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songId: song.id,
        folder: song.folder
      })
    });

    if (response.ok) return;
    const payload = (await parseJsonSafe(response)) as { error?: string } | null;
    throw new Error(firstNonEmpty(payload?.error, `Song remove failed (${response.status}).`) ?? 'Song remove failed.');
  }

  private async importSongFile(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    if (this.debugConverterMode === 'ab') {
      throw new Error('Converter mode "ab" is no longer available. Use "legacy" or "neuralnote".');
    }

    if (this.resolveImportRoute() === 'native') {
      await this.importSongFileNative(file, onProgress);
      return;
    }

    await this.importSongFileViaServer(file, onProgress);
  }

  private resolveImportRoute(): 'native' | 'server' {
    if (this.importSourceMode === 'native') return 'native';
    if (this.importSourceMode === 'server') return 'server';
    return Capacitor.isNativePlatform() ? 'native' : 'server';
  }

  private async importSongFileNative(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    const mimeType = file.type && file.type.trim().length > 0 ? file.type : inferUploadMimeType(file.name);
    if (!detectSongImportKind(file.name, mimeType)) {
      throw new Error('Unsupported format. Please upload MIDI, MP3, or OGG.');
    }

    const { importSongNative } = await import('../platform/nativeSongImport');
    await importSongNative(
      file,
      ({ stage, progress }) => {
        onProgress(stage, progress);
      },
      {
        converterMode: this.debugConverterMode
      }
    );
  }

  private async importSongFileViaServer(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    const mimeType = file.type && file.type.trim().length > 0 ? file.type : inferUploadMimeType(file.name);
    if (!detectSongImportKind(file.name, mimeType)) {
      throw new Error('Unsupported format. Please upload MIDI, MP3, or OGG.');
    }
    const body = await file.arrayBuffer();
    if (body.byteLength <= 0) {
      throw new Error('The selected file is empty.');
    }

    const startResponse = await fetch('/api/song-import/start', {
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        'X-Song-File-Name': encodeURIComponent(file.name),
        'X-Song-Converter-Mode': this.debugConverterMode
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

      onProgress(firstNonEmpty(payload.stage, 'Import in progress...') ?? 'Import in progress...', clamp01(payload.progress ?? 0));

      if (payload.status === 'completed') {
        onProgress('Import completed.', 1);
        return;
      }

      if (payload.status === 'failed') {
        throw new Error(firstNonEmpty(payload.error, 'Song import failed.') ?? 'Song import failed.');
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
    const color = abs <= TUNER_IN_TUNE_CENTS ? 0x22c55e : abs <= 15 ? 0xf59e0b : 0xef4444;
    needle.setFillStyle(color, 1);
  }

  private resolveNextTunerString(current: number): number | null {
    const currentIndex = TUNER_SEQUENCE.indexOf(current);
    if (currentIndex >= 0) {
      for (let i = currentIndex + 1; i < TUNER_SEQUENCE.length; i += 1) {
        const candidate = TUNER_SEQUENCE[i];
        if (!this.tunerTunedStrings.has(candidate)) return candidate;
      }
    }

    for (const candidate of TUNER_SEQUENCE) {
      if (!this.tunerTunedStrings.has(candidate)) return candidate;
    }
    return null;
  }

  private async runTunerCalibration(): Promise<void> {
    if (this.tunerCalibrating) return;
    const panel = this.tunerPanel;
    if (!panel) return;

    this.tunerCalibrating = true;
    const wasTunerActive = this.tunerActive;
    let calibrationCtx: AudioContext | undefined;
    let calibrationMicStream: MediaStream | undefined;
    let calibrationDetector: PitchDetectorService | undefined;
    let offPitch: (() => void) | undefined;

    try {
      panel.detectedLabel.setText('Calibration: preparing...');
      panel.calibrationStatus.setText('Requesting microphone and preparing reference tones...');
      this.setTunerNeedleFromCents(null);
      await this.stopTuner(false);

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
        this.setTunerNeedleFromCents(null);

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
      this.tunerCalibrating = false;
      if (wasTunerActive && this.scene.isActive()) {
        await this.startTuner();
      }
    }
  }

  private showCalibrationSummaryPopup(profile: PitchCalibrationProfile): void {
    const width = this.scale.width;
    const height = this.scale.height;
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

    const backdrop = new RoundedBox(this, panelX, panelY, width, height, 0x020617, 0.72, 0).setDepth(1410);
    const panel = new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.98)
      .setStrokeStyle(2, 0x3b82f6, 0.55)
      .setDepth(1411);
    const title = this.add
      .text(panelX, panelY - panelHeight * 0.42, 'Calibration Summary', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, Math.floor(width * 0.028))}px`
      })
      .setOrigin(0.5)
      .setDepth(1412);
    const body = this.add
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
      this.input.off('pointerdown', onAnyPointerDown);
      backdrop.destroy();
      panel.destroy();
      title.destroy();
      body.destroy();
    };

    const onAnyPointerDown = (): void => {
      close();
    };
    this.input.on('pointerdown', onAnyPointerDown);
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

  private async startTuner(): Promise<void> {
    if (this.tunerActive || this.tunerCalibrating) return;
    const panel = this.tunerPanel;
    if (!panel) return;

    try {
      panel.detectedLabel.setText('Detected: requesting mic...');
      this.setTunerNeedleFromCents(null);
      const ctx = new AudioContext();
      this.tunerCtx = ctx;
      if (ctx.state !== 'running') {
        await ctx.resume();
      }

      const micSource = await createMicNode(ctx);
      this.tunerMicStream = micSource.mediaStream;
      const detector = new PitchDetectorService(ctx, {
        roundMidi: false,
        calibrationProfile: this.pitchCalibrationProfile
      });
      await detector.init();
      this.tunerDetector = detector;
      this.tunerTunedStrings.clear();
      this.tunerInTuneStreakStartSeconds = null;
      this.tunerPitchStabilizer.reset();
      this.tunerOffPitch = detector.onPitch((frame) => {
        const targetMidi = STANDARD_TUNING[this.tunerTargetString];
        const stabilized = this.tunerPitchStabilizer.update(frame, targetMidi);
        if (!stabilized) {
          this.tunerInTuneStreakStartSeconds = null;
          panel.detectedLabel.setText('Detected: --');
          this.setTunerNeedleFromCents(null);
          return;
        }

        const cents = stabilized.cents;
        const inTuneZone = Math.abs(cents) <= TUNER_IN_TUNE_CENTS;
        if (inTuneZone) {
          if (this.tunerInTuneStreakStartSeconds === null) {
            this.tunerInTuneStreakStartSeconds = frame.t_seconds;
          }
          const heldInTuneSeconds = Math.max(0, frame.t_seconds - this.tunerInTuneStreakStartSeconds);
          if (
            heldInTuneSeconds >= TUNER_AUTO_ADVANCE_HOLD_SECONDS &&
            !this.tunerTunedStrings.has(this.tunerTargetString)
          ) {
            const tunedString = this.tunerTargetString;
            this.tunerTunedStrings.add(tunedString);
            this.tunerInTuneStreakStartSeconds = null;
            const nextString = this.resolveNextTunerString(tunedString);
            if (nextString !== null) {
              this.tunerTargetString = nextString;
              this.tunerPitchStabilizer.reset();
              panel.detectedLabel.setText(`Detected: String ${tunedString} tuned OK -> String ${nextString}`);
              this.setTunerNeedleFromCents(null);
            } else {
              panel.detectedLabel.setText('Detected: all strings tuned');
              this.setTunerNeedleFromCents(0);
            }
            this.refreshSongSelectUi?.();
            return;
          }
        } else {
          this.tunerInTuneStreakStartSeconds = null;
        }

        const sign = cents >= 0 ? '+' : '';
        const detected = midiToNoteName(stabilized.detectedMidi);
        panel.detectedLabel.setText(`Detected: ${detected} (${sign}${Math.round(cents)}c)`);
        this.setTunerNeedleFromCents(cents);
      });
      detector.start(micSource);

      this.tunerActive = true;
      panel.detectedLabel.setText('Detected: listening...');
      this.setTunerNeedleFromCents(null);
    } catch (error) {
      console.error('Failed to start tuner', error);
      const reason = describeMicFailure(error);
      await this.stopTuner(false);
      panel.detectedLabel.setText(
        reason ? `Mic unavailable (${truncateLabel(reason, 26)})` : 'Mic unavailable'
      );
      this.setTunerNeedleFromCents(null);
    }
  }

  private async stopTuner(clearDetectedText: boolean): Promise<void> {
    this.tunerDetector?.stop();
    this.tunerDetector = undefined;
    this.tunerInTuneStreakStartSeconds = null;
    this.tunerPitchStabilizer.reset();
    this.tunerOffPitch?.();
    this.tunerOffPitch = undefined;
    releaseMicStream(this.tunerMicStream);
    this.tunerMicStream = undefined;

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
    const defaultPreset = DIFFICULTY_PRESETS[this.selectedDifficulty];
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

    this.selectedDifficulty = stored.difficulty;
    this.selectedStrings = new Set(sanitizeSettingValues(stored.selectedStrings, 1, 6));
    this.selectedFingers = new Set(sanitizeSettingValues(stored.selectedFingers, 1, 4));
    this.selectedFrets = new Set(sanitizeSettingValues(stored.selectedFrets, 0, 21));
  }

  private persistSessionSettingsPreference(): void {
    saveSessionSettingsPreference({
      difficulty: this.selectedDifficulty,
      selectedStrings: sortedValues(this.selectedStrings),
      selectedFingers: sortedValues(this.selectedFingers),
      selectedFrets: sortedValues(this.selectedFrets)
    });
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

  private async readManifestSongs(policy: SongCatalogLoadPolicy): Promise<SongEntry[]> {
    const fallbackManifestSongs: SongManifestEntry[] = [
      {
        id: 'example',
        name: 'Example Song',
        folder: 'example',
        cover: 'cover.svg',
        midi: 'song.mid',
        audio: 'song.mp3',
        highScore: 0
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
      await Promise.all(mergedSongs.map((rawSong, index) => this.resolveSongEntry(rawSong, index, policy)))
    ).filter((song): song is SongEntry => song !== null);

    if (songs.length > 0) return songs;

    // Last-resort fallback in case the manifest exists but all entries are invalid/missing MIDI.
    const fallbackSongs = (
      await Promise.all(
        fallbackManifestSongs.map((rawSong, index) =>
          this.resolveSongEntry(rawSong, mergedSongs.length + index, policy)
        )
      )
    ).filter((song): song is SongEntry => song !== null);
    return fallbackSongs;
  }

  private async readNativeManifestSongs(): Promise<SongManifestEntry[]> {
    if (!Capacitor.isNativePlatform()) return [];

    try {
      const { readNativeSongCatalogEntries } = await import('../platform/nativeSongCatalog');
      const nativeEntries = await readNativeSongCatalogEntries();
      return nativeEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        folder: entry.folder,
        cover: entry.cover,
        midi: entry.midi,
        audio: entry.audio,
        highScore: entry.highScore
      }));
    } catch (error) {
      console.warn('Failed to load native song catalog', error);
      return [];
    }
  }

  private async resolveSongEntry(
    rawSong: SongManifestEntry,
    index: number,
    policy: SongCatalogLoadPolicy
  ): Promise<SongEntry | null> {
    const folder = normalizeFolder(rawSong.folder);
    if (!folder) return null;

    const midiField = firstNonEmpty(rawSong.midi, rawSong.file);
    if (!midiField) return null;
    const midiUrl = this.resolveSongAssetPath(folder, midiField);
    if (policy.validateAssetsOnStartup && !(await this.assetExists(midiUrl))) return null;

    let coverUrl = DEFAULT_SONG_COVER_URL;
    if (rawSong.cover && rawSong.cover.trim().length > 0) {
      const requestedCover = this.resolveSongAssetPath(folder, rawSong.cover);
      if (!policy.validateAssetsOnStartup || (await this.assetExists(requestedCover))) {
        coverUrl = requestedCover;
      }
    }

    let audioUrl = midiUrl;
    let usesMidiFallback = !rawSong.audio;
    if (rawSong.audio && rawSong.audio.trim().length > 0) {
      const requestedAudio = this.resolveSongAssetPath(folder, rawSong.audio);
      if (!policy.validateAssetsOnStartup || (await this.assetExists(requestedAudio))) {
        audioUrl = requestedAudio;
        usesMidiFallback = false;
      } else {
        usesMidiFallback = true;
      }
    }

    const coverTextureKey =
      coverUrl === DEFAULT_SONG_COVER_URL ? DEFAULT_SONG_COVER_TEXTURE_KEY : `song-cover-${sanitizeKey(rawSong.id)}-${index}`;
    const highScore = resolveSongHighScore(rawSong.id, rawSong.highScore);

    return {
      id: rawSong.id,
      name: rawSong.name,
      folder,
      cover: coverUrl,
      midi: midiUrl,
      audio: audioUrl,
      highScore,
      usesMidiFallback,
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
    const now = Date.now();
    if (cached) {
      if (cached.exists) return true;
      if ((cached.expiresAtMs ?? 0) > now) return false;
      this.assetExistenceCache.delete(url);
    }

    const capacitorFileUrl = isCapacitorFileUrl(url);
    const requestUrl = url;

    if (!capacitorFileUrl) {
      try {
        const headResponse = await fetch(requestUrl, { method: 'HEAD', cache: 'no-store' });
        if (headResponse.ok) {
          const exists = isValidAssetResponse(url, headResponse);
          this.assetExistenceCache.set(
            url,
            exists ? { exists: true } : { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS }
          );
          return exists;
        }
        if (headResponse.status !== 405 && headResponse.status !== 501) {
          this.assetExistenceCache.set(url, { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS });
          return false;
        }
      } catch {
        // Ignore and fallback to GET.
      }
    }

    try {
      const getResponse = await fetch(requestUrl, { method: 'GET', cache: 'no-store' });
      const exists = getResponse.ok && (capacitorFileUrl || isValidAssetResponse(url, getResponse));
      this.assetExistenceCache.set(
        url,
        exists ? { exists: true } : { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS }
      );
      return exists;
    } catch {
      this.assetExistenceCache.set(url, { exists: false, expiresAtMs: now + ASSET_NEGATIVE_CACHE_TTL_MS });
      return false;
    }
  }

  private async validateSongBeforeStart(song: SongEntry): Promise<SongEntry | null> {
    const midiExists = await this.assetExists(song.midi);
    if (!midiExists) return null;

    let audioUrl = song.midi;
    let usesMidiFallback = true;
    if (song.audio && song.audio !== song.midi) {
      if (await this.assetExists(song.audio)) {
        audioUrl = song.audio;
        usesMidiFallback = false;
      }
    }

    let coverUrl = DEFAULT_SONG_COVER_URL;
    let coverTextureKey = DEFAULT_SONG_COVER_TEXTURE_KEY;
    if (song.cover && song.cover !== DEFAULT_SONG_COVER_URL) {
      if (await this.assetExists(song.cover)) {
        coverUrl = song.cover;
        coverTextureKey = song.coverTextureKey;
      }
    }

    return {
      ...song,
      cover: coverUrl,
      coverTextureKey,
      audio: audioUrl,
      usesMidiFallback
    };
  }

  private async preloadSongCoverTexturesLazy(songs: SongEntry[], concurrency: number): Promise<void> {
    const coversToLoad = songs.filter(
      (song) =>
        song.coverTextureKey !== DEFAULT_SONG_COVER_TEXTURE_KEY &&
        !this.textures.exists(song.coverTextureKey) &&
        song.cover.trim().length > 0
    );
    if (coversToLoad.length === 0) return;

    const visibleSongIds = new Set(
      this.songOptions
        .filter((option) => this.songViewportRect?.contains(option.background.x, option.background.y) ?? false)
        .map((option) => option.song.id)
    );
    const prioritized = [
      ...coversToLoad.filter((song) => visibleSongIds.has(song.id)),
      ...coversToLoad.filter((song) => !visibleSongIds.has(song.id))
    ];

    const safeConcurrency = Math.max(1, Math.floor(concurrency));
    const generation = ++this.coverLoadGeneration;
    for (let index = 0; index < prioritized.length; index += safeConcurrency) {
      if (!this.scene.isActive() || generation !== this.coverLoadGeneration) return;
      const batch = prioritized.slice(index, index + safeConcurrency);
      await this.loadSongCoverBatch(batch);
      if (!this.scene.isActive() || generation !== this.coverLoadGeneration) return;
      this.refreshLoadedSongCoverTextures();
      await waitMs(0);
    }
  }

  private async loadSongCoverBatch(batch: SongEntry[]): Promise<void> {
    if (batch.length === 0) return;

    await new Promise<void>((resolve) => {
      const failedKeys = new Set<string>();
      const onFileError = (file: Phaser.Loader.File): void => {
        failedKeys.add(file.key);
      };
      const onComplete = (): void => {
        this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileError);
        if (failedKeys.size > 0) {
          batch.forEach((song) => {
            if (failedKeys.has(song.coverTextureKey)) {
              song.cover = DEFAULT_SONG_COVER_URL;
              song.coverTextureKey = DEFAULT_SONG_COVER_TEXTURE_KEY;
            }
          });
        }
        resolve();
      };

      this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onFileError);
      this.load.once(Phaser.Loader.Events.COMPLETE, onComplete);
      batch.forEach((song) => {
        if (this.textures.exists(song.coverTextureKey)) return;
        if (song.cover.toLowerCase().endsWith('.svg')) {
          this.load.svg(song.coverTextureKey, song.cover);
        } else {
          this.load.image(song.coverTextureKey, song.cover);
        }
      });
      this.load.start();
    });
  }

  private refreshLoadedSongCoverTextures(): void {
    this.songOptions.forEach((option) => {
      const image = option.thumbnailImage;
      if (!image) return;
      const hasSongCoverTexture = this.textures.exists(option.song.coverTextureKey);
      const hasDefaultCoverTexture = this.textures.exists(DEFAULT_SONG_COVER_TEXTURE_KEY);
      const key =
        option.song.usesMidiFallback || !hasSongCoverTexture
          ? hasDefaultCoverTexture
            ? DEFAULT_SONG_COVER_TEXTURE_KEY
            : option.song.coverTextureKey
          : option.song.coverTextureKey;
      const needsResize =
        Math.abs(image.displayWidth - option.thumbnailImageSize) > 0.5 ||
        Math.abs(image.displayHeight - option.thumbnailImageSize) > 0.5;
      if (image.texture.key === key && !needsResize) return;
      if (image.texture.key !== key) image.setTexture(key);
      image.setDisplaySize(option.thumbnailImageSize, option.thumbnailImageSize);
      image.setCrop();
      if (this.songViewportRect) {
        this.applySongThumbnailViewportCrop(option, this.songViewportRect.top, this.songViewportRect.bottom);
      }
    });
  }

  private createSongOptions(songs: SongEntry[], width: number, height: number, labelSize: number): SongGridView {
    const options: SongOption[] = [];
    const cols = 2;
    const gridLeft = width * 0.04;
    const gridTop = height * 0.24;
    const gridWidth = width * 0.56;
    const buttonWidth = Math.min(266, gridWidth / cols - 14);
    const buttonHeight = Math.min(122, height * 0.22);
    const gapX = Math.max(12, width * 0.014);
    const gapY = Math.max(14, height * 0.028);
    const viewportLeft = gridLeft - 8;
    const viewportTop = Math.max(height * 0.2, gridTop - buttonHeight * 0.52);
    const viewportRight = gridLeft + gridWidth + 8;
    const viewportBottom = Math.min(height * 0.8, height - Math.max(96, buttonHeight * 0.85));
    const viewportHeight = Math.max(buttonHeight + 16, viewportBottom - viewportTop);
    let contentBottom = gridTop;

    songs.forEach((song, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = gridLeft + buttonWidth / 2 + col * (buttonWidth + gapX);
      const y = gridTop + buttonHeight / 2 + row * (buttonHeight + gapY);
      const labelY = y - buttonHeight * 0.12;
      const subLabelY = y + buttonHeight * 0.2;
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

      const hasSongCoverTexture = this.textures.exists(song.coverTextureKey);
      const hasDefaultCoverTexture = this.textures.exists(DEFAULT_SONG_COVER_TEXTURE_KEY);
      const thumbnailTextureKey =
        song.usesMidiFallback || !hasSongCoverTexture
          ? hasDefaultCoverTexture
            ? DEFAULT_SONG_COVER_TEXTURE_KEY
            : song.coverTextureKey
          : song.coverTextureKey;
      const thumbnailImageSize = thumbnailSize - 2;
      const thumbnailCornerRadius = Math.max(7, Math.round(thumbnailImageSize * 0.13));
      const thumbnailImage = this.add
        .image(thumbnail.x, thumbnail.y, thumbnailTextureKey)
        .setDisplaySize(thumbnailImageSize, thumbnailImageSize)
        .setInteractive({ useHandCursor: true });
      const thumbnailImageMaskGraphics = thumbnailImage
        ? this.add
            .graphics({ x: thumbnail.x, y: thumbnail.y })
            .setVisible(false)
            .fillStyle(0xffffff, 1)
            .fillRoundedRect(
              -thumbnailImageSize / 2,
              -thumbnailImageSize / 2,
              thumbnailImageSize,
              thumbnailImageSize,
              thumbnailCornerRadius
            )
        : undefined;
      if (thumbnailImage && thumbnailImageMaskGraphics) {
        thumbnailImage.setMask(thumbnailImageMaskGraphics.createGeometryMask());
      }
      const thumbnailImageFrame = new RoundedBox(
        this,
        thumbnail.x,
        thumbnail.y,
        thumbnailImageSize,
        thumbnailImageSize,
        0xffffff,
        0,
        thumbnailCornerRadius
      ).setStrokeStyle(3, 0xffffff, 0.76);
      const thumbLabel = undefined;

      const label = this.add
        .text(x - buttonWidth * 0.02, labelY, song.name, {
          color: '#cbd5e1',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(17, labelSize + 2)}px`,
          wordWrap: { width: buttonWidth * 0.38, useAdvancedWrap: true }
        })
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true });
      this.fitSongTitleText(label, buttonWidth * 0.38, buttonHeight * 0.34, Math.max(17, labelSize + 2), 11);

      const subLabel = this.add
        .text(
          x - buttonWidth * 0.02,
          subLabelY,
          `${song.usesMidiFallback ? 'MIDI • ' : ''}Best: ${song.highScore}`,
          {
          color: '#64748b',
          fontFamily: 'Montserrat, sans-serif',
          fontSize: `${Math.max(12, labelSize - 2)}px`
          }
        )
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true });

      const interactiveObjects: Phaser.GameObjects.GameObject[] = [background, thumbnail, thumbnailImage, label, subLabel];

      options.push({
        song,
        label,
        subLabel,
        background,
        glow,
        thumbnail,
        thumbnailImageSize,
        thumbnailImage,
        thumbnailImageMaskGraphics,
        thumbnailImageFrame,
        thumbLabel,
        baseY: y,
        labelBaseY: labelY,
        subLabelBaseY: subLabelY,
        cardHeight: buttonHeight,
        interactiveObjects
      });

      contentBottom = Math.max(contentBottom, y + buttonHeight / 2);
    });

    return {
      options,
      viewportLeft,
      viewportTop,
      viewportWidth: viewportRight - viewportLeft,
      viewportHeight,
      contentBottom
    };
  }

  private createDifficultyDropdown(width: number, labelSize: number, triggerY: number): DifficultyDropdown {
    const triggerX = width * 0.79;
    const fontSize = Math.max(15, labelSize + 1);
    const measurementLabel = this.add
      .text(triggerX, triggerY, 'Medium', {
        color: '#f8fafc',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${fontSize}px`
      })
      .setOrigin(0.5)
      .setVisible(false);
    const horizontalPadding = Math.max(34, Math.floor(labelSize * 1.8));
    const buttonWidth = Math.ceil(measurementLabel.width + horizontalPadding);
    const buttonHeight = Math.min(54, Math.max(42, this.scale.height * 0.08));

    const trigger = new RoundedBox(this, triggerX, triggerY, buttonWidth, buttonHeight, 0x1a2a53, 0.72)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true })
      .setDepth(90);
    const label = measurementLabel
      .setText(this.selectedDifficulty)
      .setStyle({
        color: '#f8fafc',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${fontSize}px`
      })
      .setOrigin(0.5)
      .setVisible(true)
      .setInteractive({ useHandCursor: true })
      .setDepth(91);
    return { trigger, label };
  }

  private fitSongTitleText(
    label: Phaser.GameObjects.Text,
    maxWidth: number,
    maxHeight: number,
    startFontSize: number,
    minFontSize: number
  ): void {
    const minSize = Math.max(8, Math.floor(minFontSize));
    let fontSize = Math.max(minSize, Math.floor(startFontSize));

    label.setWordWrapWidth(maxWidth, true);
    while (fontSize >= minSize) {
      label.setFontSize(fontSize);
      const bounds = label.getBounds();
      if (bounds.width <= maxWidth + 0.5 && bounds.height <= maxHeight + 0.5) {
        return;
      }
      fontSize -= 1;
    }
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
          fontFamily: 'Montserrat, sans-serif',
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
      const background = new RoundedBox(this, x, centerY, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.add
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

      const background = new RoundedBox(this, x, y, buttonWidth, buttonHeight, 0x1a2a53, 0.68)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const label = this.add
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

function toSongManifestEntry(value: unknown): SongManifestEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string' || typeof data.name !== 'string') return null;

  const folder = typeof data.folder === 'string' && data.folder.trim().length > 0 ? data.folder : data.id;
  const cover = typeof data.cover === 'string' ? data.cover : undefined;
  const midi = typeof data.midi === 'string' ? data.midi : undefined;
  const audio = typeof data.audio === 'string' ? data.audio : undefined;
  const file = typeof data.file === 'string' ? data.file : undefined;
  const highScore =
    typeof data.highScore === 'number' && Number.isFinite(data.highScore) && data.highScore >= 0
      ? Math.round(data.highScore)
      : undefined;

  return {
    id: data.id,
    name: data.name,
    folder,
    cover,
    midi,
    audio,
    file,
    highScore
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

async function requestQuitApplication(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { App } = await import('@capacitor/app');
      App.exitApp();
      return true;
    } catch (error) {
      console.warn('Failed to quit native app', error);
      return false;
    }
  }

  if (isElectronRuntime() && typeof window !== 'undefined') {
    window.close();
    return true;
  }

  return false;
}

function isElectronRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /electron/i.test(navigator.userAgent);
}

function truncateLabel(value: string, maxLength: number): string {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function inferUploadMimeType(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.mid') || lowered.endsWith('.midi')) {
    return 'audio/midi';
  }
  if (lowered.endsWith('.ogg') || lowered.endsWith('.oga') || lowered.endsWith('.opus')) {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

function detectSongImportKind(fileName: string, mimeType: string): 'audio' | 'midi' | null {
  const lowered = fileName.toLowerCase();
  if (/\.(mid|midi)$/i.test(lowered)) return 'midi';
  if (/\.(mp3|ogg)$/i.test(lowered)) return 'audio';

  const loweredMime = String(mimeType || '').toLowerCase();
  if (/^(audio\/midi|audio\/mid|audio\/x-midi|audio\/sp-midi|application\/midi|application\/x-midi)/i.test(loweredMime)) {
    return 'midi';
  }
  if (/^audio\/(mpeg|mp3|ogg|x-ogg|opus)/i.test(loweredMime)) {
    return 'audio';
  }
  return null;
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

function describeMicFailure(error: unknown): string | null {
  const name = extractErrorName(error);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'no microphone found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'microphone busy in another app';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'unsupported audio constraints';
    case 'SecurityError':
      return 'runtime security policy blocked mic';
    case 'AbortError':
      return 'microphone start aborted by system';
    default: {
      const message = extractErrorMessage(error);
      if (message) return message;
      return name ? name : null;
    }
  }
}

function extractErrorName(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if (!('name' in error)) return null;
  const rawName = (error as { name?: unknown }).name;
  if (typeof rawName !== 'string') return null;
  const normalized = rawName.trim();
  return normalized.length > 0 ? normalized : null;
}

function extractErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if (!('message' in error)) return null;
  const rawMessage = (error as { message?: unknown }).message;
  if (typeof rawMessage !== 'string') return null;
  const normalized = rawMessage.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function isImportSourceDebugEnabled(): boolean {
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

function parseDebugConverterMode(value: string | null): DebugConverterMode | null {
  if (value === 'legacy' || value === 'neuralnote' || value === 'ab') {
    return value;
  }
  return null;
}

function loadDebugConverterModePreference(): DebugConverterMode {
  if (typeof window === 'undefined') return 'legacy';

  const params = new URLSearchParams(window.location.search);
  const fromQuery = parseDebugConverterMode(params.get('debugConverterMode'));
  if (fromQuery) {
    window.localStorage.setItem(DEBUG_CONVERTER_MODE_STORAGE_KEY, fromQuery);
    return fromQuery;
  }

  const fromStorage = parseDebugConverterMode(window.localStorage.getItem(DEBUG_CONVERTER_MODE_STORAGE_KEY));
  return fromStorage ?? 'legacy';
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

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
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

function sanitizeSettingValues(values: number[], min: number, max: number): number[] {
  const unique = new Set<number>();
  values.forEach((value) => {
    if (!Number.isInteger(value)) return;
    if (value < min || value > max) return;
    unique.add(value);
  });
  return Array.from(unique).sort((a, b) => a - b);
}
