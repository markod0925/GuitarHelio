import { describe, expect, test } from 'vitest';
import {
  resolveAndroidFretnetOrtLibrary,
  validateAndroidNativePitchPackaging
} from '../src/platform/androidNativePitchPackaging';

describe('resolveAndroidFretnetOrtLibrary', () => {
  test('prefers extracted nativeLibraryDir ORT when both extracted and APK-packaged copies exist', () => {
    const report = resolveAndroidFretnetOrtLibrary({
      abi: 'arm64-v8a',
      nativeLibraryDirLibsByAbi: {
        'arm64-v8a': ['libonnxruntime_fretnet.so']
      },
      packagedLibsByAbi: {
        'arm64-v8a': ['libonnxruntime.so']
      },
      extractNativeLibs: false
    });

    expect(report).toEqual({
      ok: true,
      abi: 'arm64-v8a',
      resolvedLibraryName: 'libonnxruntime_fretnet.so',
      resolvedLibrarySource: 'nativeLibraryDir',
      resolutionStatus: 'nativeLibraryDir:preferred_exists',
      errors: []
    });
  });

  test('accepts APK-packaged FRETNET ORT when extractNativeLibs is false and nativeLibraryDir is empty', () => {
    const report = resolveAndroidFretnetOrtLibrary({
      abi: 'arm64-v8a',
      nativeLibraryDirLibsByAbi: {},
      packagedLibsByAbi: {
        'arm64-v8a': ['libonnxruntime_fretnet.so']
      },
      extractNativeLibs: false
    });

    expect(report).toEqual({
      ok: true,
      abi: 'arm64-v8a',
      resolvedLibraryName: 'libonnxruntime_fretnet.so',
      resolvedLibrarySource: 'apk',
      resolutionStatus: 'apk:preferred_packaged',
      errors: []
    });
  });

  test('fails clearly when neither extracted nor APK-packaged ORT is available for the target ABI', () => {
    const report = resolveAndroidFretnetOrtLibrary({
      abi: 'arm64-v8a',
      nativeLibraryDirLibsByAbi: {
        x86_64: ['libonnxruntime_fretnet.so']
      },
      packagedLibsByAbi: {
        x86_64: ['libonnxruntime.so']
      },
      extractNativeLibs: false
    });

    expect(report.ok).toBe(false);
    expect(report.resolvedLibraryName).toBeNull();
    expect(report.resolvedLibrarySource).toBeNull();
    expect(report.resolutionStatus).toBe('apk:missing_required_ort_library');
    expect(report.errors).toContain(
      'Missing FRETNET ONNX Runtime library for arm64-v8a. Expected one of: libonnxruntime_fretnet.so, libonnxruntime.so.'
    );
  });
});

describe('validateAndroidNativePitchPackaging', () => {
  test('accepts complete arm64-v8a packaging with preferred FRETNET ORT library', () => {
    const report = validateAndroidNativePitchPackaging({
      abi: 'arm64-v8a',
      libsByAbi: {
        'arm64-v8a': ['libnative_pitch_runtime.so', 'libonnxruntime_fretnet.so']
      },
      assetFiles: [
        'native-pitch/fretnet/model.onnx',
        'native-pitch/masp/masp_manifest.json'
      ],
      requireFretnet: true,
      requireMasp: true
    });

    expect(report).toEqual({
      ok: true,
      abi: 'arm64-v8a',
      resolvedFretnetOrtLibrary: 'libonnxruntime_fretnet.so',
      resolvedFretnetOrtSource: 'nativeLibraryDir',
      fretnetOrtResolutionStatus: 'nativeLibraryDir:preferred_exists',
      errors: []
    });
  });

  test('accepts fallback ONNX Runtime library name when preferred one is absent', () => {
    const report = validateAndroidNativePitchPackaging({
      abi: 'arm64-v8a',
      libsByAbi: {
        'arm64-v8a': ['libnative_pitch_runtime.so', 'libonnxruntime.so']
      },
      assetFiles: ['native-pitch/fretnet/model.onnx'],
      requireFretnet: true
    });

    expect(report.ok).toBe(true);
    expect(report.resolvedFretnetOrtLibrary).toBe('libonnxruntime.so');
    expect(report.resolvedFretnetOrtSource).toBe('nativeLibraryDir');
    expect(report.fretnetOrtResolutionStatus).toBe('nativeLibraryDir:fallback_exists');
  });

  test('accepts APK-packaged fallback ONNX Runtime library when extractNativeLibs is false', () => {
    const report = validateAndroidNativePitchPackaging({
      abi: 'arm64-v8a',
      libsByAbi: {
        'arm64-v8a': ['libnative_pitch_runtime.so']
      },
      packagedLibsByAbi: {
        'arm64-v8a': ['libnative_pitch_runtime.so', 'libonnxruntime.so']
      },
      assetFiles: ['native-pitch/fretnet/model.onnx'],
      requireFretnet: true,
      extractNativeLibs: false
    });

    expect(report.ok).toBe(true);
    expect(report.resolvedFretnetOrtLibrary).toBe('libonnxruntime.so');
    expect(report.resolvedFretnetOrtSource).toBe('apk');
    expect(report.fretnetOrtResolutionStatus).toBe('apk:fallback_packaged');
  });

  test('fails clearly when the target ABI is missing required native libraries', () => {
    const report = validateAndroidNativePitchPackaging({
      abi: 'arm64-v8a',
      libsByAbi: {
        x86_64: ['libnative_pitch_runtime.so', 'libonnxruntime_fretnet.so']
      },
      assetFiles: ['native-pitch/fretnet/model.onnx'],
      requireFretnet: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain('No native libraries found for ABI arm64-v8a.');
    expect(report.errors).toContain('Missing required native pitch runtime library for arm64-v8a: libnative_pitch_runtime.so.');
    expect(report.errors).toContain(
      'Missing FRETNET ONNX Runtime library for arm64-v8a. Expected one of: libonnxruntime_fretnet.so, libonnxruntime.so.'
    );
    expect(report.resolvedFretnetOrtSource).toBeNull();
    expect(report.fretnetOrtResolutionStatus).toBe('nativeLibraryDir:missing_required_ort_library');
  });

  test('fails clearly when FRETNET model or ORT library is missing', () => {
    const report = validateAndroidNativePitchPackaging({
      abi: 'arm64-v8a',
      libsByAbi: {
        'arm64-v8a': ['libnative_pitch_runtime.so']
      },
      assetFiles: [],
      requireFretnet: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain('Missing FRETNET model asset: native-pitch/fretnet/model.onnx.');
    expect(report.errors).toContain(
      'Missing FRETNET ONNX Runtime library for arm64-v8a. Expected one of: libonnxruntime_fretnet.so, libonnxruntime.so.'
    );
    expect(report.resolvedFretnetOrtSource).toBeNull();
    expect(report.fretnetOrtResolutionStatus).toBe('nativeLibraryDir:missing_required_ort_library');
  });

  test('fails clearly when MASP assets are missing', () => {
    const report = validateAndroidNativePitchPackaging({
      abi: 'arm64-v8a',
      libsByAbi: {
        'arm64-v8a': ['libnative_pitch_runtime.so']
      },
      assetFiles: ['native-pitch/fretnet/model.onnx'],
      requireMasp: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain('Missing MASP asset directory under native-pitch/masp/.');
    expect(report.resolvedFretnetOrtLibrary).toBeNull();
    expect(report.resolvedFretnetOrtSource).toBeNull();
    expect(report.fretnetOrtResolutionStatus).toBe('not_required');
  });
});
