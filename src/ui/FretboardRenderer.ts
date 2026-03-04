import Phaser from 'phaser';
import type { Layout } from './playSceneTypes';

const STARFIELD_TEXTURE_KEY = 'gh-starfield-texture';

export class FretboardRenderer {
  private starfield?: Phaser.GameObjects.TileSprite;
  private starfieldTextureWidth = 0;
  private starfieldBand?: { width: number; yMin: number; yMax: number };

  constructor(private readonly scene: Phaser.Scene) {}

  drawTopStarfield(layout: Layout, runtimeTick: number): void {
    const width = this.scene.scale.width;
    const yMin = 6;
    const yMax = Math.max(yMin + 12, layout.top - 14);
    const bandHeight = Math.max(1, yMax - yMin);

    const requiresRebuild =
      !this.starfieldBand ||
      this.starfieldBand.width !== width ||
      Math.abs(this.starfieldBand.yMin - yMin) > 1 ||
      Math.abs(this.starfieldBand.yMax - yMax) > 1;

    if (requiresRebuild) {
      this.starfieldBand = { width, yMin, yMax };
      this.buildOrUpdateStarfieldTexture(width, bandHeight);
      this.ensureStarfieldTile(width, bandHeight, yMin);
    }

    if (!this.starfield) return;
    this.starfield
      .setPosition(0, yMin)
      .setSize(width, bandHeight)
      .setDisplaySize(width, bandHeight)
      .setTilePosition((runtimeTick * layout.pxPerTick) % Math.max(1, this.starfieldTextureWidth), 0)
      .setVisible(true);
  }

  reset(): void {
    this.starfield?.destroy();
    this.starfield = undefined;
    if (this.scene.textures.exists(STARFIELD_TEXTURE_KEY)) {
      this.scene.textures.remove(STARFIELD_TEXTURE_KEY);
    }
    this.starfieldTextureWidth = 0;
    this.starfieldBand = undefined;
  }

  private buildOrUpdateStarfieldTexture(width: number, bandHeight: number): void {
    const textureWidth = Math.max(256, Math.ceil(width));
    this.starfieldTextureWidth = textureWidth;

    if (this.scene.textures.exists(STARFIELD_TEXTURE_KEY)) {
      this.scene.textures.remove(STARFIELD_TEXTURE_KEY);
    }

    const graphics = this.scene.add.graphics();
    graphics.fillStyle(0x000000, 0);
    graphics.fillRect(0, 0, textureWidth, bandHeight);

    const starCount = Math.max(36, Math.round((textureWidth * bandHeight) / 12000));
    for (let i = 0; i < starCount; i += 1) {
      const x = Math.random() * textureWidth;
      const y = Math.random() * bandHeight;
      const radius = Phaser.Math.FloatBetween(0.7, 1.9);
      const alpha = Phaser.Math.FloatBetween(0.25, 0.85);
      graphics.fillStyle(0xe2e8f0, alpha);
      graphics.fillCircle(x, y, radius);
      if (radius >= 1.5) {
        graphics.fillStyle(0x93c5fd, alpha * 0.32);
        graphics.fillCircle(x, y, radius * 2.2);
      }
    }

    graphics.generateTexture(STARFIELD_TEXTURE_KEY, textureWidth, bandHeight);
    graphics.destroy();
  }

  private ensureStarfieldTile(width: number, bandHeight: number, yMin: number): void {
    if (!this.starfield) {
      this.starfield = this.scene.add
        .tileSprite(0, yMin, width, bandHeight, STARFIELD_TEXTURE_KEY)
        .setOrigin(0, 0)
        .setDepth(215);
      return;
    }
    this.starfield
      .setTexture(STARFIELD_TEXTURE_KEY)
      .setPosition(0, yMin)
      .setSize(width, bandHeight)
      .setDisplaySize(width, bandHeight)
      .setVisible(true);
  }
}
