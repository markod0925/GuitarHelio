import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AudioToMidiConverter,
  ConverterMode,
  CoverExtractorModule,
  SongImportRuntime,
  SupportedAudioExtension
} from './songImportTypes';

const TEMPO_CLI_BASENAME = process.platform === 'win32' ? 'tempo_cnn_cli.exe' : 'tempo_cnn_cli';
const ONNX_RUNTIME_SUBDIR = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';

type TempoEstimate = {
  bpm: number;
  tempoMap?: Array<{ timeSeconds: number; bpm: number }>;
};

function getConverterModulePath(_mode: ConverterMode): string {
  return 'scripts/audio-to-midi-neuralnote.mjs';
}

export async function loadAudioToMidiConverter(runtime: SongImportRuntime, mode: ConverterMode): Promise<AudioToMidiConverter> {
  const cached = runtime.converterPromises.get(mode);
  if (cached) return cached;

  const moduleUrl = pathToFileURL(path.resolve(runtime.projectRoot, getConverterModulePath(mode))).href;
  const pending = import(moduleUrl).then((moduleValue) => {
    const converter = (moduleValue.default ?? moduleValue) as Partial<AudioToMidiConverter>;
    if (!converter || typeof converter.convertAudioBufferToMidiBuffer !== 'function') {
      throw new Error(`Audio to MIDI converter "${mode}" is not available.`);
    }
    return converter as AudioToMidiConverter;
  });

  runtime.converterPromises.set(mode, pending);
  return pending;
}

export async function estimateTempoFromAudioBuffer(
  runtime: SongImportRuntime,
  inputBuffer: Buffer,
  audioExtension: SupportedAudioExtension
): Promise<{ tempoBpm: number; tempoMap: Array<{ timeSeconds: number; bpm: number }> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-tempo-import-'));
  try {
    const audioPath = path.join(tempDir, `tempo-source${audioExtension}`);
    await fs.writeFile(audioPath, inputBuffer);

    const tempoModuleUrl = pathToFileURL(path.resolve(runtime.projectRoot, 'tools/audio-midi-converter/src/tempo-bpm.mjs')).href;
    const tempoModule = (await import(tempoModuleUrl)) as {
      estimateTempoFromAudioFile?: (inputFilePath: string, options?: Record<string, unknown>) => Promise<TempoEstimate>;
    };
    const estimateTempo = tempoModule.estimateTempoFromAudioFile;
    if (typeof estimateTempo !== 'function') {
      throw new Error('Tempo estimation helper is not available.');
    }

    const estimated = await estimateTempo(audioPath, {
      backend: 'onnx',
      tempoCliBin: path.resolve(runtime.projectRoot, 'third_party/tempocnn_core/bin', TEMPO_CLI_BASENAME),
      tempoModelOnnxPath: path.resolve(runtime.projectRoot, 'third_party/tempo_cnn/tempocnn/models/fcn.onnx'),
      onnxLibDir: path.resolve(runtime.projectRoot, 'third_party/onnxruntime', ONNX_RUNTIME_SUBDIR, 'lib'),
      interpolate: true,
      localTempo: false,
      useFfmpeg: false
    });

    const tempoBpm = Number(estimated?.bpm);
    if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) {
      throw new Error('Tempo estimator returned an invalid BPM value.');
    }

    return { tempoBpm, tempoMap: [] };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function loadCoverExtractor(runtime: SongImportRuntime): Promise<CoverExtractorModule> {
  if (!runtime.coverExtractorPromise) {
    const moduleUrl = pathToFileURL(path.resolve(runtime.projectRoot, 'scripts/audio-cover-extractor.mjs')).href;
    runtime.coverExtractorPromise = import(moduleUrl).then((moduleValue) => {
      const extractor = moduleValue as Partial<CoverExtractorModule>;
      if (!extractor || typeof extractor.extractEmbeddedCover !== 'function') {
        throw new Error('Embedded cover extractor is not available.');
      }
      return extractor as CoverExtractorModule;
    });
  }

  return runtime.coverExtractorPromise;
}

export function getCoverFileExtension(rawCover: { extension?: string; mimeType?: string }): string {
  const extension = String(rawCover.extension || '').trim().toLowerCase();
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.gif' || extension === '.webp' || extension === '.bmp') {
    return extension === '.jpeg' ? '.jpg' : extension;
  }

  const mimeType = String(rawCover.mimeType || '').toLowerCase();
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/bmp') return '.bmp';
  return '.jpg';
}
