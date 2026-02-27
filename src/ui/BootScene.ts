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
    [
      'handReminder',
      'defaultSongCover',
      'logoGuitarHelio',
      'uiSettingsIcon',
      'uiTunerIcon',
      'uiPlayIcon'
    ].forEach((key) => {
      this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    });

    this.scene.start('SongSelectScene');
  }
}
