import { afterEach, describe, expect, test, vi } from 'vitest';

function setNavigatorGetUserMedia(getUserMedia: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia
      }
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('createMicNode native guard behavior', () => {
  test('returns a muted placeholder and skips getUserMedia when native pitch input is active', async () => {
    const getUserMedia = vi.fn();
    setNavigatorGetUserMedia(getUserMedia);

    vi.doMock('../src/platform/nativePitchInput', () => ({
      shouldUseNativePitchInput: () => true
    }));

    const { createMicNode } = await import('../src/audio/micInput');
    const gainNode = {
      gain: { value: 1 }
    };
    const context = {
      createGain: vi.fn().mockReturnValue(gainNode)
    } as unknown as AudioContext;

    const result = await createMicNode(context);

    expect(result).toBe(gainNode);
    expect(gainNode.gain.value).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  test('uses getUserMedia when native pitch input is not active', async () => {
    const stream = { id: 'stream-1' };
    const sourceNode = {};
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    setNavigatorGetUserMedia(getUserMedia);

    vi.doMock('../src/platform/nativePitchInput', () => ({
      shouldUseNativePitchInput: () => false
    }));

    const { createMicNode } = await import('../src/audio/micInput');
    const context = {
      createMediaStreamSource: vi.fn().mockReturnValue(sourceNode)
    } as unknown as AudioContext;

    const result = await createMicNode(context, { channelCount: 1 });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(result).toBe(sourceNode);
    expect((result as { mediaStream?: MediaStream }).mediaStream).toBe(stream);
  });
});
