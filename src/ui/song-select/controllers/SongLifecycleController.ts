import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { RoundedBox } from '../../RoundedBox';
import type { QuitConfirmOverlay } from '../types';
import { requestQuitApplication } from '../utils/songSelectUtils';

type SongLifecycleControllerOptions = {
  canOpenQuitPrompt: () => boolean;
  onBeforeOpenQuitPrompt: () => void;
  onAppInactive: () => void;
  onStateChanged: () => void;
};

export class SongLifecycleController {
  private quitConfirmOverlay?: QuitConfirmOverlay;
  private nativeBackButtonListener?: { remove: () => Promise<void> };
  private nativeAppStateListener?: { remove: () => Promise<void> };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly options: SongLifecycleControllerOptions
  ) {}

  initialize(width: number, height: number, labelSize: number): void {
    this.quitConfirmOverlay = this.createQuitConfirmOverlay(width, height, labelSize);
    this.bindQuitConfirmOverlayEvents();
    this.bindNativeHandlers();
  }

  isQuitConfirmOpen(): boolean {
    return this.quitConfirmOverlay?.container.visible === true;
  }

  requestQuitConfirm(): void {
    if (!this.options.canOpenQuitPrompt()) return;
    if (this.isQuitConfirmOpen()) {
      this.closeQuitConfirm();
      this.options.onStateChanged();
      return;
    }
    this.openQuitConfirm();
  }

  destroy(): void {
    if (this.nativeBackButtonListener) {
      void this.nativeBackButtonListener.remove();
      this.nativeBackButtonListener = undefined;
    }
    if (this.nativeAppStateListener) {
      void this.nativeAppStateListener.remove();
      this.nativeAppStateListener = undefined;
    }
    this.quitConfirmOverlay?.container.destroy(true);
    this.quitConfirmOverlay = undefined;
  }

  private openQuitConfirm(): void {
    if (!this.options.canOpenQuitPrompt()) return;
    if (!this.quitConfirmOverlay) return;
    this.options.onBeforeOpenQuitPrompt();
    this.quitConfirmOverlay.container.setVisible(true);
    this.options.onStateChanged();
  }

  private closeQuitConfirm(): void {
    if (!this.quitConfirmOverlay) return;
    this.quitConfirmOverlay.container.setVisible(false);
  }

  private async quitApplication(): Promise<void> {
    const quitTriggered = await requestQuitApplication();
    if (quitTriggered) return;
    this.closeQuitConfirm();
    this.options.onStateChanged();
  }

  private bindQuitConfirmOverlayEvents(): void {
    this.quitConfirmOverlay?.cancelButton.on('pointerdown', () => {
      this.closeQuitConfirm();
      this.options.onStateChanged();
    });
    this.quitConfirmOverlay?.cancelLabel.on('pointerdown', () => {
      this.closeQuitConfirm();
      this.options.onStateChanged();
    });
    this.quitConfirmOverlay?.quitButton.on('pointerdown', () => {
      void this.quitApplication();
    });
    this.quitConfirmOverlay?.quitLabel.on('pointerdown', () => {
      void this.quitApplication();
    });
    this.quitConfirmOverlay?.backdrop.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
        this.closeQuitConfirm();
        this.options.onStateChanged();
      }
    );
    this.quitConfirmOverlay?.panel.on(
      'pointerdown',
      (
        _pointer: Phaser.Input.Pointer,
        _localX: number,
        _localY: number,
        event: Phaser.Types.Input.EventData
      ) => {
        event.stopPropagation();
      }
    );
  }

  private bindNativeHandlers(): void {
    if (!Capacitor.isNativePlatform()) return;

    void import('@capacitor/app')
      .then(async ({ App }) => {
        const backListener = await App.addListener('backButton', () => {
          if (!this.scene.scene.isActive()) return;
          if (!this.options.canOpenQuitPrompt()) return;
          this.requestQuitConfirm();
        });
        const appStateListener = await App.addListener('appStateChange', ({ isActive }) => {
          if (!this.scene.scene.isActive()) return;
          if (isActive) return;
          this.options.onAppInactive();
        });
        this.nativeBackButtonListener = backListener;
        this.nativeAppStateListener = appStateListener;
      })
      .catch((error) => {
        console.warn('Failed to register native app handlers in SongSelectScene', error);
      });
  }

  private createQuitConfirmOverlay(width: number, height: number, labelSize: number): QuitConfirmOverlay {
    const backdrop = new RoundedBox(this.scene, width / 2, height / 2, width, height, 0x020617, 0.82, 0)
      .setInteractive({ useHandCursor: true });

    const panelWidth = Math.min(520, width * 0.62);
    const panelHeight = Math.min(260, height * 0.45);
    const panelX = width / 2;
    const panelY = height / 2;

    const panel = new RoundedBox(this.scene, panelX, panelY, panelWidth, panelHeight, 0x101c3c, 0.96)
      .setStrokeStyle(2, 0x3b82f6, 0.45)
      .setInteractive({ useHandCursor: true });

    const title = this.scene.add
      .text(panelX, panelY - panelHeight * 0.27, 'Quit Application?', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(20, labelSize + 5)}px`
      })
      .setOrigin(0.5);

    const message = this.scene.add
      .text(panelX, panelY - panelHeight * 0.08, 'Do you want to close the application?', {
        color: '#cbd5e1',
        fontFamily: 'Montserrat, sans-serif',
        align: 'center',
        fontSize: `${Math.max(14, labelSize - 1)}px`
      })
      .setOrigin(0.5);

    const buttonY = panelY + panelHeight * 0.24;
    const buttonWidth = Math.min(170, panelWidth * 0.36);
    const buttonHeight = 50;

    const cancelButton = new RoundedBox(this.scene, panelX - panelWidth * 0.2, buttonY, buttonWidth, buttonHeight, 0x1e293b, 1)
      .setStrokeStyle(2, 0x64748b, 0.85)
      .setInteractive({ useHandCursor: true });
    const cancelLabel = this.scene.add
      .text(cancelButton.x, cancelButton.y, 'Cancel', {
        color: '#e2e8f0',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const quitButton = new RoundedBox(this.scene, panelX + panelWidth * 0.2, buttonY, buttonWidth, buttonHeight, 0xef4444, 1)
      .setStrokeStyle(2, 0xfca5a5, 0.85)
      .setInteractive({ useHandCursor: true });
    const quitLabel = this.scene.add
      .text(quitButton.x, quitButton.y, 'Quit', {
        color: '#fff1f2',
        fontFamily: 'Montserrat, sans-serif',
        fontStyle: 'bold',
        fontSize: `${Math.max(16, labelSize + 1)}px`
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    const container = this.scene.add
      .container(0, 0, [backdrop, panel, title, message, cancelButton, cancelLabel, quitButton, quitLabel])
      .setDepth(1400)
      .setVisible(false);

    return {
      container,
      backdrop,
      panel,
      cancelButton,
      cancelLabel,
      quitButton,
      quitLabel
    };
  }
}
