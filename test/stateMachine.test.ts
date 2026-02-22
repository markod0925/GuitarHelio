import { describe, expect, test } from 'vitest';
import { PlayState, type RuntimeState, type TargetNote } from '../src/types/models';
import { updateRuntimeState } from '../src/game/stateMachine';

const target: TargetNote = {
  id: 't-1',
  tick: 1000,
  duration_ticks: 180,
  string: 4,
  fret: 2,
  finger: 1,
  expected_midi: 52
};

describe('updateRuntimeState', () => {
  test('enters waiting state when approach threshold is reached', () => {
    const state: RuntimeState = {
      state: PlayState.Playing,
      current_tick: 880,
      active_target_index: 0
    };

    const update = updateRuntimeState(state, [target], 10, false, { approachThresholdTicks: 120 });

    expect(update.transition).toBe('entered_waiting');
    expect(update.state.state).toBe(PlayState.WaitingForHit);
    expect(update.state.waiting_target_id).toBe(target.id);
    expect(update.state.current_tick).toBe(target.tick);
  });

  test('advances to next target after a valid hit', () => {
    const state: RuntimeState = {
      state: PlayState.WaitingForHit,
      current_tick: target.tick,
      active_target_index: 0,
      waiting_target_id: target.id,
      waiting_started_at_s: 12
    };

    const update = updateRuntimeState(state, [target], 12.2, true);

    expect(update.transition).toBe('validated_hit');
    expect(update.state.state).toBe(PlayState.Playing);
    expect(update.state.active_target_index).toBe(1);
  });

  test('times out waiting target when timeout is configured', () => {
    const state: RuntimeState = {
      state: PlayState.WaitingForHit,
      current_tick: target.tick,
      active_target_index: 0,
      waiting_target_id: target.id,
      waiting_started_at_s: 20
    };

    const update = updateRuntimeState(state, [target], 22.5, false, { gatingTimeoutSeconds: 2 });

    expect(update.transition).toBe('timeout_miss');
    expect(update.state.state).toBe(PlayState.Playing);
    expect(update.state.active_target_index).toBe(1);
  });

  test('marks runtime as finished when no active targets remain', () => {
    const state: RuntimeState = {
      state: PlayState.Playing,
      current_tick: 1200,
      active_target_index: 1
    };

    const update = updateRuntimeState(state, [target], 30, false);

    expect(update.transition).toBe('finished');
    expect(update.state.state).toBe(PlayState.Finished);
  });
});
