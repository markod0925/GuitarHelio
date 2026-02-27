#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const CORE_ROOT = path.join(PROJECT_ROOT, 'third_party', 'neuralnote_core');
const BUILD_DIR = path.join(CORE_ROOT, 'build');
const CLI_BASENAME = process.platform === 'win32' ? 'nn_transcriber_cli.exe' : 'nn_transcriber_cli';
const BINARY_PATH = path.join(CORE_ROOT, 'bin', CLI_BASENAME);

function run(command, args, cwd = PROJECT_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error?.code === 'ENOENT') {
    throw new Error(`Missing required command '${command}'. Install it and retry.`);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function main() {
  if (!fs.existsSync(path.join(CORE_ROOT, 'CMakeLists.txt'))) {
    throw new Error(`Missing CMakeLists.txt in ${CORE_ROOT}`);
  }

  run('cmake', [
    '-S',
    CORE_ROOT,
    '-B',
    BUILD_DIR,
    '-DNEURALNOTE_BUILD_CLI=ON',
    '-DCMAKE_BUILD_TYPE=Release'
  ]);
  run('cmake', ['--build', BUILD_DIR, '--config', 'Release', '-j']);

  if (!fs.existsSync(BINARY_PATH)) {
    throw new Error(`Build completed but binary was not found at ${BINARY_PATH}`);
  }

  process.stdout.write(`Built ${BINARY_PATH}\n`);
}

main();
