import Phaser from 'phaser';

export class SongSelectScene extends Phaser.Scene {
  constructor() {
    super('SongSelectScene');
  }

  create(): void {
    const { width, height } = this.scale;
    const titleSize = Math.max(28, Math.floor(width * 0.05));
    const infoSize = Math.max(16, Math.floor(width * 0.025));

    this.add.text(width / 2, height * 0.2, 'GuitarHelio', {
      color: '#ffffff',
      fontSize: `${titleSize}px`
    }).setOrigin(0.5);

    this.add.text(width / 2, height * 0.35, 'Tap anywhere to start (Easy)', {
      color: '#cccccc',
      align: 'center',
      fontSize: `${infoSize}px`
    }).setOrigin(0.5);

    this.add.text(width / 2, height * 0.43, 'Use your phone mic and keep volume up', {
      color: '#8da2c9',
      align: 'center',
      fontSize: `${Math.max(14, infoSize - 2)}px`
    }).setOrigin(0.5);

    const buttonWidth = Math.min(320, width * 0.7);
    const buttonHeight = Math.min(76, height * 0.12);
    const buttonY = height * 0.62;

    const button = this.add.rectangle(width / 2, buttonY, buttonWidth, buttonHeight, 0x1d4ed8, 1)
      .setStrokeStyle(2, 0x93c5fd)
      .setInteractive({ useHandCursor: true });

    this.add.text(width / 2, buttonY, 'Start', {
      color: '#ffffff',
      fontSize: `${Math.max(22, infoSize + 4)}px`
    }).setOrigin(0.5);

    const startGame = (): void => {
      this.scene.start('PlayScene', {
        songUrl: '/songs/example.mid',
        difficulty: 'Easy'
      });
    };

    button.once('pointerdown', startGame);
    this.input.keyboard?.once('keydown-SPACE', startGame);

    const tapZone = this.add.zone(width / 2, height / 2, width, height).setOrigin(0.5).setInteractive();
    tapZone.once('pointerdown', startGame);
  }
}
