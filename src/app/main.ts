import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
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
const GAME_WIDTH = BASE_WIDTH;
const GAME_HEIGHT = BASE_HEIGHT;
const IS_NATIVE_RUNTIME = Capacitor.isNativePlatform();
const STARTUP_SPLASH_READY_EVENT = 'guitarhelio:boot-ready';
const STARTUP_SPLASH_MIN_DURATION_MS = 2000;
const STARTUP_SPLASH_FADE_DURATION_MS = 350;
const STARTUP_SPLASH_FALLBACK_HIDE_MS = 8000;

function installStartupSplash(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const splash = document.createElement('div');
  splash.id = 'startup-splash';
  splash.setAttribute('aria-hidden', 'true');
  document.body.appendChild(splash);

  let appReady = false;
  let minDurationElapsed = false;
  let hidden = false;

  const onBootReady = () => {
    appReady = true;
    hideIfReady();
  };

  const hideIfReady = () => {
    if (hidden || !appReady || !minDurationElapsed) {
      return;
    }

    hidden = true;
    splash.classList.add('is-hidden');
    window.setTimeout(() => {
      splash.remove();
    }, STARTUP_SPLASH_FADE_DURATION_MS + 50);
    window.removeEventListener(STARTUP_SPLASH_READY_EVENT, onBootReady);
  };

  window.addEventListener(STARTUP_SPLASH_READY_EVENT, onBootReady);

  window.setTimeout(() => {
    minDurationElapsed = true;
    hideIfReady();
  }, STARTUP_SPLASH_MIN_DURATION_MS);

  window.setTimeout(() => {
    appReady = true;
    minDurationElapsed = true;
    hideIfReady();
  }, STARTUP_SPLASH_FALLBACK_HIDE_MS);
}

if (typeof document !== 'undefined') {
  document.documentElement.classList.add(IS_NATIVE_RUNTIME ? 'platform-native' : 'platform-web');
  installStartupSplash();
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
  scene: [BootScene, SongSelectScene, PlayScene]
});

const rendererName = game.renderer.type === Phaser.WEBGL ? 'WEBGL' : 'CANVAS';
console.info(`[GuitarHelio] Phaser renderer: ${rendererName}`);
if (rendererName !== 'WEBGL') {
  console.warn('[GuitarHelio] Canvas renderer in use; performance may be reduced on mobile.');
}

void game;
