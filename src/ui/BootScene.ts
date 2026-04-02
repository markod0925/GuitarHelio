import Phaser from 'phaser';
import { toPublicAssetUrl } from '../app/publicAssetUrl';
import { runtimeLog } from '../app/runtimeLog';

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
    this.load.image('startupSplashBg', toPublicAssetUrl('guitarhelio_splash_landscape_bg_1920x1080.png'));
    this.load.image('logoGuitarHelio', logoPath);
    this.load.image('uiSettingsIcon', toPublicAssetUrl('ui/icon-settings-neon.png'));
    this.load.image('uiTunerIcon', toPublicAssetUrl('ui/icon-tuner-neon.png'));
    this.load.image('uiPlayIcon', toPublicAssetUrl('ui/icon-play-neon.png'));
    this.load.image('uiImportIcon', toPublicAssetUrl('ui/icon-import-neon.png'));
    this.load.image('uiGuitarIcon', toPublicAssetUrl('ui/icon-guitar-neon.png'));
  }

  create(): void {
    runtimeLog({ scene: 'BootScene', subsystem: 'scene' }, 'INFO', 'Entering scene.');
    [
      'handReminder',
      'defaultSongCover',
      'startupSplashBg',
      'logoGuitarHelio',
      'uiSettingsIcon',
      'uiTunerIcon',
      'uiPlayIcon',
      'uiImportIcon',
      'uiGuitarIcon'
    ].forEach((key) => {
      this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    });

    runtimeLog({ scene: 'BootScene', subsystem: 'scene' }, 'INFO', 'Boot assets ready. Transitioning to SongSelectScene.');
    this.scene.start('SongSelectScene');
  }
}
