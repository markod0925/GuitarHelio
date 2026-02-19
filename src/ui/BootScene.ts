import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    this.load.text('songManifest', '/songs/manifest.json');
  }

  create(): void {
    this.scene.start('SongSelectScene');
  }
}
