import Phaser from 'phaser';
import { BootScene } from '../ui/BootScene';
import { PlayScene } from '../ui/PlayScene';
import { SongSelectScene } from '../ui/SongSelectScene';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import './styles.css';

const BASE_WIDTH = 1024;
const BASE_HEIGHT = 540;
const INTERNAL_RENDER_SCALE =
  typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
const GAME_WIDTH = Math.round(BASE_WIDTH * INTERNAL_RENDER_SCALE);
const GAME_HEIGHT = Math.round(BASE_HEIGHT * INTERNAL_RENDER_SCALE);

const game = new Phaser.Game({
  type: Phaser.WEBGL,
  parent: 'app',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#050d22',
  render: {
    antialias: true,
    roundPixels: false,
    pixelArt: false
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  scene: [BootScene, SongSelectScene, PlayScene]
});

const rendererName = game.renderer.type === Phaser.WEBGL ? 'WEBGL' : 'CANVAS';
console.info(`[GuitarHelio] Phaser renderer: ${rendererName}`);
if (rendererName !== 'WEBGL') {
  console.warn('[GuitarHelio] Canvas renderer in use; performance may be reduced on mobile.');
}

void game;
