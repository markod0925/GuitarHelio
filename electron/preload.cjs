const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guitarHelioNativePitch', {
  startCapture: (options) => ipcRenderer.invoke('native-pitch:start-capture', options ?? {}),
  stopCapture: () => ipcRenderer.invoke('native-pitch:stop-capture'),
  getDiagnostics: () => ipcRenderer.invoke('native-pitch:get-diagnostics'),
  runSanityTest: (options) => ipcRenderer.invoke('native-pitch:run-sanity-test', options ?? {}),
  updateGameplayContext: (context) => ipcRenderer.invoke('native-pitch:update-gameplay-context', context ?? null),
  pollDetections: (options) => ipcRenderer.invoke('native-pitch:poll-detections', options ?? {}),
  resetDetector: () => ipcRenderer.invoke('native-pitch:reset-detector')
});
