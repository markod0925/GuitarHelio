import Phaser from 'phaser';
import { DEFAULT_SONG_COVER_TEXTURE_KEY } from '../constants';
import type {
  SongEntry,
  SongOption,
  SongRemovePrompt
} from '../types';
import { RoundedBox } from '../../RoundedBox';

type SongGridControllerOptions = {
  isPointerBlocked: () => boolean;
  canSelectSong: () => boolean;
  canStartLongPressRemove: () => boolean;
  onSelectionChanged: () => void;
  onRequestRemoveSong: (song: SongEntry) => void;
  longPressMs: number;
  longPressMoveTolerancePx: number;
};

export class SongGridController {
  private songOptions: SongOption[] = [];
  private songScrollOffset = 0;
  private songScrollMax = 0;
  private songViewportRect?: Phaser.Geom.Rectangle;
  private songMaskGraphics?: Phaser.GameObjects.Graphics;
  private songScrollDragPointerId?: number;
  private songScrollDragStartY = 0;
  private songScrollDragStartOffset = 0;
  private songLongPressPointerId?: number;
  private songLongPressStartX = 0;
  private songLongPressStartY = 0;
  private songLongPressTimer?: Phaser.Time.TimerEvent;
  private songRemovePrompt?: SongRemovePrompt;
  private selectedSongIndex = 0;
  private onSongWheel?: (
    pointer: Phaser.Input.Pointer,
    gameObjects: Phaser.GameObjects.GameObject[],
    deltaX: number,
    deltaY: number
  ) => void;
  private onSongPointerDown?: (pointer: Phaser.Input.Pointer) => void;
  private onSongPointerMove?: (pointer: Phaser.Input.Pointer) => void;
  private onSongPointerUp?: (pointer: Phaser.Input.Pointer) => void;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly options: SongGridControllerOptions
  ) {}

  initialize(songs: SongEntry[], width: number, height: number, labelSize: number): void {
    this.setSongs(songs, width, height, labelSize);
    this.bindPointerHandlers();
  }

  destroy(): void {
    this.unbindPointerHandlers();
    this.cancelSongLongPress();
    this.hideRemovePrompt();
    this.songMaskGraphics?.destroy();
    this.songMaskGraphics = undefined;
    this.destroySongOptions();
    this.songViewportRect = undefined;
    this.songScrollOffset = 0;
    this.songScrollMax = 0;
    this.songScrollDragPointerId = undefined;
  }

  getOptions(): SongOption[] {
    return this.songOptions;
  }

  getSelectedIndex(): number {
    return this.selectedSongIndex;
  }

  setSelectedIndex(index: number): void {
    const maxIndex = Math.max(0, this.songOptions.length - 1);
    const nextIndex = Phaser.Math.Clamp(index, 0, maxIndex);
    if (this.selectedSongIndex === nextIndex) return;
    this.selectedSongIndex = nextIndex;
    this.ensureSelectedSongVisible();
    this.options.onSelectionChanged();
  }

  moveSelection(delta: number): void {
    this.setSelectedIndex(this.selectedSongIndex + delta);
  }

  ensureSelectedSongVisible(): void {
    if (!this.songViewportRect || this.songOptions.length === 0) return;
    const selectedOption = this.songOptions[this.selectedSongIndex];
    if (!selectedOption) return;

    const viewportTop = this.songViewportRect.top + 4;
    const viewportBottom = this.songViewportRect.bottom - 4;
    const optionTop = selectedOption.baseY - this.songScrollOffset - selectedOption.cardHeight / 2;
    const optionBottom = selectedOption.baseY - this.songScrollOffset + selectedOption.cardHeight / 2;

    if (optionTop < viewportTop) {
      this.setSongScrollOffset(this.songScrollOffset - (viewportTop - optionTop));
    } else if (optionBottom > viewportBottom) {
      this.setSongScrollOffset(this.songScrollOffset + (optionBottom - viewportBottom));
    }
  }

  hideRemovePrompt(): void {
    if (!this.songRemovePrompt) return;
    this.songRemovePrompt.button.destroy();
    this.songRemovePrompt.label.destroy();
    this.songRemovePrompt = undefined;
  }

  getViewportTop(): number {
    return this.songViewportRect?.top ?? this.scene.scale.height * 0.2;
  }

  getViewportRect(): Phaser.Geom.Rectangle | undefined {
    return this.songViewportRect;
  }

  setSongs(songs: SongEntry[], width: number, height: number, labelSize: number): void {
    this.cancelSongLongPress();
    this.hideRemovePrompt();
    this.destroySongOptions();
    this.songOptions = this.createSongOptions(songs, width, height, labelSize);
    this.configureSongScroll(width, height, songs.length);
    this.bindSongInteractions();
    this.selectedSongIndex = Phaser.Math.Clamp(this.selectedSongIndex, 0, Math.max(0, this.songOptions.length - 1));
    this.ensureSelectedSongVisible();
  }

  applyThumbnailViewportCrop(option: SongOption, viewportTop: number, viewportBottom: number): void {
    const image = option.thumbnailImage;
    if (!image) return;

    const top = image.y - image.displayHeight / 2;
    const bottom = image.y + image.displayHeight / 2;
    const visibleTop = Math.max(top, viewportTop);
    const visibleBottom = Math.min(bottom, viewportBottom);
    const isVisible = visibleBottom > visibleTop + 0.5;

    image.setVisible(isVisible);
    option.thumbnailImageFrame?.setVisible(isVisible);
    if (!isVisible) return;

    const frameHeight = Math.max(1, image.frame.height);
    const frameWidth = Math.max(1, image.frame.width);
    const scaleY = image.displayHeight / frameHeight;
    const cropY = Math.max(0, (visibleTop - top) / scaleY);
    const cropHeight = Math.max(1, (visibleBottom - visibleTop) / scaleY);
    image.setCrop(0, cropY, frameWidth, cropHeight);
  }

  private destroySongOptions(): void {
    this.songOptions.forEach((option) => {
      option.glow.destroy();
      option.background.destroy();
      option.thumbnail.destroy();
      option.thumbnailImage?.destroy();
      option.thumbnailImageMaskGraphics?.destroy();
      option.thumbnailImageFrame?.destroy();
      option.thumbLabel?.destroy();
      option.label.destroy();
      option.subLabel.destroy();
    });
    this.songOptions = [];
  }

  private bindPointerHandlers(): void {
    this.onSongWheel = (
      pointer: Phaser.Input.Pointer,
      _gameObjects: Phaser.GameObjects.GameObject[],
      _deltaX: number,
      deltaY: number
    ): void => {
      if (this.options.isPointerBlocked()) return;
      if (!this.songViewportRect || this.songScrollMax <= 0) return;
      if (!this.songViewportRect.contains(pointer.worldX, pointer.worldY)) return;
      this.setSongScrollOffset(this.songScrollOffset + deltaY * 0.8);
      this.options.onSelectionChanged();
    };
    this.onSongPointerDown = (pointer: Phaser.Input.Pointer): void => {
      if (this.options.isPointerBlocked()) return;
      if (this.songRemovePrompt && !this.isPointerInsideObject(pointer, this.songRemovePrompt.button)) {
        this.hideRemovePrompt();
      }
      if (!this.songViewportRect || this.songScrollMax <= 0) return;
      if (!this.songViewportRect.contains(pointer.worldX, pointer.worldY)) return;
      this.songScrollDragPointerId = pointer.id;
      this.songScrollDragStartY = pointer.worldY;
      this.songScrollDragStartOffset = this.songScrollOffset;
    };
    this.onSongPointerMove = (pointer: Phaser.Input.Pointer): void => {
      if (this.options.isPointerBlocked()) return;
      if (
        this.songLongPressPointerId === pointer.id &&
        Phaser.Math.Distance.Between(pointer.worldX, pointer.worldY, this.songLongPressStartX, this.songLongPressStartY) >
          this.options.longPressMoveTolerancePx
      ) {
        this.cancelSongLongPress();
      }
      if (this.songScrollDragPointerId !== pointer.id || !pointer.isDown) return;
      const dragDelta = this.songScrollDragStartY - pointer.worldY;
      this.setSongScrollOffset(this.songScrollDragStartOffset + dragDelta);
      this.options.onSelectionChanged();
    };
    this.onSongPointerUp = (pointer: Phaser.Input.Pointer): void => {
      if (this.options.isPointerBlocked()) return;
      if (this.songLongPressPointerId === pointer.id) {
        this.cancelSongLongPress();
      }
      if (this.songScrollDragPointerId !== pointer.id) return;
      this.songScrollDragPointerId = undefined;
    };

    this.scene.input.on('wheel', this.onSongWheel);
    this.scene.input.on('pointerdown', this.onSongPointerDown);
    this.scene.input.on('pointermove', this.onSongPointerMove);
    this.scene.input.on('pointerup', this.onSongPointerUp);
    this.scene.input.on('pointerupoutside', this.onSongPointerUp);
  }

  private unbindPointerHandlers(): void {
    if (this.onSongWheel) this.scene.input.off('wheel', this.onSongWheel);
    if (this.onSongPointerDown) this.scene.input.off('pointerdown', this.onSongPointerDown);
    if (this.onSongPointerMove) this.scene.input.off('pointermove', this.onSongPointerMove);
    if (this.onSongPointerUp) {
      this.scene.input.off('pointerup', this.onSongPointerUp);
      this.scene.input.off('pointerupoutside', this.onSongPointerUp);
    }
    this.onSongWheel = undefined;
    this.onSongPointerDown = undefined;
    this.onSongPointerMove = undefined;
    this.onSongPointerUp = undefined;
  }

  private configureSongScroll(width: number, height: number, songCount: number): void {
    const cols = 2;
    const gridLeft = width * 0.04;
    const gridTop = height * 0.24;
    const gridWidth = width * 0.56;
    const buttonHeight = Math.min(122, height * 0.22);
    const gapY = Math.max(14, height * 0.028);
    const viewportLeft = gridLeft - 8;
    const viewportTop = Math.max(height * 0.2, gridTop - buttonHeight * 0.52);
    const viewportRight = gridLeft + gridWidth + 8;
    const viewportBottom = Math.min(height * 0.8, height - Math.max(96, buttonHeight * 0.85));
    const viewportHeight = Math.max(buttonHeight + 16, viewportBottom - viewportTop);
    const rows = Math.max(1, Math.ceil(songCount / cols));
    const contentBottom = songCount <= 0 ? gridTop : gridTop + rows * buttonHeight + Math.max(0, rows - 1) * gapY;

    this.songScrollOffset = 0;
    this.songScrollMax = Math.max(0, contentBottom - (viewportTop + viewportHeight));
    this.songViewportRect = new Phaser.Geom.Rectangle(viewportLeft, viewportTop, viewportRight - viewportLeft, viewportHeight);
    this.songMaskGraphics?.destroy();

    this.songMaskGraphics = this.scene.add.graphics({ x: 0, y: 0 }).setVisible(false);
    this.songMaskGraphics.fillStyle(0xffffff, 1);
    this.songMaskGraphics.fillRect(viewportLeft, viewportTop, viewportRight - viewportLeft, viewportHeight);
    const mask = this.songMaskGraphics.createGeometryMask();

    this.songOptions.forEach((option) => {
      option.glow.setMask(mask);
      option.background.setMask(mask);
      option.thumbnail.setMask(mask);
      option.thumbnailImageFrame?.setMask(mask);
      option.thumbLabel?.setMask(mask);
      option.label.setMask(mask);
      option.subLabel.setMask(mask);
    });

    this.applySongScroll();
  }

  private setSongScrollOffset(offset: number): void {
    const clamped = Phaser.Math.Clamp(offset, 0, this.songScrollMax);
    if (Math.abs(clamped - this.songScrollOffset) < 0.1) return;
    this.songScrollOffset = clamped;
    this.applySongScroll();
  }

  private applySongScroll(): void {
    if (!this.songViewportRect) return;
    const viewportTop = this.songViewportRect.top;
    const viewportBottom = this.songViewportRect.bottom;

    this.songOptions.forEach((option) => {
      const y = option.baseY - this.songScrollOffset;
      option.glow.setY(y);
      option.background.setY(y);
      option.thumbnail.setY(y);
      option.thumbnailImage?.setY(y);
      option.thumbnailImageMaskGraphics?.setY(y);
      option.thumbnailImageFrame?.setY(y);
      option.thumbLabel?.setY(y);
      option.label.setY(option.labelBaseY - this.songScrollOffset);
      option.subLabel.setY(option.subLabelBaseY - this.songScrollOffset);
      this.applyThumbnailViewportCrop(option, viewportTop, viewportBottom);

      const top = y - option.cardHeight / 2;
      const bottom = y + option.cardHeight / 2;
      const intersectsViewport = bottom >= viewportTop + 2 && top <= viewportBottom - 2;
      option.interactiveObjects.forEach((interactiveObject) => {
        if (interactiveObject.input) interactiveObject.input.enabled = intersectsViewport;
      });
    });
  }

  private bindSongInteractions(): void {
    this.songOptions.forEach((option, index) => {
      const selectSong = (): void => {
        if (!this.options.canSelectSong() || this.songOptions.length === 0) return;
        this.hideRemovePrompt();
        this.selectedSongIndex = index;
        this.options.onSelectionChanged();
      };
      const startLongPress = (pointer: Phaser.Input.Pointer): void => {
        if (!this.options.canStartLongPressRemove() || this.songOptions.length === 0) return;
        this.cancelSongLongPress();
        this.songLongPressPointerId = pointer.id;
        this.songLongPressStartX = pointer.worldX;
        this.songLongPressStartY = pointer.worldY;
        this.songLongPressTimer = this.scene.time.delayedCall(this.options.longPressMs, () => {
          this.songLongPressTimer = undefined;
          if (this.songLongPressPointerId !== pointer.id || !pointer.isDown) return;
          if (
            Phaser.Math.Distance.Between(pointer.worldX, pointer.worldY, this.songLongPressStartX, this.songLongPressStartY) >
            this.options.longPressMoveTolerancePx
          ) {
            return;
          }
          this.showSongRemovePrompt(option, () => {
            this.options.onRequestRemoveSong(option.song);
          });
        });
      };
      const stopLongPress = (pointer: Phaser.Input.Pointer): void => {
        if (this.songLongPressPointerId !== pointer.id) return;
        this.cancelSongLongPress();
      };

      option.background.on('pointerdown', selectSong);
      option.thumbnail.on('pointerdown', selectSong);
      option.thumbnailImage?.on('pointerdown', selectSong);
      option.thumbLabel?.on('pointerdown', selectSong);
      option.label.on('pointerdown', selectSong);
      option.subLabel.on('pointerdown', selectSong);

      option.background.on('pointerdown', startLongPress);
      option.thumbnail.on('pointerdown', startLongPress);
      option.thumbnailImage?.on('pointerdown', startLongPress);
      option.thumbLabel?.on('pointerdown', startLongPress);
      option.label.on('pointerdown', startLongPress);
      option.subLabel.on('pointerdown', startLongPress);

      option.background.on('pointerup', stopLongPress);
      option.thumbnail.on('pointerup', stopLongPress);
      option.thumbnailImage?.on('pointerup', stopLongPress);
      option.thumbLabel?.on('pointerup', stopLongPress);
      option.label.on('pointerup', stopLongPress);
      option.subLabel.on('pointerup', stopLongPress);

      option.background.on('pointerout', stopLongPress);
      option.thumbnail.on('pointerout', stopLongPress);
      option.thumbnailImage?.on('pointerout', stopLongPress);
      option.thumbLabel?.on('pointerout', stopLongPress);
      option.label.on('pointerout', stopLongPress);
      option.subLabel.on('pointerout', stopLongPress);
    });
  }

  private cancelSongLongPress(): void {
    this.songLongPressPointerId = undefined;
    this.songLongPressTimer?.remove(false);
    this.songLongPressTimer = undefined;
  }

  private showSongRemovePrompt(option: SongOption, onRemove: () => void): void {
    this.hideRemovePrompt();

    const buttonWidth = 84;
    const buttonHeight = 28;
    const x = option.background.x + option.background.width * 0.34;
    const y = option.background.y - option.cardHeight * 0.34;
    const button = new RoundedBox(this.scene, x, y, buttonWidth, buttonHeight, 0x7f1d1d, 0.98)
      .setStrokeStyle(1, 0xfca5a5, 0.95)
      .setInteractive({ useHandCursor: true })
      .setDepth(980);
    const label = this.scene.add
      .text(x, y, 'Remove', {
        color: '#ffe4e6',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(12, Math.floor(this.scene.scale.width * 0.012))}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(981);

    const remove = (): void => {
      this.cancelSongLongPress();
      this.hideRemovePrompt();
      onRemove();
    };
    button.on('pointerdown', remove);
    label.on('pointerdown', remove);
    this.songRemovePrompt = { songId: option.song.id, button, label };
  }

  private isPointerInsideObject(pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject): boolean {
    if (!('getBounds' in object) || typeof object.getBounds !== 'function') return false;
    const bounds = object.getBounds();
    return bounds.contains(pointer.worldX, pointer.worldY);
  }

  private createSongOptions(songs: SongEntry[], width: number, height: number, labelSize: number): SongOption[] {
    const options: SongOption[] = [];
    const cols = 2;
    const gridLeft = width * 0.04;
    const gridTop = height * 0.24;
    const gridWidth = width * 0.56;
    const buttonWidth = Math.min(266, gridWidth / cols - 14);
    const buttonHeight = Math.min(122, height * 0.22);
    const gapX = Math.max(12, width * 0.014);
    const gapY = Math.max(14, height * 0.028);

    songs.forEach((song, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = gridLeft + buttonWidth / 2 + col * (buttonWidth + gapX);
      const y = gridTop + buttonHeight / 2 + row * (buttonHeight + gapY);
      const labelY = y - buttonHeight * 0.12;
      const subLabelY = y + buttonHeight * 0.2;
      const glow = new RoundedBox(this.scene, x, y, buttonWidth + 6, buttonHeight + 6, 0x60a5fa, 0.3)
        .setStrokeStyle(1, 0x93c5fd, 0.3)
        .setAlpha(0);
      const background = new RoundedBox(this.scene, x, y, buttonWidth, buttonHeight, 0x162447, 0.55)
        .setStrokeStyle(2, 0x334155, 0.45)
        .setInteractive({ useHandCursor: true });
      const thumbnailSize = buttonHeight * 0.82;
      const thumbnail = new RoundedBox(this.scene, x - buttonWidth * 0.28, y, thumbnailSize, thumbnailSize, 0x121a33, 0.85)
        .setStrokeStyle(1, 0x475569, 0.55)
        .setInteractive({ useHandCursor: true });

      const hasSongCoverTexture = this.scene.textures.exists(song.coverTextureKey);
      const hasDefaultCoverTexture = this.scene.textures.exists(DEFAULT_SONG_COVER_TEXTURE_KEY);
      const thumbnailTextureKey =
        song.usesMidiFallback || !hasSongCoverTexture
          ? hasDefaultCoverTexture
            ? DEFAULT_SONG_COVER_TEXTURE_KEY
            : song.coverTextureKey
          : song.coverTextureKey;
      const thumbnailImageSize = thumbnailSize - 2;
      const thumbnailCornerRadius = Math.max(7, Math.round(thumbnailImageSize * 0.13));
      const thumbnailImage = this.scene.add
        .image(thumbnail.x, thumbnail.y, thumbnailTextureKey)
        .setDisplaySize(thumbnailImageSize, thumbnailImageSize)
        .setInteractive({ useHandCursor: true });
      const thumbnailImageMaskGraphics = thumbnailImage
        ? this.scene.add
            .graphics({ x: thumbnail.x, y: thumbnail.y })
            .setVisible(false)
            .fillStyle(0xffffff, 1)
            .fillRoundedRect(
              -thumbnailImageSize / 2,
              -thumbnailImageSize / 2,
              thumbnailImageSize,
              thumbnailImageSize,
              thumbnailCornerRadius
            )
        : undefined;
      if (thumbnailImage && thumbnailImageMaskGraphics) {
        thumbnailImage.setMask(thumbnailImageMaskGraphics.createGeometryMask());
      }
      const thumbnailImageFrame = new RoundedBox(
        this.scene,
        thumbnail.x,
        thumbnail.y,
        thumbnailImageSize,
        thumbnailImageSize,
        0xffffff,
        0,
        thumbnailCornerRadius
      ).setStrokeStyle(3, 0xffffff, 0.76);
      const thumbLabel = undefined;

      const label = this.scene.add
        .text(x - buttonWidth * 0.02, labelY, song.name, {
          color: '#cbd5e1',
          fontFamily: 'Montserrat, sans-serif',
          fontStyle: 'bold',
          fontSize: `${Math.max(17, labelSize + 2)}px`,
          wordWrap: { width: buttonWidth * 0.38, useAdvancedWrap: true }
        })
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true });
      this.fitSongTitleText(label, buttonWidth * 0.38, buttonHeight * 0.34, Math.max(17, labelSize + 2), 11);

      const subLabel = this.scene.add
        .text(
          x - buttonWidth * 0.02,
          subLabelY,
          `${song.usesMidiFallback ? 'MIDI • ' : ''}Best: ${song.highScore}`,
          {
            color: '#64748b',
            fontFamily: 'Montserrat, sans-serif',
            fontSize: `${Math.max(12, labelSize - 2)}px`
          }
        )
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true });

      const interactiveObjects: Phaser.GameObjects.GameObject[] = [background, thumbnail, thumbnailImage, label, subLabel];

      options.push({
        song,
        label,
        subLabel,
        background,
        glow,
        thumbnail,
        thumbnailImageSize,
        thumbnailImage,
        thumbnailImageMaskGraphics,
        thumbnailImageFrame,
        thumbLabel,
        baseY: y,
        labelBaseY: labelY,
        subLabelBaseY: subLabelY,
        cardHeight: buttonHeight,
        interactiveObjects
      });
    });

    return options;
  }

  private fitSongTitleText(
    label: Phaser.GameObjects.Text,
    maxWidth: number,
    maxHeight: number,
    startFontSize: number,
    minFontSize: number
  ): void {
    const minSize = Math.max(8, Math.floor(minFontSize));
    let fontSize = Math.max(minSize, Math.floor(startFontSize));

    label.setWordWrapWidth(maxWidth, true);
    while (fontSize >= minSize) {
      label.setFontSize(fontSize);
      const bounds = label.getBounds();
      if (bounds.width <= maxWidth + 0.5 && bounds.height <= maxHeight + 0.5) {
        return;
      }
      fontSize -= 1;
    }
  }
}
