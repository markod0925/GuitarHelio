import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { AudioCaptureService } from '../audio/AudioCaptureService';
import { AudioPreprocessService } from '../audio/AudioPreprocessService';
import { DebugRecorder } from '../audio/DebugRecorder';
import { FeatureExtractionService } from '../audio/FeatureExtractionService';
import { RingBufferAudioStore } from '../audio/RingBufferAudioStore';
import {
  DEFAULT_FFT_SIZE,
  DEFAULT_FRAME_SIZE,
  DEFAULT_HOP_SIZE,
  DEFAULT_REFERENCE_TEST_NOTE_DURATION_MS,
  OPEN_STRING_REFERENCE_NOTES,
  buildSyntheticReferenceWav
} from '../audio/debugSignalProcessing';
import { decodeAudioBuffer } from '../audio/decodeAudioBuffer';
import { MASP_GAME_SCENE_PRESET } from '../audio/maspShared';
import type { PitchDetectorPreset } from '../audio/pitchDetector';
import { buildPracticeSpectralRuntimeModel } from '../audio/spectralRuntimeModel';
import { disableAndroidKeepScreenOn, enableAndroidKeepScreenOn } from '../platform/nativeKeepScreenOn';
import {
  ensureNativePitchInputPermission,
  getNativePitchDebugLogInfo,
  pollNativePitchResults,
  resetNativePitchDetector,
  shouldUseNativePitchInput,
  startNativePitchCapture,
  stopNativePitchCapture,
  type NativePitchDetectionResult,
  type NativePitchDiagnostics
} from '../platform/nativePitchInput';
import { AC14Adapter } from '../pitch/adapters/AC14Adapter';
import { FretNetAdapter } from '../pitch/adapters/FretNetAdapter';
import { MASPAdapter } from '../pitch/adapters/MASPAdapter';
import { SpectralGameRuntimeUnifiedV3Adapter } from '../pitch/adapters/SpectralGameRuntimeUnifiedV3Adapter';
import { PitchDetectorManager } from '../pitch/PitchDetectorManager';
import type {
  AudioCaptureMetadata,
  AudioFrameContext,
  FrameSignalMetrics,
  PrecomputedFeatures,
  PitchDebugFrameSnapshot,
  PitchDetectorConfig,
  PitchDetectorResult,
  ReferenceNoteSelection,
  ReferenceTestDetectorSummary,
  ReferenceTestFrameRecord,
  ReferenceTestNoteRun
} from '../pitch/types';
import { midiToHz, midiToNoteName } from './song-select/utils/songSelectUtils';
import { PitchDebugUIController } from './debug/PitchDebugUIController';
import { runtimeLog, toRuntimeErrorMessage } from '../app/runtimeLog';

type DetectorToggleName = 'ac14' | 'MASP' | 'FRETNET' | 'spectral_game_runtime_unified_v3';
type WindowType = 'hann' | 'hamming' | 'blackman' | 'rect';

type AnalysisConfig = {
  frameSize: number;
  hopSize: number;
  fftSize: number;
  windowType: WindowType;
  dcRemoval: boolean;
  normalize: boolean;
  highPass: boolean;
  lowPass: boolean;
  bandPass: boolean;
  noiseGate: boolean;
  temporalSmoothing: boolean;
};

export class PitchDebugScene extends Phaser.Scene {
  private readonly spectralModel = buildPracticeSpectralRuntimeModel(12);
  private readonly useNativePitchInput = shouldUseNativePitchInput();
  private captureMetadata: AudioCaptureMetadata | null = null;
  private captureService?: AudioCaptureService;
  private preprocessService = new AudioPreprocessService(DEFAULT_FRAME_SIZE);
  private rawFeatureService = new FeatureExtractionService(DEFAULT_FFT_SIZE);
  private processedFeatureService = new FeatureExtractionService(DEFAULT_FFT_SIZE);
  private detectorManager?: PitchDetectorManager;
  private ui?: PitchDebugUIController;
  private debugRecorder = new DebugRecorder(30, 48_000);
  private rollingRawAudio = new RingBufferAudioStore(48_000 * 8);
  private rollingProcessedAudio = new RingBufferAudioStore(48_000 * 8);
  private continuousRawInitialized = false;
  private frameIndex = 0;
  private analysisWindowId = 0;
  private currentSnapshot: PitchDebugFrameSnapshot | null = null;
  private recording = true;
  private freezeFrame = false;
  private lastUiUpdateMs = 0;
  private logs: string[] = [];
  private readonly detectorEnabled: Record<DetectorToggleName, boolean> = {
    ac14: true,
    MASP: true,
    FRETNET: true,
    spectral_game_runtime_unified_v3: true
  };
  private readonly detectorLastAccepted = new Map<string, boolean>();
  private readonly detectorLastMidi = new Map<string, number>();
  private sampleRateMismatchLogged = false;
  private readonly analysisConfig: AnalysisConfig = {
    frameSize: DEFAULT_FRAME_SIZE,
    hopSize: DEFAULT_HOP_SIZE,
    fftSize: DEFAULT_FFT_SIZE,
    windowType: 'hann',
    dcRemoval: true,
    normalize: false,
    highPass: false,
    lowPass: false,
    bandPass: false,
    noiseGate: false,
    temporalSmoothing: false
  };
  private readonly smoothingState = new Map<string, number>();
  private referenceSelection: ReferenceNoteSelection = {
    enabled: false,
    label: 'E2',
    midi: 40,
    frequencyHz: midiToHz(40),
    stringId: 6,
    fret: 0,
    centsTolerance: 35,
    harmonicOverlays: 4
  };
  private openStringsRunning = false;
  private openStringsIndex = 0;
  private referenceRuns: ReferenceTestNoteRun[] = [];
  private currentReferenceRun: ReferenceTestNoteRun | null = null;
  private nativeBackButtonListener?: { remove: () => Promise<void> };
  private nativePollTimerId: number | null = null;
  private nativePollInFlight = false;
  private nativeLiveMicRunning = false;
  private nativeDiagnostics: NativePitchDiagnostics | null = null;
  private nativeDebugLogAnnounced = false;

  constructor() {
    super('PitchDebugScene');
  }

  create(): void {
    runtimeLog(
      { scene: 'PitchDebugScene', subsystem: 'scene' },
      'INFO',
      'Entering scene.',
      { nativePitchInput: this.useNativePitchInput }
    );
    this.ui = new PitchDebugUIController(this);
    this.bindUiButtons();
    this.configureServices();
    this.installSceneHandlers();
    this.updateUi();
    void enableAndroidKeepScreenOn();
    void this.announceNativeDebugLogInfo();
    void this.refreshDetectors();
    void this.startLiveMic();
  }

  private configureServices(): void {
    this.preprocessService = new AudioPreprocessService(this.analysisConfig.frameSize, {
      windowType: this.analysisConfig.windowType,
      dcRemoval: this.analysisConfig.dcRemoval,
      normalize: this.analysisConfig.normalize,
      highPass: this.analysisConfig.highPass,
      lowPass: this.analysisConfig.lowPass,
      bandPass: this.analysisConfig.bandPass,
      noiseGate: this.analysisConfig.noiseGate
    });
    this.rawFeatureService = new FeatureExtractionService(this.analysisConfig.fftSize);
    this.processedFeatureService = new FeatureExtractionService(this.analysisConfig.fftSize);
    this.debugRecorder.setFrameShape(this.analysisConfig.frameSize, this.analysisConfig.hopSize);

    this.captureService = new AudioCaptureService({
      onFrame: (frame) => this.handleAudioFrame(frame),
      onStateChanged: (metadata) => {
        this.captureMetadata = metadata;
      },
      onEvent: (message) => this.addLog(message)
    });
    this.captureService.updateFrameConfig(this.analysisConfig.frameSize, this.analysisConfig.hopSize);
  }

  private installSceneHandlers(): void {
    const onEsc = (): void => {
      void this.leaveScene();
    };
    this.input.keyboard?.on('keydown-ESC', onEsc);
    if (Capacitor.isNativePlatform()) {
      void import('@capacitor/app')
        .then(async ({ App }) => {
          this.nativeBackButtonListener = await App.addListener('backButton', () => {
            if (!this.scene.isActive()) return;
            void this.leaveScene();
          });
        })
        .catch(() => undefined);
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      runtimeLog({ scene: 'PitchDebugScene', subsystem: 'scene' }, 'INFO', 'Leaving scene.');
      this.input.keyboard?.off('keydown-ESC', onEsc);
      void this.nativeBackButtonListener?.remove();
      this.nativeBackButtonListener = undefined;
      this.ui?.destroy();
      this.ui = undefined;
      this.detectorManager?.dispose();
      this.detectorManager = undefined;
      if (this.nativePollTimerId !== null) {
        window.clearInterval(this.nativePollTimerId);
        this.nativePollTimerId = null;
      }
      this.nativeLiveMicRunning = false;
      this.nativePollInFlight = false;
      this.nativeDiagnostics = null;
      void this.captureService?.stop();
      void stopNativePitchCapture().catch(() => undefined);
      this.captureService = undefined;
      void disableAndroidKeepScreenOn();
    });
  }

  private bindUiButtons(): void {
    const buttons = [
      { key: 'mic', label: 'Mic', x: 474, y: 108, width: 60, height: 24, onClick: () => void this.startLiveMic() },
      { key: 'stop', label: 'Stop', x: 540, y: 108, width: 60, height: 24, onClick: () => void this.stopCapture() },
      { key: 'test', label: 'Test WAV', x: 610, y: 108, width: 72, height: 24, onClick: () => void this.startInternalTestWav() },
      { key: 'file', label: 'Load File', x: 692, y: 108, width: 76, height: 24, onClick: () => void this.loadLocalAudioFile() },
      { key: 'replay', label: 'Replay 3s', x: 778, y: 108, width: 82, height: 24, onClick: () => void this.startReplay(3) },
      { key: 'freeze', label: 'Freeze', x: 870, y: 108, width: 68, height: 24, onClick: () => this.toggleFreeze() },
      { key: 'record', label: 'Record', x: 948, y: 108, width: 58, height: 24, onClick: () => this.toggleRecording() },
      { key: 'clear', label: 'Clear Log', x: 474, y: 136, width: 72, height: 24, onClick: () => this.clearLogs() },
      { key: 'raw', label: 'Raw WAV', x: 554, y: 136, width: 72, height: 24, onClick: () => void this.exportRawWav() },
      { key: 'proc', label: 'Proc WAV', x: 634, y: 136, width: 76, height: 24, onClick: () => void this.exportProcessedWav() },
      { key: 'jsonl', label: 'JSONL', x: 720, y: 136, width: 64, height: 24, onClick: () => void this.exportJsonl() },
      { key: 'csv', label: 'CSV', x: 792, y: 136, width: 56, height: 24, onClick: () => void this.exportCsv() },
      { key: 'back', label: 'Back', x: 856, y: 136, width: 56, height: 24, onClick: () => void this.leaveScene() },
      { key: 'ref', label: 'Ref', x: 920, y: 136, width: 40, height: 24, onClick: () => this.toggleReferenceMode() },
      { key: 'refNote', label: 'Next Note', x: 968, y: 136, width: 60, height: 24, onClick: () => this.cycleReferenceNote(1) },
      { key: 'ac14', label: 'AC14', x: 474, y: 164, width: 56, height: 22, onClick: () => void this.toggleDetector('ac14') },
      { key: 'masp', label: 'MASP', x: 536, y: 164, width: 56, height: 22, onClick: () => void this.toggleDetector('MASP') },
      { key: 'fretnet', label: 'FRETNET', x: 598, y: 164, width: 70, height: 22, onClick: () => void this.toggleDetector('FRETNET') },
      { key: 'spec', label: 'SPEC V3', x: 674, y: 164, width: 74, height: 22, onClick: () => void this.toggleDetector('spectral_game_runtime_unified_v3') },
      { key: 'frame', label: 'Frame', x: 756, y: 164, width: 54, height: 22, onClick: () => this.cycleFrameSize() },
      { key: 'hop', label: 'Hop', x: 816, y: 164, width: 46, height: 22, onClick: () => this.cycleHopSize() },
      { key: 'fft', label: 'FFT', x: 868, y: 164, width: 44, height: 22, onClick: () => this.cycleFftSize() },
      { key: 'window', label: 'Window', x: 918, y: 164, width: 58, height: 22, onClick: () => this.cycleWindowType() },
      { key: 'dc', label: 'DC', x: 982, y: 164, width: 36, height: 22, onClick: () => this.toggleAnalysisFlag('dcRemoval') },
      { key: 'norm', label: 'Norm', x: 474, y: 192, width: 50, height: 22, onClick: () => this.toggleAnalysisFlag('normalize') },
      { key: 'hp', label: 'HP', x: 530, y: 192, width: 40, height: 22, onClick: () => this.toggleAnalysisFlag('highPass') },
      { key: 'lp', label: 'LP', x: 576, y: 192, width: 40, height: 22, onClick: () => this.toggleAnalysisFlag('lowPass') },
      { key: 'gate', label: 'Gate', x: 622, y: 192, width: 48, height: 22, onClick: () => this.toggleAnalysisFlag('noiseGate') },
      { key: 'smooth', label: 'Smooth', x: 676, y: 192, width: 60, height: 22, onClick: () => this.toggleAnalysisFlag('temporalSmoothing') },
      { key: 'strings', label: 'Open Strings', x: 742, y: 192, width: 92, height: 22, onClick: () => this.toggleOpenStringsTest() },
      { key: 'resetDet', label: 'Reset Det', x: 840, y: 192, width: 76, height: 22, onClick: () => void this.resetDetectors() },
      { key: 'harmonics', label: 'Harm+', x: 922, y: 192, width: 56, height: 22, onClick: () => this.cycleHarmonicOverlays() },
      { key: 'tolerance', label: 'Tol+', x: 984, y: 192, width: 44, height: 22, onClick: () => this.cycleReferenceTolerance() }
    ];
    this.ui?.addButtons(buttons);
  }

  private async refreshDetectors(): Promise<void> {
    this.detectorManager?.dispose();
    this.detectorManager = new PitchDetectorManager([
      new AC14Adapter(),
      new MASPAdapter(),
      new FretNetAdapter(),
      new SpectralGameRuntimeUnifiedV3Adapter()
    ]);
    const configs: Record<string, PitchDetectorConfig> = {
      ac14: { enabled: this.detectorEnabled.ac14 },
      MASP: { enabled: this.detectorEnabled.MASP },
      FRETNET: {
        enabled: this.detectorEnabled.FRETNET,
        detectorSpecific: { spectralModelJson: JSON.stringify(this.spectralModel) }
      },
      spectral_game_runtime_unified_v3: {
        enabled: this.detectorEnabled.spectral_game_runtime_unified_v3,
        detectorSpecific: { spectralModelJson: JSON.stringify(this.spectralModel) }
      }
    };
    await this.detectorManager.init(configs);
  }

  private async startLiveMic(): Promise<void> {
    runtimeLog(
      { scene: 'PitchDebugScene', subsystem: 'mic' },
      'INFO',
      'Starting live mic diagnostics.',
      { nativePitchInput: this.useNativePitchInput }
    );
    if (this.useNativePitchInput) {
      await this.startNativeLiveMic();
      return;
    }
    if (!this.captureService) return;
    await this.stopNativeLiveMic(false);
    this.addLog('Starting live microphone diagnostics...');
    this.resetRunState();
    this.captureService.updateFrameConfig(this.analysisConfig.frameSize, this.analysisConfig.hopSize);
    await this.captureService.startLiveMic({
      requestedSampleRate: 48_000,
      frameSize: this.analysisConfig.frameSize,
      hopSize: this.analysisConfig.hopSize
    }).catch((error) => {
      this.addLog(`Mic start failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async startInternalTestWav(): Promise<void> {
    if (!this.captureService) return;
    await this.stopNativeLiveMic(false);
    const bytes = buildSyntheticReferenceWav(this.referenceSelection.enabled ? this.referenceSelection : {
      ...this.referenceSelection,
      enabled: true
    });
    const decoded = await decodeAudioBuffer(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
    this.resetRunState();
    await this.captureService.startDecodedBuffer(decoded, 'file', `internal-${this.referenceSelection.label}.wav`);
  }

  private async loadLocalAudioFile(): Promise<void> {
    const file = await promptForAudioFile();
    if (!file || !this.captureService) return;
    await this.stopNativeLiveMic(false);
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await decodeAudioBuffer(arrayBuffer);
    this.resetRunState();
    await this.captureService.startDecodedBuffer(decoded, 'file', file.name);
  }

  private async startReplay(seconds: number): Promise<void> {
    if (!this.captureService) return;
    await this.stopNativeLiveMic(false);
    const sampleRate = this.captureMetadata?.actualSampleRate ?? 48_000;
    const samples = this.rollingRawAudio.readLatest(Math.round(sampleRate * seconds));
    if (samples.length <= 0) {
      this.addLog('Replay unavailable: no buffered audio yet.');
      return;
    }
    const decoded = {
      sampleRate,
      length: samples.length,
      numberOfChannels: 1,
      getChannelData: () => samples
    };
    await this.captureService.startDecodedBuffer(decoded, 'replay', `replay-${seconds}s`);
  }

  private async stopCapture(): Promise<void> {
    runtimeLog({ scene: 'PitchDebugScene', subsystem: 'mic' }, 'INFO', 'Stopping capture.');
    await this.stopNativeLiveMic(false);
    await this.captureService?.stop();
    this.addLog('Capture stopped.');
  }

  private async leaveScene(): Promise<void> {
    await this.stopNativeLiveMic(false);
    await this.captureService?.stop();
    await disableAndroidKeepScreenOn();
    if (this.scene.isActive()) {
      this.scene.start('SongSelectScene');
    }
  }

  private handleAudioFrame(frame: { timestampMs: number; rawFrame: Float32Array; sampleRate: number }): void {
    const captureMetadata = this.captureMetadata ?? this.captureService?.getMetadata();
    if (!captureMetadata || !this.detectorManager) {
      return;
    }

    const analysisStartedAt = performance.now();
    const rawFeatures = this.rawFeatureService.extractFeatures(frame.rawFrame, frame.sampleRate, this.referenceSelection.enabled ? this.referenceSelection : null, this.spectralModel);
    const processedFrame = new Float32Array(frame.rawFrame.length);
    this.preprocessService.processFrame(frame.rawFrame, frame.sampleRate, processedFrame);
    const features = this.processedFeatureService.extractFeatures(
      processedFrame,
      frame.sampleRate,
      this.referenceSelection.enabled ? this.referenceSelection : null,
      this.spectralModel
    );
    const frameContext: AudioFrameContext = {
      timestampMs: frame.timestampMs,
      frameIndex: this.frameIndex,
      sampleRate: frame.sampleRate,
      rawFrame: frame.rawFrame,
      processedFrame,
      analysisWindowId: this.analysisWindowId,
      optionalFeatures: features
    };
    let detectorResults = this.detectorManager.processAll(frameContext);
    if (this.analysisConfig.temporalSmoothing) {
      detectorResults = detectorResults.map((result) => this.applyTemporalSmoothing(result));
    }
    const analysisTimeMs = performance.now() - analysisStartedAt;
    const budgetMs = (this.analysisConfig.hopSize / frame.sampleRate) * 1000;
    const snapshot: PitchDebugFrameSnapshot = {
      frameContext,
      rawMetrics: rawFeatures.metrics,
      features,
      detectorResults,
      captureMetadata,
      analysisTimeMs,
      overload: analysisTimeMs > budgetMs
    };
    this.currentSnapshot = snapshot;
    this.appendRollingAudio(frame.rawFrame, processedFrame);
    if (this.recording) {
      this.debugRecorder.append(snapshot);
    }
    this.handleFrameLogs(snapshot);
    this.collectReferenceTestFrame(detectorResults, frame.timestampMs);

    this.frameIndex += 1;
    this.analysisWindowId += 1;
    if (!this.freezeFrame && (performance.now() - this.lastUiUpdateMs >= 60 || this.lastUiUpdateMs === 0)) {
      this.lastUiUpdateMs = performance.now();
      this.updateUi();
    }
  }

  private appendRollingAudio(rawFrame: Float32Array, processedFrame: Float32Array): void {
    if (!this.continuousRawInitialized || this.analysisWindowId === 0) {
      this.rollingRawAudio.append(rawFrame);
      this.rollingProcessedAudio.append(processedFrame);
      this.continuousRawInitialized = true;
      return;
    }
    this.rollingRawAudio.append(rawFrame.subarray(rawFrame.length - this.analysisConfig.hopSize));
    this.rollingProcessedAudio.append(processedFrame.subarray(processedFrame.length - this.analysisConfig.hopSize));
  }

  private handleFrameLogs(snapshot: PitchDebugFrameSnapshot): void {
    if (!this.sampleRateMismatchLogged && snapshot.captureMetadata.requestedSampleRate !== null && snapshot.captureMetadata.actualSampleRate !== null) {
      if (Math.abs(snapshot.captureMetadata.requestedSampleRate - snapshot.captureMetadata.actualSampleRate) > 1) {
        this.addLog(`Sample-rate mismatch: requested ${snapshot.captureMetadata.requestedSampleRate} Hz, actual ${snapshot.captureMetadata.actualSampleRate} Hz`);
        this.sampleRateMismatchLogged = true;
      }
    }

    if (snapshot.rawMetrics.clippingRatio > 0.002) {
      this.addLog(`Clipping warning: ${(snapshot.rawMetrics.clippingRatio * 100).toFixed(2)}% of current frame`);
    }
    if (
      snapshot.captureMetadata.inputSource !== 'native_android_oboe' &&
      this.referenceSelection.enabled &&
      this.referenceSelection.midi === 40 &&
      snapshot.features.metrics.lowBandEnergyRatio < 0.03
    ) {
      this.addLog('Low-band warning: E2 diagnostic shows weak energy below 200 Hz');
    }
    for (const result of snapshot.detectorResults) {
      const previousAccepted = this.detectorLastAccepted.get(result.detectorName);
      if (previousAccepted !== undefined && previousAccepted !== result.accepted) {
        this.addLog(`${result.detectorName} ${result.accepted ? 'accepted' : `rejected (${result.rejectReason ?? 'unknown'})`}`);
      }
      this.detectorLastAccepted.set(result.detectorName, result.accepted);
      if (result.accepted && result.midi !== undefined) {
        const previousMidi = this.detectorLastMidi.get(result.detectorName);
        if (previousMidi !== undefined && Math.abs(previousMidi - result.midi) >= 5) {
          this.addLog(`Large pitch jump: ${result.detectorName} ${midiToNoteName(Math.round(previousMidi))} -> ${result.noteName ?? result.midi.toFixed(2)}`);
        }
        this.detectorLastMidi.set(result.detectorName, result.midi);
      }
    }
  }

  private applyTemporalSmoothing(result: PitchDetectorResult): PitchDetectorResult {
    if (!result.accepted || result.midi === undefined) {
      this.smoothingState.delete(result.detectorName);
      return result;
    }
    const previous = this.smoothingState.get(result.detectorName);
    const smoothed = previous === undefined ? result.midi : previous + 0.35 * (result.midi - previous);
    this.smoothingState.set(result.detectorName, smoothed);
    return {
      ...result,
      midi: smoothed,
      pitchHz: midiToHz(smoothed),
      noteName: midiToNoteName(Math.round(smoothed)),
      cents: this.referenceSelection.enabled ? (smoothed - this.referenceSelection.midi) * 100 : result.cents
    };
  }

  private addLog(message: string): void {
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const entry = `[${stamp}] ${message}`;
    if (this.logs[this.logs.length - 1] === entry) {
      return;
    }
    this.logs.push(entry);
    if (this.logs.length > 80) {
      this.logs.splice(0, this.logs.length - 80);
    }
    this.updateUi();
  }

  private clearLogs(): void {
    this.logs = [];
    this.addLog('Logs cleared.');
  }

  private toggleFreeze(): void {
    this.freezeFrame = !this.freezeFrame;
    this.addLog(`Freeze frame ${this.freezeFrame ? 'enabled' : 'disabled'}`);
    this.updateUi();
  }

  private toggleRecording(): void {
    this.recording = !this.recording;
    this.addLog(`Recording ${this.recording ? 'started' : 'stopped'}`);
    this.updateUi();
  }

  private toggleReferenceMode(): void {
    this.referenceSelection.enabled = !this.referenceSelection.enabled;
    this.addLog(`Reference mode ${this.referenceSelection.enabled ? `enabled (${this.referenceSelection.label})` : 'disabled'}`);
    this.updateUi();
  }

  private cycleReferenceNote(direction: 1 | -1): void {
    const notes = OPEN_STRING_REFERENCE_NOTES;
    const currentIndex = notes.findIndex((note) => note.midi === this.referenceSelection.midi);
    const nextIndex = (currentIndex + direction + notes.length) % notes.length;
    const note = notes[nextIndex];
    this.referenceSelection = {
      ...this.referenceSelection,
      label: note.label,
      midi: note.midi,
      frequencyHz: note.frequencyHz,
      stringId: note.stringId,
      fret: note.fret
    };
    this.addLog(`Reference note set to ${note.label}`);
    this.updateUi();
  }

  private cycleReferenceTolerance(): void {
    const next = this.referenceSelection.centsTolerance >= 50 ? 20 : this.referenceSelection.centsTolerance + 5;
    this.referenceSelection.centsTolerance = next;
    this.addLog(`Reference tolerance ${next} cents`);
    this.updateUi();
  }

  private cycleHarmonicOverlays(): void {
    const next = this.referenceSelection.harmonicOverlays >= 8 ? 2 : this.referenceSelection.harmonicOverlays + 2;
    this.referenceSelection.harmonicOverlays = next;
    this.addLog(`Reference harmonic overlays ${next}`);
    this.updateUi();
  }

  private toggleOpenStringsTest(): void {
    this.openStringsRunning = !this.openStringsRunning;
    if (this.openStringsRunning) {
      this.referenceSelection.enabled = true;
      this.referenceRuns = [];
      this.openStringsIndex = 0;
      this.beginCurrentReferenceRun();
      this.addLog('Open strings guided test started');
    } else {
      if (this.currentReferenceRun) {
        this.finishCurrentReferenceRun();
      }
      this.addLog('Open strings guided test stopped');
    }
    this.updateUi();
  }

  private beginCurrentReferenceRun(): void {
    const note = OPEN_STRING_REFERENCE_NOTES[this.openStringsIndex];
    this.referenceSelection = {
      ...this.referenceSelection,
      enabled: true,
      label: note.label,
      midi: note.midi,
      frequencyHz: note.frequencyHz,
      stringId: note.stringId,
      fret: note.fret
    };
    this.currentReferenceRun = {
      note,
      startedAtMs: performance.now(),
      completedAtMs: null,
      framesByDetector: {}
    };
    this.addLog(`Play and sustain ${note.label} on string ${note.stringId}`);
  }

  private finishCurrentReferenceRun(): void {
    if (!this.currentReferenceRun) return;
    this.currentReferenceRun.completedAtMs = performance.now();
    this.referenceRuns.push(this.currentReferenceRun);
    this.currentReferenceRun = null;
    this.openStringsIndex += 1;
    if (this.openStringsIndex >= OPEN_STRING_REFERENCE_NOTES.length) {
      this.openStringsRunning = false;
      this.addLog('Open strings guided test completed');
      return;
    }
    this.beginCurrentReferenceRun();
  }

  private collectReferenceTestFrame(results: PitchDetectorResult[], timestampMs: number): void {
    if (!this.openStringsRunning || !this.currentReferenceRun) return;
    for (const result of results) {
      const list = this.currentReferenceRun.framesByDetector[result.detectorName] ?? [];
      const centsError = result.midi === undefined ? null : (result.midi - this.currentReferenceRun.note.midi) * 100;
      const octaveError = result.midi !== undefined && Math.abs(Math.round(result.midi) - this.currentReferenceRun.note.midi) === 12;
      const correct = result.accepted && result.midi !== undefined && Math.abs(result.midi - this.currentReferenceRun.note.midi) <= this.referenceSelection.centsTolerance / 100;
      const frameRecord: ReferenceTestFrameRecord = {
        detectorName: result.detectorName,
        accepted: result.accepted,
        confidence: result.confidence ?? 0,
        centsError,
        octaveError,
        correct
      };
      list.push(frameRecord);
      this.currentReferenceRun.framesByDetector[result.detectorName] = list;
    }
    if (timestampMs - this.currentReferenceRun.startedAtMs >= DEFAULT_REFERENCE_TEST_NOTE_DURATION_MS) {
      this.finishCurrentReferenceRun();
    }
  }

  private buildReferenceSummaries(): ReferenceTestDetectorSummary[] {
    const summaries = new Map<string, ReferenceTestFrameRecord[]>();
    for (const run of this.referenceRuns) {
      for (const [detectorName, records] of Object.entries(run.framesByDetector)) {
        const list = summaries.get(detectorName) ?? [];
        list.push(...records);
        summaries.set(detectorName, list);
      }
    }
    const out: ReferenceTestDetectorSummary[] = [];
    for (const [detectorName, records] of summaries.entries()) {
      const accepted = records.filter((record) => record.accepted);
      const correct = records.filter((record) => record.correct);
      const octaveErrors = records.filter((record) => record.octaveError);
      const confidenceValues = accepted.map((record) => record.confidence).sort((a, b) => a - b);
      const centsValues = accepted
        .map((record) => record.centsError)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      out.push({
        detectorName,
        acceptanceRate: records.length > 0 ? accepted.length / records.length : 0,
        correctNoteRate: records.length > 0 ? correct.length / records.length : 0,
        medianCentsError: median(centsValues),
        octaveErrorRate: records.length > 0 ? octaveErrors.length / records.length : 0,
        medianConfidence: median(confidenceValues) ?? 0,
        rejectedFrameRate: records.length > 0 ? (records.length - accepted.length) / records.length : 0
      });
    }
    out.sort((a, b) => a.detectorName.localeCompare(b.detectorName));
    return out;
  }

  private updateUi(): void {
    const recentWaveform = this.rollingRawAudio.readLatest(Math.min(this.rollingRawAudio.getLength(), Math.round((this.captureMetadata?.actualSampleRate ?? 48_000) * 1.5)));
    this.ui?.update(this.freezeFrame ? this.currentSnapshot : this.currentSnapshot, {
      logs: this.logs,
      modeLabel: this.captureMetadata?.capturePreset ?? 'Idle',
      enabledDetectors: Object.entries(this.detectorEnabled)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
      recording: this.recording,
      freezeFrame: this.freezeFrame,
      recentRawWaveform: recentWaveform,
      referenceStateLabel: this.referenceSelection.enabled
        ? `${this.referenceSelection.label} ±${this.referenceSelection.centsTolerance}c | harmonics ${this.referenceSelection.harmonicOverlays}${this.openStringsRunning ? ' | guided test running' : ''}`
        : 'disabled',
      referenceSummaries: this.buildReferenceSummaries(),
      currentFrameSize: this.analysisConfig.frameSize,
      currentHopSize: this.analysisConfig.hopSize,
      currentFftSize: this.analysisConfig.fftSize,
      currentWindowType: this.analysisConfig.windowType,
      smoothingEnabled: this.analysisConfig.temporalSmoothing
    });

    this.ui?.setButtonActive('freeze', this.freezeFrame, true);
    this.ui?.setButtonActive('record', this.recording, true);
    this.ui?.setButtonActive('ref', this.referenceSelection.enabled);
    this.ui?.setButtonActive('strings', this.openStringsRunning, true);
    this.ui?.setButtonActive('ac14', this.detectorEnabled.ac14);
    this.ui?.setButtonActive('masp', this.detectorEnabled.MASP);
    this.ui?.setButtonActive('fretnet', this.detectorEnabled.FRETNET);
    this.ui?.setButtonActive('spec', this.detectorEnabled.spectral_game_runtime_unified_v3);
    this.ui?.setButtonActive('dc', this.analysisConfig.dcRemoval);
    this.ui?.setButtonActive('norm', this.analysisConfig.normalize);
    this.ui?.setButtonActive('hp', this.analysisConfig.highPass);
    this.ui?.setButtonActive('lp', this.analysisConfig.lowPass);
    this.ui?.setButtonActive('gate', this.analysisConfig.noiseGate);
    this.ui?.setButtonActive('smooth', this.analysisConfig.temporalSmoothing);
  }

  private async toggleDetector(detectorName: DetectorToggleName): Promise<void> {
    if (this.nativeLiveMicRunning) {
      const changed = this.setExclusiveDetectorSelection(detectorName);
      if (changed) {
        await this.refreshDetectors();
      }
      this.addLog(`${detectorName} selected for Android native live mic`);
      await this.startNativeLiveMic();
      this.updateUi();
      return;
    }
    this.detectorEnabled[detectorName] = !this.detectorEnabled[detectorName];
    await this.refreshDetectors();
    this.addLog(`${detectorName} ${this.detectorEnabled[detectorName] ? 'enabled' : 'disabled'}`);
    this.updateUi();
  }

  private cycleFrameSize(): void {
    const values = [2048, 4096, 8192];
    this.analysisConfig.frameSize = cycleValue(values, this.analysisConfig.frameSize);
    this.applyAnalysisConfig();
  }

  private cycleHopSize(): void {
    const values = [256, 512, 1024];
    this.analysisConfig.hopSize = cycleValue(values, this.analysisConfig.hopSize);
    this.applyAnalysisConfig();
  }

  private cycleFftSize(): void {
    const values = [2048, 4096, 8192];
    this.analysisConfig.fftSize = cycleValue(values, this.analysisConfig.fftSize);
    this.applyAnalysisConfig();
  }

  private cycleWindowType(): void {
    const values: WindowType[] = ['hann', 'hamming', 'blackman', 'rect'];
    this.analysisConfig.windowType = cycleValue(values, this.analysisConfig.windowType);
    this.applyAnalysisConfig();
  }

  private toggleAnalysisFlag(key: keyof Pick<AnalysisConfig, 'dcRemoval' | 'normalize' | 'highPass' | 'lowPass' | 'noiseGate' | 'temporalSmoothing'>): void {
    this.analysisConfig[key] = !this.analysisConfig[key];
    this.applyAnalysisConfig();
  }

  private applyAnalysisConfig(): void {
    this.preprocessService.updateFrameSize(this.analysisConfig.frameSize);
    this.preprocessService.updateConfig({
      windowType: this.analysisConfig.windowType,
      dcRemoval: this.analysisConfig.dcRemoval,
      normalize: this.analysisConfig.normalize,
      highPass: this.analysisConfig.highPass,
      lowPass: this.analysisConfig.lowPass,
      bandPass: this.analysisConfig.bandPass,
      noiseGate: this.analysisConfig.noiseGate
    });
    this.rawFeatureService.updateFftSize(this.analysisConfig.fftSize);
    this.processedFeatureService.updateFftSize(this.analysisConfig.fftSize);
    this.captureService?.updateFrameConfig(this.analysisConfig.frameSize, this.analysisConfig.hopSize);
    this.debugRecorder.setFrameShape(this.analysisConfig.frameSize, this.analysisConfig.hopSize);
    this.addLog(`Analysis config updated: frame ${this.analysisConfig.frameSize}, hop ${this.analysisConfig.hopSize}, fft ${this.analysisConfig.fftSize}, window ${this.analysisConfig.windowType}`);
    if (this.nativeLiveMicRunning) {
      void this.startNativeLiveMic();
    }
    this.updateUi();
  }

  private async exportRawWav(): Promise<void> {
    if (this.nativeLiveMicRunning) {
      this.addLog('Raw WAV export unavailable: Android native live mic does not stream PCM into JS.');
      return;
    }
    const sampleRate = this.captureMetadata?.actualSampleRate ?? 48_000;
    const target = await this.debugRecorder.exportRawWav(sampleRate, this.analysisConfig.frameSize, this.analysisConfig.hopSize);
    this.addLog(`Raw WAV exported: ${target}`);
  }

  private async exportProcessedWav(): Promise<void> {
    if (this.nativeLiveMicRunning) {
      this.addLog('Processed WAV export unavailable: Android native live mic does not stream PCM into JS.');
      return;
    }
    const sampleRate = this.captureMetadata?.actualSampleRate ?? 48_000;
    const target = await this.debugRecorder.exportProcessedWav(sampleRate, this.analysisConfig.frameSize, this.analysisConfig.hopSize);
    this.addLog(`Processed WAV exported: ${target}`);
  }

  private async exportJsonl(): Promise<void> {
    const target = await this.debugRecorder.exportJsonl();
    this.addLog(`JSONL exported: ${target}`);
  }

  private async exportCsv(): Promise<void> {
    const diagnostics = this.debugRecorder.getFrameDiagnostics();
    const meanRmsDbfs = diagnostics.length > 0
      ? diagnostics.reduce((sum, entry) => sum + entry.metrics.rmsDbfs, 0) / diagnostics.length
      : 0;
    const meanNoiseFloorDb = diagnostics.length > 0
      ? diagnostics.reduce((sum, entry) => sum + entry.metrics.estimatedNoiseFloorDb, 0) / diagnostics.length
      : 0;
    const clippedFrames = diagnostics.filter((entry) => entry.metrics.clippingRatio > 0).length;
    const sampleRate = this.captureMetadata?.actualSampleRate ?? 48_000;
    const durationSeconds = diagnostics.length > 0
      ? (this.analysisConfig.frameSize + (diagnostics.length - 1) * this.analysisConfig.hopSize) / sampleRate
      : 0;
    const detectorResults = this.currentSnapshot?.detectorResults ?? [];
    const target = await this.debugRecorder.exportCsvSummary({
      sessionId: `pitch-debug-${Date.now()}`,
      captureMetadata: this.captureMetadata ?? this.captureService?.getMetadata() ?? fallbackMetadata(),
      frameSize: this.analysisConfig.frameSize,
      hopSize: this.analysisConfig.hopSize,
      durationSeconds,
      meanRmsDbfs,
      meanNoiseFloorDb,
      clippedFrames,
      referenceSummary: this.buildReferenceSummaries(),
      detectorResults
    });
    this.addLog(`CSV summary exported: ${target}`);
  }

  private async startNativeLiveMic(): Promise<void> {
    runtimeLog(
      { scene: 'PitchDebugScene', subsystem: 'native-mic' },
      'INFO',
      'Preparing Android native live mic start.',
      { detector: this.resolveNativeDetectorSelection() }
    );
    const granted = await ensureNativePitchInputPermission().catch((error) => {
      this.addLog(`Native mic permission failed: ${error instanceof Error ? error.message : String(error)}`);
      runtimeLog(
        { scene: 'PitchDebugScene', subsystem: 'native-mic' },
        'WARN',
        'Native mic permission request failed.',
        { error: toRuntimeErrorMessage(error) }
      );
      return false;
    });
    if (!granted) {
      this.addLog('Native mic permission denied.');
      runtimeLog({ scene: 'PitchDebugScene', subsystem: 'native-mic' }, 'WARN', 'Native mic permission denied.');
      return;
    }

    await this.captureService?.stop();
    if (this.nativePollTimerId !== null) {
      window.clearInterval(this.nativePollTimerId);
      this.nativePollTimerId = null;
    }
    this.nativePollInFlight = false;
    await stopNativePitchCapture().catch(() => undefined);

    const detectorName = this.resolveNativeDetectorSelection();
    this.setExclusiveDetectorSelection(detectorName);
    this.resetRunState();
    this.nativeDiagnostics = null;
    this.captureMetadata = buildNativeCaptureMetadata(null, detectorName, this.analysisConfig.frameSize);
    this.updateUi();
    this.addLog(`Starting Android native live mic (${detectorName})...`);
    runtimeLog(
      { scene: 'PitchDebugScene', subsystem: 'native-mic' },
      'INFO',
      'Starting Android native live mic.',
      { detector: detectorName, frameSize: this.analysisConfig.frameSize }
    );

    const detectorPreset = this.resolveNativeDetectorPreset(detectorName);
    try {
      const response = await startNativePitchCapture({
        detectorPreset,
        requestedSampleRate: 48_000,
        blockSize: this.analysisConfig.frameSize,
        audioInputMode: 'speaker',
        spectralModel: needsNativeSpectralModel(detectorPreset) ? this.spectralModel : null
      });
      this.nativeDiagnostics = response.diagnostics ?? null;
      this.captureMetadata = buildNativeCaptureMetadata(this.nativeDiagnostics, detectorName, this.analysisConfig.frameSize);
      this.nativeLiveMicRunning = Boolean(response.running);
      if (!this.nativeLiveMicRunning) {
        const reason = this.nativeDiagnostics?.fallback_reason ?? 'unknown native start failure';
        this.addLog(`Android native live mic failed: ${reason}`);
        runtimeLog(
          { scene: 'PitchDebugScene', subsystem: 'native-mic' },
          'WARN',
          'Android native live mic reported unsuccessful start.',
          { detector: detectorName, reason }
        );
        this.updateUi();
        return;
      }
      this.logNativeDiagnostics(detectorName, this.nativeDiagnostics);
      this.nativePollTimerId = window.setInterval(() => {
        void this.pollNativeDebugResults();
      }, 50);
      this.updateUi();
    } catch (error) {
      this.nativeLiveMicRunning = false;
      this.captureMetadata = buildNativeCaptureMetadata(this.nativeDiagnostics, detectorName, this.analysisConfig.frameSize);
      this.addLog(`Android native live mic start failed: ${error instanceof Error ? error.message : String(error)}`);
      runtimeLog(
        { scene: 'PitchDebugScene', subsystem: 'native-mic' },
        'ERROR',
        'Android native live mic start failed.',
        { detector: detectorName, error: toRuntimeErrorMessage(error) }
      );
      this.updateUi();
    }
  }

  private async announceNativeDebugLogInfo(): Promise<void> {
    if (this.nativeDebugLogAnnounced) {
      return;
    }
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      this.nativeDebugLogAnnounced = true;
      return;
    }

    try {
      const info = await getNativePitchDebugLogInfo();
      if (info.enabled && info.logPath) {
        this.addLog(`Android native debug log: ${info.logPath}`);
      } else if (!info.enabled) {
        this.addLog('Android native debug file log is disabled in this build.');
      }
      this.nativeDebugLogAnnounced = true;
    } catch (error) {
      this.addLog(`Native debug log info unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.nativeDebugLogAnnounced = true;
    }
  }

  private async stopNativeLiveMic(logStop = true): Promise<void> {
    if (this.nativePollTimerId !== null) {
      window.clearInterval(this.nativePollTimerId);
      this.nativePollTimerId = null;
    }
    this.nativePollInFlight = false;
    const wasRunning = this.nativeLiveMicRunning;
    this.nativeLiveMicRunning = false;
    this.nativeDiagnostics = null;
    if (!this.useNativePitchInput) {
      return;
    }
    runtimeLog(
      { scene: 'PitchDebugScene', subsystem: 'native-mic' },
      'INFO',
      'Stopping Android native live mic.',
      { wasRunning }
    );
    await stopNativePitchCapture().catch(() => undefined);
    if (wasRunning && logStop) {
      this.addLog('Android native live mic stopped.');
    }
  }

  private async pollNativeDebugResults(): Promise<void> {
    if (!this.nativeLiveMicRunning || this.nativePollInFlight) {
      return;
    }
    this.nativePollInFlight = true;
    try {
      const response = await pollNativePitchResults(6);
      this.nativeDiagnostics = response.diagnostics ?? this.nativeDiagnostics;
      if (this.captureMetadata) {
        this.captureMetadata = buildNativeCaptureMetadata(
          this.nativeDiagnostics,
          this.resolveNativeDetectorSelection(),
          this.analysisConfig.frameSize
        );
      }
      if (response.running === false) {
        this.nativeLiveMicRunning = false;
        if (this.nativePollTimerId !== null) {
          window.clearInterval(this.nativePollTimerId);
          this.nativePollTimerId = null;
        }
        this.addLog(`Android native live mic stopped by plugin${this.nativeDiagnostics?.fallback_reason ? `: ${this.nativeDiagnostics.fallback_reason}` : ''}`);
        this.updateUi();
        return;
      }

      const results = response.results ?? [];
      if (results.length <= 0) {
        this.updateUi();
        return;
      }

      for (const result of results) {
        const snapshot = this.buildNativeSnapshot(result);
        this.currentSnapshot = snapshot;
        if (this.recording) {
          this.debugRecorder.appendDiagnosticsOnly(snapshot);
        }
        this.handleFrameLogs(snapshot);
        this.collectReferenceTestFrame(snapshot.detectorResults, snapshot.frameContext.timestampMs);
        this.frameIndex += 1;
        this.analysisWindowId += 1;
      }
      if (!this.freezeFrame && (performance.now() - this.lastUiUpdateMs >= 60 || this.lastUiUpdateMs === 0)) {
        this.lastUiUpdateMs = performance.now();
        this.updateUi();
      }
    } catch (error) {
      this.addLog(`Android native poll failed: ${error instanceof Error ? error.message : String(error)}`);
      runtimeLog(
        { scene: 'PitchDebugScene', subsystem: 'native-mic' },
        'WARN',
        'Android native poll failed.',
        { error: toRuntimeErrorMessage(error) }
      );
    } finally {
      this.nativePollInFlight = false;
    }
  }

  private buildNativeSnapshot(result: NativePitchDetectionResult): PitchDebugFrameSnapshot {
    const detectorName = mapNativeDetectorName(result.backend_name, this.resolveNativeDetectorSelection());
    const sampleRate = this.captureMetadata?.actualSampleRate ?? this.nativeDiagnostics?.sample_rate ?? 48_000;
    const timestampMs = Number.isFinite(result.timestamp_sec) ? Number(result.timestamp_sec) * 1000 : performance.now();
    const rawFrame = new Float32Array(this.analysisConfig.frameSize);
    const processedFrame = new Float32Array(this.analysisConfig.frameSize);
    const metrics = buildNativeMetrics(this.nativeDiagnostics);
    const features: PrecomputedFeatures = {
      metrics,
      fftSize: this.analysisConfig.fftSize,
      magnitudeSpectrum: new Float32Array(Math.max(1, Math.floor(this.analysisConfig.fftSize / 2))),
      frequencyResolutionHz: sampleRate / Math.max(1, this.analysisConfig.fftSize),
      topSpectralPeaks: [],
      spectralEnergyTotal: 0,
      referenceNote: this.referenceSelection.enabled ? this.referenceSelection : null,
      spectralModel: this.spectralModel,
      candidateNotes: []
    };
    const frameContext: AudioFrameContext = {
      timestampMs,
      frameIndex: this.frameIndex,
      sampleRate,
      rawFrame,
      processedFrame,
      analysisWindowId: this.analysisWindowId,
      optionalFeatures: features
    };
    const detectorResultRaw = buildDetectorResultFromNative(result, detectorName, this.referenceSelection);
    const detectorResult = this.analysisConfig.temporalSmoothing
      ? this.applyTemporalSmoothing(detectorResultRaw)
      : detectorResultRaw;
    return {
      frameContext,
      rawMetrics: metrics,
      features,
      detectorResults: [detectorResult],
      captureMetadata: buildNativeCaptureMetadata(this.nativeDiagnostics, this.resolveNativeDetectorSelection(), this.analysisConfig.frameSize),
      analysisTimeMs: result.processing_time_ms ?? 0,
      overload: Boolean(result.overrun) || ((result.callback_to_result_latency_ms ?? 0) > ((this.analysisConfig.hopSize / sampleRate) * 1000 * 2))
    };
  }

  private resolveNativeDetectorSelection(): DetectorToggleName {
    const active = (Object.entries(this.detectorEnabled) as Array<[DetectorToggleName, boolean]>)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    if (active.length > 0) {
      return active[0];
    }
    this.detectorEnabled.ac14 = true;
    return 'ac14';
  }

  private setExclusiveDetectorSelection(detectorName: DetectorToggleName): boolean {
    let changed = false;
    for (const name of Object.keys(this.detectorEnabled) as DetectorToggleName[]) {
      const enabled = name === detectorName;
      if (this.detectorEnabled[name] !== enabled) {
        this.detectorEnabled[name] = enabled;
        changed = true;
      }
    }
    return changed;
  }

  private resolveNativeDetectorPreset(detectorName: DetectorToggleName): PitchDetectorPreset {
    if (detectorName === 'MASP') {
      return MASP_GAME_SCENE_PRESET;
    }
    if (detectorName === 'FRETNET') {
      return 'fretnet';
    }
    return detectorName;
  }

  private logNativeDiagnostics(detectorName: DetectorToggleName, diagnostics: NativePitchDiagnostics | null): void {
    if (!diagnostics) {
      this.addLog(`Android native live mic running with ${detectorName}.`);
      return;
    }
    const preset = diagnostics.actual_input_preset ?? 'unknown';
    const audioApi = diagnostics.audio_api ?? 'unknown_api';
    const sampleRate = diagnostics.sample_rate ?? 0;
    const callbackCount = diagnostics.callback_count ?? 0;
    const signalCallbacks = diagnostics.signal_callback_count ?? 0;
    const zeroCallbacks = diagnostics.all_zero_callback_count ?? 0;
    const fallbackReason = diagnostics.fallback_reason ? ` | fallback ${diagnostics.fallback_reason}` : '';
    this.addLog(
      `Android native live mic active: ${detectorName} | ${audioApi} | ${sampleRate} Hz | preset ${preset} | callbacks ${callbackCount} | signal ${signalCallbacks} | zero ${zeroCallbacks}${fallbackReason}`
    );
  }

  private async resetDetectors(): Promise<void> {
    if (this.nativeLiveMicRunning) {
      await resetNativePitchDetector({ allowWhileRunning: true }).catch((error) => {
        this.addLog(`Native detector reset failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.addLog('Android native detector reset.');
      return;
    }
    this.detectorManager?.resetAll();
    this.addLog('Detector state reset.');
  }

  private resetRunState(): void {
    this.frameIndex = 0;
    this.analysisWindowId = 0;
    this.currentSnapshot = null;
    this.logs = [];
    this.rollingRawAudio.clear();
    this.rollingProcessedAudio.clear();
    this.continuousRawInitialized = false;
    this.debugRecorder.clear();
    this.debugRecorder.setFrameShape(this.analysisConfig.frameSize, this.analysisConfig.hopSize);
    this.sampleRateMismatchLogged = false;
    this.detectorLastAccepted.clear();
    this.detectorLastMidi.clear();
    this.smoothingState.clear();
  }
}

function cycleValue<T>(values: T[], current: T): T {
  const index = values.indexOf(current);
  if (index < 0) return values[0];
  return values[(index + 1) % values.length];
}

function median(values: number[]): number | null {
  if (values.length <= 0) return null;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[middle - 1] + values[middle]) / 2;
  }
  return values[middle];
}

async function promptForAudioFile(): Promise<File | null> {
  return await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.m4a,.mp3,.ogg';
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
    };
    input.click();
  });
}

function fallbackMetadata(): AudioCaptureMetadata {
  return {
    mode: 'live_mic',
    requestedSampleRate: null,
    actualSampleRate: null,
    requestedBufferSize: 512,
    callbackBufferSize: 512,
    callbackIntervalMs: 0,
    callbackIntervalAvgMs: 0,
    callbackIntervalMaxMs: 0,
    droppedBuffers: 0,
    channels: 1,
    unprocessedRequested: true,
    processingConstraintsDisabled: true,
    inputSource: 'unknown',
    deviceLabel: null,
    fileName: null,
    capturePreset: 'Unknown',
    lowLatencyRequested: false,
    lowLatencyActive: null,
    androidInfo: null
  };
}

function needsNativeSpectralModel(detectorPreset: PitchDetectorPreset): boolean {
  return detectorPreset === 'fretnet' || detectorPreset === 'spectral_game_runtime_unified_v3';
}

function mapNativeDetectorName(backendName: string | undefined, fallback: DetectorToggleName): string {
  if (backendName === 'fretnet') return 'FRETNET';
  if (backendName === 'masp') return 'MASP';
  if (backendName === 'spectral_game_runtime_unified_v3') return 'spectral_game_runtime_unified_v3';
  if (backendName === 'ac14') return 'ac14';
  if (fallback === 'FRETNET') return 'FRETNET';
  if (fallback === 'MASP') return 'MASP';
  return fallback;
}

function buildDetectorResultFromNative(
  result: NativePitchDetectionResult,
  detectorName: string,
  referenceSelection: ReferenceNoteSelection
): PitchDetectorResult {
  const midi = Number.isFinite(result.midi_estimate) ? Number(result.midi_estimate) : undefined;
  const pitchHz = Number.isFinite(result.pitch_hz) ? Number(result.pitch_hz) : undefined;
  const accepted = result.validation_passed === false
    ? false
    : Boolean(pitchHz !== undefined || midi !== undefined || (result.selected_notes?.length ?? 0) > 0);
  return {
    detectorName,
    accepted,
    pitchHz,
    midi,
    noteName: midi === undefined ? undefined : midiToNoteName(Math.round(midi)),
    cents: midi === undefined || !referenceSelection.enabled ? undefined : (midi - referenceSelection.midi) * 100,
    confidence: result.confidence,
    stringId: result.detected_string ?? result.selected_notes?.[0]?.string ?? null,
    fret: result.detected_fret ?? result.selected_notes?.[0]?.fret ?? null,
    candidates: (result.selected_notes ?? [])
      .filter((note): note is NonNullable<typeof result.selected_notes>[number] & { midi: number } => Number.isFinite(note.midi))
      .map((note) => ({
        pitchHz: midiToHz(note.midi),
        midi: note.midi,
        noteName: midiToNoteName(Math.round(note.midi)),
        confidence: note.score,
        label: note.note_id ?? undefined
      })),
    rejectReason: accepted ? null : (result.reason ?? (result.validation_passed === false ? 'native_validation_failed' : 'native_no_detection')),
    processingTimeMs: result.processing_time_ms,
    debug: {
      backend_name: result.backend_name ?? detectorName,
      best_note_id: result.best_note_id ?? null,
      detected_string: result.detected_string ?? null,
      detected_fret: result.detected_fret ?? null,
      callback_to_result_latency_ms: result.callback_to_result_latency_ms ?? null,
      detector_queue_depth: result.detector_queue_depth ?? null,
      dropped_blocks: result.dropped_blocks ?? null,
      overrun: result.overrun ?? false,
      validation_passed: result.validation_passed ?? null
    }
  };
}

function buildNativeCaptureMetadata(
  diagnostics: NativePitchDiagnostics | null,
  detectorName: DetectorToggleName,
  blockSize: number
): AudioCaptureMetadata {
  const sampleRate = diagnostics?.sample_rate ?? diagnostics?.hardware_sample_rate ?? 48_000;
  const callbackFrames = diagnostics?.frames_per_callback ?? blockSize;
  const callbackIntervalMs = sampleRate > 0 ? (callbackFrames / sampleRate) * 1000 : 0;
  const actualPreset = diagnostics?.actual_input_preset ?? 'native_android';
  const detectorLabel = detectorName === 'MASP' ? 'MASP' : detectorName;
  const androidInfoParts = [
    diagnostics?.audio_api,
    actualPreset,
    diagnostics?.performance_mode,
    diagnostics?.sharing_mode
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    mode: 'live_mic',
    requestedSampleRate: 48_000,
    actualSampleRate: sampleRate,
    requestedBufferSize: blockSize,
    callbackBufferSize: callbackFrames,
    callbackIntervalMs,
    callbackIntervalAvgMs: callbackIntervalMs,
    callbackIntervalMaxMs: callbackIntervalMs,
    droppedBuffers: diagnostics?.dropped_blocks ?? 0,
    channels: diagnostics?.channel_count ?? 1,
    unprocessedRequested: true,
    processingConstraintsDisabled: actualPreset === 'unprocessed',
    inputSource: 'native_android_oboe',
    deviceLabel: diagnostics?.device_id === undefined ? null : `device ${diagnostics.device_id}`,
    fileName: null,
    capturePreset: `Android native mic (${detectorLabel})`,
    lowLatencyRequested: true,
    lowLatencyActive: diagnostics?.performance_mode === 'low_latency',
    androidInfo: androidInfoParts.length > 0 ? androidInfoParts.join(' | ') : 'native_android_oboe'
  };
}

function buildNativeMetrics(diagnostics: NativePitchDiagnostics | null): FrameSignalMetrics {
  const rms = clampAmplitude(diagnostics?.rms ?? 0);
  const peak = clampAmplitude(diagnostics?.peak ?? 0);
  const noiseFloor = clampAmplitude(diagnostics?.noise_floor ?? 0);
  return {
    rms,
    rmsDbfs: toDbfs(rms),
    peak,
    peakDbfs: toDbfs(peak),
    crestFactor: rms > 0 ? peak / rms : 0,
    dcOffset: 0,
    clippingRatio: peak >= 0.999 ? 1 : 0,
    zcr: 0,
    spectralCentroidHz: 0,
    spectralRolloffHz: 0,
    spectralFlatness: 0,
    bandEnergy_60_100: 0,
    bandEnergy_100_200: 0,
    bandEnergy_200_400: 0,
    bandEnergy_400_800: 0,
    bandEnergy_800_1600: 0,
    bandEnergy_1600_3200: 0,
    lowBandEnergyRatio: 0,
    estimatedNoiseFloorDb: toDbfs(noiseFloor),
    estimatedSnrDb: rms > 0 && noiseFloor > 0 ? toDbfs(rms) - toDbfs(noiseFloor) : 0
  };
}

function clampAmplitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toDbfs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return -120;
  }
  return 20 * Math.log10(value);
}
