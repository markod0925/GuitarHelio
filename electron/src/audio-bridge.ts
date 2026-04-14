export type ElectronNativePitchStartOptions = {
  detector: 'ac14' | 'masp' | 'fretnet' | 'pyin' | 'spectral_game_runtime_unified_v3';
  sampleRateHint: number;
  bufferFrames: number;
  audioInputMode?: 'speaker' | 'headphones';
  spectralModelJson?: string;
  maspAssetsDir?: string;
  fretnetModelPath?: string;
};

export type ElectronNativePitchPollOptions = {
  maxResults?: number;
};

export type ElectronNativePitchSanityOptions = {
  captureSeconds?: number;
};

export type ElectronNativePitchBridge = {
  startCapture: (options: ElectronNativePitchStartOptions) => Promise<unknown>;
  stopCapture: () => Promise<unknown>;
  getDiagnostics: () => Promise<unknown>;
  runSanityTest: (options?: ElectronNativePitchSanityOptions) => Promise<unknown>;
  updateGameplayContext: (context: Record<string, unknown> | null) => Promise<unknown>;
  pollDetections: (options?: ElectronNativePitchPollOptions) => Promise<unknown>;
  resetDetector: () => Promise<unknown>;
};

declare global {
  interface Window {
    guitarHelioNativePitch?: ElectronNativePitchBridge;
  }
}

export function isElectronRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /electron/i.test(navigator.userAgent);
}

export function getElectronNativePitchBridge(): ElectronNativePitchBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.guitarHelioNativePitch ?? null;
}

export function hasElectronNativePitchBridge(): boolean {
  return getElectronNativePitchBridge() !== null;
}

export function requireElectronNativePitchBridge(): ElectronNativePitchBridge {
  const bridge = getElectronNativePitchBridge();
  if (!bridge) {
    throw new Error('Electron native pitch bridge unavailable in renderer preload context.');
  }
  return bridge;
}
