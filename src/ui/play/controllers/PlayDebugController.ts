import { resolveTargetGroup } from '../../../guitar/targetGrouping';
import { PlayState, type SourceNote } from '../../../types/models';
import type { PlaySceneContext } from './PlaySceneContext';

export class PlayDebugController {
  constructor(private readonly scene: PlaySceneContext) {}

  async playDebugTargetNote(): Promise<void> {
    await playDebugTargetNoteImpl.call(this.scene);
  }
}

async function playDebugTargetNoteImpl(this: PlaySceneContext): Promise<void> {
  if (this.isWaitingPausedByButton()) {
    this.feedbackText = 'Resume with Play before debug input';
    this.feedbackUntilMs = performance.now() + 900;
    this.updateHud();
    this.updateDebugOverlay();
    return;
  }
  const activeGroup = resolveTargetGroup(this.targets, this.runtime.active_target_index);
  const target = activeGroup[0];
  if (!target || activeGroup.length === 0) {
    this.feedbackText = 'No target to play';
    this.feedbackUntilMs = performance.now() + 700;
    return;
  }
  if (!this.audioCtx || !this.debugSynth) return;

  if (this.audioCtx.state !== 'running') {
    await this.audioCtx.resume();
  }

  const when = this.audioCtx.currentTime + 0.01;
  const tickSeed = Math.floor(performance.now() * 1000);
  for (let index = 0; index < activeGroup.length; index += 1) {
    const debugTarget = activeGroup[index];
    const note: SourceNote = {
      tick_on: tickSeed + index,
      tick_off: tickSeed + index + 1,
      midi_note: debugTarget.expected_midi,
      velocity: 1,
      channel: 15,
      track: 99
    };
    const noteWhen = when + index * 0.015;
    this.debugSynth.noteOn(note, noteWhen);
    this.debugSynth.noteOff(note, noteWhen + 0.35);
  }

  this.feedbackText = activeGroup.length > 1
    ? `Debug chord: ${activeGroup.map((item) => item.expected_midi).join(', ')}`
    : `Debug note: ${target.expected_midi}`;
  this.feedbackUntilMs = performance.now() + 600;

  if (
    this.audioCtx &&
    (this.runtime.state === PlayState.WaitingForHit ||
      (this.runtime.state === PlayState.Playing && this.isInsideLiveHitWindow(target)))
  ) {
    this.consumeDebugHit();
  } else {
    this.feedbackText = activeGroup.length > 1
      ? `Debug chord (outside hit window)`
      : `Debug note: ${target.expected_midi} (outside hit window)`;
    this.feedbackUntilMs = performance.now() + 900;
    this.updateHud();
    this.updateDebugOverlay();
  }
}
