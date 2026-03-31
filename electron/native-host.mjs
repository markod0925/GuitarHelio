import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { ipcMain } from 'electron';

const require = createRequire(import.meta.url);

const IPC = {
  startCapture: 'native-pitch:start-capture',
  stopCapture: 'native-pitch:stop-capture',
  getDiagnostics: 'native-pitch:get-diagnostics',
  runSanityTest: 'native-pitch:run-sanity-test',
  updateGameplayContext: 'native-pitch:update-gameplay-context',
  pollDetections: 'native-pitch:poll-detections',
  resetDetector: 'native-pitch:reset-detector'
};

function hostErrorMessage(error) {
  if (error instanceof Error) {
    return error.stack && error.stack.length > 0 ? error.stack : error.message;
  }
  return String(error);
}

function resolveAddonCandidates(appRoot, assetRoot) {
  const rel = path.join('electron', 'native', 'build', 'Release', 'guitarhelio_native_pitch.node');
  const preferredUnpacked = path.join(assetRoot, rel);
  const packagedCandidate = path.join(appRoot, rel);
  const cwdCandidate = path.join(process.cwd(), rel);
  return Array.from(new Set([
    preferredUnpacked,
    packagedCandidate,
    cwdCandidate
  ]));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function loadAddon(appRoot, assetRoot) {
  const candidates = resolveAddonCandidates(appRoot, assetRoot);
  const errors = [];

  for (const candidate of candidates) {
    if (candidate.includes(`${path.sep}app.asar${path.sep}`) && !candidate.includes(`${path.sep}app.asar.unpacked${path.sep}`)) {
      continue;
    }
    if (fsSync.existsSync(candidate) === false) {
      continue;
    }
    try {
      return { addon: require(candidate), path: candidate };
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const probe = candidates.join(', ');
  const details = errors.length > 0 ? ` Load errors: ${errors.join(' | ')}` : '';
  throw new Error(`Native pitch addon not found. Probed: ${probe}.${details}`);
}

export class NativePitchHost {
  constructor({ appRoot, assetRoot, logger = null }) {
    this.appRoot = appRoot;
    this.assetRoot = assetRoot;
    this.logger = typeof logger === 'function' ? logger : null;
    this.addon = null;
    this.addonLoadError = null;
    this.lastStartOptions = null;
    this.running = false;
    this.restartOnForeground = false;
    this.updateContextCallCount = 0;
  }

  registerIpc() {
    ipcMain.removeHandler(IPC.startCapture);
    ipcMain.removeHandler(IPC.stopCapture);
    ipcMain.removeHandler(IPC.getDiagnostics);
    ipcMain.removeHandler(IPC.runSanityTest);
    ipcMain.removeHandler(IPC.updateGameplayContext);
    ipcMain.removeHandler(IPC.pollDetections);
    ipcMain.removeHandler(IPC.resetDetector);

    ipcMain.handle(IPC.startCapture, async (_event, options = {}) => this.invoke('startCapture', options, () => {
      this.log('startCapture: resolving native addon.');
      const addon = this.requireAddon();
      this.log('startCapture: native addon resolved.');
      const startOptions = this.prepareStartOptions(options);
      this.lastStartOptions = { ...startOptions };
      this.log('startCapture: invoking addon.startCapture.');
      const result = addon.startCapture({ ...startOptions });
      this.log('startCapture: addon.startCapture returned.');
      this.running = Boolean(result?.running);
      this.restartOnForeground = false;
      return result;
    }));

    ipcMain.handle(IPC.stopCapture, async () => this.invoke('stopCapture', undefined, () => {
      const addon = this.requireAddon();
      const result = addon.stopCapture();
      this.running = false;
      this.restartOnForeground = false;
      return result;
    }));

    ipcMain.handle(IPC.getDiagnostics, async () => this.invoke('getDiagnostics', undefined, () => {
      const addon = this.requireAddon();
      return addon.getDiagnostics();
    }));

    ipcMain.handle(IPC.runSanityTest, async (_event, options = {}) => this.invoke('runSanityTest', options, () => {
      const addon = this.requireAddon();
      return addon.runSanityTest({ ...options });
    }));

    ipcMain.handle(IPC.updateGameplayContext, async (_event, context) => this.invoke('updateGameplayContext', context, () => {
      const addon = this.requireAddon();
      return addon.updateGameplayContext(context ?? null);
    }));

    ipcMain.handle(IPC.pollDetections, async (_event, options = {}) => this.invoke('pollDetections', options, () => {
      const addon = this.requireAddon();
      const result = addon.pollDetections({ ...options });
      this.running = Boolean(result?.running);
      return result;
    }));

    ipcMain.handle(IPC.resetDetector, async () => this.invoke('resetDetector', undefined, () => {
      const addon = this.requireAddon();
      return addon.resetDetector();
    }));
  }

  handleBackground() {
    if (this.running === false || this.lastStartOptions == null) {
      return;
    }
    try {
      const addon = this.requireAddon();
      addon.stopCapture();
      this.running = false;
      this.restartOnForeground = true;
    } catch (error) {
      this.log('Failed to stop capture on background transition.', error);
    }
  }

  handleForeground() {
    if (this.restartOnForeground === false || this.lastStartOptions == null) {
      return;
    }
    try {
      const addon = this.requireAddon();
      const result = addon.startCapture({ ...this.lastStartOptions });
      this.running = Boolean(result?.running);
      this.restartOnForeground = false;
    } catch (error) {
      this.restartOnForeground = false;
      this.log('Failed to restore capture on foreground transition.', error);
    }
  }

  shutdown() {
    if (this.addon == null) {
      return;
    }
    try {
      if (typeof this.addon.shutdown === 'function') {
        this.addon.shutdown();
      } else if (typeof this.addon.stopCapture === 'function') {
        this.addon.stopCapture();
      }
    } catch (error) {
      this.log('Failed to shutdown native pitch host cleanly.', error);
    } finally {
      this.running = false;
      this.restartOnForeground = false;
    }
  }

  requireAddon() {
    if (this.addon != null) {
      return this.addon;
    }
    if (this.addonLoadError != null) {
      throw new Error(this.addonLoadError);
    }

    try {
      const loaded = loadAddon(this.appRoot, this.assetRoot);
      this.addon = loaded.addon;
      this.log(`Native addon loaded successfully from ${loaded.path}.`);
      return this.addon;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addonLoadError = message;
      this.log(`Native addon load failed: ${message}`);
      throw new Error(message);
    }
  }

  prepareStartOptions(options = {}) {
    const startOptions = { ...options };
    const detector = isNonEmptyString(startOptions.detector) ? startOptions.detector : 'ac14';

    if (detector === 'masp' || detector === 'masp_game_scene_ts_v1') {
      const assetsDir = this.resolveMaspAssetsDir(startOptions.maspAssetsDir);
      if (assetsDir) {
        startOptions.maspAssetsDir = assetsDir;
      } else {
        const fallbackDetector = isNonEmptyString(startOptions.spectralModelJson)
          ? 'spectral_game_runtime_unified_v3'
          : 'ac14';
        this.log(
          `MASP assets not found. Falling back from ${detector} to ${fallbackDetector}. ` +
          'Provide maspAssetsDir or bundle MASP assets under native-pitch/masp.'
        );
        startOptions.detector = fallbackDetector;
        delete startOptions.maspAssetsDir;
      }
    }

    if (detector === 'fretnet') {
      const modelPath = this.resolveFretnetModelPath(startOptions.fretnetModelPath);
      if (modelPath) {
        startOptions.fretnetModelPath = modelPath;
      } else {
        const fallbackDetector = isNonEmptyString(startOptions.spectralModelJson)
          ? 'spectral_game_runtime_unified_v3'
          : 'ac14';
        this.log(
          `FretNet model not found. Falling back from fretnet to ${fallbackDetector}. ` +
          'Provide fretnetModelPath to enable FretNet runtime.'
        );
        startOptions.detector = fallbackDetector;
        delete startOptions.fretnetModelPath;
      }
    }

    return startOptions;
  }

  resolveFretnetModelPath(explicitPath) {
    if (isNonEmptyString(explicitPath) && fsSync.existsSync(explicitPath)) {
      return explicitPath;
    }

    const candidates = [
      path.join(this.assetRoot, 'android', 'app', 'src', 'main', 'assets', 'native-pitch', 'fretnet', 'model.onnx'),
      path.join(this.assetRoot, 'native-pitch', 'fretnet', 'model.onnx'),
      path.join(this.assetRoot, 'third_party', 'native-pitch', 'fretnet', 'model.onnx'),
      path.join(this.assetRoot, 'third_party', 'fretnet', 'model.onnx'),
      path.join(this.appRoot, 'android', 'app', 'src', 'main', 'assets', 'native-pitch', 'fretnet', 'model.onnx'),
      path.join(this.appRoot, 'native-pitch', 'fretnet', 'model.onnx'),
      path.join(this.appRoot, 'third_party', 'native-pitch', 'fretnet', 'model.onnx'),
      path.join(process.cwd(), 'native-pitch', 'fretnet', 'model.onnx')
    ];

    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  resolveMaspAssetsDir(explicitPath) {
    const hasMaspManifest = (dirPath) =>
      isNonEmptyString(dirPath) &&
      fsSync.existsSync(path.join(dirPath, 'masp_manifest.json'));

    if (hasMaspManifest(explicitPath)) {
      return explicitPath;
    }

    const candidates = [
      path.join(this.assetRoot, 'android', 'app', 'src', 'main', 'assets', 'native-pitch', 'masp'),
      path.join(this.assetRoot, 'native-pitch', 'masp'),
      path.join(this.assetRoot, 'third_party', 'native-pitch', 'masp'),
      path.join(this.appRoot, 'android', 'app', 'src', 'main', 'assets', 'native-pitch', 'masp'),
      path.join(this.appRoot, 'native-pitch', 'masp'),
      path.join(process.cwd(), 'native-pitch', 'masp')
    ];

    for (const candidate of candidates) {
      if (hasMaspManifest(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  invoke(method, payload, action) {
    const payloadText =
      payload === undefined
        ? ''
        : (() => {
            try {
              return ` payload=${JSON.stringify(payload)}`;
            } catch {
              return ' payload=<unserializable>';
            }
          })();
    const traceEveryCall = method !== 'pollDetections' && method !== 'updateGameplayContext';
    if (traceEveryCall) {
      this.log(`IPC ${method} begin.${payloadText}`);
    } else if (method === 'updateGameplayContext') {
      this.updateContextCallCount += 1;
      if (this.updateContextCallCount % 50 === 1) {
        this.log(`IPC ${method} progress count=${this.updateContextCallCount}.`);
      }
    }

    try {
      const result = action();
      if (traceEveryCall) {
        this.log(`IPC ${method} success.`);
      }
      return result;
    } catch (error) {
      this.log(`IPC ${method} failed.${payloadText}`, error);
      throw error;
    }
  }

  log(message, error = null) {
    const line = `[NativePitchHost] ${message}`;
    if (this.logger) {
      this.logger(line, error ?? undefined);
      return;
    }
    if (error) {
      console.error(`${line}: ${hostErrorMessage(error)}`);
      return;
    }
    console.error(line);
  }
}
