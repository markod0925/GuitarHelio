import { Capacitor, registerPlugin } from '@capacitor/core';

type KeepScreenOnPlugin = {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
};

const KeepScreenOn = registerPlugin<KeepScreenOnPlugin>('KeepScreenOn');

function isAndroidNativeRuntime(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function enableKeepScreenOnDuringPlayScene(): Promise<void> {
  if (!isAndroidNativeRuntime()) return;
  try {
    await KeepScreenOn.enable();
  } catch (error) {
    console.warn('Failed to enable Android keep-screen-on for PlayScene', error);
  }
}

export async function disableKeepScreenOnAfterPlayScene(): Promise<void> {
  if (!isAndroidNativeRuntime()) return;
  try {
    await KeepScreenOn.disable();
  } catch (error) {
    console.warn('Failed to disable Android keep-screen-on after PlayScene', error);
  }
}
