import { APPROACH_THRESHOLD_TICKS } from '../app/config';
import { PlayState, type RuntimeState, type TargetNote } from '../types/models';

export function createInitialRuntimeState(): RuntimeState {
  return {
    state: PlayState.Playing,
    current_tick: 0,
    active_target_index: 0
  };
}

export function updateRuntimeState(
  state: RuntimeState,
  targets: TargetNote[],
  nowSeconds: number,
  isHitValid: boolean
): RuntimeState {
  if (state.state === PlayState.Finished) return state;

  const activeTarget = targets[state.active_target_index];
  if (!activeTarget) {
    return { ...state, state: PlayState.Finished };
  }

  if (state.state === PlayState.Playing && state.current_tick >= activeTarget.tick - APPROACH_THRESHOLD_TICKS) {
    return {
      ...state,
      state: PlayState.WaitingForHit,
      waiting_target_id: activeTarget.id,
      waiting_started_at_s: nowSeconds,
      current_tick: activeTarget.tick
    };
  }

  if (state.state === PlayState.WaitingForHit && isHitValid) {
    return {
      state: PlayState.Playing,
      active_target_index: state.active_target_index + 1,
      current_tick: activeTarget.tick + 1
    };
  }

  return state;
}
