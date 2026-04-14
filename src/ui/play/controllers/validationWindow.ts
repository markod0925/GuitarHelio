import { TARGET_HIT_GRACE_SECONDS } from '../../../app/config';
import { buildValidationTargetFromTargetGroup } from '../../../gameplay/validation';
import type { RuntimeValidatorStateSnapshot, ValidationTarget } from '../../../gameplay/validation';
import {
  DEFAULT_ACTIVATION_GATE_POLICY,
  DEFAULT_NOTE_SET_POLICY,
  DEFAULT_VALIDATOR_DECISION_CONFIG,
  MONO_ACTIVATION_GATE_POLICY,
  MONO_NOTE_SET_POLICY
} from '../../../gameplay/validation/validatorPolicies';
import { resolveTargetGroup } from '../../../guitar/targetGrouping';
import { PlayState, type TargetNote } from '../../../types/models';
import type { ValidationWindowState } from '../../playSceneTypes';
import type { PlaySceneContext } from './PlaySceneContext';

type ValidationTolerance = {
  earlySeconds: number;
  lateSeconds: number;
};

export function createIdleValidationWindowState(): ValidationWindowState {
  return {
    phase: 'idle',
    deadTime: true,
    targetKey: null,
    targetIds: [],
    targetMode: null,
    aggregationPolicyId: null,
    activationGatePolicyId: null,
    noteDecisionConfigId: null,
    windowStartSeconds: null,
    windowEndSeconds: null,
    earlyToleranceSeconds: null,
    lateToleranceSeconds: null,
    armedAtMs: null,
    acceptedAtSongSeconds: null,
    expiredAtSongSeconds: null,
    lastSongSeconds: null,
    lastReason: 'idle',
    setTargetCount: 0,
    resetCount: 0,
    armCount: 0,
    lastSetTargetAtMs: null,
    lastResetAtMs: null,
    lastTargetChangeAtMs: null
  };
}

export function buildValidationWindowTargetKey(targetGroup: TargetNote[]): string {
  return targetGroup.map((target) => target.id).join('|');
}

export function resolveGameplayValidationToleranceSeconds(difficulty: 'Easy' | 'Medium' | 'Hard' | undefined): ValidationTolerance {
  if (difficulty === 'Easy') {
    return {
      earlySeconds: TARGET_HIT_GRACE_SECONDS + 0.1,
      lateSeconds: TARGET_HIT_GRACE_SECONDS + 0.1
    };
  }
  if (difficulty === 'Hard') {
    return {
      earlySeconds: TARGET_HIT_GRACE_SECONDS - 0.1,
      lateSeconds: TARGET_HIT_GRACE_SECONDS - 0.1
    };
  }
  return {
    earlySeconds: TARGET_HIT_GRACE_SECONDS,
    lateSeconds: TARGET_HIT_GRACE_SECONDS
  };
}

export function syncGameplayValidationWindow(
  scene: PlaySceneContext,
  nowMs: number,
  songSecondsNow: number | undefined
): ValidationWindowState {
  const validator = scene.realtimeGameplayValidator as
    | {
        reset: () => void;
        setTarget: (target: ValidationTarget | null) => void;
        getState: () => RuntimeValidatorStateSnapshot;
      }
    | undefined;
  const state = ensureValidationWindowState(scene);
  const activeGroup = resolveTargetGroup(scene.targets, scene.runtime.active_target_index);
  const activeTarget = activeGroup[0];
  const targetKey = activeGroup.length > 0 ? buildValidationWindowTargetKey(activeGroup) : null;
  const targetMode = activeGroup.length > 1 ? 'poly' : activeGroup.length === 1 ? 'mono' : null;
  const tolerance = resolveGameplayValidationToleranceSeconds(scene.sceneData?.difficulty);
  const isWaitingForHit = scene.runtime.state === PlayState.WaitingForHit;
  const nowTargetChanged = state.targetKey !== targetKey;
  const targetSeconds = activeTarget && scene.tempoMap ? scene.tempoMap.tickToSeconds(activeTarget.tick) : null;
  const playbackActive = scene.playbackStarted && songSecondsNow !== undefined && targetSeconds !== null && (scene.runtime.state === PlayState.Playing || isWaitingForHit);
  const policyIds = resolveValidationPolicyIds(targetMode);

  if (nowTargetChanged) {
    state.targetKey = targetKey;
    state.targetIds = activeGroup.map((target) => target.id);
    state.targetMode = targetMode;
    state.aggregationPolicyId = policyIds.aggregationPolicyId;
    state.activationGatePolicyId = policyIds.activationGatePolicyId;
    state.noteDecisionConfigId = policyIds.noteDecisionConfigId;
    state.windowStartSeconds = targetSeconds !== null ? targetSeconds - tolerance.earlySeconds : null;
    state.windowEndSeconds = targetSeconds !== null ? targetSeconds + tolerance.lateSeconds : null;
    state.earlyToleranceSeconds = targetSeconds !== null ? tolerance.earlySeconds : null;
    state.lateToleranceSeconds = targetSeconds !== null ? tolerance.lateSeconds : null;
    state.armedAtMs = null;
    state.acceptedAtSongSeconds = null;
    state.expiredAtSongSeconds = null;
    state.lastSongSeconds = songSecondsNow ?? null;
    state.lastReason = targetKey === null ? 'no_target' : 'target_changed';
    state.phase = 'idle';
    state.deadTime = true;
    state.setTargetCount = 0;
    state.resetCount = 0;
    state.armCount = 0;
    state.lastSetTargetAtMs = null;
    state.lastResetAtMs = null;
    state.lastTargetChangeAtMs = nowMs;
    validator?.setTarget(null);
    state.setTargetCount += 1;
    state.lastSetTargetAtMs = nowMs;
  }

  if (!playbackActive) {
    if (state.phase === 'armed') {
      state.phase = 'expired';
      state.expiredAtSongSeconds = songSecondsNow ?? state.expiredAtSongSeconds;
      state.deadTime = true;
      state.lastReason = 'expired';
      validator?.setTarget(null);
      state.setTargetCount += 1;
      state.lastSetTargetAtMs = nowMs;
    } else if (state.phase !== 'accepted' && state.phase !== 'expired') {
      state.phase = 'idle';
      state.deadTime = true;
      state.lastReason = targetKey === null ? 'no_target' : 'dead_time';
    }
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  state.lastSongSeconds = songSecondsNow ?? null;
  state.windowStartSeconds = targetSeconds !== null ? targetSeconds - tolerance.earlySeconds : null;
  state.windowEndSeconds = targetSeconds !== null ? targetSeconds + tolerance.lateSeconds : null;
  state.earlyToleranceSeconds = targetSeconds !== null ? tolerance.earlySeconds : null;
  state.lateToleranceSeconds = targetSeconds !== null ? tolerance.lateSeconds : null;

  if (state.phase === 'accepted' && state.targetKey === targetKey) {
    state.deadTime = true;
    state.lastReason = 'accepted';
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  if (isWaitingForHit && targetKey !== null) {
    if (state.phase !== 'armed') {
      validator?.reset();
      state.resetCount += 1;
      state.lastResetAtMs = nowMs;
      validator?.setTarget(buildValidationTargetFromTargetGroup(activeGroup));
      state.setTargetCount += 1;
      state.lastSetTargetAtMs = nowMs;
      state.armCount += 1;
      state.armedAtMs = nowMs;
    }
    state.phase = 'armed';
    state.deadTime = false;
    state.expiredAtSongSeconds = null;
    state.lastReason = 'waiting';
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  if (state.phase === 'expired' && state.targetKey === targetKey) {
    state.deadTime = true;
    state.lastReason = 'expired';
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  if (songSecondsNow === undefined || targetSeconds === null || targetKey === null) {
    state.phase = 'idle';
    state.deadTime = true;
    state.lastReason = 'no_target';
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  const windowStart = targetSeconds - tolerance.earlySeconds;
  const windowEnd = targetSeconds + tolerance.lateSeconds;

  if (songSecondsNow < windowStart) {
    if (state.phase === 'armed') {
      validator?.setTarget(null);
      state.setTargetCount += 1;
      state.lastSetTargetAtMs = nowMs;
    }
    state.phase = 'idle';
    state.deadTime = true;
    state.lastReason = 'pre_window';
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  if (songSecondsNow <= windowEnd) {
    if (state.phase !== 'armed') {
      validator?.reset();
      state.resetCount += 1;
      state.lastResetAtMs = nowMs;
      validator?.setTarget(buildValidationTargetFromTargetGroup(activeGroup));
      state.setTargetCount += 1;
      state.lastSetTargetAtMs = nowMs;
      state.armCount += 1;
      state.phase = 'armed';
      state.armedAtMs = nowMs;
      state.deadTime = false;
      state.lastReason = 'armed';
    } else {
      state.deadTime = false;
      state.lastReason = 'armed';
    }
    scene.realtimeValidationState = validator?.getState();
    return state;
  }

  if (state.phase === 'armed') {
    validator?.setTarget(null);
    state.setTargetCount += 1;
    state.lastSetTargetAtMs = nowMs;
  }
  state.phase = 'expired';
  state.expiredAtSongSeconds = songSecondsNow;
  state.deadTime = true;
  state.lastReason = 'expired';
  scene.realtimeValidationState = validator?.getState();
  return state;
}

export function markGameplayValidationWindowAccepted(
  scene: PlaySceneContext,
  nowMs: number,
  songSecondsNow: number | undefined
): ValidationWindowState {
  const state = ensureValidationWindowState(scene);
  state.phase = 'accepted';
  state.deadTime = true;
  state.acceptedAtSongSeconds = songSecondsNow ?? state.acceptedAtSongSeconds;
  state.lastSongSeconds = songSecondsNow ?? state.lastSongSeconds;
  state.lastReason = 'accepted';
  state.armedAtMs = state.armedAtMs ?? nowMs;
  const validator = scene.realtimeGameplayValidator as
    | {
        setTarget: (target: ValidationTarget | null) => void;
        getState: () => RuntimeValidatorStateSnapshot;
      }
    | undefined;
  validator?.setTarget(null);
  state.setTargetCount += 1;
  state.lastSetTargetAtMs = nowMs;
  scene.realtimeValidationState = validator?.getState();
  return state;
}

function ensureValidationWindowState(scene: PlaySceneContext): ValidationWindowState {
  if (!scene.validationWindowState) {
    scene.validationWindowState = createIdleValidationWindowState();
  }
  return scene.validationWindowState;
}

function resolveValidationPolicyIds(targetMode: 'mono' | 'poly' | null): {
  aggregationPolicyId: string | null;
  activationGatePolicyId: string | null;
  noteDecisionConfigId: string | null;
} {
  if (targetMode === 'mono') {
    return {
      aggregationPolicyId: MONO_NOTE_SET_POLICY.id,
      activationGatePolicyId: MONO_ACTIVATION_GATE_POLICY.id,
      noteDecisionConfigId: DEFAULT_VALIDATOR_DECISION_CONFIG.id
    };
  }
  if (targetMode === 'poly') {
    return {
      aggregationPolicyId: DEFAULT_NOTE_SET_POLICY.id,
      activationGatePolicyId: DEFAULT_ACTIVATION_GATE_POLICY.id,
      noteDecisionConfigId: DEFAULT_VALIDATOR_DECISION_CONFIG.id
    };
  }
  return {
    aggregationPolicyId: null,
    activationGatePolicyId: null,
    noteDecisionConfigId: null
  };
}
