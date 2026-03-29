import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { BootScene } from '../ui/BootScene';
import { PlayScene } from '../ui/PlayScene';
import { PitchDebugScene } from '../ui/PitchDebugScene';
import { PracticeScene } from '../ui/PracticeScene';
import { SongSelectScene } from '../ui/SongSelectScene';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import './styles.css';

const BASE_WIDTH = 1024;
const BASE_HEIGHT = 540;
const GAME_WIDTH = BASE_WIDTH;
const GAME_HEIGHT = BASE_HEIGHT;
const IS_NATIVE_RUNTIME = Capacitor.isNativePlatform();

function installDynamicViewportSizing(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const syncViewportSize = () => {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    // Keep sub-pixel precision to avoid occasional 1px overflow/clipping on the right edge.
    document.documentElement.style.setProperty('--app-viewport-width', `${width}px`);
    document.documentElement.style.setProperty('--app-viewport-height', `${height}px`);
  };

  syncViewportSize();
  window.addEventListener('resize', syncViewportSize, { passive: true });
  window.visualViewport?.addEventListener('resize', syncViewportSize, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncViewportSize, { passive: true });
}

if (typeof document !== 'undefined') {
  document.documentElement.classList.add(IS_NATIVE_RUNTIME ? 'platform-native' : 'platform-web');
  if (!IS_NATIVE_RUNTIME) {
    installDynamicViewportSizing();
  }
}

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
    mode: IS_NATIVE_RUNTIME ? Phaser.Scale.RESIZE : Phaser.Scale.FIT,
    autoCenter: IS_NATIVE_RUNTIME ? undefined : Phaser.Scale.CENTER_BOTH
  },
  scene: [BootScene, SongSelectScene, PlayScene, PracticeScene, PitchDebugScene]
});

const rendererName = game.renderer.type === Phaser.WEBGL ? 'WEBGL' : 'CANVAS';
console.info(`[GuitarHelio] Phaser renderer: ${rendererName}`);
if (rendererName !== 'WEBGL') {
  console.warn('[GuitarHelio] Canvas renderer in use; performance may be reduced on mobile.');
}

void game;
