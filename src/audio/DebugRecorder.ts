import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type {
  AudioCaptureMetadata,
  FrameSignalMetrics,
  PitchDetectorResult,
  PitchDebugFrameSnapshot,
  ReferenceTestDetectorSummary
} from '../pitch/types';
import {
  buildDownloadFileName,
  bytesToBase64,
  encodeMonoWav
} from './debugSignalProcessing';
import { RingBufferAudioStore } from './RingBufferAudioStore';

type FrameDiagnosticRecord = {
  timestampMs: number;
  frameIndex: number;
  sampleRate: number;
  metrics: FrameSignalMetrics;
  detectors: Record<string, PitchDetectorResult>;
};

type SessionSummaryInput = {
  sessionId: string;
  captureMetadata: AudioCaptureMetadata;
  frameSize: number;
  hopSize: number;
  durationSeconds: number;
  meanRmsDbfs: number;
  meanNoiseFloorDb: number;
  clippedFrames: number;
  referenceSummary: ReferenceTestDetectorSummary[];
  detectorResults: PitchDetectorResult[];
};

export class DebugRecorder {
  private readonly rawAudioStore: RingBufferAudioStore;
  private readonly processedAudioStore: RingBufferAudioStore;
  private readonly frameDiagnostics: FrameDiagnosticRecord[] = [];
  private hopSize = 512;
  private rawInitialized = false;
  private processedInitialized = false;

  constructor(maxSeconds: number, sampleRate: number) {
    const capacity = Math.max(sampleRate, Math.round(maxSeconds * sampleRate));
    this.rawAudioStore = new RingBufferAudioStore(capacity);
    this.processedAudioStore = new RingBufferAudioStore(capacity);
  }

  clear(): void {
    this.rawAudioStore.clear();
    this.processedAudioStore.clear();
    this.frameDiagnostics.length = 0;
    this.rawInitialized = false;
    this.processedInitialized = false;
  }

  setFrameShape(_frameSize: number, hopSize: number): void {
    this.hopSize = Math.max(1, Math.round(hopSize));
  }

  append(snapshot: PitchDebugFrameSnapshot): void {
    this.appendWindow(snapshot.frameContext.rawFrame, snapshot.frameContext.processedFrame, snapshot.frameContext.analysisWindowId);
    const detectors: Record<string, PitchDetectorResult> = {};
    for (const result of snapshot.detectorResults) {
      detectors[result.detectorName] = result;
    }
    this.frameDiagnostics.push({
      timestampMs: snapshot.frameContext.timestampMs,
      frameIndex: snapshot.frameContext.frameIndex,
      sampleRate: snapshot.frameContext.sampleRate,
      metrics: snapshot.features.metrics,
      detectors
    });
    if (this.frameDiagnostics.length > 2400) {
      this.frameDiagnostics.splice(0, this.frameDiagnostics.length - 2400);
    }
  }

  private appendWindow(rawFrame: Float32Array, processedFrame: Float32Array, analysisWindowId: number): void {
    if (!this.rawInitialized || analysisWindowId === 0) {
      this.rawAudioStore.append(rawFrame);
      this.rawInitialized = true;
    } else {
      this.rawAudioStore.append(rawFrame.subarray(Math.max(0, rawFrame.length - this.hopSize)));
    }

    if (!this.processedInitialized || analysisWindowId === 0) {
      this.processedAudioStore.append(processedFrame);
      this.processedInitialized = true;
    } else {
      this.processedAudioStore.append(processedFrame.subarray(Math.max(0, processedFrame.length - this.hopSize)));
    }
  }

  rebuildContinuousAudio(frameSize: number, hopSize: number, useProcessed = false): Float32Array {
    const totalFrames = this.frameDiagnostics.length;
    if (totalFrames <= 0) return new Float32Array(0);
    const expectedLength = frameSize + Math.max(0, totalFrames - 1) * hopSize;
    return useProcessed
      ? this.processedAudioStore.readLatest(expectedLength)
      : this.rawAudioStore.readLatest(expectedLength);
  }

  latestRawSamples(sampleCount: number): Float32Array {
    return this.rawAudioStore.readLatest(sampleCount);
  }

  getFrameDiagnostics(): FrameDiagnosticRecord[] {
    return this.frameDiagnostics.slice();
  }

  async exportRawWav(sampleRate: number, frameSize: number, hopSize: number): Promise<string> {
    return await this.exportWav('pitch-debug-raw', this.rebuildContinuousAudio(frameSize, hopSize, false), sampleRate);
  }

  async exportProcessedWav(sampleRate: number, frameSize: number, hopSize: number): Promise<string> {
    return await this.exportWav('pitch-debug-processed', this.rebuildContinuousAudio(frameSize, hopSize, true), sampleRate);
  }

  async exportJsonl(): Promise<string> {
    const lines = this.frameDiagnostics.map((record) => JSON.stringify(record)).join('\n');
    return await this.writeTextExport('pitch-debug-diagnostics', 'jsonl', lines.length > 0 ? `${lines}\n` : '');
  }

  async exportCsvSummary(input: SessionSummaryInput): Promise<string> {
    const referenceSummary = new Map(input.referenceSummary.map((item) => [item.detectorName, item]));
    const rows = [
      'session_id,device_info,capture_preset,sample_rate,frame_size,hop_size,duration_seconds,mean_rms_dbfs,mean_noise_floor_db,clipped_frames,detector,acceptance_rate,median_confidence,median_cents_error,miss_rate,octave_error_rate',
      ...input.detectorResults.map((result) => {
        const detectorSummary = referenceSummary.get(result.detectorName);
        const missRate = detectorSummary ? 1 - detectorSummary.correctNoteRate : null;
        return [
          csvCell(input.sessionId),
          csvCell(input.captureMetadata.androidInfo ?? input.captureMetadata.deviceLabel ?? input.captureMetadata.inputSource),
          csvCell(input.captureMetadata.capturePreset),
          csvCell(input.captureMetadata.actualSampleRate ?? ''),
          csvCell(input.frameSize),
          csvCell(input.hopSize),
          csvCell(input.durationSeconds.toFixed(2)),
          csvCell(input.meanRmsDbfs.toFixed(3)),
          csvCell(input.meanNoiseFloorDb.toFixed(3)),
          csvCell(input.clippedFrames),
          csvCell(result.detectorName),
          csvCell(detectorSummary ? detectorSummary.acceptanceRate.toFixed(4) : ''),
          csvCell(detectorSummary ? detectorSummary.medianConfidence.toFixed(4) : ''),
          csvCell(detectorSummary?.medianCentsError ?? ''),
          csvCell(missRate === null ? '' : missRate.toFixed(4)),
          csvCell(detectorSummary ? detectorSummary.octaveErrorRate.toFixed(4) : '')
        ].join(',');
      })
    ].join('\n');
    return await this.writeTextExport('pitch-debug-summary', 'csv', `${rows}\n`);
  }

  private async exportWav(prefix: string, samples: Float32Array, sampleRate: number): Promise<string> {
    const bytes = encodeMonoWav(samples, sampleRate);
    return await this.writeBinaryExport(prefix, 'wav', bytes);
  }

  private async writeTextExport(prefix: string, extension: string, data: string): Promise<string> {
    if (Capacitor.isNativePlatform()) {
      const fileName = buildDownloadFileName(prefix, extension);
      const path = `diagnostics/${fileName}`;
      await Filesystem.mkdir({ path: 'diagnostics', directory: Directory.Data, recursive: true }).catch(() => undefined);
      await Filesystem.writeFile({ path, directory: Directory.Data, data });
      const uri = await Filesystem.getUri({ path, directory: Directory.Data });
      return uri.uri;
    }

    const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
    return triggerWebDownload(blob, buildDownloadFileName(prefix, extension));
  }

  private async writeBinaryExport(prefix: string, extension: string, bytes: Uint8Array): Promise<string> {
    if (Capacitor.isNativePlatform()) {
      const fileName = buildDownloadFileName(prefix, extension);
      const path = `diagnostics/${fileName}`;
      await Filesystem.mkdir({ path: 'diagnostics', directory: Directory.Data, recursive: true }).catch(() => undefined);
      await Filesystem.writeFile({
        path,
        directory: Directory.Data,
        data: bytesToBase64(bytes)
      });
      const uri = await Filesystem.getUri({ path, directory: Directory.Data });
      return uri.uri;
    }

    const copied = new Uint8Array(bytes);
    const blob = new Blob([copied], {
      type: extension === 'wav' ? 'audio/wav' : 'application/octet-stream'
    });
    return triggerWebDownload(blob, buildDownloadFileName(prefix, extension));
  }
}

function triggerWebDownload(blob: Blob, fileName: string): string {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return fileName;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  if (!/[,"\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
