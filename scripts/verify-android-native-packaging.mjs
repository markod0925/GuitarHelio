import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REQUIRED_ABI = 'arm64-v8a';
const REQUIRED_NATIVE_LIBS = ['libnative_pitch_runtime.so'];
const FRETNET_ORT_CANDIDATES = ['libonnxruntime_fretnet.so', 'libonnxruntime.so'];
const REQUIRED_FRETNET_ASSET = path.join('native-pitch', 'fretnet', 'model.onnx');
const REQUIRED_MASP_PREFIX = path.join('native-pitch', 'masp') + path.sep;

async function main() {
  const repoRoot = process.cwd();
  const sourceJniLibDir = path.join(repoRoot, 'android', 'app', 'src', 'main', 'jniLibs');
  const assetRoot = path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets');
  const mergedLibRoot = path.join(
    repoRoot,
    'android',
    'app',
    'build',
    'intermediates',
    'merged_native_libs',
    'debug',
    'mergeDebugNativeLibs',
    'out',
    'lib'
  );
  const packagedManifestPath = path.join(
    repoRoot,
    'android',
    'app',
    'build',
    'intermediates',
    'packaged_manifests',
    'debug',
    'processDebugManifestForPackage',
    'AndroidManifest.xml'
  );
  const apkPath = path.join(
    repoRoot,
    'android',
    'app',
    'build',
    'outputs',
    'apk',
    'debug',
    'app-debug.apk'
  );

  const sourceLibsByAbi = await readLibsByAbi(sourceJniLibDir);
  const mergedLibsByAbi = await readLibsByAbi(mergedLibRoot);
  const assetFiles = await listRelativeFiles(assetRoot);

  const sourceErrors = validateLibContainer({
    label: 'source jniLibs',
    abi: REQUIRED_ABI,
    libs: sourceLibsByAbi[REQUIRED_ABI] ?? [],
    assetFiles
  });
  const mergedErrors = validateLibContainer({
    label: 'merged native libs',
    abi: REQUIRED_ABI,
    libs: mergedLibsByAbi[REQUIRED_ABI] ?? [],
    assetFiles
  });

  const buildOutputErrors = [];
  if (!(await pathExists(packagedManifestPath))) {
    buildOutputErrors.push(`Packaged manifest not found at ${packagedManifestPath}. Build the Android app first.`);
  }
  if (!(await pathExists(apkPath))) {
    buildOutputErrors.push(`Debug APK not found at ${apkPath}. Build the Android app first.`);
  }

  let extractNativeLibs = null;
  let apkLibsByAbi = {};
  let runtimeResolution = null;
  if (buildOutputErrors.length === 0) {
    extractNativeLibs = await readExtractNativeLibs(packagedManifestPath);
    apkLibsByAbi = await readApkLibsByAbi(apkPath);
    const apkErrors = validateLibContainer({
      label: `APK native libs${typeof extractNativeLibs === 'boolean' ? ` (extractNativeLibs=${extractNativeLibs})` : ''}`,
      abi: REQUIRED_ABI,
      libs: apkLibsByAbi[REQUIRED_ABI] ?? [],
      assetFiles
    });
    buildOutputErrors.push(...apkErrors);

    runtimeResolution = resolveRuntimeFretnetOrt({
      abi: REQUIRED_ABI,
      nativeLibraryDirLibs: mergedLibsByAbi[REQUIRED_ABI] ?? [],
      apkLibs: apkLibsByAbi[REQUIRED_ABI] ?? [],
      extractNativeLibs
    });
    buildOutputErrors.push(...runtimeResolution.errors);
  }

  const allErrors = [...sourceErrors, ...mergedErrors, ...buildOutputErrors];
  if (allErrors.length > 0) {
    console.error('Android native packaging verification failed.');
    for (const error of allErrors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Android native packaging verification passed.');
  console.log(`- ABI: ${REQUIRED_ABI}`);
  console.log(`- Source libs: ${(sourceLibsByAbi[REQUIRED_ABI] ?? []).sort().join(', ')}`);
  console.log(`- Merged libs: ${(mergedLibsByAbi[REQUIRED_ABI] ?? []).sort().join(', ')}`);
  console.log(
    `- APK libs: ${(apkLibsByAbi[REQUIRED_ABI] ?? []).sort().join(', ')}`
      + (typeof extractNativeLibs === 'boolean' ? ` | extractNativeLibs=${extractNativeLibs}` : '')
  );
  if (runtimeResolution) {
    console.log(
      `- Runtime FRETNET ORT: ${runtimeResolution.libraryName}`
        + ` | source=${runtimeResolution.source}`
        + ` | resolution=${runtimeResolution.status}`
    );
  }
  console.log(`- Assets: verified ${REQUIRED_FRETNET_ASSET} and ${REQUIRED_MASP_PREFIX}`);
}

function validateLibContainer({ label, abi, libs, assetFiles }) {
  const errors = [];
  for (const libraryName of REQUIRED_NATIVE_LIBS) {
    if (!libs.includes(libraryName)) {
      errors.push(`${label} missing ${libraryName} for ${abi}.`);
    }
  }
  if (!FRETNET_ORT_CANDIDATES.some((libraryName) => libs.includes(libraryName))) {
    errors.push(
      `${label} missing a FRETNET ONNX Runtime library for ${abi}. Expected one of: ${FRETNET_ORT_CANDIDATES.join(', ')}.`
    );
  }
  if (!assetFiles.includes(REQUIRED_FRETNET_ASSET)) {
    errors.push(`Missing asset ${REQUIRED_FRETNET_ASSET}.`);
  }
  if (!assetFiles.some((assetPath) => assetPath.startsWith(REQUIRED_MASP_PREFIX))) {
    errors.push(`Missing MASP asset directory under ${REQUIRED_MASP_PREFIX}.`);
  }
  return errors;
}

function resolveRuntimeFretnetOrt({ abi, nativeLibraryDirLibs, apkLibs, extractNativeLibs }) {
  const errors = [];
  const nativeSet = new Set(nativeLibraryDirLibs);
  const apkSet = new Set(apkLibs);

  const nativeLibrary = FRETNET_ORT_CANDIDATES.find((libraryName) => nativeSet.has(libraryName)) ?? null;
  const packagedLibrary = FRETNET_ORT_CANDIDATES.find((libraryName) => apkSet.has(libraryName)) ?? null;
  const preferApkPackaging = extractNativeLibs === false;

  if (preferApkPackaging && packagedLibrary) {
    return {
      libraryName: packagedLibrary,
      source: 'apk',
      status:
        packagedLibrary === FRETNET_ORT_CANDIDATES[0]
          ? 'apk:preferred_packaged'
          : 'apk:fallback_packaged',
      errors
    };
  }

  if (nativeLibrary) {
    return {
      libraryName: nativeLibrary,
      source: 'nativeLibraryDir',
      status:
        nativeLibrary === FRETNET_ORT_CANDIDATES[0]
          ? 'nativeLibraryDir:preferred_exists'
          : 'nativeLibraryDir:fallback_exists',
      errors
    };
  }

  if (packagedLibrary) {
    return {
      libraryName: packagedLibrary,
      source: 'apk',
      status:
        packagedLibrary === FRETNET_ORT_CANDIDATES[0]
          ? 'apk:preferred_packaged'
          : 'apk:fallback_packaged',
      errors
    };
  }

  errors.push(
    `Runtime FRETNET ORT resolution failed for ${abi}. Expected one of ${FRETNET_ORT_CANDIDATES.join(', ')} `
      + `in merged native libs or APK packaging. extractNativeLibs=${String(extractNativeLibs)}.`
  );
  return {
    libraryName: null,
    source: null,
    status:
      extractNativeLibs === false
        ? 'apk:missing_required_ort_library'
        : 'nativeLibraryDir:missing_required_ort_library',
    errors
  };
}

async function readLibsByAbi(rootDir) {
  const byAbi = {};
  if (!(await pathExists(rootDir))) {
    return byAbi;
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    byAbi[entry.name] = await readFileNames(path.join(rootDir, entry.name));
  }
  return byAbi;
}

async function readFileNames(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listRelativeFiles(rootDir) {
  if (!(await pathExists(rootDir))) {
    return [];
  }
  const results = [];
  const queue = [''];
  while (queue.length > 0) {
    const relativeDir = queue.shift();
    const absoluteDir = path.join(rootDir, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(relativePath);
        continue;
      }
      results.push(relativePath);
    }
  }
  return results;
}

async function readExtractNativeLibs(manifestPath) {
  const manifest = await fs.readFile(manifestPath, 'utf8');
  const match = manifest.match(/android:extractNativeLibs="(true|false)"/);
  if (!match) {
    return null;
  }
  return match[1] === 'true';
}

async function readApkLibsByAbi(apkPath) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', apkPath], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    const byAbi = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^lib\/([^/]+)\/([^/]+)$/);
      if (!match) {
        continue;
      }
      const [, abi, libraryName] = match;
      byAbi[abi] ??= [];
      byAbi[abi].push(libraryName);
    }
    return byAbi;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to inspect APK native libraries with unzip: ${message}`);
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

await main();
