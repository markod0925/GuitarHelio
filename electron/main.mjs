import { app, BrowserWindow, crashReporter, dialog, session } from 'electron';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { NativePitchHost } from './native-host.mjs';

let mainWindow = null;
let previewServer = null;
let baseUrl = null;
let shuttingDown = false;
let nativePitchHost = null;
let desktopLogFile = null;

function formatError(error) {
  if (!error) return '';
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' ? error.stack : '';
    return stack.length > 0 ? stack : error.message;
  }
  return String(error);
}

function logDesktop(message, error) {
  const errorText = formatError(error);
  const line = `[${new Date().toISOString()}] ${message}${errorText ? ` | ${errorText}` : ''}`;
  console.error(line);
  if (!desktopLogFile) return;
  try {
    fsSync.appendFileSync(desktopLogFile, `${line}\n`, 'utf8');
  } catch {
    // Ignore logging failures to avoid feedback loops during crash handling.
  }
}

function setupDesktopLogging() {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fsSync.mkdirSync(logDir, { recursive: true });
    desktopLogFile = path.join(logDir, 'desktop-native.log');
    fsSync.appendFileSync(desktopLogFile, `\n[${new Date().toISOString()}] ---- app boot ----\n`, 'utf8');
  } catch {
    desktopLogFile = null;
  }
}

function setupCrashReporting() {
  try {
    const crashDumpDir = path.join(app.getPath('userData'), 'crashDumps');
    app.setPath('crashDumps', crashDumpDir);
    crashReporter.start({
      productName: 'GuitarHelio',
      companyName: 'GuitarHelio Team',
      uploadToServer: false,
      compress: true
    });
    logDesktop(`Crash dumps path: ${crashDumpDir}`);
  } catch (error) {
    logDesktop('Failed to initialize crash reporter.', error);
  }
}

function isDirectory(entryPath) {
  try {
    return fsSync.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

async function copyMissingFiles(sourceDir, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyMissingFiles(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile() && !fsSync.existsSync(destinationPath)) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function ensureRuntimeSongsDirectory(appRoot) {
  const bundledSongsDir = path.join(appRoot, 'dist', 'songs');
  if (!isDirectory(bundledSongsDir)) {
    throw new Error(`Bundled songs directory not found: ${bundledSongsDir}`);
  }

  const runtimeSongsDir = path.join(app.getPath('userData'), 'songs');
  await copyMissingFiles(bundledSongsDir, runtimeSongsDir);
  return runtimeSongsDir;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Could not allocate local preview port.'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function startPreviewServer(appRoot, runtimeSongsDir) {
  const assetRoot = resolveAssetRoot(appRoot);
  process.env.GH_RUNTIME_SONGS_DIR = runtimeSongsDir;
  process.env.GH_PROJECT_ROOT = appRoot;
  process.env.GH_ASSET_ROOT = assetRoot;
  configureBundledEsbuildBinary(appRoot, assetRoot);
  const viteConfigPath = resolveViteConfigPath(appRoot, assetRoot);
  const { preview } = await import('vite');
  const port = await findFreePort();
  previewServer = await preview({
    root: appRoot,
    configFile: viteConfigPath,
    logLevel: 'warn',
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      open: false
    }
  });

  const address = previewServer?.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Preview server started without a valid HTTP address.');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function resolveAssetRoot(appRoot) {
  if (!app.isPackaged) return appRoot;
  return path.join(process.resourcesPath, 'app.asar.unpacked');
}

function resolveViteConfigPath(appRoot, assetRoot) {
  const unpackedConfigPath = path.join(assetRoot, 'vite.config.ts');
  if (fsSync.existsSync(unpackedConfigPath)) return unpackedConfigPath;
  return path.join(appRoot, 'vite.config.ts');
}

function resolveEsbuildPackageName() {
  if (process.platform === 'win32' && process.arch === 'x64') return '@esbuild/win32-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return '@esbuild/linux-x64';
  if (process.platform === 'darwin' && process.arch === 'x64') return '@esbuild/darwin-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return '@esbuild/darwin-arm64';
  return null;
}

function configureBundledEsbuildBinary(appRoot, assetRoot) {
  if (process.env.ESBUILD_BINARY_PATH) return;
  const packageName = resolveEsbuildPackageName();
  if (!packageName) return;
  const executableName = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  const candidates = [
    path.join(assetRoot, 'node_modules', packageName, executableName),
    path.join(appRoot, 'node_modules', packageName, executableName)
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      process.env.ESBUILD_BINARY_PATH = candidate;
      return;
    }
  }
}

async function stopPreviewServer() {
  if (!previewServer) return;
  const currentServer = previewServer;
  previewServer = null;
  await currentServer.close();
}

function createMainWindow() {
  if (!baseUrl) {
    throw new Error('Missing desktop app URL.');
  }

  const iconPath = path.join(app.getAppPath(), 'assets', 'guitarhelio.ico');
  const windowIcon = fsSync.existsSync(iconPath) ? iconPath : undefined;
  const preloadCandidates = [
    path.join(app.getAppPath(), 'electron', 'preload.cjs'),
    path.join(resolveAssetRoot(app.getAppPath()), 'electron', 'preload.cjs')
  ];
  const preloadPath = preloadCandidates.find((candidate) => fsSync.existsSync(candidate));
  logDesktop(`Creating main window. preload=${preloadPath ?? 'missing'}`);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    show: false,
    icon: windowIcon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath
    }
  });

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('minimize', () => {
    nativePitchHost?.handleBackground();
  });

  mainWindow.on('hide', () => {
    nativePitchHost?.handleBackground();
  });

  mainWindow.on('restore', () => {
    nativePitchHost?.handleForeground();
  });

  mainWindow.on('show', () => {
    nativePitchHost?.handleForeground();
  });

  void mainWindow.loadURL(baseUrl);
}

async function bootDesktopApp() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone');
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'microphone';
  });

  const appRoot = app.getAppPath();
  setupDesktopLogging();
  logDesktop(`Boot start. appRoot=${appRoot}`);
  setupCrashReporting();
  const assetRoot = resolveAssetRoot(appRoot);
  logDesktop(`Asset root resolved: ${assetRoot}`);
  const runtimeSongsDir = await ensureRuntimeSongsDirectory(appRoot);
  logDesktop(`Runtime songs ready: ${runtimeSongsDir}`);
  await startPreviewServer(appRoot, runtimeSongsDir);
  logDesktop(`Preview server ready: ${baseUrl ?? 'missing'}`);
  nativePitchHost = new NativePitchHost({
    appRoot,
    assetRoot,
    logger: (message, error) => logDesktop(message, error)
  });
  nativePitchHost.registerIpc();
  logDesktop('Native pitch IPC handlers registered.');
  createMainWindow();
  logDesktop('Main window created.');
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error || 'Unknown startup error');
}

app.whenReady()
  .then(() => bootDesktopApp())
  .catch((error) => {
    logDesktop('Desktop startup failed.', error);
    dialog.showErrorBox('GuitarHelio startup failed', toErrorMessage(error));
    void app.quit();
  });

app.on('activate', () => {
  if (mainWindow !== null) return;
  if (!baseUrl) return;
  createMainWindow();
});

app.on('browser-window-blur', () => {
  nativePitchHost?.handleBackground();
});

app.on('browser-window-focus', () => {
  nativePitchHost?.handleForeground();
});

app.on('render-process-gone', (_event, webContents, details) => {
  logDesktop(
    `Renderer process gone. URL=${webContents?.getURL?.() ?? 'unknown'} reason=${details?.reason ?? 'unknown'} exitCode=${details?.exitCode ?? 'unknown'}`
  );
});

app.on('child-process-gone', (_event, details) => {
  logDesktop(
    `Child process gone. type=${details?.type ?? 'unknown'} reason=${details?.reason ?? 'unknown'} exitCode=${details?.exitCode ?? 'unknown'} serviceName=${details?.serviceName ?? ''}`
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void app.quit();
  }
});

app.on('will-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  nativePitchHost?.shutdown();
  void stopPreviewServer().finally(() => {
    app.quit();
  });
});

process.on('uncaughtException', (error) => {
  logDesktop('Uncaught exception in main process.', error);
});

process.on('unhandledRejection', (reason) => {
  logDesktop('Unhandled rejection in main process.', reason);
});
