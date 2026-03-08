import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { IMPORT_DEBUG_LOG_ENABLED } from '../../../platform/importDebugConfig';
import { RoundedBox } from '../../RoundedBox';
import {
  IMPORT_STATUS_POLL_MS,
  IMPORT_TIMEOUT_MS
} from '../constants';
import type {
  DebugConverterMode,
  ImportSourceMode,
  SongImportOverlay,
  SongImportStatusResponse
} from '../types';
import {
  clamp01,
  detectSongImportKind,
  firstNonEmpty,
  inferUploadMimeType,
  isImportSourceDebugEnabled,
  loadDebugConverterModePreference,
  loadImportSourceModePreference,
  parseJsonSafe,
  saveImportSourceModePreference,
  stripFileExtension,
  toErrorMessage,
  waitMs
} from '../utils/songSelectUtils';

type SongImportControllerOptions = {
  onBeforeOpenPicker: () => void;
  onStateChanged: () => void;
  onRefreshSongList: () => Promise<void>;
};

export type SongImportSnapshot = {
  inProgress: boolean;
  debugShareInProgress: boolean;
  sourceMode: ImportSourceMode;
  converterMode: DebugConverterMode;
  showSourceDebug: boolean;
  summaryMessage: string;
  summaryColor: string;
};

export class SongImportController {
  private overlay?: SongImportOverlay;
  private input?: HTMLInputElement;
  private inProgress = false;
  private debugShareInProgress = false;
  private sourceMode: ImportSourceMode = 'auto';
  private converterMode: DebugConverterMode = 'legacy';
  private showSourceDebug = false;
  private summaryMessage = '';
  private summaryColor = '#a5b4fc';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly options: SongImportControllerOptions
  ) {}

  initialize(width: number, height: number, labelSize: number): void {
    this.showSourceDebug = isImportSourceDebugEnabled();
    this.sourceMode = this.showSourceDebug ? loadImportSourceModePreference() : 'auto';
    this.converterMode = this.showSourceDebug ? loadDebugConverterModePreference() : 'legacy';
    this.summaryMessage = this.describeSummary();
    this.summaryColor = '#a5b4fc';
    this.overlay = this.createOverlay(width, height, labelSize);
    this.bindOverlayEvents();
    this.bindInputEvents();
  }

  destroy(): void {
    this.overlay?.container.destroy(true);
    this.overlay = undefined;
    this.inProgress = false;
    if (this.input) {
      this.input.onchange = null;
      this.input.remove();
    }
    this.input = undefined;
  }

  getSnapshot(): SongImportSnapshot {
    return {
      inProgress: this.inProgress,
      debugShareInProgress: this.debugShareInProgress,
      sourceMode: this.sourceMode,
      converterMode: this.converterMode,
      showSourceDebug: this.showSourceDebug,
      summaryMessage: this.summaryMessage,
      summaryColor: this.summaryColor
    };
  }

  isInProgress(): boolean {
    return this.inProgress;
  }

  isOverlayVisible(): boolean {
    return this.overlay?.container.visible === true;
  }

  openPicker(): void {
    if (this.inProgress) return;
    this.options.onBeforeOpenPicker();
    const input = this.ensureInput();
    input.value = '';
    input.click();
    this.options.onStateChanged();
  }

  closeOverlay(): void {
    this.overlay?.container.setVisible(false);
  }

  setSourceMode(mode: ImportSourceMode): void {
    if (this.inProgress) return;
    this.sourceMode = mode;
    if (this.showSourceDebug) {
      saveImportSourceModePreference(this.sourceMode);
    }
    this.summaryMessage = this.describeSummary();
    this.summaryColor = '#a5b4fc';
    this.options.onStateChanged();
  }

  async shareDebugLog(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    if (!IMPORT_DEBUG_LOG_ENABLED) return;
    if (this.inProgress || this.debugShareInProgress) return;

    this.debugShareInProgress = true;
    this.summaryMessage = 'Opening Android share...';
    this.summaryColor = '#fde68a';
    this.options.onStateChanged();

    try {
      const { shareNativeImportDebugLog } = await import('../../../platform/nativeNeuralNoteConverter');
      const shared = await shareNativeImportDebugLog();
      const sharedName = shared.logPath ? shared.logPath.split(/[\\/]/).pop() : null;
      this.summaryMessage = sharedName ? `Shared log: ${sharedName}` : 'Import debug log shared.';
      this.summaryColor = '#86efac';
    } catch (error) {
      this.summaryMessage = `Share log failed: ${toErrorMessage(error)}`;
      this.summaryColor = '#fca5a5';
    } finally {
      this.debugShareInProgress = false;
      if (this.scene.scene.isActive()) {
        this.options.onStateChanged();
      }
    }
  }

  private bindInputEvents(): void {
    const input = this.ensureInput();
    input.onchange = () => {
      const selectedFile = input.files?.[0];
      input.value = '';
      if (!selectedFile) return;
      void this.runSongImport(selectedFile);
    };
  }

  private ensureInput(): HTMLInputElement {
    if (this.input && document.body.contains(this.input)) {
      return this.input;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mid,.midi,.mp3,.ogg,audio/midi,audio/mid,audio/x-midi,application/midi,application/x-midi,audio/mpeg,audio/ogg';
    input.style.display = 'none';
    document.body.appendChild(input);
    this.input = input;
    return input;
  }

  private describeSummary(): string {
    const sourceSummary = this.sourceMode === 'auto' ? '' : `Forced source: ${this.sourceMode}`;
    if (!this.showSourceDebug || this.converterMode === 'legacy') {
      return sourceSummary;
    }
    return sourceSummary ? `${sourceSummary} • conv: ${this.converterMode}` : `conv: ${this.converterMode}`;
  }

  private bindOverlayEvents(): void {
    this.overlay?.backdrop.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        this.closeOverlay();
      }
    );

    this.overlay?.panel.on(
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
  }

  private createOverlay(width: number, height: number, labelSize: number): SongImportOverlay {
    const panelWidth = Math.min(720, width * 0.78);
    const panelHeight = Math.min(300, height * 0.44);
    const panelX = width / 2;
    const panelY = height / 2;

    const backdrop = new RoundedBox(this.scene, panelX, panelY, width, height, 0x020617, 0.76, 0)
      .setDepth(1300)
      .setInteractive({ useHandCursor: true });
    const panel = new RoundedBox(this.scene, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.97)
      .setStrokeStyle(2, 0x3b82f6, 0.5)
      .setInteractive({ useHandCursor: true });

    const title = this.scene.add
      .text(panelX, panelY - panelHeight * 0.3, 'Import Song', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 3)}px`
      })
      .setOrigin(0.5);

    const stageWrapWidth = panelWidth * 0.88;
    const stageLabel = this.scene.add
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
    const progressTrack = new RoundedBox(
      this.scene,
      panelX,
      progressTrackY,
      progressTrackWidth,
      progressTrackHeight,
      0x0f172a,
      0.92
    ).setStrokeStyle(1, 0x60a5fa, 0.45);
    const progressFill = new RoundedBox(
      this.scene,
      progressTrackLeft + 6,
      progressTrackY,
      12,
      progressTrackHeight - 6,
      0x38bdf8,
      0.96
    ).setStrokeStyle(1, 0x93c5fd, 0.78);

    const percentLabel = this.scene.add
      .text(panelX, panelY + panelHeight * 0.27, '0%', {
        color: '#fde68a',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const tip = this.scene.add
      .text(panelX, panelY + panelHeight * 0.39, 'Tap/click outside this window to close.', {
        color: '#94a3b8',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, labelSize - 3)}px`
      })
      .setOrigin(0.5);

    const container = this.scene.add
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

  private setOverlayProgress(stage: string, progress: number): void {
    const overlay = this.overlay;
    if (!overlay) return;
    const clamped = Phaser.Math.Clamp(progress, 0, 1);
    const fillWidth = Math.max(10, overlay.progressTrackWidth * clamped);
    overlay.progressFill.setBoxSize(fillWidth, overlay.progressTrackHeight - 6);
    overlay.progressFill.x = overlay.progressTrackLeft + fillWidth / 2;
    overlay.stageLabel.setText(firstNonEmpty(stage, 'Import in progress...') ?? 'Import in progress...');
    overlay.percentLabel.setText(`${Math.round(clamped * 100)}%`);
  }

  private async runSongImport(file: File): Promise<void> {
    if (this.inProgress) return;

    const importRoute = this.resolveImportRoute();
    let importSucceeded = false;
    this.inProgress = true;
    this.summaryMessage = `Importing ${file.name} (${importRoute})`;
    this.summaryColor = '#fde68a';
    this.overlay?.container.setVisible(true);
    this.setOverlayProgress('Uploading file...', 0.02);
    this.options.onStateChanged();

    try {
      await this.importSongFile(file, (stage, progress) => {
        this.summaryMessage = stage;
        this.setOverlayProgress(stage, progress);
        this.options.onStateChanged();
      });

      this.summaryMessage = `Imported ${stripFileExtension(file.name)}`;
      this.summaryColor = '#86efac';
      this.setOverlayProgress('Import completed.', 1);
      this.options.onStateChanged();

      importSucceeded = true;
      await waitMs(480);
      await this.options.onRefreshSongList();
      return;
    } catch (error) {
      const message = toErrorMessage(error);
      this.summaryMessage = message;
      this.summaryColor = '#fca5a5';
      this.setOverlayProgress(`Import failed: ${message}`, 1);
      this.options.onStateChanged();
    } finally {
      this.inProgress = false;
      if (this.scene.scene.isActive()) {
        if (importSucceeded) {
          this.overlay?.container.setVisible(false);
        }
        this.options.onStateChanged();
      }
    }
  }

  private resolveImportRoute(): 'native' | 'server' {
    if (this.sourceMode === 'native') return 'native';
    if (this.sourceMode === 'server') return 'server';
    return Capacitor.isNativePlatform() ? 'native' : 'server';
  }

  private async importSongFile(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    if (this.converterMode === 'ab') {
      throw new Error('Converter mode "ab" is no longer available. Use "legacy" or "neuralnote".');
    }

    if (this.resolveImportRoute() === 'native') {
      await this.importSongFileNative(file, onProgress);
      return;
    }

    await this.importSongFileViaServer(file, onProgress);
  }

  private async importSongFileNative(file: File, onProgress: (stage: string, progress: number) => void): Promise<void> {
    const mimeType = file.type && file.type.trim().length > 0 ? file.type : inferUploadMimeType(file.name);
    if (!detectSongImportKind(file.name, mimeType)) {
      throw new Error('Unsupported format. Please upload MIDI, MP3, or OGG.');
    }

    const { importSongNative } = await import('../../../platform/nativeSongImport');
    await importSongNative(
      file,
      ({ stage, progress }) => {
        onProgress(stage, progress);
      },
      {
        converterMode: this.converterMode
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
        'X-Song-Converter-Mode': this.converterMode
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

    await this.pollImportStatus(jobId, onProgress);
  }

  private async pollImportStatus(jobId: string, onProgress: (stage: string, progress: number) => void): Promise<void> {
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
}
