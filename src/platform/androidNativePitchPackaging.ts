export const REQUIRED_ANDROID_NATIVE_PITCH_LIBS = ['libnative_pitch_runtime.so'] as const;
export const FRETNET_ORT_LIBRARY_CANDIDATES = [
  'libonnxruntime_fretnet.so',
  'libonnxruntime.so'
] as const;

export type AndroidFretnetOrtLibrarySource = 'nativeLibraryDir' | 'apk';

export type AndroidFretnetOrtResolutionInput = {
  abi: string;
  nativeLibraryDirLibsByAbi?: Record<string, string[]>;
  packagedLibsByAbi?: Record<string, string[]>;
  extractNativeLibs?: boolean | null;
};

export type AndroidFretnetOrtResolutionReport = {
  ok: boolean;
  abi: string;
  resolvedLibraryName: string | null;
  resolvedLibrarySource: AndroidFretnetOrtLibrarySource | null;
  resolutionStatus: string;
  errors: string[];
};

export type AndroidNativePitchPackagingInput = {
  abi: string;
  libsByAbi: Record<string, string[]>;
  packagedLibsByAbi?: Record<string, string[]>;
  assetFiles: string[];
  requireFretnet?: boolean;
  requireMasp?: boolean;
  extractNativeLibs?: boolean | null;
};

export type AndroidNativePitchPackagingReport = {
  ok: boolean;
  abi: string;
  resolvedFretnetOrtLibrary: string | null;
  resolvedFretnetOrtSource: AndroidFretnetOrtLibrarySource | null;
  fretnetOrtResolutionStatus: string;
  errors: string[];
};

const MASP_REQUIRED_ASSET_PREFIX = 'native-pitch/masp/';
const FRETNET_MODEL_ASSET = 'native-pitch/fretnet/model.onnx';

export function resolveAndroidFretnetOrtLibrary(
  input: AndroidFretnetOrtResolutionInput
): AndroidFretnetOrtResolutionReport {
  const abi = input.abi.trim();
  const errors: string[] = [];
  const nativeLibraryDirLibs = new Set(input.nativeLibraryDirLibsByAbi?.[abi] ?? []);
  const packagedLibs = new Set(input.packagedLibsByAbi?.[abi] ?? []);

  if (abi.length === 0) {
    errors.push('Target ABI is required.');
  }

  const preferredLibraryName =
    FRETNET_ORT_LIBRARY_CANDIDATES.find((libraryName) => nativeLibraryDirLibs.has(libraryName)) ?? null;
  if (preferredLibraryName) {
    return {
      ok: errors.length === 0,
      abi,
      resolvedLibraryName: preferredLibraryName,
      resolvedLibrarySource: 'nativeLibraryDir',
      resolutionStatus:
        preferredLibraryName === FRETNET_ORT_LIBRARY_CANDIDATES[0]
          ? 'nativeLibraryDir:preferred_exists'
          : 'nativeLibraryDir:fallback_exists',
      errors
    };
  }

  const packagedLibraryName =
    FRETNET_ORT_LIBRARY_CANDIDATES.find((libraryName) => packagedLibs.has(libraryName)) ?? null;
  if (packagedLibraryName) {
    return {
      ok: errors.length === 0,
      abi,
      resolvedLibraryName: packagedLibraryName,
      resolvedLibrarySource: 'apk',
      resolutionStatus:
        packagedLibraryName === FRETNET_ORT_LIBRARY_CANDIDATES[0]
          ? 'apk:preferred_packaged'
          : 'apk:fallback_packaged',
      errors
    };
  }

  errors.push(
    `Missing FRETNET ONNX Runtime library for ${abi}. Expected one of: ${FRETNET_ORT_LIBRARY_CANDIDATES.join(', ')}.`
  );

  return {
    ok: false,
    abi,
    resolvedLibraryName: null,
    resolvedLibrarySource: null,
    resolutionStatus:
      input.extractNativeLibs === false
        ? 'apk:missing_required_ort_library'
        : 'nativeLibraryDir:missing_required_ort_library',
    errors
  };
}

export function validateAndroidNativePitchPackaging(
  input: AndroidNativePitchPackagingInput
): AndroidNativePitchPackagingReport {
  const abi = input.abi.trim();
  const errors: string[] = [];
  const nativeLibraryDirLibsByAbi = input.libsByAbi;
  const packagedLibsByAbi = input.packagedLibsByAbi ?? {};
  const libs = new Set([
    ...(nativeLibraryDirLibsByAbi[abi] ?? []),
    ...(packagedLibsByAbi[abi] ?? [])
  ]);
  const assetFiles = new Set(input.assetFiles);

  if (abi.length === 0) {
    errors.push('Target ABI is required.');
  }

  if (
    (!nativeLibraryDirLibsByAbi[abi] || nativeLibraryDirLibsByAbi[abi].length === 0) &&
    (!packagedLibsByAbi[abi] || packagedLibsByAbi[abi].length === 0)
  ) {
    errors.push(`No native libraries found for ABI ${abi}.`);
  }

  for (const libraryName of REQUIRED_ANDROID_NATIVE_PITCH_LIBS) {
    if (!libs.has(libraryName)) {
      errors.push(`Missing required native pitch runtime library for ${abi}: ${libraryName}.`);
    }
  }

  let resolvedFretnetOrtLibrary: string | null = null;
  let resolvedFretnetOrtSource: AndroidFretnetOrtLibrarySource | null = null;
  let fretnetOrtResolutionStatus = 'not_required';
  if (input.requireFretnet ?? false) {
    if (!assetFiles.has(FRETNET_MODEL_ASSET)) {
      errors.push(`Missing FRETNET model asset: ${FRETNET_MODEL_ASSET}.`);
    }
    const resolution = resolveAndroidFretnetOrtLibrary({
      abi,
      nativeLibraryDirLibsByAbi,
      packagedLibsByAbi,
      extractNativeLibs: input.extractNativeLibs
    });
    resolvedFretnetOrtLibrary = resolution.resolvedLibraryName;
    resolvedFretnetOrtSource = resolution.resolvedLibrarySource;
    fretnetOrtResolutionStatus = resolution.resolutionStatus;
    for (const error of resolution.errors) {
      if (!errors.includes(error)) {
        errors.push(error);
      }
    }
  }

  if (input.requireMasp ?? false) {
    const hasMaspDirectory = [...assetFiles].some((assetPath) => assetPath.startsWith(MASP_REQUIRED_ASSET_PREFIX));
    if (!hasMaspDirectory) {
      errors.push(`Missing MASP asset directory under ${MASP_REQUIRED_ASSET_PREFIX}.`);
    }
  }

  return {
    ok: errors.length === 0,
    abi,
    resolvedFretnetOrtLibrary,
    resolvedFretnetOrtSource,
    fretnetOrtResolutionStatus,
    errors
  };
}
