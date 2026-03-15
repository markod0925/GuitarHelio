import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { TuneoPitchDetectorService } from '../audio/tuneoPitchDetector';
import { createMicNode } from '../audio/micInput';
import type { PitchCalibrationProfile } from '../audio/pitchCalibration';
import { loadPitchCalibrationProfile } from '../audio/pitchCalibration';
import { PitchDetectorService } from '../audio/pitchDetector';
import { midiForStringFret } from '../guitar/tuning';
import { DEFAULT_AUDIO_INPUT_MODE, type AudioInputMode } from '../types/audioInputMode';
import { disableAndroidKeepScreenOn, enableAndroidKeepScreenOn } from '../platform/nativeKeepScreenOn';
import { releaseMicStream } from './AudioController';
import { RoundedBox } from './RoundedBox';
import { describeMicFailure, midiToNoteName, toErrorMessage, truncateLabel } from './song-select/utils/songSelectUtils';

type DetectorConfig = {
  id: string;
  label: string;
  kind: 'custom' | 'tuneo';
};

type NoteSpec = {
  midi: number;
  label: string;
};

type StringFretPosition = {
  string: number;
  fret: number;
};

type NoteStats = {
  totalFrames: number;
  validFrames: number;
  detectRate: number;
  inTuneRate: number;
  medianAbsCents: number | null;
  jitterCents: number | null;
  octaveErrorRate: number;
  avgConfidence: number;
  error?: string;
};

type DetectorSummaryRow = {
  detectorId: string;
  label: string;
  testedNotes: number;
  avgDetectRate: number;
  avgInTuneRate: number;
  avgMedianAbsCents: number | null;
  avgJitterCents: number | null;
  avgOctaveErrorRate: number;
  score: number;
};

type StoredBenchmarkRun = {
  id: string;
  createdAtMs: number;
  audioInputMode: AudioInputMode;
  notes: Array<{ midi: number; label: string }>;
  detectors: Array<{ id: string; label: string }>;
  results: Array<{
    detectorId: string;
    noteMidi: number;
    stats: NoteStats;
  }>;
  summary: DetectorSummaryRow[];
};

type NativeExportResult = {
  directory: Directory;
  path: string;
  uri: string | null;
};

const STORAGE_KEY = 'gh_pitch_benchmark_runs_v1';
const MAX_STORED_RUNS = 24;
const CAPTURE_WARMUP_MS = 350;
const CAPTURE_DURATION_MS = 2200;
const MIN_FRAME_CONFIDENCE = 0.25;
const IN_TUNE_CENTS = 35;
const OCTAVE_ERROR_MIN_SEMITONES = 5.5;

const DETECTOR_CONFIGS: DetectorConfig[] = [
  { id: 'custom', label: 'Custom (DSP Worklet)', kind: 'custom' },
  { id: 'tuneo-yin', label: 'Tuneo YIN', kind: 'tuneo' }
];

const BENCHMARK_NOTES: NoteSpec[] = [
  { midi: 40, label: 'E2' },
  { midi: 41, label: 'F2' },
  { midi: 43, label: 'G2' },
  { midi: 45, label: 'A2' },
  { midi: 46, label: 'A#2' },
  { midi: 48, label: 'C3' },
  { midi: 50, label: 'D3' },
  { midi: 55, label: 'G3' },
  { midi: 59, label: 'B3' },
  { midi: 64, label: 'E4' }
];

export class PitchBenchmarkScene extends Phaser.Scene {
  private audioCtx?: AudioContext;
  private micNode?: MediaStreamAudioSourceNode;
  private micStream?: MediaStream;
  private calibrationProfile: PitchCalibrationProfile | null = null;
  private readonly resultsByDetector = new Map<string, Map<number, NoteStats>>();
  private readonly completedNotes = new Set<number>();

  private runButton?: RoundedBox;
  private runLabel?: Phaser.GameObjects.Text;
  private exportButton?: RoundedBox;
  private exportLabel?: Phaser.GameObjects.Text;
  private prevNoteButton?: RoundedBox;
  private prevNoteLabel?: Phaser.GameObjects.Text;
  private nextNoteButton?: RoundedBox;
  private nextNoteLabel?: Phaser.GameObjects.Text;
  private backButton?: RoundedBox;
  private backLabel?: Phaser.GameObjects.Text;
  private instructionLabel?: Phaser.GameObjects.Text;
  private currentNoteLabel?: Phaser.GameObjects.Text;
  private noteStatsLabel?: Phaser.GameObjects.Text;
  private summaryLabel?: Phaser.GameObjects.Text;
  private statusLabel?: Phaser.GameObjects.Text;
  private historyLabel?: Phaser.GameObjects.Text;
  private progressBarTrack?: RoundedBox;
  private progressBarFill?: RoundedBox;

  private running = false;
  private runToken = 0;
  private currentNoteIndex = 0;
  private currentStepLabel = 'Idle';
  private statusMessage = 'Ready. Results are saved locally at the end of the full run.';
  private audioInputMode: AudioInputMode = DEFAULT_AUDIO_INPUT_MODE;
  private isShuttingDown = false;
  private nativeBackButtonListener?: { remove: () => Promise<void> };
  private onEscHandler?: () => void;

  constructor() {
    super('PitchBenchmarkScene');
  }

  create(data?: { audioInputMode?: AudioInputMode }): void {
    this.isShuttingDown = false;
    this.audioInputMode = data?.audioInputMode ?? DEFAULT_AUDIO_INPUT_MODE;
    this.calibrationProfile = loadPitchCalibrationProfile();
    this.resultsByDetector.clear();
    this.completedNotes.clear();
    this.currentNoteIndex = 0;
    this.currentStepLabel = 'Idle';
    this.statusMessage = 'Ready. Results are saved locally at the end of the full run.';
    DETECTOR_CONFIGS.forEach((config) => this.resultsByDetector.set(config.id, new Map<number, NoteStats>()));
    void enableAndroidKeepScreenOn();

    const { width, height } = this.scale;
    this.drawBackdrop(width, height);
    this.createLayout(width, height);
    this.bindNativeBackHandler();
    this.refreshUi();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.isShuttingDown = true;
      this.cancelRunningCapture();
      if (this.onEscHandler) {
        this.input.keyboard?.off('keydown-ESC', this.onEscHandler);
        this.onEscHandler = undefined;
      }
      if (this.nativeBackButtonListener) {
        void this.nativeBackButtonListener.remove();
        this.nativeBackButtonListener = undefined;
      }
      void this.stopAudioChain();
      void disableAndroidKeepScreenOn();
    });
  }

  private createLayout(width: number, height: number): void {
    const topY = Math.max(32, Math.round(height * 0.068));
    const panelWidth = Math.min(920, width * 0.94);
    const panelHeight = Math.min(560, height * 0.88);
    const panelX = width / 2;
    const panelY = height / 2 + 12;

    const title = this.add
      .text(width / 2, topY - 8, 'Pitch Benchmark', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(24, Math.floor(width * 0.028))}px`
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, title.y + 24, 'Guided note-by-note benchmark: one detector at a time.', {
        color: '#93c5fd',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.0125))}px`
      })
      .setOrigin(0.5);

    this.runButton = new RoundedBox(this, 126, topY + 4, 156, 42, 0x2563eb, 1)
      .setStrokeStyle(2, 0x93c5fd, 0.86)
      .setInteractive({ useHandCursor: true });
    this.runLabel = this.add
      .text(this.runButton.x, this.runButton.y, 'Run Current Note', {
        color: '#eff6ff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(width * 0.0128))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.exportButton = new RoundedBox(this, 492, topY + 4, 148, 42, 0x0f766e, 1)
      .setStrokeStyle(2, 0x5eead4, 0.86)
      .setInteractive({ useHandCursor: true });
    this.exportLabel = this.add
      .text(this.exportButton.x, this.exportButton.y, 'Export JSON', {
        color: '#ecfeff',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(width * 0.0128))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.prevNoteButton = new RoundedBox(this, 298, topY + 4, 62, 38, 0x1e293b, 0.98)
      .setStrokeStyle(2, 0x64748b, 0.86)
      .setInteractive({ useHandCursor: true });
    this.prevNoteLabel = this.add
      .text(this.prevNoteButton.x, this.prevNoteButton.y, '<', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(18, Math.floor(width * 0.018))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.nextNoteButton = new RoundedBox(this, 370, topY + 4, 62, 38, 0x1e293b, 0.98)
      .setStrokeStyle(2, 0x64748b, 0.86)
      .setInteractive({ useHandCursor: true });
    this.nextNoteLabel = this.add
      .text(this.nextNoteButton.x, this.nextNoteButton.y, '>', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(18, Math.floor(width * 0.018))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.backButton = new RoundedBox(this, width - 96, topY + 4, 142, 42, 0x1e293b, 0.98)
      .setStrokeStyle(2, 0x64748b, 0.84)
      .setInteractive({ useHandCursor: true });
    this.backLabel = this.add
      .text(this.backButton.x, this.backButton.y, 'Back to Practice', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(width * 0.0128))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    new RoundedBox(this, panelX, panelY, panelWidth, panelHeight, 0x0b1228, 0.93).setStrokeStyle(2, 0x334155, 0.82);

    this.currentNoteLabel = this.add
      .text(panelX, panelY - panelHeight * 0.43, '', {
        color: '#f8fafc',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, Math.floor(width * 0.02))}px`
      })
      .setOrigin(0.5);

    this.instructionLabel = this.add
      .text(panelX, panelY - panelHeight * 0.36, '', {
        color: '#bfdbfe',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.0128))}px`,
        align: 'center',
        wordWrap: { width: panelWidth * 0.9 }
      })
      .setOrigin(0.5);

    this.progressBarTrack = new RoundedBox(this, panelX, panelY - panelHeight * 0.29, panelWidth * 0.82, 12, 0x1f2937, 1)
      .setStrokeStyle(1, 0x60a5fa, 0.45);
    this.progressBarFill = new RoundedBox(this, panelX - panelWidth * 0.41 + 4, panelY - panelHeight * 0.29, 8, 8, 0x22c55e, 0.95);

    const tableWidth = panelWidth * 0.92;
    const tableLeft = panelX - tableWidth / 2;
    const contentTop = panelY - panelHeight * 0.24;
    const contentBottom = panelY + panelHeight * 0.38;
    const contentHeight = Math.max(120, contentBottom - contentTop);
    const boxGap = Math.max(10, Math.floor(panelHeight * 0.022));
    const noteBoxHeight = Math.floor((contentHeight - boxGap) / 2);
    const summaryBoxHeight = contentHeight - boxGap - noteBoxHeight;
    const noteBoxTop = contentTop;
    const summaryBoxTop = noteBoxTop + noteBoxHeight + boxGap;
    const monospaceFontSize = 10;
    new RoundedBox(this, panelX, noteBoxTop + noteBoxHeight / 2, tableWidth, noteBoxHeight, 0x101c3c, 0.86)
      .setStrokeStyle(1, 0x334155, 0.76);
    this.noteStatsLabel = this.add
      .text(tableLeft + 8, noteBoxTop + 8, '', {
        color: '#cbd5e1',
        fontFamily: 'monospace',
        fontSize: `${monospaceFontSize}px`,
        lineSpacing: 0
      })
      .setOrigin(0, 0);
    const noteMaskShape = this.add.graphics().setVisible(false);
    noteMaskShape.fillStyle(0xffffff, 1);
    noteMaskShape.fillRect(tableLeft + 4, noteBoxTop + 4, tableWidth - 8, noteBoxHeight - 8);
    this.noteStatsLabel.setMask(noteMaskShape.createGeometryMask());

    new RoundedBox(this, panelX, summaryBoxTop + summaryBoxHeight / 2, tableWidth, summaryBoxHeight, 0x101c3c, 0.92)
      .setStrokeStyle(1, 0x334155, 0.76);
    this.summaryLabel = this.add
      .text(tableLeft + 8, summaryBoxTop + 8, '', {
        color: '#e2e8f0',
        fontFamily: 'monospace',
        fontSize: `${monospaceFontSize}px`,
        lineSpacing: 0
      })
      .setOrigin(0, 0);
    const summaryMaskShape = this.add.graphics().setVisible(false);
    summaryMaskShape.fillStyle(0xffffff, 1);
    summaryMaskShape.fillRect(tableLeft + 4, summaryBoxTop + 4, tableWidth - 8, summaryBoxHeight - 8);
    this.summaryLabel.setMask(summaryMaskShape.createGeometryMask());

    this.historyLabel = this.add
      .text(panelX, panelY + panelHeight * 0.42, '', {
        color: '#93c5fd',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(11, Math.floor(width * 0.0115))}px`
      })
      .setOrigin(0.5);

    this.statusLabel = this.add
      .text(width / 2, height - 20, '', {
        color: '#a5b4fc',
        fontFamily: 'Montserrat, sans-serif',
        fontSize: `${Math.max(12, Math.floor(width * 0.0125))}px`
      })
      .setOrigin(0.5);

    const triggerRun = (): void => {
      void this.runCurrentNoteBenchmark();
    };
    this.runButton.on('pointerdown', triggerRun);
    this.runLabel.on('pointerdown', triggerRun);
    const triggerExport = (): void => {
      void this.exportRunsJson();
    };
    this.exportButton.on('pointerdown', triggerExport);
    this.exportLabel.on('pointerdown', triggerExport);

    const onPrev = (): void => {
      if (this.running) return;
      this.currentNoteIndex = Math.max(0, this.currentNoteIndex - 1);
      this.refreshUi();
    };
    const onNext = (): void => {
      if (this.running) return;
      this.currentNoteIndex = Math.min(BENCHMARK_NOTES.length - 1, this.currentNoteIndex + 1);
      this.refreshUi();
    };
    this.prevNoteButton.on('pointerdown', onPrev);
    this.prevNoteLabel.on('pointerdown', onPrev);
    this.nextNoteButton.on('pointerdown', onNext);
    this.nextNoteLabel.on('pointerdown', onNext);

    const onBack = (): void => {
      void this.leaveToPractice();
    };
    this.backButton.on('pointerdown', onBack);
    this.backLabel.on('pointerdown', onBack);

    this.onEscHandler = onBack;
    this.input.keyboard?.on('keydown-ESC', onBack);
  }

  private drawBackdrop(width: number, height: number): void {
    const g = this.add.graphics();
    g.fillGradientStyle(0x050d22, 0x0a1a42, 0x030916, 0x071734, 1, 1, 1, 1);
    g.fillRect(0, 0, width, height);
    g.lineStyle(1, 0x93c5fd, 0.1);
    for (let i = 0; i < 9; i += 1) {
      const y = (i / 8) * height;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.strokePath();
    }
  }

  private async leaveToPractice(): Promise<void> {
    this.cancelRunningCapture();
    await this.stopAudioChain();
    await disableAndroidKeepScreenOn();
    if (this.scene.isActive()) {
      this.scene.start('PracticeScene', { audioInputMode: this.audioInputMode });
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
          void this.leaveToPractice();
        });
        this.nativeBackButtonListener = backListener;
      })
      .catch((error) => {
        console.warn('Failed to register native back handler in PitchBenchmarkScene', error);
      });
  }

  private cancelRunningCapture(): void {
    this.runToken += 1;
    this.running = false;
  }

  private async ensureAudioChain(): Promise<void> {
    if (this.audioCtx && this.micNode) return;
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
    const micNode = await createMicNode(ctx, {
      audioInputMode: this.audioInputMode,
      echoCancellation: this.audioInputMode === 'speaker',
      noiseSuppression: this.audioInputMode === 'speaker',
      autoGainControl: this.audioInputMode === 'speaker',
      channelCount: 1
    });
    this.micNode = micNode;
    this.micStream = micNode.mediaStream;
  }

  private async stopAudioChain(): Promise<void> {
    releaseMicStream(this.micStream);
    this.micStream = undefined;
    this.micNode = undefined;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        await this.audioCtx.close();
      } catch {
        // ignore close failures during scene transitions
      }
    }
    this.audioCtx = undefined;
  }

  private async runCurrentNoteBenchmark(): Promise<void> {
    if (this.running) return;
    const note = BENCHMARK_NOTES[this.currentNoteIndex];
    if (!note) return;

    this.running = true;
    const token = this.runToken + 1;
    this.runToken = token;
    this.currentStepLabel = `${note.label}: preparing mic...`;
    this.statusMessage = 'Preparing audio input...';
    this.refreshUi();

    try {
      await this.ensureAudioChain();
      this.statusMessage = `Play ${note.label} (${midiToNoteName(note.midi)}) and hold it steady.`;
      this.refreshUi();

      for (let i = 0; i < DETECTOR_CONFIGS.length; i += 1) {
        if (token !== this.runToken || this.isShuttingDown) {
          throw new Error('capture-cancelled');
        }
        const detector = DETECTOR_CONFIGS[i];
        this.currentStepLabel = `${note.label}: ${detector.label} (${i + 1}/${DETECTOR_CONFIGS.length})`;
        this.refreshUi();
        const stats = await this.captureDetectorStats(detector, note.midi, token);
        this.resultsByDetector.get(detector.id)?.set(note.midi, stats);
        this.refreshUi();
      }

      this.completedNotes.add(note.midi);
      this.currentStepLabel = `${note.label}: completed`;
      this.statusMessage = `${note.label} completed. Move to next note when ready.`;
      const nextIndex = this.findNextPendingIndex(this.currentNoteIndex + 1);
      if (nextIndex !== null) {
        this.currentNoteIndex = nextIndex;
      }
      if (this.completedNotes.size >= BENCHMARK_NOTES.length) {
        const saveMessage = this.persistResults();
        this.statusMessage = saveMessage ?? `Benchmark complete. Saved to local storage key "${STORAGE_KEY}".`;
      }
    } catch (error) {
      if (toErrorMessage(error) !== 'capture-cancelled') {
        const micReason = describeMicFailure(error);
        const fallback = truncateLabel(toErrorMessage(error), 68);
        this.statusMessage = micReason ? `Capture failed (${micReason})` : `Capture failed (${fallback})`;
      }
      if (!this.micNode) {
        await this.stopAudioChain();
      }
    } finally {
      if (token === this.runToken) {
        this.running = false;
      }
      this.refreshUi();
    }
  }

  private async exportRunsJson(): Promise<void> {
    if (this.running) return;
    const runs = loadStoredRuns();
    if (runs.length === 0) {
      this.statusMessage = 'No saved benchmark runs to export yet.';
      this.refreshUi();
      return;
    }

    const exportedAtMs = Date.now();
    const payload = {
      schemaVersion: 1,
      storageKey: STORAGE_KEY,
      exportedAtMs,
      runCount: runs.length,
      runs
    };
    const json = JSON.stringify(payload, null, 2);
    const fileName = buildExportFileName(exportedAtMs);

    if (Capacitor.isNativePlatform()) {
      const nativeSaved = await trySaveExportOnNative(fileName, json);
      if (nativeSaved) {
        const targetHint = nativeSaved.directory === Directory.Documents ? 'Documents' : String(nativeSaved.directory);
        const location = nativeSaved.uri ?? nativeSaved.path;
        this.statusMessage = `Export saved in ${targetHint}: ${location}`;
        this.refreshUi();
        return;
      }
    }

    const downloaded = tryDownloadTextFile(fileName, json, 'application/json');
    if (downloaded) {
      this.statusMessage = `Export completed: ${fileName} (${runs.length} runs).`;
      this.refreshUi();
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(json);
        this.statusMessage = `Download unavailable here. JSON copied to clipboard (${runs.length} runs).`;
      } catch (error) {
        this.statusMessage = `Export failed (${truncateLabel(toErrorMessage(error), 46)}).`;
      }
      this.refreshUi();
      return;
    }

    this.statusMessage = 'Export failed: download not supported and clipboard unavailable.';
    this.refreshUi();
  }

  private async captureDetectorStats(detectorConfig: DetectorConfig, targetMidi: number, token: number): Promise<NoteStats> {
    const ctx = this.audioCtx;
    const micNode = this.micNode;
    if (!ctx || !micNode) {
      return createErrorStats('Audio chain unavailable');
    }

    let customDetector: PitchDetectorService | undefined;
    let tuneoDetector: TuneoPitchDetectorService | undefined;
    let disposeListener: (() => void) | undefined;
    let collecting = false;
    const frames: Array<{ midi: number | null; confidence: number }> = [];

    try {
      if (detectorConfig.kind === 'custom') {
        customDetector = new PitchDetectorService(ctx, {
          roundMidi: false,
          smoothingAlpha: 0,
          calibrationProfile: this.calibrationProfile ?? undefined,
          audioInputMode: this.audioInputMode,
          enableDspCore: true
        });
        await customDetector.init();
        disposeListener = customDetector.onPitch((frame) => {
          if (!collecting) return;
          frames.push({
            midi: frame.midi_estimate,
            confidence: Number.isFinite(frame.confidence) ? frame.confidence : 0
          });
        });
        await customDetector.start(micNode);
      } else {
        tuneoDetector = new TuneoPitchDetectorService(ctx, {
          windowSize: 9000,
          buffersPerSecond: 15,
          minFrequencyHz: 30,
          maxFrequencyHz: 500,
          calibrationProfile: this.calibrationProfile ?? undefined
        });
        await tuneoDetector.init();
        disposeListener = tuneoDetector.onPitch((frame) => {
          if (!collecting) return;
          frames.push({
            midi: frame.midi_estimate,
            confidence: Number.isFinite(frame.confidence) ? frame.confidence : 0
          });
        });
        tuneoDetector.start(micNode);
      }

      await this.waitCancelable(CAPTURE_WARMUP_MS, token);
      collecting = true;
      await this.waitCancelable(CAPTURE_DURATION_MS, token);
      collecting = false;
      return computeNoteStats(frames, targetMidi);
    } catch (error) {
      if (toErrorMessage(error) === 'capture-cancelled') {
        throw error;
      }
      return createErrorStats(truncateLabel(toErrorMessage(error), 54));
    } finally {
      collecting = false;
      disposeListener?.();
      customDetector?.stop();
      tuneoDetector?.stop();
    }
  }

  private async waitCancelable(ms: number, token: number): Promise<void> {
    const endAt = performance.now() + ms;
    while (performance.now() < endAt) {
      if (token !== this.runToken || this.isShuttingDown) {
        throw new Error('capture-cancelled');
      }
      const remaining = endAt - performance.now();
      const waitMs = Math.max(8, Math.min(80, remaining));
      await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
    }
  }

  private findNextPendingIndex(startIndex: number): number | null {
    for (let i = Math.max(0, startIndex); i < BENCHMARK_NOTES.length; i += 1) {
      const note = BENCHMARK_NOTES[i];
      if (!note) continue;
      if (!this.completedNotes.has(note.midi)) return i;
    }
    for (let i = 0; i < BENCHMARK_NOTES.length; i += 1) {
      const note = BENCHMARK_NOTES[i];
      if (!note) continue;
      if (!this.completedNotes.has(note.midi)) return i;
    }
    return null;
  }

  private persistResults(): string | null {
    if (typeof window === 'undefined') return null;
    const summary = this.computeSummaryRows();
    const run: StoredBenchmarkRun = {
      id: `run_${Date.now()}`,
      createdAtMs: Date.now(),
      audioInputMode: this.audioInputMode,
      notes: BENCHMARK_NOTES.map((note) => ({ midi: note.midi, label: note.label })),
      detectors: DETECTOR_CONFIGS.map((detector) => ({ id: detector.id, label: detector.label })),
      results: DETECTOR_CONFIGS.flatMap((detector) => {
        const noteMap = this.resultsByDetector.get(detector.id);
        if (!noteMap) return [];
        return BENCHMARK_NOTES.flatMap((note) => {
          const stats = noteMap.get(note.midi);
          return stats ? [{ detectorId: detector.id, noteMidi: note.midi, stats }] : [];
        });
      }),
      summary
    };

    try {
      const existing = loadStoredRuns();
      existing.unshift(run);
      const trimmed = existing.slice(0, MAX_STORED_RUNS);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      const createdText = new Date(run.createdAtMs).toLocaleString();
      return `Benchmark complete. Saved to local storage key "${STORAGE_KEY}" (${createdText}).`;
    } catch (error) {
      return `Benchmark complete, but save failed (${truncateLabel(toErrorMessage(error), 42)}).`;
    }
  }

  private computeSummaryRows(): DetectorSummaryRow[] {
    return DETECTOR_CONFIGS.map((detector) => {
      const noteMap = this.resultsByDetector.get(detector.id);
      const validStats: NoteStats[] = [];
      if (noteMap) {
        BENCHMARK_NOTES.forEach((note) => {
          const stats = noteMap.get(note.midi);
          if (!stats || stats.error) return;
          validStats.push(stats);
        });
      }

      if (validStats.length === 0) {
        return {
          detectorId: detector.id,
          label: detector.label,
          testedNotes: 0,
          avgDetectRate: 0,
          avgInTuneRate: 0,
          avgMedianAbsCents: null,
          avgJitterCents: null,
          avgOctaveErrorRate: 0,
          score: 0
        };
      }

      const avgDetectRate = mean(validStats.map((entry) => entry.detectRate));
      const avgInTuneRate = mean(validStats.map((entry) => entry.inTuneRate));
      const medians = validStats.map((entry) => entry.medianAbsCents).filter((value): value is number => value !== null);
      const jitters = validStats.map((entry) => entry.jitterCents).filter((value): value is number => value !== null);
      const avgMedianAbsCents = medians.length > 0 ? mean(medians) : null;
      const avgJitterCents = jitters.length > 0 ? mean(jitters) : null;
      const avgOctaveErrorRate = mean(validStats.map((entry) => entry.octaveErrorRate));
      const score = computeSummaryScore(avgDetectRate, avgInTuneRate, avgMedianAbsCents, avgJitterCents, avgOctaveErrorRate);

      return {
        detectorId: detector.id,
        label: detector.label,
        testedNotes: validStats.length,
        avgDetectRate,
        avgInTuneRate,
        avgMedianAbsCents,
        avgJitterCents,
        avgOctaveErrorRate,
        score
      };
    }).sort((a, b) => b.score - a.score);
  }

  private buildCurrentNoteTable(): string {
    const note = BENCHMARK_NOTES[this.currentNoteIndex];
    if (!note) return 'No note selected.';
    const header = 'Detector              Det%  Tune%  Med(c)  Jit(c)  Oct%   Status';
    const divider = '--------------------------------------------------------------------';
    const lines = DETECTOR_CONFIGS.map((detector) => {
      const stats = this.resultsByDetector.get(detector.id)?.get(note.midi);
      if (!stats) {
        return `${pad(detector.label, 21)}  ----  -----  ------  ------  ----   pending`;
      }
      if (stats.error) {
        return `${pad(detector.label, 21)}  ----  -----  ------  ------  ----   ${truncateLabel(stats.error, 18)}`;
      }
      return `${pad(detector.label, 21)}  ${fmtPct(stats.detectRate)}  ${fmtPct(stats.inTuneRate)}  ${fmtNum(stats.medianAbsCents, 6, 1)}  ${fmtNum(stats.jitterCents, 6, 1)}  ${fmtPct(stats.octaveErrorRate)}   ok`;
    });
    return [`Current note details (${note.label}/${midiToNoteName(note.midi)}):`, header, divider, ...lines].join('\n');
  }

  private buildSummaryTable(): string {
    const summaryRows = this.computeSummaryRows();
    const header = 'Detector              N    Det%  Tune%  Med(c)  Jit(c)  Oct%  Score';
    const divider = '---------------------------------------------------------------------';
    const lines = summaryRows.map((row) => {
      return `${pad(row.label, 21)}  ${pad(String(row.testedNotes), 2)}   ${fmtPct(row.avgDetectRate)}  ${fmtPct(row.avgInTuneRate)}  ${fmtNum(row.avgMedianAbsCents, 6, 1)}  ${fmtNum(row.avgJitterCents, 6, 1)}  ${fmtPct(row.avgOctaveErrorRate)}  ${pad(String(row.score), 5)}`;
    });
    return ['Summary ranking:', header, divider, ...lines].join('\n');
  }

  private refreshUi(): void {
    const note = BENCHMARK_NOTES[this.currentNoteIndex];
    if (note && this.currentNoteLabel) {
      const completed = this.completedNotes.has(note.midi) ? ' (completed)' : '';
      const displayedNote = note.label === midiToNoteName(note.midi) ? note.label : `${note.label}/${midiToNoteName(note.midi)}`;
      const suggestedPosition = resolvePreferredStringFret(note.midi);
      const positionSuffix = suggestedPosition ? ` • C${suggestedPosition.string}/F${suggestedPosition.fret}` : '';
      this.currentNoteLabel.setText(
        `Target note ${this.currentNoteIndex + 1}/${BENCHMARK_NOTES.length}: ${displayedNote}${positionSuffix}${completed}`
      );
    }

    if (this.instructionLabel) {
      const guidance = this.running
        ? `Running ${this.currentStepLabel}. Keep playing the target note steadily.`
        : 'Select a note, play only that note, then press "Run Current Note". One detector is applied at a time.';
      this.instructionLabel.setText(guidance);
    }

    if (this.noteStatsLabel) {
      this.noteStatsLabel.setText(this.buildCurrentNoteTable());
    }
    if (this.summaryLabel) {
      this.summaryLabel.setText(this.buildSummaryTable());
    }

    if (this.statusLabel) {
      this.statusLabel.setText(this.statusMessage);
    }

    if (this.runButton && this.runLabel) {
      this.runButton.setFillStyle(this.running ? 0x7f1d1d : 0x2563eb, 1);
      this.runButton.setStrokeStyle(2, this.running ? 0xfca5a5 : 0x93c5fd, 0.86);
      this.runLabel.setText(this.running ? 'Running...' : 'Run Current Note');
      this.runLabel.setColor(this.running ? '#ffe4e6' : '#eff6ff');
      this.runButton.setAlpha(this.running ? 0.88 : 1);
      this.runLabel.setAlpha(this.running ? 0.92 : 1);
    }
    if (this.exportButton && this.exportLabel) {
      const hasRuns = loadStoredRuns().length > 0;
      const enabled = !this.running && hasRuns;
      this.exportButton.setFillStyle(enabled ? 0x0f766e : 0x334155, enabled ? 1 : 0.94);
      this.exportButton.setStrokeStyle(2, enabled ? 0x5eead4 : 0x64748b, 0.86);
      this.exportButton.setAlpha(enabled ? 1 : 0.76);
      this.exportLabel.setColor(enabled ? '#ecfeff' : '#cbd5e1');
      this.exportLabel.setAlpha(enabled ? 1 : 0.76);
    }

    const canChangeNote = !this.running;
    if (this.prevNoteButton && this.prevNoteLabel) {
      const enabled = canChangeNote && this.currentNoteIndex > 0;
      this.prevNoteButton.setFillStyle(enabled ? 0x1e293b : 0x0f172a, 0.98);
      this.prevNoteButton.setAlpha(enabled ? 1 : 0.65);
      this.prevNoteLabel.setAlpha(enabled ? 1 : 0.65);
    }
    if (this.nextNoteButton && this.nextNoteLabel) {
      const enabled = canChangeNote && this.currentNoteIndex < BENCHMARK_NOTES.length - 1;
      this.nextNoteButton.setFillStyle(enabled ? 0x1e293b : 0x0f172a, 0.98);
      this.nextNoteButton.setAlpha(enabled ? 1 : 0.65);
      this.nextNoteLabel.setAlpha(enabled ? 1 : 0.65);
    }

    if (this.progressBarFill && this.progressBarTrack) {
      const ratio = Phaser.Math.Clamp(this.completedNotes.size / BENCHMARK_NOTES.length, 0, 1);
      const fullWidth = this.progressBarTrack.width - 4;
      const fillWidth = Math.max(8, fullWidth * ratio);
      this.progressBarFill.setBoxSize(fillWidth, 8);
      this.progressBarFill.x = this.progressBarTrack.x - this.progressBarTrack.width / 2 + 2 + fillWidth / 2;
      this.progressBarFill.setFillStyle(ratio >= 1 ? 0x22c55e : 0x38bdf8, 0.95);
    }

    if (this.historyLabel) {
      const historyCount = loadStoredRuns().length;
      this.historyLabel.setText(
        `Completed notes: ${this.completedNotes.size}/${BENCHMARK_NOTES.length}  •  Saved runs in local storage: ${historyCount}  •  key: ${STORAGE_KEY}`
      );
    }
  }
}

function computeNoteStats(
  frames: Array<{ midi: number | null; confidence: number }>,
  targetMidi: number
): NoteStats {
  if (frames.length === 0) {
    return {
      totalFrames: 0,
      validFrames: 0,
      detectRate: 0,
      inTuneRate: 0,
      medianAbsCents: null,
      jitterCents: null,
      octaveErrorRate: 0,
      avgConfidence: 0
    };
  }

  const absCentsValues: number[] = [];
  const signedCentsValues: number[] = [];
  let validFrames = 0;
  let inTuneFrames = 0;
  let octaveErrors = 0;
  let confidenceSum = 0;

  frames.forEach((frame) => {
    if (frame.midi === null || !Number.isFinite(frame.midi)) return;
    const confidence = Number.isFinite(frame.confidence) ? frame.confidence : 0;
    if (confidence < MIN_FRAME_CONFIDENCE) return;
    validFrames += 1;
    confidenceSum += confidence;

    const deltaSemitones = frame.midi - targetMidi;
    const deltaCents = deltaSemitones * 100;
    const absCents = Math.abs(deltaCents);
    absCentsValues.push(absCents);
    signedCentsValues.push(deltaCents);
    if (absCents <= IN_TUNE_CENTS) {
      inTuneFrames += 1;
    }
    if (Math.abs(deltaSemitones) >= OCTAVE_ERROR_MIN_SEMITONES) {
      octaveErrors += 1;
    }
  });

  const medianAbsCents = absCentsValues.length > 0 ? median(absCentsValues) : null;
  const jitterCents = signedCentsValues.length > 1 ? stdDev(signedCentsValues) : null;

  return {
    totalFrames: frames.length,
    validFrames,
    detectRate: validFrames / frames.length,
    inTuneRate: inTuneFrames / frames.length,
    medianAbsCents,
    jitterCents,
    octaveErrorRate: validFrames > 0 ? octaveErrors / validFrames : 0,
    avgConfidence: validFrames > 0 ? confidenceSum / validFrames : 0
  };
}

function createErrorStats(message: string): NoteStats {
  return {
    totalFrames: 0,
    validFrames: 0,
    detectRate: 0,
    inTuneRate: 0,
    medianAbsCents: null,
    jitterCents: null,
    octaveErrorRate: 0,
    avgConfidence: 0,
    error: message
  };
}

function computeSummaryScore(
  avgDetectRate: number,
  avgInTuneRate: number,
  avgMedianAbsCents: number | null,
  avgJitterCents: number | null,
  avgOctaveErrorRate: number
): number {
  const detectComponent = 0.42 * clamp01(avgDetectRate);
  const tuneComponent = 0.28 * clamp01(avgInTuneRate);
  const medianComponent = 0.18 * (1 - clamp01((avgMedianAbsCents ?? 120) / 120));
  const jitterComponent = 0.12 * (1 - clamp01((avgJitterCents ?? 140) / 140));
  const octavePenalty = 0.15 * clamp01(avgOctaveErrorRate);
  const raw = 100 * (detectComponent + tuneComponent + medianComponent + jitterComponent - octavePenalty);
  return Math.max(0, Math.round(raw));
}

function loadStoredRuns(): StoredBenchmarkRun[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredBenchmarkRun[];
  } catch {
    return [];
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  values.forEach((value) => {
    sum += value;
  });
  return sum / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const low = sorted[middle - 1] ?? 0;
    const high = sorted[middle] ?? low;
    return (low + high) / 2;
  }
  return sorted[middle] ?? 0;
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  let variance = 0;
  values.forEach((value) => {
    const delta = value - avg;
    variance += delta * delta;
  });
  variance /= values.length;
  return Math.sqrt(variance);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return `${value}${' '.repeat(width - value.length)}`;
}

function fmtPct(value: number): string {
  return `${Math.round(clamp01(value) * 100).toString().padStart(3, ' ')}%`;
}

function fmtNum(value: number | null, width: number, decimals: number): string {
  if (value === null || !Number.isFinite(value)) {
    return pad('--', width);
  }
  return pad(value.toFixed(decimals), width);
}

function resolvePreferredStringFret(midi: number): StringFretPosition | null {
  let best: StringFretPosition | null = null;
  for (let string = 1; string <= 6; string += 1) {
    for (let fret = 0; fret <= 12; fret += 1) {
      if (midiForStringFret(string, fret) !== midi) continue;
      if (!best || fret < best.fret || (fret === best.fret && string > best.string)) {
        best = { string, fret };
      }
    }
  }
  return best;
}

async function trySaveExportOnNative(fileName: string, content: string): Promise<NativeExportResult | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const relativeFolder = 'GuitarHelio/Benchmarks';
  const targetDirectories: Directory[] = [Directory.Documents, Directory.External, Directory.Data];

  for (const directory of targetDirectories) {
    try {
      await Filesystem.mkdir({
        path: relativeFolder,
        directory,
        recursive: true
      }).catch(() => undefined);

      const path = `${relativeFolder}/${fileName}`;
      await Filesystem.writeFile({
        path,
        directory,
        recursive: true,
        encoding: Encoding.UTF8,
        data: content
      });
      let uri: string | null = null;
      try {
        const resolved = await Filesystem.getUri({ path, directory });
        uri = typeof resolved?.uri === 'string' && resolved.uri.trim().length > 0 ? resolved.uri : null;
      } catch {
        uri = null;
      }
      return {
        directory,
        path,
        uri
      };
    } catch {
      // try next directory
    }
  }
  return null;
}

function buildExportFileName(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `guitarhelio-pitch-benchmark-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
}

function tryDownloadTextFile(fileName: string, text: string, mimeType: string): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const blob = new Blob([text], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 800);
    return true;
  } catch {
    return false;
  }
}
