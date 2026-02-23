import Phaser from 'phaser';

function defaultCornerRadius(width: number, height: number): number {
  const base = Math.min(width, height) * 0.22;
  return Phaser.Math.Clamp(base, 6, 20);
}

export class RoundedBox extends Phaser.GameObjects.Container {
  private readonly shape: Phaser.GameObjects.Graphics;
  private boxWidth: number;
  private boxHeight: number;
  private cornerRadius: number;
  private fillColor: number;
  private fillAlpha: number;
  private strokeWidth = 0;
  private strokeColor = 0xffffff;
  private strokeAlpha = 1;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number,
    fillColor: number,
    fillAlpha = 1,
    cornerRadius = defaultCornerRadius(width, height)
  ) {
    super(scene, x, y);
    this.boxWidth = width;
    this.boxHeight = height;
    this.cornerRadius = cornerRadius;
    this.fillColor = fillColor;
    this.fillAlpha = fillAlpha;

    this.shape = scene.add.graphics();
    this.add(this.shape);
    this.setSize(width, height);
    this.redraw();

    scene.add.existing(this);
  }

  setFillStyle(color: number, alpha = 1): this {
    this.fillColor = color;
    this.fillAlpha = alpha;
    this.redraw();
    return this;
  }

  setStrokeStyle(lineWidth?: number, color?: number, alpha = 1): this {
    const width = Number(lineWidth ?? 0);
    this.strokeWidth = width > 0 ? width : 0;
    if (color !== undefined) this.strokeColor = color;
    this.strokeAlpha = alpha;
    this.redraw();
    return this;
  }

  setCornerRadius(radius: number): this {
    this.cornerRadius = radius;
    this.redraw();
    return this;
  }

  setBoxSize(width: number, height: number): this {
    this.boxWidth = width;
    this.boxHeight = height;
    this.setSize(width, height);
    this.redraw();
    if (this.input?.hitArea instanceof Phaser.Geom.Rectangle) {
      this.input.hitArea.setTo(-width / 2, -height / 2, width, height);
    }
    return this;
  }

  setInteractive(config: Phaser.Types.Input.InputConfiguration = {}): this {
    const hitArea = new Phaser.Geom.Rectangle(-this.boxWidth / 2, -this.boxHeight / 2, this.boxWidth, this.boxHeight);
    super.setInteractive({
      ...config,
      hitArea,
      hitAreaCallback: Phaser.Geom.Rectangle.Contains
    });
    return this;
  }

  private redraw(): void {
    this.shape.clear();
    const radius = Phaser.Math.Clamp(this.cornerRadius, 0, Math.min(this.boxWidth, this.boxHeight) / 2);
    const left = -this.boxWidth / 2;
    const top = -this.boxHeight / 2;

    if (this.fillAlpha > 0) {
      this.shape.fillStyle(this.fillColor, this.fillAlpha);
      this.shape.fillRoundedRect(left, top, this.boxWidth, this.boxHeight, radius);
    }

    if (this.strokeWidth > 0 && this.strokeAlpha > 0) {
      this.shape.lineStyle(this.strokeWidth, this.strokeColor, this.strokeAlpha);
      this.shape.strokeRoundedRect(left, top, this.boxWidth, this.boxHeight, radius);
    }
  }
}
