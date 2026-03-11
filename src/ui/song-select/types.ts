import Phaser from 'phaser';
import { RoundedBox } from '../RoundedBox';

export type Difficulty = 'Easy' | 'Medium' | 'Hard';
export type ImportSourceMode = 'auto' | 'server' | 'native';
export type DebugConverterMode = 'legacy' | 'neuralnote' | 'ab';

export type SongEntry = {
  id: string;
  name: string;
  folder: string;
  cover: string;
  midi: string;
  audio: string;
  highScore: number;
  usesMidiFallback: boolean;
  coverTextureKey: string;
};

export type SongOption = {
  song: SongEntry;
  label: Phaser.GameObjects.Text;
  subLabel: Phaser.GameObjects.Text;
  background: RoundedBox;
  glow: RoundedBox;
  thumbnail: RoundedBox;
  thumbnailImageSize: number;
  thumbnailImage?: Phaser.GameObjects.Image;
  thumbnailImageMaskGraphics?: Phaser.GameObjects.Graphics;
  thumbnailImageFrame?: RoundedBox;
  thumbLabel?: Phaser.GameObjects.Text;
  baseY: number;
  labelBaseY: number;
  subLabelBaseY: number;
  cardHeight: number;
  interactiveObjects: Phaser.GameObjects.GameObject[];
};

export type SongGridView = {
  options: SongOption[];
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  contentBottom: number;
};

export type SongRemovePrompt = {
  songId: string;
  button: RoundedBox;
  label: Phaser.GameObjects.Text;
};

export type SongManifestEntry = {
  id: string;
  name: string;
  folder: string;
  cover?: string;
  midi?: string;
  audio?: string;
  file?: string;
  highScore?: number;
};

export type SongCatalogLoadPolicy = {
  validateAssetsOnStartup: boolean;
  lazyCoverLoading: 'none' | 'visible-first';
  coverLoadConcurrency: number;
};

export type AssetExistenceCacheEntry = {
  exists: boolean;
  expiresAtMs?: number;
};

export type DifficultyDropdown = {
  trigger: RoundedBox;
  label: Phaser.GameObjects.Text;
};

export type ToggleOption = {
  value: number;
  label: Phaser.GameObjects.Text;
  background: RoundedBox;
};

export type SettingsOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  doneButton: RoundedBox;
  doneLabel: Phaser.GameObjects.Text;
  resetScoresButton: RoundedBox;
  resetScoresLabel: Phaser.GameObjects.Text;
  resetScoresConfirmBackdrop: RoundedBox;
  resetScoresConfirmPanel: RoundedBox;
  resetScoresConfirmTitle: Phaser.GameObjects.Text;
  resetScoresConfirmMessage: Phaser.GameObjects.Text;
  resetScoresConfirmCancelButton: RoundedBox;
  resetScoresConfirmCancelLabel: Phaser.GameObjects.Text;
  resetScoresConfirmConfirmButton: RoundedBox;
  resetScoresConfirmConfirmLabel: Phaser.GameObjects.Text;
  stringToggles: ToggleOption[];
  fingerToggles: ToggleOption[];
  fretToggles: ToggleOption[];
};

export type TunerPanel = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  targetLabel: Phaser.GameObjects.Text;
  detectedLabel: Phaser.GameObjects.Text;
  calibrationStatus: Phaser.GameObjects.Text;
  startButton: RoundedBox;
  startLabel: Phaser.GameObjects.Text;
  calibrateButton: RoundedBox;
  calibrateLabel: Phaser.GameObjects.Text;
  resetCalibrationButton: RoundedBox;
  resetCalibrationLabel: Phaser.GameObjects.Text;
  closeButton: RoundedBox;
  closeLabel: Phaser.GameObjects.Text;
  meterNeedle: RoundedBox;
  meterCenterX: number;
  meterHalfWidth: number;
  stringToggles: ToggleOption[];
};

export type SongImportOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  stageLabel: Phaser.GameObjects.Text;
  percentLabel: Phaser.GameObjects.Text;
  progressFill: RoundedBox;
  progressTrackLeft: number;
  progressTrackWidth: number;
  progressTrackHeight: number;
};

export type QuitConfirmOverlay = {
  container: Phaser.GameObjects.Container;
  backdrop: RoundedBox;
  panel: RoundedBox;
  cancelButton: RoundedBox;
  cancelLabel: Phaser.GameObjects.Text;
  quitButton: RoundedBox;
  quitLabel: Phaser.GameObjects.Text;
};

export type SongImportJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type SongImportStatusResponse = {
  id: string;
  status: SongImportJobStatus;
  stage?: string;
  progress?: number;
  error?: string;
};

export type ImportSourceToggleOption = {
  mode: ImportSourceMode;
  background: RoundedBox;
  label: Phaser.GameObjects.Text;
};
