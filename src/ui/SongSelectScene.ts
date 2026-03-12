import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { IMPORT_DEBUG_LOG_ENABLED } from '../platform/importDebugConfig';
import {
  SONG_REMOVE_LONG_PRESS_MOVE_TOLERANCE_PX,
  SONG_REMOVE_LONG_PRESS_MS,
  WEB_STARTUP_CATALOG_POLICY
} from './song-select/constants';
import { SongGridController } from './song-select/controllers/SongGridController';
import { SongImportController } from './song-select/controllers/SongImportController';
import { SongLifecycleController } from './song-select/controllers/SongLifecycleController';
import { SongSessionController } from './song-select/controllers/SongSessionController';
import { SongTunerController } from './song-select/controllers/SongTunerController';
import { SongCatalogService } from './song-select/services/SongCatalogService';
import type {
  AssetExistenceCacheEntry,
  Difficulty,
  DifficultyDropdown,
  ImportSourceMode,
  ImportSourceToggleOption,
  SongCatalogLoadPolicy,
  SongEntry
} from './song-select/types';
import {
  firstNonEmpty,
  parseJsonSafe,
  toErrorMessage,
  truncateLabel
} from './song-select/utils/songSelectUtils';
import { RoundedBox } from './RoundedBox';

export class SongSelectScene extends Phaser.Scene {
  private readonly assetExistenceCache = new Map<string, AssetExistenceCacheEntry>();
  private readonly songCatalogService = new SongCatalogService(this, this.assetExistenceCache);
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

    const startScale = Math.SQRT2;
    const startButtonWidth = Math.min(Math.round(388 * startScale), width * 0.82);
    const startButtonHeight = Math.round(62 * 1.08);
    const startY = height - startButtonHeight / 2 - 16;
    const startTopY = startY - startButtonHeight / 2;
    const songGridController = new SongGridController(this, {
      isPointerBlocked: () => isQuitConfirmOpen() || importController.isOverlayVisible(),
      canSelectSong: () => !settingsController.isOpen() && songs.length > 0,
      canStartLongPressRemove: () => !settingsController.isOpen() && songs.length > 0 && !importController.isInProgress(),
      getViewportBottomLimitY: () => startTopY - 12,
      onSelectionChanged: () => refreshSelections(),
      onRequestRemoveSong: (song) => void removeSong(song),
      longPressMs: SONG_REMOVE_LONG_PRESS_MS,
      longPressMoveTolerancePx: SONG_REMOVE_LONG_PRESS_MOVE_TOLERANCE_PX
    });
    songGridController.initialize(songs, width, height, labelSize);

    const sideLayoutScale = Phaser.Math.Clamp(height / 540, 0.6, 1);
    const sideButtonWidth = Math.min(300, width * 0.3);
    const sideButtonsBottomGapFromStart = 14;
    const difficultyButtonHeight = Math.min(54, Math.max(42, height * 0.08));
    const sideTopSafeInset = Math.max(20, Math.round(height * 0.06));
    const minDifficultyButtonY = sideTopSafeInset + difficultyButtonHeight / 2;
    const preferredDifficultyButtonY = height * 0.21;
    const difficultyButtonY = Math.max(preferredDifficultyButtonY, minDifficultyButtonY);
    const availableSideSpan = startTopY - sideButtonsBottomGapFromStart - difficultyButtonY;
    const minimumInterButtonGap = 10;
    const maxSideButtonHeightForFit = Math.floor((availableSideSpan - minimumInterButtonGap * 4) / 4.5);
    const preferredSideButtonHeight = Math.round(50 * sideLayoutScale);
    const fittedSideButtonHeight = Phaser.Math.Clamp(Math.min(preferredSideButtonHeight, maxSideButtonHeightForFit), 30, 50);
    const sideButtonHeight = Math.max(27, fittedSideButtonHeight - 3);
    const preferredInterButtonGap = Math.round(Phaser.Math.Clamp(22 * sideLayoutScale, 12, 22));
    const preferredSideCenterStep = sideButtonHeight + preferredInterButtonGap;
    const maxSideCenterStep = (availableSideSpan - sideButtonHeight / 2) / 4;
    const sideCenterStep = Math.min(preferredSideCenterStep, maxSideCenterStep);
    const importButtonY = difficultyButtonY + sideCenterStep;
    const settingsButtonY = importButtonY + sideCenterStep;
    const tunerButtonY = settingsButtonY + sideCenterStep;
    const practiceButtonY = tunerButtonY + sideCenterStep;
    const settingsController = new SongSessionController(this, {
      onStateChanged: () => refreshSelections(),
      onScoresReset: async () => {
        await this.refreshSongListAfterImport();
      }
    });
    settingsController.initialize(width, height, labelSize);
    const difficultyDropdown = this.createDifficultyDropdown(
      width,
      labelSize,
      difficultyButtonY,
      settingsController.getDifficulty()
    );
    const sideIconSize = Math.max(16, Math.min(26, Math.floor(labelSize * 1.5), Math.floor(sideButtonHeight * 0.56)));
    const sideButtonFontSize = Math.max(14, Math.min(Math.max(17, labelSize + 2), Math.floor(sideButtonHeight * 0.48)));
    const settingsButton = new RoundedBox(this, width * 0.79, settingsButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const settingsIcon = this.textures.exists('uiSettingsIcon')
      ? (() => {
          const icon = this.add
            .image(settingsButton.x - sideButtonWidth * 0.33, settingsButtonY, 'uiSettingsIcon')
            .setInteractive({ useHandCursor: true });
          const scaleFromNative = sideIconSize / Math.max(icon.width, icon.height);
          icon.setScale(scaleFromNative);
          return icon;
        })()
      : undefined;
    const settingsLabel = this.add
      .text(settingsButton.x + (settingsIcon ? sideButtonWidth * 0.04 : 0), settingsButtonY, 'Settings', {
        color: '#f1f5f9',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${sideButtonFontSize}px`
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
        fontSize: `${sideButtonFontSize}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const baseSideSummaryOffset = Math.max(16, Math.min(sideButtonHeight / 2 + 10, sideCenterStep - sideButtonHeight / 2 - 6));
    const sideSummaryOffset = Math.round(Math.max(14, baseSideSummaryOffset - 2));
    const tunerSummary = this.add
      .text(tunerButton.x, tunerButtonY + sideSummaryOffset, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5)
      .setVisible(false);
    const practiceButton = new RoundedBox(
      this,
      width * 0.79,
      practiceButtonY,
      sideButtonWidth,
      sideButtonHeight,
      0x1a2a53,
      0.74
    )
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const practiceIcon = this.textures.exists('uiGuitarIcon')
      ? this.add
          .image(practiceButton.x - sideButtonWidth * 0.33, practiceButtonY, 'uiGuitarIcon')
          .setDisplaySize(sideIconSize, sideIconSize)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const practiceLabel = this.add
      .text(practiceButton.x + (practiceIcon ? sideButtonWidth * 0.04 : 0), practiceButtonY, 'Practice', {
        color: '#f1f5f9',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${sideButtonFontSize}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const settingsSummary = this.add
      .text(settingsButton.x, settingsButtonY + sideSummaryOffset, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const importButton = new RoundedBox(this, width * 0.79, importButtonY, sideButtonWidth, sideButtonHeight, 0x1a2a53, 0.74)
      .setStrokeStyle(2, 0x3b82f6, 0.35)
      .setInteractive({ useHandCursor: true });
    const importIcon = this.textures.exists('uiImportIcon')
      ? this.add
          .image(importButton.x - sideButtonWidth * 0.33, importButtonY, 'uiImportIcon')
          .setDisplaySize(sideIconSize, sideIconSize)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const importLabel = this.add
      .text(importButton.x + (importIcon ? sideButtonWidth * 0.04 : 0), importButtonY, 'Import Your Song', {
        color: '#f1f5f9',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(13, sideButtonFontSize - 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const importSummary = this.add
      .text(importButton.x, importButtonY + sideSummaryOffset, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);
    const importLogShareButton = Capacitor.isNativePlatform() && IMPORT_DEBUG_LOG_ENABLED
      ? new RoundedBox(
          this,
          importButton.x + sideButtonWidth * 0.295,
          importButtonY - sideButtonHeight * 0.28,
          Math.min(102, sideButtonWidth * 0.34),
          22,
          0x0f766e,
          0.96
        )
          .setStrokeStyle(1, 0x5eead4, 0.86)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const importLogShareLabel = importLogShareButton
      ? this.add
          .text(importLogShareButton.x, importLogShareButton.y, 'Share Log', {
            color: '#ecfeff',
            fontFamily: 'Montserrat, sans-serif',
            fontStyle: 'bold',
            fontSize: `${Math.max(10, labelSize - 5)}px`
          })
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true })
      : undefined;
    const importController = new SongImportController(this, {
      onBeforeOpenPicker: () => songGridController.hideRemovePrompt(),
      onStateChanged: () => refreshSelections(),
      onRefreshSongList: async () => this.refreshSongListAfterImport()
    });
    importController.initialize(width, height, labelSize);
    const showImportSourceDebug = importController.getSnapshot().showSourceDebug;
    const importSourceScale = 0.7;
    const importSourceDebugWidth = Math.min(300, width * 0.38) * importSourceScale;
    const importSourceDebugCenterX = 14 + importSourceDebugWidth / 2;
    const importSourceDebugButtonHeight = 30 * importSourceScale;
    const importSourceGapFromSongs = 14;
    const importSourceDebugMinCenterY = importSourceDebugButtonHeight / 2 + 26;
    const importSourceDebugToggleY = Math.max(
      importSourceDebugMinCenterY,
      songGridController.getViewportTop() - importSourceDebugButtonHeight / 2 - importSourceGapFromSongs
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

    const hint = this.add
      .text(width / 2, height * 0.84, '', {
        color: '#fca5a5',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(13, Math.floor(width * 0.015))}px`
      })
      .setOrigin(0.5)
      .setVisible(false);

    const playIconSize = Math.min(60, labelSize + 24);
    const startButton = new RoundedBox(this, width / 2, startY, startButtonWidth, startButtonHeight, 0xf97316, 1)
      .setStrokeStyle(2, 0xfecaca, 0.8)
      .setInteractive({ useHandCursor: true })
      .setDepth(120);
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
    playIcon?.setDepth(startButton.depth + 1);
    startLabel.setDepth(startButton.depth + 1);

    const tunerController = new SongTunerController(this, () => refreshSelections());
    tunerController.initialize(width, height, labelSize);
    const lifecycleController = new SongLifecycleController(this, {
      canOpenQuitPrompt: () => !importController.isInProgress(),
      onBeforeOpenQuitPrompt: () => songGridController.hideRemovePrompt(),
      onAppInactive: () => tunerController.handleAppInactive(),
      onStateChanged: () => refreshSelections()
    });
    lifecycleController.initialize(width, height, labelSize);
    const isQuitConfirmOpen = (): boolean => lifecycleController.isQuitConfirmOpen();
    const requestQuitConfirm = (): void => lifecycleController.requestQuitConfirm();

    const cycleDifficulty = (): void => {
      if (settingsController.isOpen() || importController.isInProgress() || isQuitConfirmOpen()) return;
      settingsController.cycleDifficultyNext();
      refreshSelections();
    };

    const refreshSelections = (): void => {
      const quitPromptOpen = isQuitConfirmOpen();
      const settingsState = settingsController.getSnapshot();
      const importState = importController.getSnapshot();
      const settingsValid = settingsState.valid;
      const hasPlayableSongs = songs.length > 0;
      const canStartSession = settingsValid && hasPlayableSongs && !importState.inProgress && !isCatalogLoading && !quitPromptOpen;
      const difficultyColors: Record<Difficulty, { fill: number; stroke: number }> = {
        Easy: { fill: 0x166534, stroke: 0x4ade80 },
        Medium: { fill: 0x1a2a53, stroke: 0x3b82f6 },
        Hard: { fill: 0x7f1d1d, stroke: 0xfb7185 }
      };
      const difficultyColor = difficultyColors[settingsState.difficulty];

      const songOptions = songGridController.getOptions();
      const selectedSongIndex = songGridController.getSelectedIndex();
      songOptions.forEach((option, index) => {
        const active = index === selectedSongIndex;
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
      difficultyDropdown.label.setText(settingsState.difficulty);
      difficultyDropdown.label.setColor('#f8fafc');

      settingsButton.setFillStyle(settingsState.open ? 0x27457c : 0x1a2a53, settingsState.open ? 0.9 : 0.74);
      settingsButton.setStrokeStyle(2, settingsState.open ? 0x60a5fa : settingsValid ? 0x3b82f6 : 0xfb7185, 0.52);
      settingsLabel.setColor(settingsState.open ? '#e0f2fe' : '#f1f5f9');
      settingsIcon?.setAlpha(settingsState.open ? 1 : 0.94);
      settingsSummary.setText(
        `${settingsState.selectedStringsCount} strings • ${settingsState.selectedFingersCount} fingers • ${settingsState.selectedFretsCount} frets`
      );
      settingsSummary.setColor(settingsValid ? '#a5b4fc' : '#fca5a5');

      const tunerState = tunerController.getSnapshot();
      tunerButton.setFillStyle(tunerState.open ? 0x27457c : 0x1a2a53, tunerState.open ? 0.9 : 0.74);
      tunerButton.setStrokeStyle(2, tunerState.open ? 0x60a5fa : 0x3b82f6, 0.52);
      tunerLabel.setColor(tunerState.open ? '#e0f2fe' : '#f1f5f9');
      tunerIcon?.setAlpha(tunerState.open ? 1 : 0.94);
      const calibrationBadge = tunerState.calibrationPoints > 0 ? `CAL ${tunerState.calibrationPoints}pt` : 'CAL OFF';
      const tunedBadge = `${tunerState.tunedCount}/${tunerState.tunedTotal} tuned`;
      tunerSummary.setText(
        `String ${tunerState.targetString} • ${tunerState.active ? 'ON' : 'OFF'}${tunerState.calibrating ? ' • CAL...' : ''} • ${tunedBadge} • ${calibrationBadge}`
      );
      tunerSummary.setColor(tunerState.calibrating ? '#fde68a' : tunerState.active ? '#86efac' : '#a5b4fc');

      const practiceDisabled = importState.inProgress || quitPromptOpen;
      practiceButton.setFillStyle(practiceDisabled ? 0x334155 : 0x1a2a53, practiceDisabled ? 0.9 : 0.74);
      practiceButton.setStrokeStyle(2, practiceDisabled ? 0x64748b : 0x3b82f6, practiceDisabled ? 0.72 : 0.52);
      practiceLabel.setColor(practiceDisabled ? '#cbd5e1' : '#f1f5f9');
      practiceIcon?.setAlpha(practiceDisabled ? 0.72 : 0.94);

      importButton.setFillStyle(importState.inProgress || quitPromptOpen ? 0x334155 : 0x1a2a53, importState.inProgress || quitPromptOpen ? 0.9 : 0.74);
      importButton.setStrokeStyle(2, importState.inProgress ? 0xf59e0b : 0x3b82f6, importState.inProgress || quitPromptOpen ? 0.82 : 0.52);
      importLabel.setColor(importState.inProgress || quitPromptOpen ? '#fef3c7' : '#f1f5f9');
      importIcon?.setAlpha(importState.inProgress || quitPromptOpen ? 0.78 : 0.94);
      importSummary.setText(
        truncateLabel(importState.inProgress ? 'Import in progress...' : importState.summaryMessage, Math.max(28, Math.floor(width * 0.036)))
      );
      importSummary.setColor(importState.inProgress ? '#fde68a' : importState.summaryColor);
      if (importLogShareButton && importLogShareLabel) {
        const shareDisabled = importState.inProgress || quitPromptOpen || importState.debugShareInProgress;
        importLogShareButton.setFillStyle(shareDisabled ? 0x334155 : 0x0f766e, shareDisabled ? 0.86 : 0.96);
        importLogShareButton.setStrokeStyle(1, shareDisabled ? 0x64748b : 0x5eead4, shareDisabled ? 0.64 : 0.86);
        importLogShareButton.setAlpha(shareDisabled ? 0.76 : 1);
        importLogShareLabel.setText(importState.debugShareInProgress ? 'Sharing...' : 'Share Log');
        importLogShareLabel.setColor(shareDisabled ? '#cbd5e1' : '#ecfeff');
        importLogShareLabel.setAlpha(shareDisabled ? 0.8 : 1);
      }
      importSourceTitle?.setColor(importState.inProgress || quitPromptOpen ? '#fcd34d' : '#94a3b8');
      importSourceToggleOptions.forEach((option) => {
        const active = option.mode === importState.sourceMode;
        option.background.setFillStyle(active ? 0x2563eb : 0x1a2a53, active ? 0.92 : 0.72);
        option.background.setStrokeStyle(1, active ? 0x93c5fd : 0x334155, active ? 0.82 : 0.46);
        option.background.setAlpha(importState.inProgress || quitPromptOpen ? 0.7 : 1);
        option.label.setColor(active ? '#eff6ff' : '#94a3b8');
        option.label.setAlpha(importState.inProgress || quitPromptOpen ? 0.75 : 1);
      });

      startButton.setFillStyle(canStartSession ? 0xf97316 : 0x9f1239, 1);
      startButton.setStrokeStyle(2, canStartSession ? 0xfecaca : 0xfda4af, canStartSession ? 0.8 : 0.75);
      startLabel.setColor(canStartSession ? '#fff7ed' : '#ffe4e6');
      startLabel.setText(importState.inProgress ? 'Import in progress...' : canStartSession ? 'Start Session' : 'Fix Song Setup');
      playIcon?.setAlpha(canStartSession ? 0.98 : 0.72);

      if (quitPromptOpen) {
        hint.setText('Quit confirmation is open.');
      } else if (isCatalogLoading) {
        hint.setText('Loading songs...');
      } else if (!hasPlayableSongs) {
        hint.setText('No songs with a valid MIDI file found in /public/songs.');
      } else if (importState.inProgress) {
        hint.setText('Importing song: keep this screen open until import finishes.');
      } else {
        hint.setText(settingsValid ? '' : 'Open Settings and select at least one string, one finger and one fret.');
      }
      settingsController.refresh();
      tunerController.refresh();
    };

    const openSettings = (): void => {
      if (importController.isInProgress() || isQuitConfirmOpen()) return;
      songGridController.hideRemovePrompt();
      closeTuner();
      settingsController.openOverlay();
      refreshSelections();
    };

    const closeSettings = (): void => {
      settingsController.closeOverlay();
      refreshSelections();
    };

    const openTuner = (): void => {
      if (importController.isInProgress() || isQuitConfirmOpen()) return;
      if (settingsController.isOpen()) return;
      songGridController.hideRemovePrompt();
      tunerController.openOverlay();
      refreshSelections();
    };

    const openPractice = (): void => {
      if (importController.isInProgress() || isQuitConfirmOpen()) return;
      if (tunerController.isCalibrating()) return;
      songGridController.hideRemovePrompt();
      if (settingsController.isOpen()) closeSettings();
      if (tunerController.isOpen()) closeTuner();
      void tunerController.stop(false);
      this.scene.start('PracticeScene');
    };

    const closeTuner = (): void => {
      if (tunerController.isCalibrating()) return;
      tunerController.closeOverlay();
      refreshSelections();
    };

    const openImportPicker = (): void => {
      if (importController.isInProgress() || isQuitConfirmOpen()) return;
      songGridController.hideRemovePrompt();
      if (settingsController.isOpen()) closeSettings();
      if (tunerController.isOpen()) closeTuner();
      importController.openPicker();
      refreshSelections();
    };

    const startGame = async (): Promise<void> => {
      if (importController.isInProgress() || isQuitConfirmOpen()) return;
      songGridController.hideRemovePrompt();
      if (settingsController.isOpen()) return;
      if (isCatalogLoading) {
        refreshSelections();
        return;
      }
      if (tunerController.isOpen()) {
        closeTuner();
      }
      if (songs.length === 0) {
        refreshSelections();
        return;
      }
      if (!settingsController.isValid()) {
        refreshSelections();
        openSettings();
        return;
      }

      void tunerController.stop(false);

      const selectedSongIndex = songGridController.getSelectedIndex();
      const song = songs[selectedSongIndex];
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
      songs[selectedSongIndex] = validatedSong;
      const selectedOption = songGridController.getOptions()[selectedSongIndex];
      if (selectedOption) {
        selectedOption.song = validatedSong;
      }
      this.scene.start('PlayScene', {
        songId: validatedSong.id,
        midiUrl: validatedSong.midi,
        audioUrl: validatedSong.audio,
        difficulty: settingsController.getDifficulty(),
        allowedStrings: settingsController.getAllowedStrings(),
        allowedFingers: settingsController.getAllowedFingers(),
        allowedFrets: settingsController.getAllowedFrets()
      });
    };

    const removeSong = async (song: SongEntry): Promise<void> => {
      if (importController.isInProgress() || isQuitConfirmOpen()) return;
      songGridController.hideRemovePrompt();
      hint.setText(`Removing "${song.name}"...`);
      try {
        await this.removeSongFromLibrary(song);
        this.songCatalogService.clearAssetExistenceCache();
        await this.refreshSongListAfterImport();
      } catch (error) {
        hint.setText(`Remove failed: ${truncateLabel(toErrorMessage(error), 62)}`);
        refreshSelections();
      }
    };

    settingsButton.on('pointerdown', openSettings);
    settingsLabel.on('pointerdown', openSettings);
    settingsIcon?.on('pointerdown', openSettings);
    tunerButton.on('pointerdown', openTuner);
    tunerLabel.on('pointerdown', openTuner);
    tunerIcon?.on('pointerdown', openTuner);
    practiceButton.on('pointerdown', openPractice);
    practiceLabel.on('pointerdown', openPractice);
    practiceIcon?.on('pointerdown', openPractice);
    importButton.on('pointerdown', openImportPicker);
    importLabel.on('pointerdown', openImportPicker);
    importIcon?.on('pointerdown', openImportPicker);
    importLogShareButton?.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        void importController.shareDebugLog();
      }
    );
    importLogShareLabel?.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        void importController.shareDebugLog();
      }
    );
    importSourceToggleOptions.forEach((option) => {
      const applyImportSourceMode = (): void => {
        if (importController.isInProgress()) return;
        importController.setSourceMode(option.mode);
        refreshSelections();
      };
      option.background.on('pointerdown', applyImportSourceMode);
      option.label.on('pointerdown', applyImportSourceMode);
    });
    difficultyDropdown.trigger.on('pointerdown', cycleDifficulty);
    difficultyDropdown.label.on('pointerdown', cycleDifficulty);

    const onStartPointerDown = (
      _pointer: Phaser.Input.Pointer,
      _localX: number,
      _localY: number,
      event: Phaser.Types.Input.EventData
    ): void => {
      event.stopPropagation();
      void startGame();
    };
    startButton.on('pointerdown', onStartPointerDown);
    startLabel.on('pointerdown', onStartPointerDown);
    playIcon?.on('pointerdown', onStartPointerDown);

    this.input.keyboard?.on('keydown-LEFT', () => {
      if (isQuitConfirmOpen() || settingsController.isOpen() || songs.length === 0) return;
      songGridController.moveSelection(-1);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-RIGHT', () => {
      if (isQuitConfirmOpen() || settingsController.isOpen() || songs.length === 0) return;
      songGridController.moveSelection(1);
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-UP', () => {
      if (isQuitConfirmOpen() || settingsController.isOpen()) return;
      settingsController.cycleDifficultyPrevious();
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-DOWN', () => {
      if (isQuitConfirmOpen() || settingsController.isOpen()) return;
      settingsController.cycleDifficultyNext();
      refreshSelections();
    });
    this.input.keyboard?.on('keydown-ENTER', () => {
      if (isQuitConfirmOpen()) return;
      if (settingsController.isOpen()) {
        closeSettings();
        return;
      }
      void startGame();
    });
    this.input.keyboard?.on('keydown-SPACE', () => {
      if (isQuitConfirmOpen() || settingsController.isOpen()) return;
      void startGame();
    });
    this.input.keyboard?.on('keydown-ESC', () => {
      requestQuitConfirm();
    });

    const reloadSongsInBackground = async (): Promise<void> => {
      const loadGeneration = ++this.catalogLoadGeneration;
      isCatalogLoading = true;
      refreshSelections();
      try {
        const loadedSongs = await this.readManifestSongs(WEB_STARTUP_CATALOG_POLICY);
        if (!this.scene.isActive() || loadGeneration !== this.catalogLoadGeneration) return;

        songs = loadedSongs;
        songGridController.setSongs(songs, width, height, labelSize);
        isCatalogLoading = false;
        loadingSongsLabel.setVisible(false);
        refreshSelections();
        if (WEB_STARTUP_CATALOG_POLICY.lazyCoverLoading === 'visible-first') {
          void this.preloadSongCoverTexturesLazy(songs, WEB_STARTUP_CATALOG_POLICY.coverLoadConcurrency, songGridController);
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
      settingsController.destroy();
      tunerController.destroy();
      importController.destroy();
      songGridController.destroy();
      lifecycleController.destroy();
      this.coverLoadGeneration += 1;
      this.catalogLoadGeneration += 1;
      this.reloadSongsTask = undefined;
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

  private async readManifestSongs(policy: SongCatalogLoadPolicy): Promise<SongEntry[]> {
    return this.songCatalogService.readManifestSongs(policy);
  }

  private async validateSongBeforeStart(song: SongEntry): Promise<SongEntry | null> {
    return this.songCatalogService.validateSongBeforeStart(song);
  }

  private async preloadSongCoverTexturesLazy(
    songs: SongEntry[],
    concurrency: number,
    songGridController: SongGridController
  ): Promise<void> {
    const generation = ++this.coverLoadGeneration;
    await this.songCatalogService.preloadSongCoverTexturesLazy({
      songs,
      songOptions: songGridController.getOptions(),
      viewportRect: songGridController.getViewportRect(),
      concurrency,
      generation,
      isSceneActive: () => this.scene.isActive(),
      isGenerationValid: () => generation === this.coverLoadGeneration,
      onBatchLoaded: () => undefined,
      applyThumbnailViewportCrop: (option, viewportTop, viewportBottom) =>
        songGridController.applyThumbnailViewportCrop(option, viewportTop, viewportBottom)
    });
  }

  private createDifficultyDropdown(
    width: number,
    labelSize: number,
    triggerY: number,
    initialDifficulty: Difficulty
  ): DifficultyDropdown {
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
      .setText(initialDifficulty)
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

}
