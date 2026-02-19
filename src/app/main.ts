import Phaser from 'phaser';
import { BootScene } from '../ui/BootScene';
import { PlayScene } from '../ui/PlayScene';
import { SongSelectScene } from '../ui/SongSelectScene';
import './styles.css';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 1024,
  height: 540,
  backgroundColor: '#111827',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  scene: [BootScene, SongSelectScene, PlayScene]
});

void game;
