import { createMicNode } from '../../../audio/micInput';
import Phaser from 'phaser';
import { JzzTinySynth } from '../../../audio/jzzTinySynth';
import { MidiScrubPlayer } from '../../../audio/midiScrubPlayer';
import { PitchDetectorService } from '../../../audio/pitchDetector';
import { buildPlaybackNotes } from '../../../audio/playbackNotes';
import {
  resolveResumeSongSeconds,
  resolveResumeSongSecondsForAudio,
  resolveSongSecondsForRuntime,
  sanitizeSongSeconds
} from '../../playbackResumeState';
import {
  getSongSecondsFromClock as getSongSecondsFromClockValue,
  pausePlaybackClock as pausePlaybackClockState,
  startPlaybackClock as startPlaybackClockState,
  type PlaybackClockState
} from '../../AudioController';
import { isBackingTrackAudioUrl } from '../../playSceneDebug';
import { PlayState, type SourceNote } from '../../../types/models';
import type { PlaySceneContext } from './PlaySceneContext';
type PlaySceneStatics = typeof import('../../PlayScene').PlayScene;

export class PlaybackController {
  constructor(private readonly scene: PlaySceneContext) {}

  async setupAudioStack(sourceNotes: SourceNote[]): Promise<void> {
    return await setupAudioStackImpl.call(this.scene, sourceNotes);
  }

  schedulePlaybackStart(delayMs?: number): void {
    schedulePlaybackStartImpl.call(this.scene, delayMs);
  }

  async beginSessionPlayback(): Promise<void> {
    return await beginSessionPlaybackImpl.call(this.scene);
  }

  async startBackingTrackAudio(audioUrl: string | undefined, startSongSeconds: number): Promise<boolean> {
    return await startBackingTrackAudioImpl.call(this.scene, audioUrl, startSongSeconds);
  }

  pauseBackingPlayback(): void {
    pauseBackingPlaybackImpl.call(this.scene);
  }

  resumeBackingPlayback(): void {
    resumeBackingPlaybackImpl.call(this.scene);
  }

  stopBackingPlayback(): void {
    stopBackingPlaybackImpl.call(this.scene);
  }

  async resumeBackingTrackAudio(songSeconds: number): Promise<void> {
    return await resumeBackingTrackAudioImpl.call(this.scene, songSeconds);
  }

  async playBackingTrackAudioFrom(songSeconds: number): Promise<boolean> {
    return await playBackingTrackAudioFromImpl.call(this.scene, songSeconds);
  }

  releaseBackingTrackAudio(): void {
    releaseBackingTrackAudioImpl.call(this.scene);
  }

  syncRuntimeToBackingTrackPosition(songSeconds: number): void {
    syncRuntimeToBackingTrackPositionImpl.call(this.scene, songSeconds);
  }

  stopBackingTrackSource(): void {
    stopBackingTrackSourceImpl.call(this.scene);
  }

  ensureBackingTrackGainNode(): void {
    ensureBackingTrackGainNodeImpl.call(this.scene);
  }

  getBackingTrackSongSeconds(): number | undefined {
    return getBackingTrackSongSecondsImpl.call(this.scene);
  }

  async loadBackingTrackBuffer(audioUrl: string): Promise<AudioBuffer> {
    return await loadBackingTrackBufferImpl.call(this.scene, audioUrl);
  }

  clampAudioSeekSeconds(songSeconds: number): number {
    return clampAudioSeekSecondsImpl.call(this.scene, songSeconds);
  }

  createPlaybackClockState(): PlaybackClockState {
    return createPlaybackClockStateImpl.call(this.scene);
  }

  applyPlaybackClockState(state: PlaybackClockState): void {
    applyPlaybackClockStateImpl.call(this.scene, state);
  }

  startPlaybackClock(songSeconds: number): void {
    startPlaybackClockImpl.call(this.scene, songSeconds);
  }

  pausePlaybackClock(): void {
    pausePlaybackClockImpl.call(this.scene);
  }

  getSongSecondsNow(): number {
    return getSongSecondsNowImpl.call(this.scene);
  }

  getSongSecondsFromClock(): number {
    return getSongSecondsFromClockImpl.call(this.scene);
  }

  getCurrentPlaybackBpm(songSeconds: number | undefined): number | undefined {
    return getCurrentPlaybackBpmImpl.call(this.scene, songSeconds);
  }
}

async function setupAudioStackImpl(this: PlaySceneContext, sourceNotes: SourceNote[]): Promise<void> {
  const audioCtx = new AudioContext();
  this.audioCtx = audioCtx;
  let synth: JzzTinySynth;
  try {
    synth = new JzzTinySynth(audioCtx);
  } catch (error) {
    console.error('JZZ Tiny synth setup failed', error);
    this.feedbackText = 'Playback synth unavailable.';
    this.feedbackUntilMs = Number.POSITIVE_INFINITY;
    return;
  }
  this.debugSynth = synth;
  const playbackNotes = buildPlaybackNotes(sourceNotes, this.ticksPerQuarter);
  this.scrubPlayer = new MidiScrubPlayer(synth, playbackNotes, Math.max(1, Math.floor(this.ticksPerQuarter / 2)));

  try {
    const micSource = await createMicNode(audioCtx);
    this.micStream = micSource.mediaStream;
    const detector = new PitchDetectorService(audioCtx);
    await detector.init();
    detector.onPitch((frame) => {
      if (this.pauseOverlay) return;
      if (this.runtime.state === PlayState.Finished) return;
      this.latestFrames.push(frame);
    });
    detector.start(micSource);
    this.detector = detector;
  } catch (error) {
    console.error('Microphone setup failed', error);
    if (this.profile.gating_timeout_seconds === undefined) {
      this.fallbackTimeoutSeconds = 2.5;
    }
    this.feedbackText = this.fallbackTimeoutSeconds
      ? 'Microphone unavailable. Auto-miss timeout active.'
      : 'Microphone unavailable.';
    this.feedbackUntilMs = Number.POSITIVE_INFINITY;
  }

  await audioCtx.resume();
  this.playbackMode = 'midi';
  this.pausedBackingAudioSeconds = undefined;
  this.lastKnownBackingAudioSeconds = 0;
  this.backingTrackBuffer = undefined;
  this.backingTrackSource = undefined;
  this.backingTrackGain = undefined;
  this.backingTrackSourceStartedAtAudioTime = undefined;
  this.backingTrackSourceStartSongSeconds = 0;
  this.backingTrackIsPlaying = false;
  this.backingTrackAudioUrl = undefined;
  this.playbackStarted = false;
  this.pausedSongSeconds = 0;
  this.playbackStartSongSeconds = 0;
  this.playbackStartAudioTime = null;
  this.prePlaybackStartAtMs = undefined;
}

function schedulePlaybackStartImpl(this: PlaySceneContext, delayMs?: number): void {
  const sceneClass = this.constructor as PlaySceneStatics;
  const resolvedDelayMs = delayMs ?? sceneClass.PRE_PLAYBACK_DELAY_MS;
  if (this.runtime.state === PlayState.Finished || this.playbackStarted) return;
  const clampedDelayMs = Math.max(0, resolvedDelayMs);
  this.prePlaybackStartAtMs = performance.now() + clampedDelayMs;
  this.playbackIntroTimer?.remove(false);
  this.playbackIntroTimer = this.time.delayedCall(clampedDelayMs, () => {
    this.playbackIntroTimer = undefined;
    if (!this.scene.isActive() || this.runtime.state === PlayState.Finished || this.playbackStarted) return;
    if (this.pauseOverlay || this.playbackPausedByButton) {
      this.schedulePlaybackStart(120);
      return;
    }
    void this.beginSessionPlayback();
  });
}

async function beginSessionPlaybackImpl(this: PlaySceneContext): Promise<void> {
  if (!this.audioCtx || this.playbackStarted) return;
  if (this.audioCtx.state !== 'running') {
    await this.audioCtx.resume();
  }

  const startSongSeconds = this.tempoMap?.tickToSeconds(this.runtime.current_tick) ?? 0;
  this.resetBallTrailHistory();
  this.prePlaybackStartAtMs = undefined;

  const wantsBackingAudio = isBackingTrackAudioUrl(this.sceneData?.audioUrl ?? '');
  if (wantsBackingAudio) {
    const startedBackingAudio = await this.startBackingTrackAudio(this.sceneData?.audioUrl, startSongSeconds);
    if (!startedBackingAudio) {
      this.playbackStarted = false;
      this.startPlaybackClock(startSongSeconds);
      this.pausePlaybackClock();
      this.schedulePlaybackStart(300);
      this.feedbackText = 'Backing track failed to start. Retrying...';
      this.feedbackUntilMs = performance.now() + 1200;
      return;
    }
    this.playbackStarted = true;
  } else {
    this.playbackMode = 'midi';
    this.startPlaybackClock(startSongSeconds);
    this.scrubPlayer?.resume(this.runtime.current_tick, this.audioCtx.currentTime);
    this.playbackStarted = true;
  }

  this.feedbackText = 'Go!';
  this.feedbackUntilMs = performance.now() + 900;
}

async function startBackingTrackAudioImpl(this: PlaySceneContext, audioUrl: string | undefined, startSongSeconds: number): Promise<boolean> {
  if (!audioUrl || !isBackingTrackAudioUrl(audioUrl)) {
    return false;
  }
  if (!this.audioCtx) return false;

  this.playbackMode = 'audio';
  this.lastKnownBackingAudioSeconds = 0;
  this.pausedBackingAudioSeconds = undefined;

  try {
    if (!this.backingTrackBuffer || this.backingTrackAudioUrl !== audioUrl) {
      this.backingTrackBuffer = await this.loadBackingTrackBuffer(audioUrl);
      this.backingTrackAudioUrl = audioUrl;
    }
    this.ensureBackingTrackGainNode();
    return await this.playBackingTrackAudioFrom(startSongSeconds);
  } catch (error) {
    this.lastAudioSeekDebug = {
      requestedSongSeconds: startSongSeconds,
      targetSeconds: startSongSeconds,
      beforeSeekSeconds: 0,
      afterPlaySeconds: undefined,
      fallbackToMidi: false,
      seekDisabled: false,
      ok: false,
      atMs: performance.now()
    };
    console.warn('Backing track load failed', { audioUrl, error });
    return false;
  }
}

function pauseBackingPlaybackImpl(this: PlaySceneContext): void {
  if (!this.playbackStarted) return;
  if (this.playbackMode === 'audio') {
    const pausedAudioSeconds = resolveSongSecondsForRuntime(
      this.getSongSecondsFromClock(),
      this.pausedSongSeconds,
      this.getBackingTrackSongSeconds()
    );
    this.lastKnownBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, pausedAudioSeconds);
    this.pausedBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, pausedAudioSeconds, this.pausedSongSeconds);
    this.pausedSongSeconds = this.pausedBackingAudioSeconds;
    this.stopBackingTrackSource();
    return;
  }
  this.scrubPlayer?.pause(this.runtime.current_tick);
}

function resumeBackingPlaybackImpl(this: PlaySceneContext): void {
  if (!this.playbackStarted) return;
  const runtimeResumeSeconds = resolveResumeSongSeconds(this.runtime.current_tick, this.pausedSongSeconds, this.tempoMap);
  let resumeSeconds = runtimeResumeSeconds;
  if (this.playbackMode === 'audio') {
    resumeSeconds = resolveResumeSongSecondsForAudio(resumeSeconds, this.pausedBackingAudioSeconds);
    resumeSeconds = Math.max(resumeSeconds, this.lastKnownBackingAudioSeconds);
  }
  this.pausedSongSeconds = resumeSeconds;
  this.startPlaybackClock(resumeSeconds);

  if (this.playbackMode === 'audio') {
    void this.resumeBackingTrackAudio(resumeSeconds);
    return;
  }
  this.scrubPlayer?.resume(this.runtime.current_tick, this.audioCtx?.currentTime ?? 0);
}

function stopBackingPlaybackImpl(this: PlaySceneContext): void {
  this.stopBackingTrackSource();
  this.releaseBackingTrackAudio();
  this.scrubPlayer?.stop();
}

async function resumeBackingTrackAudioImpl(this: PlaySceneContext, songSeconds: number): Promise<void> {
  const resumed = await this.playBackingTrackAudioFrom(songSeconds);
  if (resumed) return;

  this.feedbackText = 'Backing track unavailable.';
  this.feedbackUntilMs = performance.now() + 1200;
}

async function playBackingTrackAudioFromImpl(this: PlaySceneContext, songSeconds: number): Promise<boolean> {
  if (!this.audioCtx || !this.backingTrackBuffer) return false;
  const safeSeconds = Math.max(0, songSeconds);
  const targetSeconds = this.clampAudioSeekSeconds(safeSeconds);
  const beforeSeekSeconds = sanitizeSongSeconds(
    this.getBackingTrackSongSeconds() ?? this.pausedSongSeconds,
    this.pausedSongSeconds
  );
  this.stopBackingTrackSource();
  this.ensureBackingTrackGainNode();

  try {
    const source = this.audioCtx.createBufferSource();
    source.buffer = this.backingTrackBuffer;
    source.playbackRate.value = this.playbackSpeedMultiplier;
    source.connect(this.backingTrackGain!);
    const startAtAudioTime = this.audioCtx.currentTime + 0.005;
    source.onended = () => {
      if (this.backingTrackSource !== source) return;
      this.backingTrackSource = undefined;
      this.backingTrackSourceStartedAtAudioTime = undefined;
      this.backingTrackSourceStartSongSeconds = this.backingTrackBuffer?.duration ?? targetSeconds;
      this.backingTrackIsPlaying = false;
    };
    source.start(startAtAudioTime, targetSeconds);
    this.backingTrackSource = source;
    this.backingTrackSourceStartedAtAudioTime = startAtAudioTime;
    this.backingTrackSourceStartSongSeconds = targetSeconds;
    this.backingTrackIsPlaying = true;

    this.lastAudioSeekDebug = {
      requestedSongSeconds: safeSeconds,
      targetSeconds,
      beforeSeekSeconds,
      afterPlaySeconds: targetSeconds,
      afterRetrySeconds: undefined,
      fallbackToMidi: false,
      seekDisabled: false,
      ok: true,
      atMs: performance.now()
    };
    this.lastKnownBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, targetSeconds);
    this.syncRuntimeToBackingTrackPosition(targetSeconds);
    this.pausedBackingAudioSeconds = undefined;
    return true;
  } catch (error) {
    this.lastAudioSeekDebug = {
      requestedSongSeconds: safeSeconds,
      targetSeconds,
      beforeSeekSeconds,
      afterPlaySeconds: undefined,
      fallbackToMidi: false,
      seekDisabled: false,
      ok: false,
      atMs: performance.now()
    };
    console.warn('Backing track play failed', { audioUrl: this.sceneData?.audioUrl, error });
    return false;
  }
}

function releaseBackingTrackAudioImpl(this: PlaySceneContext): void {
  this.stopBackingTrackSource();
  this.backingTrackBuffer = undefined;
  this.backingTrackAudioUrl = undefined;
  if (this.backingTrackGain) {
    try {
      this.backingTrackGain.disconnect();
    } catch {
      // Ignore best-effort disconnect errors.
    }
  }
  this.backingTrackGain = undefined;
  this.backingTrackSourceStartedAtAudioTime = undefined;
  this.backingTrackSourceStartSongSeconds = 0;
  this.backingTrackIsPlaying = false;
  this.pausedBackingAudioSeconds = undefined;
  this.lastKnownBackingAudioSeconds = 0;
}

function syncRuntimeToBackingTrackPositionImpl(this: PlaySceneContext, songSeconds: number): void {
  const safeSeconds = sanitizeSongSeconds(songSeconds, this.pausedSongSeconds);
  this.startPlaybackClock(safeSeconds);
  if (this.tempoMap) {
    this.runtime.current_tick = Math.max(0, this.tempoMap.secondsToTick(safeSeconds));
  }
}

function stopBackingTrackSourceImpl(this: PlaySceneContext): void {
  if (!this.backingTrackSource) return;
  this.backingTrackSource.onended = null;
  try {
    this.backingTrackSource.stop();
  } catch {
    // Ignore stop errors for already-ended sources.
  }
  try {
    this.backingTrackSource.disconnect();
  } catch {
    // Ignore best-effort disconnect errors.
  }
  this.backingTrackSource = undefined;
  this.backingTrackSourceStartedAtAudioTime = undefined;
  this.backingTrackIsPlaying = false;
}

function ensureBackingTrackGainNodeImpl(this: PlaySceneContext): void {
  if (!this.audioCtx) return;
  if (this.backingTrackGain) return;
  const gain = this.audioCtx.createGain();
  gain.gain.value = 1;
  gain.connect(this.audioCtx.destination);
  this.backingTrackGain = gain;
}

function getBackingTrackSongSecondsImpl(this: PlaySceneContext): number | undefined {
  const buffer = this.backingTrackBuffer;
  if (!buffer) return undefined;
  if (!this.backingTrackIsPlaying || !this.audioCtx || this.backingTrackSourceStartedAtAudioTime === undefined) {
    return Phaser.Math.Clamp(this.backingTrackSourceStartSongSeconds, 0, Math.max(0, buffer.duration));
  }
  const elapsed = Math.max(0, this.audioCtx.currentTime - this.backingTrackSourceStartedAtAudioTime);
  const position = this.backingTrackSourceStartSongSeconds + elapsed * this.playbackSpeedMultiplier;
  return Phaser.Math.Clamp(position, 0, Math.max(0, buffer.duration));
}

async function loadBackingTrackBufferImpl(this: PlaySceneContext, audioUrl: string): Promise<AudioBuffer> {
  if (!this.audioCtx) {
    throw new Error('Audio context unavailable while loading backing track.');
  }
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch backing track (${response.status} ${response.statusText})`);
  }
  const encoded = await response.arrayBuffer();
  if (encoded.byteLength === 0) {
    throw new Error('Backing track file is empty.');
  }
  return await this.audioCtx.decodeAudioData(encoded.slice(0));
}

function clampAudioSeekSecondsImpl(this: PlaySceneContext, songSeconds: number): number {
  if (!this.backingTrackBuffer || !Number.isFinite(this.backingTrackBuffer.duration) || this.backingTrackBuffer.duration <= 0) {
    return songSeconds;
  }
  return Phaser.Math.Clamp(songSeconds, 0, Math.max(0, this.backingTrackBuffer.duration - 0.02));
}

function createPlaybackClockStateImpl(this: PlaySceneContext): PlaybackClockState {
  return {
    playbackStartSongSeconds: this.playbackStartSongSeconds,
    pausedSongSeconds: this.pausedSongSeconds,
    playbackStartAudioTime: this.playbackStartAudioTime
  };
}

function applyPlaybackClockStateImpl(this: PlaySceneContext, state: PlaybackClockState): void {
  this.playbackStartSongSeconds = state.playbackStartSongSeconds;
  this.pausedSongSeconds = state.pausedSongSeconds;
  this.playbackStartAudioTime = state.playbackStartAudioTime;
}

function startPlaybackClockImpl(this: PlaySceneContext, songSeconds: number): void {
  const clockState = this.createPlaybackClockState();
  startPlaybackClockState(clockState, this.audioCtx, songSeconds);
  this.applyPlaybackClockState(clockState);
}

function pausePlaybackClockImpl(this: PlaySceneContext): void {
  const clockState = this.createPlaybackClockState();
  const pausedCurrentTick = pausePlaybackClockState(
    clockState,
    this.audioCtx,
    this.runtime.current_tick,
    this.tempoMap,
    this.playbackSpeedMultiplier
  );
  this.applyPlaybackClockState(clockState);
  this.runtime.current_tick = pausedCurrentTick;
}

function getSongSecondsNowImpl(this: PlaySceneContext): number {
  const expectedClockSongSeconds = this.getSongSecondsFromClock();
  if (this.playbackMode === 'audio' && this.backingTrackBuffer) {
    const resolved = resolveSongSecondsForRuntime(
      expectedClockSongSeconds,
      this.pausedSongSeconds,
      this.getBackingTrackSongSeconds()
    );
    this.lastKnownBackingAudioSeconds = Math.max(this.lastKnownBackingAudioSeconds, resolved);
    return resolved;
  }
  return expectedClockSongSeconds;
}

function getSongSecondsFromClockImpl(this: PlaySceneContext): number {
  return getSongSecondsFromClockValue(
    this.createPlaybackClockState(),
    this.audioCtx,
    this.playbackSpeedMultiplier
  );
}

function getCurrentPlaybackBpmImpl(this: PlaySceneContext, songSeconds: number | undefined): number | undefined {
  if (!this.tempoMap || songSeconds === undefined || !Number.isFinite(songSeconds)) return undefined;
  const segments = this.tempoMap.segments;
  if (segments.length === 0) return undefined;

  const safeSeconds = Math.max(0, songSeconds);
  let selected = segments[0];
  for (const segment of segments) {
    if (segment.startSeconds <= safeSeconds) {
      selected = segment;
      continue;
    }
    break;
  }

  if (!Number.isFinite(selected.usPerQuarter) || selected.usPerQuarter <= 0) return undefined;
  return 60_000_000 / selected.usPerQuarter;
}
