import Phaser from 'phaser';
import { BootScene } from '../ui/BootScene';
import { PlayScene } from '../ui/PlayScene';
import { SongSelectScene } from '../ui/SongSelectScene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 1024,
  height: 540,
  backgroundColor: '#111827',
  scene: [BootScene, SongSelectScene, PlayScene]
});

void game;
