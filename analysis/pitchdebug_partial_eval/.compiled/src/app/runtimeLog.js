import { Capacitor } from '@capacitor/core';
function resolvePlatformLabel() {
    try {
        if (Capacitor.isNativePlatform()) {
            return `native-${Capacitor.getPlatform()}`;
        }
    }
    catch {
        // Ignore Capacitor platform resolution failures and fall back to runtime heuristics.
    }
    if (typeof navigator !== 'undefined' && /\bElectron\b/i.test(navigator.userAgent)) {
        return 'electron';
    }
    return 'web';
}
function serializeDetails(details) {
    if (!details) {
        return '';
    }
    const entries = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatValue(value)}`);
    return entries.length > 0 ? ` | ${entries.join(' ')}` : '';
}
function formatValue(value) {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    if (value instanceof Error) {
        return JSON.stringify(value.message);
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return JSON.stringify(String(value));
    }
}
export function runtimeLog(scope, severity, message, details) {
    const prefix = `[GH][platform=${resolvePlatformLabel()}][scene=${scope.scene ?? 'app'}][subsystem=${scope.subsystem}][${severity}]`;
    const line = `${prefix} ${message}${serializeDetails(details)}`;
    if (severity === 'ERROR') {
        console.error(line);
        return;
    }
    if (severity === 'WARN') {
        console.warn(line);
        return;
    }
    if (severity === 'DEBUG') {
        console.debug(line);
        return;
    }
    console.info(line);
}
export function toRuntimeErrorMessage(error) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message.trim();
    }
    return String(error);
}
