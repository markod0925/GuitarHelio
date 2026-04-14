#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = path.resolve(process.cwd(), process.argv[2] ?? 'analysis/benchmark_suites/.compiled');
await rewriteTree(rootDir);

async function rewriteTree(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await rewriteTree(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const source = await fs.readFile(entryPath, 'utf8');
    const rewritten = await rewriteSource(entryPath, source);
    if (rewritten !== source) {
      await fs.writeFile(entryPath, rewritten, 'utf8');
    }
  }
}

async function rewriteSource(filePath, source) {
  let output = source;
  output = await replaceSpecifiers(filePath, output, /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g);
  output = await replaceSpecifiers(filePath, output, /(import\(\s*['"])(\.\.?\/[^'"]+)(['"]\s*\))/g);
  return output;
}

async function replaceSpecifiers(filePath, source, pattern) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length <= 0) return source;
  let output = source;
  for (const match of matches.reverse()) {
    const fullMatch = match[0];
    const prefix = match[1];
    const specifier = match[2];
    const suffix = match[3];
    if (/\.[a-z0-9]+$/i.test(specifier)) continue;

    const resolvedJs = path.resolve(path.dirname(filePath), `${specifier}.js`);
    const resolvedIndex = path.resolve(path.dirname(filePath), specifier, 'index.js');
    const hasJs = await exists(resolvedJs);
    const hasIndex = !hasJs && await exists(resolvedIndex);
    if (!hasJs && !hasIndex) continue;

    const replacement = `${prefix}${specifier}${hasJs ? '.js' : '/index.js'}${suffix}`;
    output = `${output.slice(0, match.index)}${replacement}${output.slice(match.index + fullMatch.length)}`;
  }
  return output;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
