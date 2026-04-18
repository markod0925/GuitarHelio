import { describe, expect, test } from 'vitest';
import { PlayState, type PitchFrame, type TargetNote } from '../src/types/models';
import { buildGameplayValidationDebugSnapshot, formatGameplayValidationDebugSnapshot } from '../src/ui/play/controllers/gameplayValidationDebugOverlay';
import { createIdleValidationWindowState } from '../src/ui/play/controllers/validationWindow';

function makeTarget(id: string, tick: number, expectedMidi: number): TargetNote {
  return {
    id,
    tick,
    duration_ticks: 120,
    string: 4,
    fret: 2,
    finger: 1,
    expected_midi: expectedMidi
  };
}

describe('play validation debug overlay', () => {
  test('captures mono target policy ids and candidate ranks', () => {
    const target = makeTarget('t-1', 1000, 60);
    const frame: PitchFrame = {
      t_seconds: 9.62,
      midi_estimate: 64,
      confidence: 0.91,
      selected_notes: [
        { midi: 64, score: 0.91, note_id: 'candidate-64' },
        { midi: 60, score: 0.82, note_id: 'candidate-60' },
        { midi: 67, score: 0.14, note_id: 'candidate-67' }
      ],
      best_note_id: 'candidate-64'
    };
    const snapshot = buildGameplayValidationDebugSnapshot({
      sceneData: { difficulty: 'Medium' },
      playbackStarted: true,
      runtime: {
        state: PlayState.Playing,
        current_tick: 1000,
        active_target_index: 0
      },
      pausedSongSeconds: 0,
      getSongSecondsNow: () => 9.62,
      tempoMap: {
        tickToSeconds: (tick: number) => (tick === 1000 ? 9.5 : 0)
      },
      targets: [target],
      latestFrames: {
        latest: () => frame,
        length: 1
      },
      validationWindowState: {
        ...createIdleValidationWindowState(),
        phase: 'armed',
        deadTime: false,
        difficulty: 'Medium',
        semitoneTolerance: 1,
        targetKey: target.id,
        targetIds: [target.id],
        targetMode: 'mono',
        aggregationPolicyId: 'runtime_mono_all_notes_required_v1',
        activationGatePolicyId: 'runtime_mono_activation_gate_off_v1',
        noteDecisionConfigId: 'runtime_shared_note_only_v1',
        windowStartSeconds: 9,
        windowEndSeconds: 10,
        earlyToleranceSeconds: 0.5,
        lateToleranceSeconds: 0.5,
        armedAtMs: 100,
        lastSetTargetAtMs: 100,
        lastResetAtMs: 100,
        lastTargetChangeAtMs: 100,
        setTargetCount: 1,
        resetCount: 1,
        armCount: 1
      },
      realtimeValidationOutput: {
        accepted: false,
        acceptedPreGate: false,
        acceptedPostGate: false,
        targetMode: 'mono',
        validatedNotes: [],
        matchedNotes: [],
        missingNotes: [60],
        extraNotes: [64],
        noteValidationRatio: 0,
        confidence: 0.91,
        rejectReasons: ['note:60:note_stage_passed'],
        rejectStage: 'note_level',
        gateRejectReason: null
      } as any,
      realtimeValidationState: {
        target: {
          mode: 'mono',
          midiNotes: [60],
          semitoneTolerance: 1,
          allowSuperset: true,
          metadata: { targetIds: [target.id] }
        },
        targetRevision: 1,
        targetStartedAtMs: 100,
        mode: 'mono',
        frameCount: 1,
        lastTimestampMs: 120,
        lastOutput: null,
        noteDecisions: [
          {
            midi: 60,
            accepted: false,
            decisionReason: 'note_stage_passed',
            evidence: {
              targetSemitoneTolerance: 1,
              matchedMidi: 60,
              matchedSemitoneDistance: 0,
              supportFrames: 2,
              supportSeconds: 0.186,
              minValidatedSupportFrames: 1,
              minValidatedSupportSeconds: 0.02,
              confidenceScore: 0.91,
              expectedVsSourceFrameRatio: 0.75,
              targetConfirmationFrameRatio: 0.75,
              expectedTop1FrameRatio: 1,
              expectedTop3FrameRatio: 1,
              octaveConfusionFrameRatio: 0,
              rawDetectionMaxConfidence: 0.91,
              rawDetectionFrameRatio: 1
            }
          }
        ]
      } as any
    } as any, 120);

    expect(snapshot.window.targetMode).toBe('mono');
    expect(snapshot.window.currentArmedTargetId).toBe(target.id);
    expect(snapshot.window.targetChangedThisFrame).toBe(true);
    expect(snapshot.spectral.topCandidates[0]?.midi).toBe(64);
    expect(snapshot.spectral.topCandidates[1]?.midi).toBe(60);
    expect(snapshot.spectral.expectedRanks).toContain('C4@2');
    expect(snapshot.target.aggregationPolicyId).toBe('runtime_mono_all_notes_required_v1');
    expect(snapshot.target.activationGatePolicyId).toBe('runtime_mono_activation_gate_off_v1');
    expect(snapshot.target.noteDecisionConfigId).toBe('runtime_shared_note_only_v1');
    expect(snapshot.runtime.frameCount).toBe(1);
    expect(snapshot.runtime.noteDecisions[0]?.supportSeconds).toBe(0.186);

    const lines = formatGameplayValidationDebugSnapshot(snapshot);
    expect(lines[0]).toContain('Gameplay Validation Debug');
    expect(lines.some((line) => line.includes('top5=1:64'))).toBe(true);
    expect(lines.some((line) => line.includes('history=frames1'))).toBe(true);
    expect(lines.some((line) => line.includes('support=0.186s/0.020s'))).toBe(true);
  });

  test('treats waiting as an active validation window', () => {
    const target = makeTarget('t-2', 1000, 60);
    const snapshot = buildGameplayValidationDebugSnapshot({
      sceneData: { difficulty: 'Medium' },
      playbackStarted: true,
      pausedSongSeconds: 10.7,
      runtime: {
        state: PlayState.WaitingForHit,
        current_tick: 1000,
        active_target_index: 0,
        waiting_target_id: target.id,
        waiting_started_at_s: 10.7
      },
      getSongSecondsNow: () => 10.7,
      tempoMap: {
        tickToSeconds: (tick: number) => (tick === 1000 ? 10 : 0)
      },
      targets: [target],
      latestFrames: {
        latest: () => undefined,
        length: 0
      },
      validationWindowState: {
        ...createIdleValidationWindowState(),
        phase: 'armed',
        deadTime: false,
        targetKey: target.id,
        targetIds: [target.id],
        targetMode: 'mono',
        aggregationPolicyId: 'runtime_mono_all_notes_required_v1',
        activationGatePolicyId: 'runtime_mono_activation_gate_off_v1',
        noteDecisionConfigId: 'runtime_shared_note_only_v1',
        windowStartSeconds: 9.5,
        windowEndSeconds: 10.5,
        earlyToleranceSeconds: 0.5,
        lateToleranceSeconds: 0.5,
        armedAtMs: 100,
        lastSetTargetAtMs: 100,
        lastResetAtMs: 100,
        lastTargetChangeAtMs: 100,
        setTargetCount: 1,
        resetCount: 1,
        armCount: 1
      },
      realtimeValidationOutput: undefined,
      realtimeValidationState: undefined
    } as any, 120);

    const lines = formatGameplayValidationDebugSnapshot(snapshot);
    expect(lines[1]).toContain('phase=armed');
    expect(lines[1]).toContain('dead=N');
    expect(lines[1]).toContain('activeWindow=Y');
  });
});
