import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
const tempBase = env.TMPDIR || env.TMP || env.TEMP || '';
const isWsl = process.platform === 'linux' && Boolean(env.WSL_DISTRO_NAME);
const usesWindowsMountTemp = /^\/mnt\/[a-z]\//i.test(tempBase);

if (isWsl && usesWindowsMountTemp) {
  const wslTempDir = '/tmp/guitarhelio-vitest';
  await fs.mkdir(wslTempDir, { recursive: true });
  env.TMPDIR = wslTempDir;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const vitestCli = path.resolve(scriptDir, '../node_modules/vitest/vitest.mjs');
const child = spawn(process.execPath, [vitestCli, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
