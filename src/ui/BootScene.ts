import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    this.load.text('songManifest', '/songs/manifest.json');
    this.load.image('handReminder', '/ui/hand-reminder.png');
    this.load.image('defaultSongCover', '/ui/song-cover-placeholder-neon.png');
    this.load.image('logoGuitarHelio', '/ui/logo-guitarhelio-neon.png');
    this.load.image('uiSettingsIcon', '/ui/icon-settings-neon.png');
    this.load.image('uiTunerIcon', '/ui/icon-tuner-neon.png');
    this.load.image('uiPlayIcon', '/ui/icon-play-neon.png');
  }

  create(): void {
    this.scene.start('SongSelectScene');
  }
}
