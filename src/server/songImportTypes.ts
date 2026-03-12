import type { ConverterMode, RequestedConverterMode } from '../platform/converterMode';
export type { ConverterMode, RequestedConverterMode } from '../platform/converterMode';

export type SupportedAudioExtension = '.mp3' | '.ogg' | '.wav';
export type SupportedMidiExtension = '.mid' | '.midi';
export type SupportedImportSource = 'audio' | 'midi';
export type SongImportStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type MidiAnalysisSummary = {
  noteCount: number;
  uniquePitches: number;
  durationSeconds: number;
  meanNoteDurationSeconds: number;
  meanVelocity: number;
  pitchSet: number[];
};

export type ConverterComparisonSummary = {
  baselineMode: 'legacy';
  candidateMode: 'neuralnote';
  candidateStatus: 'ok' | 'failed';
  candidateError?: string;
  legacy: MidiAnalysisSummary;
  neuralnote?: MidiAnalysisSummary;
  deltas?: {
    noteCount: number;
    durationSeconds: number;
    meanNoteDurationSeconds: number;
    meanVelocity: number;
    pitchSetJaccard: number;
  };
};

export type SongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi: string;
  audio?: string;
};

export type SongManifestDocument = {
  songs: SongManifestEntry[];
  [key: string]: unknown;
};

export type SongImportJob = {
  id: string;
  status: SongImportStatus;
  stage: string;
  progress: number;
  fileName: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    song: SongManifestEntry;
    coverExtracted: boolean;
    sourceType: SupportedImportSource;
    sourceExtension: SupportedAudioExtension | '.mid';
    audioExtension?: SupportedAudioExtension;
    converterMode: RequestedConverterMode;
    converterComparison?: ConverterComparisonSummary;
  };
};

export type SongImportPayload = {
  fileName: string;
  mimeType: string;
  sourceType: SupportedImportSource;
  sourceExtension: SupportedAudioExtension | '.mid';
  audioExtension?: SupportedAudioExtension;
  converterMode: RequestedConverterMode;
  buffer: Buffer;
};

export type AudioToMidiConverter = {
  convertAudioBufferToMidiBuffer: (
    inputBuffer: Buffer,
    mimeOrExt?: string,
    options?: {
      conversionPreset?: 'accurate' | 'balanced' | 'dense';
      tempoBpm?: number;
      tempoMap?: Array<{ timeSeconds: number; bpm: number }>;
      onProgress?: (update: { stage?: string; progress?: number }) => void;
    }
  ) => Promise<Buffer>;
};

export type CoverExtractorModule = {
  extractEmbeddedCover: (input: {
    buffer: Buffer;
    fileName?: string;
    mimeType?: string;
  }) =>
    | {
        mimeType: string;
        extension: string;
        data: Buffer | Uint8Array;
      }
    | null;
};

export type SongImportRuntime = {
  projectRoot: string;
  runtimeSongsDir: string;
  runtimeSongManifestPath: string;
  importJobs: Map<string, SongImportJob>;
  converterPromises: Map<ConverterMode, Promise<AudioToMidiConverter>>;
  coverExtractorPromise: Promise<CoverExtractorModule> | null;
};
