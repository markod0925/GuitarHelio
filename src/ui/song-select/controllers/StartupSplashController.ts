import Phaser from 'phaser';
import { hideStartupDomSplash } from '../../../app/startupDomSplash';

const STARTUP_SCENE_SPLASH_MIN_DURATION_MS = 2000;
const STARTUP_SCENE_SPLASH_FADE_MS = 350;
const STARTUP_SCENE_SPLASH_FALLBACK_HIDE_MS = 8000;
const STARTUP_SCENE_SPLASH_DEPTH = 5000;

export class StartupSplashController {
  private static startupSplashShown = false;

  private splashOverlay?: Phaser.GameObjects.Container;
  private minDurationElapsed = false;
  private loadSettled = false;
  private hidden = false;
  private minTimer?: Phaser.Time.TimerEvent;
  private fallbackTimer?: Phaser.Time.TimerEvent;

  constructor(private readonly scene: Phaser.Scene) {}

  initialize(width: number, height: number): void {
    if (StartupSplashController.startupSplashShown) {
      this.hidden = true;
      this.minDurationElapsed = true;
      this.loadSettled = true;
      hideStartupDomSplash(0);
      return;
    }

    this.splashOverlay = this.createSplashOverlay(width, height);
    this.minDurationElapsed = false;
    this.loadSettled = false;
    this.hidden = false;

    this.minTimer = this.scene.time.delayedCall(STARTUP_SCENE_SPLASH_MIN_DURATION_MS, () => {
      this.minDurationElapsed = true;
      this.hideIfReady();
    });
    this.fallbackTimer = this.scene.time.delayedCall(STARTUP_SCENE_SPLASH_FALLBACK_HIDE_MS, () => {
      this.minDurationElapsed = true;
      this.loadSettled = true;
      this.hideIfReady();
    });
  }

  markLoadSettled(): void {
    this.loadSettled = true;
    this.hideIfReady();
  }

  destroy(): void {
    this.minTimer?.remove(false);
    this.fallbackTimer?.remove(false);
    this.minTimer = undefined;
    this.fallbackTimer = undefined;
    this.splashOverlay?.destroy(true);
    this.splashOverlay = undefined;
    hideStartupDomSplash(0);
  }

  private hideIfReady(): void {
    if (this.hidden || !this.minDurationElapsed || !this.loadSettled || !this.splashOverlay) {
      return;
    }

    this.hidden = true;
    StartupSplashController.startupSplashShown = true;
    hideStartupDomSplash(STARTUP_SCENE_SPLASH_FADE_MS);

    this.scene.tweens.add({
      targets: this.splashOverlay,
      alpha: 0,
      duration: STARTUP_SCENE_SPLASH_FADE_MS,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.splashOverlay?.destroy(true);
        this.splashOverlay = undefined;
      }
    });
  }

  private createSplashOverlay(width: number, height: number): Phaser.GameObjects.Container {
    const base = this.scene.add
      .rectangle(width / 2, height / 2, width, height, 0x030712, 1)
      .setOrigin(0.5);

    const nodes: Phaser.GameObjects.GameObject[] = [base];
    if (this.scene.textures.exists('startupSplashBg')) {
      const splashBg = this.scene.add.image(width / 2, height / 2, 'startupSplashBg').setOrigin(0.5);
      const sx = width / Math.max(1, splashBg.width);
      const sy = height / Math.max(1, splashBg.height);
      const scale = Math.max(sx, sy);
      splashBg.setScale(scale);
      nodes.push(splashBg);
    }

    const vignette = this.scene.add
      .rectangle(width / 2, height / 2, width, height, 0x020617, 0.28)
      .setOrigin(0.5);
    nodes.push(vignette);

    return this.scene.add.container(0, 0, nodes).setDepth(STARTUP_SCENE_SPLASH_DEPTH);
  }
}
