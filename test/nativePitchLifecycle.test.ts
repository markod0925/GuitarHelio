import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type NativePitchInputMock = {
  ensureNativePitchInputPermission: ReturnType<typeof vi.fn>;
  pollNativePitchResults: ReturnType<typeof vi.fn>;
  resetNativePitchDetector: ReturnType<typeof vi.fn>;
  shouldUseNativePitchInput: ReturnType<typeof vi.fn>;
  startNativePitchCapture: ReturnType<typeof vi.fn>;
  stopNativePitchCapture: ReturnType<typeof vi.fn>;
  updateNativePitchGameplayContext: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function loadPitchDetectorWithNativeMocks(overrides: Partial<NativePitchInputMock> = {}) {
  vi.resetModules();

  const nativePitchInput: NativePitchInputMock = {
    ensureNativePitchInputPermission: vi.fn().mockResolvedValue(true),
    pollNativePitchResults: vi.fn().mockResolvedValue({ running: true, diagnostics: {}, results: [] }),
    resetNativePitchDetector: vi.fn().mockResolvedValue(undefined),
    shouldUseNativePitchInput: vi.fn().mockReturnValue(true),
    startNativePitchCapture: vi.fn().mockResolvedValue({ running: true, diagnostics: {} }),
    stopNativePitchCapture: vi.fn().mockResolvedValue(undefined),
    updateNativePitchGameplayContext: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };

  vi.doMock('../src/platform/nativePitchInput', () => nativePitchInput);
  vi.doMock('../src/app/runtimeLog', () => ({
    runtimeLog: vi.fn(),
    toRuntimeErrorMessage: (error: unknown) => String(error)
  }));

  const module = await import('../src/audio/pitchDetector');
  return {
    PitchDetectorService: module.PitchDetectorService,
    nativePitchInput
  };
}

beforeEach(() => {
  Object.assign(globalThis, {
    window: globalThis
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('PitchDetectorService native lifecycle', () => {
  test('duplicate stop requests are idempotent once the native backend is already stopping/stopped', async () => {
    const { PitchDetectorService, nativePitchInput } = await loadPitchDetectorWithNativeMocks();
    const detector = new PitchDetectorService({ sampleRate: 48_000, currentTime: 0 } as AudioContext, {
      detectorPreset: 'fretnet'
    });

    await detector.init();
    await detector.start();

    detector.stop();
    detector.stop();
    await flushPromises();

    expect(nativePitchInput.stopNativePitchCapture).toHaveBeenCalledTimes(1);
    expect(nativePitchInput.resetNativePitchDetector).toHaveBeenCalledTimes(1);
  });

  test('a second start while permission/startup is still pending does not launch a duplicate native session', async () => {
    const permissionGate = deferred<boolean>();
    const { PitchDetectorService, nativePitchInput } = await loadPitchDetectorWithNativeMocks({
      ensureNativePitchInputPermission: vi.fn().mockReturnValue(permissionGate.promise)
    });
    const detector = new PitchDetectorService({ sampleRate: 48_000, currentTime: 0 } as AudioContext, {
      detectorPreset: 'fretnet'
    });

    await detector.init();
    const firstStart = detector.start();
    const secondStart = detector.start();

    permissionGate.resolve(true);
    await Promise.all([firstStart, secondStart]);

    expect(nativePitchInput.ensureNativePitchInputPermission).toHaveBeenCalledTimes(1);
    expect(nativePitchInput.startNativePitchCapture).toHaveBeenCalledTimes(1);
  });

  test('stop during startup-in-progress prevents the native capture request from starting later', async () => {
    const permissionGate = deferred<boolean>();
    const { PitchDetectorService, nativePitchInput } = await loadPitchDetectorWithNativeMocks({
      ensureNativePitchInputPermission: vi.fn().mockReturnValue(permissionGate.promise)
    });
    const detector = new PitchDetectorService({ sampleRate: 48_000, currentTime: 0 } as AudioContext, {
      detectorPreset: 'spectral_game_runtime_unified_v3'
    });

    await detector.init();
    const startPromise = detector.start();
    detector.stop();

    permissionGate.resolve(true);
    await startPromise;
    await flushPromises();

    expect(nativePitchInput.startNativePitchCapture).not.toHaveBeenCalled();
    expect(nativePitchInput.stopNativePitchCapture).not.toHaveBeenCalled();
    expect(nativePitchInput.resetNativePitchDetector).not.toHaveBeenCalled();
  });
});
