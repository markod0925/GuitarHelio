import Phaser from 'phaser';
import { toPublicAssetUrl } from '../app/publicAssetUrl';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload(): void {
    const isGitHubReleaseBuild = import.meta.env.VITE_RELEASE_LOGO === 'classic';
    const logoPath = isGitHubReleaseBuild
      ? toPublicAssetUrl('ui/logo-guitarhelio-neon.png')
      : toPublicAssetUrl('ui/logo-guitarhelio-neon_2.png');

    this.load.text('songManifest', toPublicAssetUrl('songs/manifest.json'));
    this.load.image('handReminder', toPublicAssetUrl('ui/hand-reminder.png'));
    this.load.image('defaultSongCover', toPublicAssetUrl('ui/song-cover-placeholder-neon.png'));
    this.load.image('logoGuitarHelio', logoPath);
    this.load.image('uiSettingsIcon', toPublicAssetUrl('ui/icon-settings-neon.png'));
    this.load.image('uiTunerIcon', toPublicAssetUrl('ui/icon-tuner-neon.png'));
    this.load.image('uiPlayIcon', toPublicAssetUrl('ui/icon-play-neon.png'));
    this.load.image('uiImportIcon', toPublicAssetUrl('ui/icon-import-neon.png'));
    this.load.image('uiGuitarIcon', toPublicAssetUrl('ui/icon-guitar-neon.png'));
  }

  create(): void {
    [
      'handReminder',
      'defaultSongCover',
      'logoGuitarHelio',
      'uiSettingsIcon',
      'uiTunerIcon',
      'uiPlayIcon',
      'uiImportIcon',
      'uiGuitarIcon'
    ].forEach((key) => {
      this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('guitarhelio:boot-ready'));
    }

    this.scene.start('SongSelectScene');
  }
}
