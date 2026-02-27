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
    expect(update.state.current_tick).toBe(880);
  });

  test('enters waiting only after late grace window when target timing is provided', () => {
    const beforeLateWindow: RuntimeState = {
      state: PlayState.Playing,
      current_tick: 1010,
      active_target_index: 0
    };

    const updateBefore = updateRuntimeState(beforeLateWindow, [target], 10.49, false, {
      targetTimeSeconds: 10,
      lateHitWindowSeconds: 0.5
    });
    expect(updateBefore.transition).toBe('none');

    const afterLateWindow = updateRuntimeState(beforeLateWindow, [target], 10.5, false, {
      targetTimeSeconds: 10,
      lateHitWindowSeconds: 0.5
    });
    expect(afterLateWindow.transition).toBe('entered_waiting');
    expect(afterLateWindow.state.state).toBe(PlayState.WaitingForHit);
  });

  test('uses song timeline for waiting transition when songTimeSeconds is provided', () => {
    const state: RuntimeState = {
      state: PlayState.Playing,
      current_tick: 1010,
      active_target_index: 0
    };

    const updateBefore = updateRuntimeState(state, [target], 200, false, {
      targetTimeSeconds: 10,
      songTimeSeconds: 10.49,
      lateHitWindowSeconds: 0.5
    });
    expect(updateBefore.transition).toBe('none');

    const updateAfter = updateRuntimeState(state, [target], 200, false, {
      targetTimeSeconds: 10,
      songTimeSeconds: 10.5,
      lateHitWindowSeconds: 0.5
    });
    expect(updateAfter.transition).toBe('entered_waiting');
    expect(updateAfter.state.state).toBe(PlayState.WaitingForHit);
  });

  test('validates hit directly while still playing', () => {
    const state: RuntimeState = {
      state: PlayState.Playing,
      current_tick: 1002,
      active_target_index: 0
    };

    const update = updateRuntimeState(state, [target], 10.2, true, {
      targetTimeSeconds: 10,
      lateHitWindowSeconds: 0.5
    });

    expect(update.transition).toBe('validated_hit');
    expect(update.state.state).toBe(PlayState.Playing);
    expect(update.state.active_target_index).toBe(1);
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

  test('keeps playing when no active targets remain and finish is deferred', () => {
    const state: RuntimeState = {
      state: PlayState.Playing,
      current_tick: 1200,
      active_target_index: 1
    };

    const update = updateRuntimeState(state, [target], 30, false, { finishWhenNoTargets: false });

    expect(update.transition).toBe('none');
    expect(update.state.state).toBe(PlayState.Playing);
    expect(update.state.active_target_index).toBe(1);
  });
});
