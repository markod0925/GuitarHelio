import { Capacitor } from '@capacitor/core';
import captureWorkletUrl from './audioCaptureWorklet.js?worker&url';
import type { AudioCaptureFrame, AudioCaptureMetadata, PitchDebugInputMode } from '../pitch/types';
import {
  DEFAULT_CALLBACK_CHUNK_SIZE,
  DEFAULT_FRAME_SIZE,
  DEFAULT_HOP_SIZE,
  clampInteger,
  describeAndroidRuntime,
  resolveCapturePresetLabel
} from './debugSignalProcessing';

type CaptureServiceCallbacks = {
  onFrame: (frame: AudioCaptureFrame) => void;
  onStateChanged?: (metadata: AudioCaptureMetadata) => void;
  onEvent?: (message: string) => void;
};

type CaptureStreamOptions = {
  requestedSampleRate?: number;
  frameSize?: number;
  hopSize?: number;
  callbackChunkSize?: number;
};

type DecodedBufferLike = {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData: (channel: number) => Float32Array;
};

const DEFAULT_REQUESTED_SAMPLE_RATE = 48_000;

export class AudioCaptureService {
  private readonly onFrame: (frame: AudioCaptureFrame) => void;
  private readonly onStateChanged?: (metadata: AudioCaptureMetadata) => void;
  private readonly onEvent?: (message: string) => void;
  private metadata: AudioCaptureMetadata;
  private frameSize = DEFAULT_FRAME_SIZE;
  private hopSize = DEFAULT_HOP_SIZE;
  private callbackChunkSize = DEFAULT_CALLBACK_CHUNK_SIZE;
  private ringBuffer = new Float32Array(DEFAULT_FRAME_SIZE * 4);
  private writeIndex = 0;
  private totalSamples = 0;
  private samplesSinceLastFrame = 0;
  private ctx?: AudioContext;
  private mediaStream?: MediaStream;
  private workletNode?: AudioWorkletNode;
  private sourceNode?: MediaStreamAudioSourceNode;
  private sinkNode?: GainNode;
  private playbackTimerId: number | null = null;
  private callbackIntervalSamples: number[] = [];
  private lastChunkTimeMs: number | null = null;

  constructor(callbacks: CaptureServiceCallbacks) {
    this.onFrame = callbacks.onFrame;
    this.onStateChanged = callbacks.onStateChanged;
    this.onEvent = callbacks.onEvent;
    this.metadata = createDefaultMetadata();
  }

  async startLiveMic(options: CaptureStreamOptions = {}): Promise<void> {
    await this.stop();
    this.configureWindowing(options);
    const requestedSampleRate = options.requestedSampleRate ?? DEFAULT_REQUESTED_SAMPLE_RATE;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: requestedSampleRate,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    this.mediaStream = stream;

    const ctx = new AudioContext({ sampleRate: requestedSampleRate });
    this.ctx = ctx;
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
    await ctx.audioWorklet.addModule(captureWorkletUrl);
    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;
    const node = new AudioWorkletNode(ctx, 'pitch-debug-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        chunkSize: this.callbackChunkSize
      }
    });
    this.workletNode = node;
    node.port.onmessage = (event: MessageEvent<{ type?: string; timeSeconds?: number; sampleRate?: number; samples?: Float32Array }>) => {
      const payload = event.data;
      if (!payload || payload.type !== 'chunk' || !(payload.samples instanceof Float32Array)) return;
      const timeSeconds = typeof payload.timeSeconds === 'number' ? payload.timeSeconds : Number.NaN;
      this.handleChunk(payload.samples, Number.isFinite(timeSeconds) ? timeSeconds * 1000 : performance.now());
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.sinkNode = sink;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    this.updateMetadata({
      mode: 'live_mic',
      requestedSampleRate,
      actualSampleRate: ctx.sampleRate,
      callbackBufferSize: this.callbackChunkSize,
      requestedBufferSize: this.callbackChunkSize,
      channels: Number.isFinite(settings.channelCount) ? Number(settings.channelCount) : 1,
      unprocessedRequested: true,
      processingConstraintsDisabled: true,
      inputSource: 'getUserMedia',
      deviceLabel: track?.label?.trim() || null,
      fileName: null,
      capturePreset: resolveCapturePresetLabel('live_mic'),
      lowLatencyRequested: true,
      lowLatencyActive: null
    });
    this.onEvent?.('Capture started: live microphone');
  }

  async startDecodedBuffer(
    decodedBuffer: DecodedBufferLike,
    mode: PitchDebugInputMode,
    fileName: string | null
  ): Promise<void> {
    await this.stop();
    this.resetFrameAggregation();
    const mono = mixToMono(decodedBuffer);
    const chunkSize = this.callbackChunkSize;
    let readIndex = 0;
    const startedAt = performance.now();
    const chunkDurationMs = (chunkSize / decodedBuffer.sampleRate) * 1000;
    this.updateMetadata({
      mode,
      requestedSampleRate: decodedBuffer.sampleRate,
      actualSampleRate: decodedBuffer.sampleRate,
      callbackBufferSize: chunkSize,
      requestedBufferSize: chunkSize,
      channels: 1,
      unprocessedRequested: true,
      processingConstraintsDisabled: true,
      inputSource: mode === 'replay' ? 'ring-buffer replay' : 'decoded audio buffer',
      deviceLabel: null,
      fileName,
      capturePreset: resolveCapturePresetLabel(mode),
      lowLatencyRequested: false,
      lowLatencyActive: false
    });

    const tick = () => {
      const elapsedMs = performance.now() - startedAt;
      const targetReadIndex = Math.min(
        mono.length,
        Math.round((elapsedMs / 1000) * decodedBuffer.sampleRate)
      );
      if (targetReadIndex <= readIndex) {
        this.playbackTimerId = window.setTimeout(tick, Math.max(8, chunkDurationMs * 0.5));
        return;
      }
      while (readIndex < targetReadIndex) {
        const end = Math.min(mono.length, readIndex + chunkSize);
        this.handleChunk(mono.subarray(readIndex, end), performance.now(), decodedBuffer.sampleRate);
        readIndex = end;
      }
      if (readIndex >= mono.length) {
        this.playbackTimerId = null;
        this.onEvent?.(`Capture completed: ${mode === 'replay' ? 'replay' : 'file playback'}`);
        return;
      }
      this.playbackTimerId = window.setTimeout(tick, Math.max(8, chunkDurationMs * 0.5));
    };

    this.onEvent?.(mode === 'replay' ? 'Replay started' : `Playback started${fileName ? `: ${fileName}` : ''}`);
    tick();
  }

  async stop(): Promise<void> {
    if (this.playbackTimerId !== null) {
      window.clearTimeout(this.playbackTimerId);
      this.playbackTimerId = null;
    }
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.sinkNode?.disconnect();
    this.workletNode = undefined;
    this.sourceNode = undefined;
    this.sinkNode = undefined;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = undefined;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.close().catch(() => undefined);
    }
    this.ctx = undefined;
    this.resetFrameAggregation();
  }

  getMetadata(): AudioCaptureMetadata {
    return { ...this.metadata };
  }

  updateFrameConfig(frameSize: number, hopSize: number, callbackChunkSize = this.callbackChunkSize): void {
    this.frameSize = clampInteger(frameSize, 256, 16384);
    this.hopSize = clampInteger(hopSize, 64, this.frameSize);
    this.callbackChunkSize = clampInteger(callbackChunkSize, 128, 4096);
    this.ringBuffer = new Float32Array(Math.max(this.ringBuffer.length, this.frameSize * 4));
    this.resetFrameAggregation();
  }

  private configureWindowing(options: CaptureStreamOptions): void {
    this.frameSize = clampInteger(options.frameSize ?? DEFAULT_FRAME_SIZE, 256, 16384);
    this.hopSize = clampInteger(options.hopSize ?? DEFAULT_HOP_SIZE, 64, this.frameSize);
    this.callbackChunkSize = clampInteger(options.callbackChunkSize ?? DEFAULT_CALLBACK_CHUNK_SIZE, 128, 4096);
    this.ringBuffer = new Float32Array(Math.max(this.frameSize * 4, this.callbackChunkSize * 4));
    this.resetFrameAggregation();
  }

  private resetFrameAggregation(): void {
    this.ringBuffer.fill(0);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.samplesSinceLastFrame = 0;
    this.callbackIntervalSamples.length = 0;
    this.lastChunkTimeMs = null;
  }

  private handleChunk(chunk: Float32Array, timestampMs: number, sampleRate = this.metadata.actualSampleRate ?? DEFAULT_REQUESTED_SAMPLE_RATE): void {
    const intervalMs = this.lastChunkTimeMs === null ? 0 : Math.max(0, timestampMs - this.lastChunkTimeMs);
    this.lastChunkTimeMs = timestampMs;
    if (intervalMs > 0) {
      this.callbackIntervalSamples.push(intervalMs);
      if (this.callbackIntervalSamples.length > 120) {
        this.callbackIntervalSamples.shift();
      }
      const expectedIntervalMs = (chunk.length / sampleRate) * 1000;
      if (intervalMs > expectedIntervalMs * 1.6) {
        this.metadata.droppedBuffers += Math.max(1, Math.round(intervalMs / Math.max(1, expectedIntervalMs)) - 1);
      }
      this.metadata.callbackIntervalMs = intervalMs;
      this.metadata.callbackIntervalAvgMs = average(this.callbackIntervalSamples);
      this.metadata.callbackIntervalMaxMs = maxOf(this.callbackIntervalSamples);
    }

    this.metadata.actualSampleRate = sampleRate;
    for (let i = 0; i < chunk.length; i += 1) {
      this.ringBuffer[this.writeIndex] = chunk[i];
      this.writeIndex = (this.writeIndex + 1) % this.ringBuffer.length;
      this.totalSamples = Math.min(this.totalSamples + 1, this.ringBuffer.length);
      this.samplesSinceLastFrame += 1;
    }
    this.onStateChanged?.({ ...this.metadata });

    while (this.totalSamples >= this.frameSize && this.samplesSinceLastFrame >= this.hopSize) {
      this.samplesSinceLastFrame -= this.hopSize;
      const rawFrame = new Float32Array(this.frameSize);
      const start = (this.writeIndex - this.frameSize + this.ringBuffer.length) % this.ringBuffer.length;
      for (let i = 0; i < this.frameSize; i += 1) {
        rawFrame[i] = this.ringBuffer[(start + i) % this.ringBuffer.length];
      }
      this.onFrame({
        timestampMs,
        rawFrame,
        sampleRate
      });
    }
  }

  private updateMetadata(partial: Partial<AudioCaptureMetadata>): void {
    this.metadata = {
      ...this.metadata,
      ...partial,
      androidInfo: partial.androidInfo ?? this.metadata.androidInfo ?? (Capacitor.getPlatform() === 'android' ? describeAndroidRuntime() : null)
    };
    this.onStateChanged?.({ ...this.metadata });
  }
}

function createDefaultMetadata(): AudioCaptureMetadata {
  return {
    mode: 'live_mic',
    requestedSampleRate: null,
    actualSampleRate: null,
    requestedBufferSize: DEFAULT_CALLBACK_CHUNK_SIZE,
    callbackBufferSize: DEFAULT_CALLBACK_CHUNK_SIZE,
    callbackIntervalMs: 0,
    callbackIntervalAvgMs: 0,
    callbackIntervalMaxMs: 0,
    droppedBuffers: 0,
    channels: 1,
    unprocessedRequested: true,
    processingConstraintsDisabled: true,
    inputSource: 'idle',
    deviceLabel: null,
    fileName: null,
    capturePreset: 'Idle',
    lowLatencyRequested: false,
    lowLatencyActive: null,
    androidInfo: Capacitor.getPlatform() === 'android' ? describeAndroidRuntime() : null
  };
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxOf(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((max, value) => Math.max(max, value), 0);
}

function mixToMono(decoded: DecodedBufferLike): Float32Array {
  if (decoded.numberOfChannels <= 1) {
    return new Float32Array(decoded.getChannelData(0));
  }
  const output = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < decoded.length; i += 1) {
      output[i] += data[i] / decoded.numberOfChannels;
    }
  }
  return output;
}
