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
  private laneLayer?: Phaser.GameObjects.Graphics;
  private targetLayer?: Phaser.GameObjects.Graphics;

  constructor() {
    super('PlayScene');
  }

  async create(data: { songUrl: string; difficulty: 'Easy' | 'Medium' | 'Hard' }): Promise<void> {
    const difficulty = DIFFICULTY_PRESETS[data.difficulty];
    const loaded = await loadMidiFromUrl(data.songUrl);
    this.targets = generateTargetNotes(loaded.sourceNotes, difficulty, loaded.tempoMap);

    this.laneLayer = this.add.graphics();
    this.targetLayer = this.add.graphics();

    this.drawLanes();
    this.drawTargets();

    this.scale.on('resize', () => {
      this.drawLanes();
      this.drawTargets();
    });

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
          const fontSize = Math.max(15, Math.floor(this.scale.width * 0.02));
          this.add.text(this.scale.width * 0.58, this.scale.height * 0.06, formatSummary(summary), {
            color: '#ffffff',
            fontSize: `${fontSize}px`
          });
        }
      }
    });
  }

  private drawLanes(): void {
    if (!this.laneLayer) return;

    const { width, height } = this.scale;
    const left = width * 0.12;
    const laneAreaWidth = width * 0.8;
    const top = height * 0.14;
    const spacing = (height * 0.72) / 5;

    this.laneLayer.clear();

    for (let i = 0; i < 6; i += 1) {
      this.laneLayer.fillStyle(0x666666, 1);
      this.laneLayer.fillRect(left, top + i * spacing, laneAreaWidth, 2);
    }

    this.laneLayer.fillStyle(0xffffff, 1);
    this.laneLayer.fillRect(left, height * 0.1, 3, height * 0.8);
  }

  private drawTargets(): void {
    if (!this.targetLayer) return;

    const { width, height } = this.scale;
    const startX = width * 0.16;
    const pxPerTick = Math.max(0.08, width / 5000);
    const top = height * 0.14;
    const spacing = (height * 0.72) / 5;
    const noteHeight = Math.max(14, height * 0.03);

    this.targetLayer.clear();

    for (const target of this.targets) {
      const x = startX + target.tick * pxPerTick;
      const y = top + (target.string - 1) * spacing;
      const w = Math.max(20, target.duration_ticks * (pxPerTick * 0.75));
      this.targetLayer.fillStyle(FINGER_COLORS[target.finger] ?? 0xffffff, 1);
      this.targetLayer.fillRoundedRect(x, y - noteHeight / 2, w, noteHeight, noteHeight / 4);
    }
  }
}
