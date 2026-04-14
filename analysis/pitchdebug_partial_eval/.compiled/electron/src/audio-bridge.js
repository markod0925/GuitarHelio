export function isElectronRuntime() {
    if (typeof navigator === 'undefined')
        return false;
    return /electron/i.test(navigator.userAgent);
}
export function getElectronNativePitchBridge() {
    if (typeof window === 'undefined') {
        return null;
    }
    return window.guitarHelioNativePitch ?? null;
}
export function hasElectronNativePitchBridge() {
    return getElectronNativePitchBridge() !== null;
}
export function requireElectronNativePitchBridge() {
    const bridge = getElectronNativePitchBridge();
    if (!bridge) {
        throw new Error('Electron native pitch bridge unavailable in renderer preload context.');
    }
    return bridge;
}
