import Phaser from 'phaser';

export class SongSelectScene extends Phaser.Scene {
  constructor() {
    super('SongSelectScene');
  }

  create(): void {
    this.add.text(30, 30, 'GuitarHelio', { color: '#ffffff', fontSize: '28px' });
    this.add.text(30, 80, 'Click to start with Easy difficulty', { color: '#cccccc', fontSize: '16px' });
    this.input.once('pointerdown', () => {
      this.scene.start('PlayScene', {
        songUrl: '/songs/example.mid',
        difficulty: 'Easy'
      });
    });
  }
}
