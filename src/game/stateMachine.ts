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
  targetTimeSeconds?: number;
  songTimeSeconds?: number;
  lateHitWindowSeconds?: number;
  finishWhenNoTargets?: boolean;
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
  options: RuntimeUpdateOptions = {},
  out?: RuntimeUpdate
): RuntimeUpdate {
  if (state.state === PlayState.Finished) {
    return writeRuntimeUpdate(out, state, 'none');
  }

  const approachThresholdTicks = options.approachThresholdTicks ?? APPROACH_THRESHOLD_TICKS;
  const lateHitWindowSeconds = options.lateHitWindowSeconds ?? 0;

  const activeTarget = targets[state.active_target_index];
  if (!activeTarget) {
    if (options.finishWhenNoTargets === false) {
      return writeRuntimeUpdate(
        out,
        {
          ...state,
          state: PlayState.Playing,
          waiting_started_at_s: undefined,
          waiting_target_id: undefined
        },
        'none'
      );
    }
    return writeRuntimeUpdate(
      out,
      {
        ...state,
        state: PlayState.Finished,
        waiting_started_at_s: undefined,
        waiting_target_id: undefined
      },
      'finished'
    );
  }

  if (state.state === PlayState.Playing && isHitValid) {
    return writeRuntimeUpdate(
      out,
      {
        state: PlayState.Playing,
        active_target_index: state.active_target_index + 1,
        current_tick: Math.max(state.current_tick, activeTarget.tick) + 1
      },
      'validated_hit',
      activeTarget
    );
  }

  const comparisonSongSeconds = options.songTimeSeconds ?? nowSeconds;
  const shouldEnterWaitingByTime =
    state.state === PlayState.Playing &&
    options.targetTimeSeconds !== undefined &&
    comparisonSongSeconds >= options.targetTimeSeconds + lateHitWindowSeconds;
  const shouldEnterWaitingByTick =
    state.state === PlayState.Playing && state.current_tick >= activeTarget.tick - approachThresholdTicks;

  if (shouldEnterWaitingByTime || (options.targetTimeSeconds === undefined && shouldEnterWaitingByTick)) {
    return writeRuntimeUpdate(
      out,
      {
        ...state,
        state: PlayState.WaitingForHit,
        waiting_target_id: activeTarget.id,
        waiting_started_at_s: nowSeconds,
        current_tick: state.current_tick
      },
      'entered_waiting',
      activeTarget
    );
  }

  if (state.state === PlayState.WaitingForHit && isHitValid) {
    return writeRuntimeUpdate(
      out,
      {
        state: PlayState.Playing,
        active_target_index: state.active_target_index + 1,
        current_tick: Math.max(state.current_tick, activeTarget.tick) + 1
      },
      'validated_hit',
      activeTarget
    );
  }

  const timeoutSeconds = options.gatingTimeoutSeconds;
  const hasTimedOut =
    state.state === PlayState.WaitingForHit &&
    timeoutSeconds !== undefined &&
    state.waiting_started_at_s !== undefined &&
    nowSeconds - state.waiting_started_at_s >= timeoutSeconds;

  if (hasTimedOut) {
    return writeRuntimeUpdate(
      out,
      {
        state: PlayState.Playing,
        active_target_index: state.active_target_index + 1,
        current_tick: Math.max(state.current_tick, activeTarget.tick) + 1
      },
      'timeout_miss',
      activeTarget
    );
  }

  return writeRuntimeUpdate(out, state, 'none');
}

function writeRuntimeUpdate(
  out: RuntimeUpdate | undefined,
  state: RuntimeState,
  transition: RuntimeTransition,
  target?: TargetNote
): RuntimeUpdate {
  if (!out) {
    return { state, transition, target };
  }

  out.state = state;
  out.transition = transition;
  if (target) {
    out.target = target;
  } else {
    delete out.target;
  }
  return out;
}
