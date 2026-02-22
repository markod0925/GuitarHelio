import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    this.load.text('songManifest', '/songs/manifest.json');
    this.load.image('handReminder', '/ui/hand-reminder.png');
  }

  create(): void {
    this.scene.start('SongSelectScene');
  }
}
