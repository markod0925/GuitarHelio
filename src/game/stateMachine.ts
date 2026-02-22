import { APPROACH_THRESHOLD_TICKS } from '../app/config';
import { PlayState, type RuntimeState, type TargetNote } from '../types/models';

export type RuntimeTransition = 'none' | 'entered_waiting' | 'validated_hit' | 'timeout_miss' | 'finished';

export type RuntimeUpdate = {
  state: RuntimeState;
  transition: RuntimeTransition;
  target?: TargetNote;
};

export type RuntimeUpdateOptions = {
  approachThresholdTicks?: number;
  gatingTimeoutSeconds?: number;
};

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
  isHitValid: boolean,
  options: RuntimeUpdateOptions = {}
): RuntimeUpdate {
  if (state.state === PlayState.Finished) {
    return { state, transition: 'none' };
  }

  const approachThresholdTicks = options.approachThresholdTicks ?? APPROACH_THRESHOLD_TICKS;

  const activeTarget = targets[state.active_target_index];
  if (!activeTarget) {
    return {
      state: {
        ...state,
        state: PlayState.Finished,
        waiting_started_at_s: undefined,
        waiting_target_id: undefined
      },
      transition: 'finished'
    };
  }

  if (state.state === PlayState.Playing && state.current_tick >= activeTarget.tick - approachThresholdTicks) {
    return {
      state: {
        ...state,
        state: PlayState.WaitingForHit,
        waiting_target_id: activeTarget.id,
        waiting_started_at_s: nowSeconds,
        current_tick: activeTarget.tick
      },
      transition: 'entered_waiting',
      target: activeTarget
    };
  }

  if (state.state === PlayState.WaitingForHit && isHitValid) {
    return {
      state: {
        state: PlayState.Playing,
        active_target_index: state.active_target_index + 1,
        current_tick: activeTarget.tick + 1
      },
      transition: 'validated_hit',
      target: activeTarget
    };
  }

  const timeoutSeconds = options.gatingTimeoutSeconds;
  const hasTimedOut =
    state.state === PlayState.WaitingForHit &&
    timeoutSeconds !== undefined &&
    state.waiting_started_at_s !== undefined &&
    nowSeconds - state.waiting_started_at_s >= timeoutSeconds;

  if (hasTimedOut) {
    return {
      state: {
        state: PlayState.Playing,
        active_target_index: state.active_target_index + 1,
        current_tick: activeTarget.tick + 1
      },
      transition: 'timeout_miss',
      target: activeTarget
    };
  }

  return { state, transition: 'none' };
}
