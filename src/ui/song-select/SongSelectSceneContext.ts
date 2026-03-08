import type Phaser from 'phaser';
import type { SongEntry } from './types';

export interface SongSelectSceneContext {
  scene: Phaser.Scene;
  scale: Phaser.Scale.ScaleManager;
  refreshUI(): void;
  getSongs(): SongEntry[];
  setSongs(nextSongs: SongEntry[]): void;
  getSelectedIndex(): number;
  setSelectedIndex(index: number): void;
  isSceneActive(): boolean;
}
