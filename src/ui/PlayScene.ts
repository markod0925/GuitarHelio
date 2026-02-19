import Phaser from 'phaser';
import { DIFFICULTY_PRESETS, FINGER_COLORS } from '../app/config';
import { createMicNode } from '../audio/micInput';
import { PitchDetectorService, isValidHeldHit } from '../audio/pitchDetector';
import { AudioScheduler } from '../audio/scheduler';
import { SimpleSynth } from '../audio/synth';
import { summarizeScores } from '../game/scoring';
import { createInitialRuntimeState, updateRuntimeState } from '../game/stateMachine';
import { generateTargetNotes } from '../guitar/targetGenerator';
import { loadMidiFromUrl } from '../midi/midiLoader';
import type { PitchFrame, ScoreEvent, TargetNote } from '../types/models';
import { PlayState } from '../types/models';
import { formatSummary } from './hud';

export class PlayScene extends Phaser.Scene {
  private targets: TargetNote[] = [];
  private runtime = createInitialRuntimeState();
  private scoreEvents: ScoreEvent[] = [];
  private latestFrames: PitchFrame[] = [];
  private waitingStartMs: number | null = null;
  private songStartAudioTime: number | null = null;

  constructor() {
    super('PlayScene');
  }

  async create(data: { songUrl: string; difficulty: 'Easy' | 'Medium' | 'Hard' }): Promise<void> {
    const difficulty = DIFFICULTY_PRESETS[data.difficulty];
    const loaded = await loadMidiFromUrl(data.songUrl);
    this.targets = generateTargetNotes(loaded.sourceNotes, difficulty, loaded.tempoMap);

    this.drawLanes();
    this.drawTargets();

    const audioCtx = new AudioContext();
    const synth = new SimpleSynth(audioCtx);
    const scheduler = new AudioScheduler(audioCtx, synth, loaded.sourceNotes, loaded.tempoMap);

    const micSource = await createMicNode(audioCtx);
    const detector = new PitchDetectorService(audioCtx);
    await detector.init();
    detector.onPitch((frame) => {
      this.latestFrames.push(frame);
      if (this.latestFrames.length > 24) this.latestFrames.shift();
    });
    detector.start(micSource);

    await audioCtx.resume();
    this.songStartAudioTime = audioCtx.currentTime;
    scheduler.start();

    this.time.addEvent({
      delay: 16,
      loop: true,
      callback: () => {
        if (this.runtime.state === PlayState.Finished) return;

        if (this.runtime.state === PlayState.Playing) {
          const elapsedSeconds = Math.max(0, audioCtx.currentTime - (this.songStartAudioTime ?? audioCtx.currentTime));
          this.runtime.current_tick = loaded.tempoMap.secondsToTick(elapsedSeconds);
        }

        const active = this.targets[this.runtime.active_target_index];
        const valid = active
          ? isValidHeldHit(this.latestFrames, active.expected_midi, difficulty.pitch_tolerance_semitones)
          : false;

        const prev = this.runtime;
        this.runtime = updateRuntimeState(this.runtime, this.targets, performance.now() / 1000, valid);

        if (prev.state !== PlayState.WaitingForHit && this.runtime.state === PlayState.WaitingForHit) {
          this.waitingStartMs = performance.now();
        }

        if (prev.state === PlayState.WaitingForHit && this.runtime.state === PlayState.Playing && active && this.waitingStartMs !== null) {
          const deltaMs = performance.now() - this.waitingStartMs;
          const rating = deltaMs <= 50 ? 'Perfect' : deltaMs <= 120 ? 'Great' : deltaMs <= 250 ? 'OK' : 'Miss';
          const points = rating === 'Perfect' ? 100 : rating === 'Great' ? 70 : rating === 'OK' ? 40 : 0;
          this.scoreEvents.push({ targetId: active.id, rating, deltaMs, points });
          this.waitingStartMs = null;
        }

        if (this.runtime.active_target_index >= this.targets.length) {
          this.runtime.state = PlayState.Finished;
          const summary = summarizeScores(this.scoreEvents);
          this.add.text(520, 30, formatSummary(summary), { color: '#ffffff', fontSize: '16px' });
        }
      }
    });
  }

  private drawLanes(): void {
    for (let i = 0; i < 6; i += 1) {
      this.add.rectangle(400, 80 + i * 70, 760, 2, 0x666666);
    }
    this.add.rectangle(140, 260, 3, 420, 0xffffff);
  }

  private drawTargets(): void {
    for (const target of this.targets) {
      const x = 180 + target.tick * 0.2;
      const y = 80 + (target.string - 1) * 70;
      const w = Math.max(20, target.duration_ticks * 0.15);
      this.add.rectangle(x, y, w, 18, FINGER_COLORS[target.finger] ?? 0xffffff);
    }
  }
}
