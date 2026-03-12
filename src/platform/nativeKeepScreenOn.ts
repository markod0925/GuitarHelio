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
  await enableAndroidKeepScreenOn();
}

export async function disableKeepScreenOnAfterPlayScene(): Promise<void> {
  await disableAndroidKeepScreenOn();
}

export async function enableAndroidKeepScreenOn(): Promise<void> {
  if (!isAndroidNativeRuntime()) return;
  try {
    await KeepScreenOn.enable();
  } catch (error) {
    console.warn('Failed to enable Android keep-screen-on', error);
  }
}

export async function disableAndroidKeepScreenOn(): Promise<void> {
  if (!isAndroidNativeRuntime()) return;
  try {
    await KeepScreenOn.disable();
  } catch (error) {
    console.warn('Failed to disable Android keep-screen-on', error);
  }
}
