import { app, BrowserWindow, dialog, session } from 'electron';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

let mainWindow = null;
let previewServer = null;
let baseUrl = null;
let shuttingDown = false;

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
  process.env.GH_RUNTIME_SONGS_DIR = runtimeSongsDir;
  process.env.GH_PROJECT_ROOT = appRoot;
  const { preview } = await import('vite');
  const port = await findFreePort();
  previewServer = await preview({
    root: appRoot,
    configFile: path.join(appRoot, 'vite.config.ts'),
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
      sandbox: true
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
  const runtimeSongsDir = await ensureRuntimeSongsDirectory(appRoot);
  await startPreviewServer(appRoot, runtimeSongsDir);
  createMainWindow();
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
    dialog.showErrorBox('GuitarHelio startup failed', toErrorMessage(error));
    void app.quit();
  });

app.on('activate', () => {
  if (mainWindow !== null) return;
  if (!baseUrl) return;
  createMainWindow();
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
  void stopPreviewServer().finally(() => {
    app.quit();
  });
});
