export type PracticePipeline = 'current' | 'fretnet';

export const DEFAULT_PRACTICE_PIPELINE: PracticePipeline = 'current';

export type PracticePipelineSwitchResult = {
  nextPipeline: PracticePipeline;
  isNoop: boolean;
  isSwitching: boolean;
  requiresMicRestart: boolean;
};

export type PracticePipelineAvailability = {
  available: boolean;
  reason: string | null;
};

export function createPracticePipelineSessionDefault(): PracticePipeline {
  return DEFAULT_PRACTICE_PIPELINE;
}

export function resolvePracticePipelineSwitch(args: {
  currentPipeline: PracticePipeline;
  nextPipeline: PracticePipeline;
  micActive: boolean;
}): PracticePipelineSwitchResult {
  const isNoop = args.currentPipeline === args.nextPipeline;
  return {
    nextPipeline: args.nextPipeline,
    isNoop,
    isSwitching: !isNoop,
    requiresMicRestart: !isNoop && args.micActive
  };
}

export function resolvePracticePipelineAvailability(pipeline: PracticePipeline): PracticePipelineAvailability {
  if (pipeline === 'fretnet') {
    return {
      available: true,
      reason: null
    };
  }
  return {
    available: true,
    reason: null
  };
}

export function formatPracticePipelineLabel(pipeline: PracticePipeline): string {
  return pipeline === 'fretnet' ? 'FretNet' : 'Current';
}
