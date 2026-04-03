import Phaser from 'phaser';
import type {
  PitchDebugFrameSnapshot,
  PitchDetectorResult,
  ReferenceTestDetectorSummary
} from '../../pitch/types';
import { RoundedBox } from '../RoundedBox';

type ButtonSpec = {
  key: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  onClick: () => void;
};

type UpdateState = {
  logs: string[];
  modeLabel: string;
  enabledDetectors: string[];
  recording: boolean;
  freezeFrame: boolean;
  recentRawWaveform: Float32Array;
  referenceStateLabel: string;
  referenceSummaries: ReferenceTestDetectorSummary[];
  currentFrameSize: number;
  currentHopSize: number;
  currentFftSize: number;
  currentWindowType: string;
  smoothingEnabled: boolean;
  datasetStatusLabel: string;
};

export class PitchDebugUIController {
  private readonly width: number;
  private readonly height: number;
  private readonly panelGraphics: Phaser.GameObjects.Graphics;
  private readonly waveformGraphics: Phaser.GameObjects.Graphics;
  private readonly spectrumGraphics: Phaser.GameObjects.Graphics;
  private readonly spectrogramGraphics: Phaser.GameObjects.Graphics;
  private readonly buttons = new Map<string, { background: RoundedBox; label: Phaser.GameObjects.Text }>();
  private readonly statusLabel: Phaser.GameObjects.Text;
  private readonly sessionLabel: Phaser.GameObjects.Text;
  private readonly controlsLabel: Phaser.GameObjects.Text;
  private readonly detectorTableLabel: Phaser.GameObjects.Text;
  private readonly metricsLabel: Phaser.GameObjects.Text;
  private readonly logLabel: Phaser.GameObjects.Text;
  private readonly referenceLabel: Phaser.GameObjects.Text;
  private spectrogramColumns: number[][] = [];

  constructor(private readonly scene: Phaser.Scene) {
    this.width = this.scene.scale.width;
    this.height = this.scene.scale.height;
    this.panelGraphics = this.scene.add.graphics();
    this.waveformGraphics = this.scene.add.graphics();
    this.spectrumGraphics = this.scene.add.graphics();
    this.spectrogramGraphics = this.scene.add.graphics();
    this.drawPanels();
    this.statusLabel = this.createLabel(16, 12, this.width - 32, 14);
    this.controlsLabel = this.createLabel(446, 72, 556, 28, 10);
    this.sessionLabel = this.createLabel(446, 246, 556, 46, 11);
    this.detectorTableLabel = this.createLabel(446, 328, 556, 56, 10);
    this.metricsLabel = this.createLabel(446, 412, 270, 108, 10);
    this.referenceLabel = this.createLabel(724, 412, 278, 36, 10);
    this.logLabel = this.createLabel(724, 468, 278, 52, 10);
  }

  addButtons(buttons: ButtonSpec[]): void {
    for (const button of buttons) {
      const background = new RoundedBox(this.scene, button.x, button.y, button.width, button.height, 0x162447, 0.92)
        .setStrokeStyle(1, 0x60a5fa, 0.5)
        .setInteractive({ useHandCursor: true });
      const label = this.scene.add
        .text(button.x, button.y, button.label, {
          color: '#e2e8f0',
          fontFamily: 'Montserrat, sans-serif',
          fontSize: '11px',
          fontStyle: 'bold',
          align: 'center'
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      background.on('pointerdown', button.onClick);
      label.on('pointerdown', button.onClick);
      this.buttons.set(button.key, { background, label });
    }
  }

  update(snapshot: PitchDebugFrameSnapshot | null, state: UpdateState): void {
    this.controlsLabel.setText([
      `mode ${state.modeLabel} | frame ${state.currentFrameSize} hop ${state.currentHopSize} fft ${state.currentFftSize} | window ${state.currentWindowType} | smooth ${state.smoothingEnabled ? 'on' : 'off'}`,
      `detectors ${state.enabledDetectors.join(', ') || 'none'} | recording ${state.recording ? 'on' : 'off'} | freeze ${state.freezeFrame ? 'on' : 'off'}`
    ].join('  \n'));

    if (!snapshot) {
      this.statusLabel.setText('PitchDebugScene | waiting for audio...');
      this.sessionLabel.setText('No active audio session.');
      this.detectorTableLabel.setText('Detector results will appear here.');
      this.metricsLabel.setText('Signal metrics will appear here.');
      this.referenceLabel.setText(state.referenceStateLabel);
      this.logLabel.setText(state.logs.join('\n'));
      return;
    }

    const metadata = snapshot.captureMetadata;
    this.statusLabel.setText([
      `PitchDebugScene | ${metadata.androidInfo ?? metadata.deviceLabel ?? metadata.inputSource} | mode ${state.modeLabel} | requested ${formatNumber(metadata.requestedSampleRate)} Hz | actual ${formatNumber(metadata.actualSampleRate)} Hz | callback ${metadata.callbackBufferSize}`,
      `analysis ${snapshot.analysisTimeMs.toFixed(2)} ms | overload ${snapshot.overload ? 'YES' : 'no'} | dropped ${metadata.droppedBuffers} | rec ${state.recording ? 'on' : 'off'} | freeze ${state.freezeFrame ? 'on' : 'off'}`
    ].join('\n'));

    this.sessionLabel.setText([
      `source ${metadata.inputSource} | preset ${metadata.capturePreset}`,
      `unprocessed req ${metadata.unprocessedRequested ? 'yes' : 'no'} | low latency ${metadata.lowLatencyRequested ? 'req' : 'off'} | channels ${metadata.channels}`,
      `callback ${metadata.callbackIntervalMs.toFixed(1)} ms avg ${metadata.callbackIntervalAvgMs.toFixed(1)} max ${metadata.callbackIntervalMaxMs.toFixed(1)} | dropped ${metadata.droppedBuffers}`,
      `raw rms ${snapshot.rawMetrics.rmsDbfs.toFixed(1)} dBFS | raw peak ${snapshot.rawMetrics.peakDbfs.toFixed(1)} dBFS | raw dc ${snapshot.rawMetrics.dcOffset.toFixed(4)}`
    ].join('\n'));

    this.detectorTableLabel.setText(this.formatDetectorTable(snapshot.detectorResults));
    this.metricsLabel.setText(this.formatMetrics(snapshot));
    this.referenceLabel.setText([
      state.referenceStateLabel,
      ...state.referenceSummaries.slice(0, 3).map((summary) =>
        `${summary.detectorName}: acc ${toPct(summary.acceptanceRate)} ok ${toPct(summary.correctNoteRate)} med ${summary.medianCentsError === null ? '-' : summary.medianCentsError.toFixed(1)}c`
      )
    ].join('\n'));
    this.logLabel.setText(state.logs.slice(-7).join('\n'));

    this.drawWaveform(snapshot.frameContext.rawFrame, state.recentRawWaveform);
    this.drawSpectrum(snapshot);
    this.drawSpectrogram(snapshot.features.magnitudeSpectrum);
  }

  setButtonActive(key: string, active: boolean, emphasized = false): void {
    const entry = this.buttons.get(key);
    if (!entry) return;
    entry.background.setFillStyle(active ? (emphasized ? 0x7c2d12 : 0x1d4ed8) : 0x162447, active ? 1 : 0.92);
    entry.background.setStrokeStyle(1, active ? (emphasized ? 0xfdba74 : 0x93c5fd) : 0x475569, 0.72);
    entry.label.setColor(active ? '#fff7ed' : '#e2e8f0');
  }

  setButtonVisible(key: string, visible: boolean): void {
    const entry = this.buttons.get(key);
    if (!entry) return;
    entry.background.setVisible(visible);
    entry.label.setVisible(visible);
    if (!visible) {
      entry.background.disableInteractive();
      entry.label.disableInteractive();
      return;
    }
    entry.background.setInteractive({ useHandCursor: true });
    entry.label.setInteractive({ useHandCursor: true });
  }

  destroy(): void {
    this.panelGraphics.destroy();
    this.waveformGraphics.destroy();
    this.spectrumGraphics.destroy();
    this.spectrogramGraphics.destroy();
    this.statusLabel.destroy();
    this.sessionLabel.destroy();
    this.controlsLabel.destroy();
    this.detectorTableLabel.destroy();
    this.metricsLabel.destroy();
    this.logLabel.destroy();
    this.referenceLabel.destroy();
    for (const entry of this.buttons.values()) {
      entry.background.destroy();
      entry.label.destroy();
    }
    this.buttons.clear();
  }

  private createLabel(x: number, y: number, width: number, _height: number, fontSize = 12): Phaser.GameObjects.Text {
    return this.scene.add
      .text(x, y, '', {
        color: '#dbeafe',
        fontFamily: 'monospace',
        fontSize: `${fontSize}px`,
        wordWrap: { width, useAdvancedWrap: true }
      })
      .setOrigin(0, 0)
      .setDepth(50);
  }

  private drawPanels(): void {
    const g = this.panelGraphics;
    g.fillStyle(0x050d22, 1);
    g.fillRect(0, 0, this.width, this.height);
    drawPanel(g, 8, 8, this.width - 16, 36, 0x0b1228);
    drawPanel(g, 8, 50, 426, 128, 0x0b1228);
    drawPanel(g, 8, 184, 426, 118, 0x0b1228);
    drawPanel(g, 8, 308, 426, 212, 0x0b1228);
    drawPanel(g, 440, 50, 576, 170, 0x0b1228);
    drawPanel(g, 440, 226, 576, 76, 0x0b1228);
    drawPanel(g, 440, 308, 576, 80, 0x0b1228);
    drawPanel(g, 440, 390, 278, 130, 0x0b1228);
    drawPanel(g, 722, 390, 294, 58, 0x0b1228);
    drawPanel(g, 722, 450, 294, 70, 0x0b1228);
    addPanelTitle(this.scene, 16, 54, 'Waveform');
    addPanelTitle(this.scene, 16, 188, 'Spectrum');
    addPanelTitle(this.scene, 16, 312, 'Spectrogram');
    addPanelTitle(this.scene, 446, 54, 'Controls');
    addPanelTitle(this.scene, 446, 230, 'Audio Session');
    addPanelTitle(this.scene, 446, 312, 'Detector Comparison');
    addPanelTitle(this.scene, 446, 394, 'Signal Metrics');
    addPanelTitle(this.scene, 728, 394, 'Reference');
    addPanelTitle(this.scene, 728, 454, 'Event Log');
  }

  private drawWaveform(currentFrame: Float32Array, recentWaveform: Float32Array): void {
    const g = this.waveformGraphics;
    g.clear();
    drawPolyline(g, currentFrame, 18, 76, 406, 42, 0x38bdf8, 1.3);
    drawPolyline(g, recentWaveform, 18, 128, 406, 36, 0xf59e0b, 1);
  }

  private drawSpectrum(snapshot: PitchDebugFrameSnapshot): void {
    const g = this.spectrumGraphics;
    g.clear();
    const spectrum = snapshot.features.magnitudeSpectrum;
    if (spectrum.length <= 0) return;
    const width = 406;
    const height = 74;
    const baseX = 18;
    const baseY = 220;
    let max = 0;
    for (let i = 0; i < spectrum.length; i += 1) {
      max = Math.max(max, spectrum[i]);
    }
    const safeMax = max > 0 ? max : 1;
    g.lineStyle(1.2, 0x22d3ee, 0.95);
    g.beginPath();
    for (let i = 0; i < spectrum.length; i += 1) {
      const x = baseX + (i / Math.max(1, spectrum.length - 1)) * width;
      const y = baseY + height - (spectrum[i] / safeMax) * height;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokePath();

    const overlayFrequencies = [
      snapshot.features.referenceNote?.frequencyHz,
      snapshot.features.referenceNote ? snapshot.features.referenceNote.frequencyHz * 2 : undefined,
      snapshot.features.referenceNote ? snapshot.features.referenceNote.frequencyHz * 3 : undefined,
      snapshot.features.referenceNote ? snapshot.features.referenceNote.frequencyHz * 4 : undefined,
      82.4069,
      164.8138,
      247.2207
    ].filter((value): value is number => Number.isFinite(value));

    g.lineStyle(1, 0xfacc15, 0.35);
    for (const frequencyHz of overlayFrequencies) {
      const normalized = Math.min(1, frequencyHz / 3200);
      const x = baseX + normalized * width;
      g.beginPath();
      g.moveTo(x, baseY);
      g.lineTo(x, baseY + height);
      g.strokePath();
    }

    const bandMetrics = snapshot.features.metrics;
    const bars = [
      bandMetrics.bandEnergy_60_100,
      bandMetrics.bandEnergy_100_200,
      bandMetrics.bandEnergy_200_400,
      bandMetrics.bandEnergy_400_800,
      bandMetrics.bandEnergy_800_1600,
      bandMetrics.bandEnergy_1600_3200
    ];
    const barMax = Math.max(1, ...bars);
    for (let i = 0; i < bars.length; i += 1) {
      const barHeight = (bars[i] / barMax) * 26;
      g.fillStyle(0x60a5fa, 0.72);
      g.fillRect(baseX + i * 65, 268 - barHeight, 40, barHeight);
    }
  }

  private drawSpectrogram(magnitudeSpectrum: Float32Array): void {
    const binsToRender = 56;
    const bucket = Math.max(1, Math.floor(magnitudeSpectrum.length / binsToRender));
    const column: number[] = [];
    let localMax = 0;
    for (let i = 0; i < binsToRender; i += 1) {
      let energy = 0;
      const start = i * bucket;
      const end = Math.min(magnitudeSpectrum.length, start + bucket);
      for (let j = start; j < end; j += 1) {
        energy += magnitudeSpectrum[j];
      }
      localMax = Math.max(localMax, energy);
      column.push(energy);
    }
    const safeMax = localMax > 0 ? localMax : 1;
    this.spectrogramColumns.push(column.map((value) => value / safeMax));
    if (this.spectrogramColumns.length > 110) {
      this.spectrogramColumns.shift();
    }

    const g = this.spectrogramGraphics;
    g.clear();
    const originX = 18;
    const originY = 336;
    const width = 406;
    const height = 176;
    const columnWidth = width / Math.max(1, this.spectrogramColumns.length);
    const rowHeight = height / binsToRender;
    for (let x = 0; x < this.spectrogramColumns.length; x += 1) {
      const spectrogramColumn = this.spectrogramColumns[x];
      for (let y = 0; y < spectrogramColumn.length; y += 1) {
        const intensity = spectrogramColumn[y];
        const color = Phaser.Display.Color.GetColor(
          Math.round(20 + intensity * 90),
          Math.round(40 + intensity * 180),
          Math.round(80 + intensity * 140)
        );
        g.fillStyle(color, Math.max(0.12, intensity));
        g.fillRect(originX + x * columnWidth, originY + height - (y + 1) * rowHeight, columnWidth + 1, rowHeight + 1);
      }
    }
  }

  private formatDetectorTable(results: PitchDetectorResult[]): string {
    const lines = ['name acc note cents conf str fret reason/debug'];
    for (const result of results) {
      lines.push([
        pad(result.detectorName, 8),
        pad(result.accepted ? 'Y' : 'N', 3),
        pad(result.noteName ?? '-', 5),
        pad(result.cents === undefined ? '-' : result.cents.toFixed(1), 7),
        pad(result.confidence === undefined ? '-' : result.confidence.toFixed(2), 6),
        pad(result.stringId === null || result.stringId === undefined ? '-' : `${result.stringId}`, 4),
        pad(result.fret === null || result.fret === undefined ? '-' : `${result.fret}`, 4),
        result.accepted
          ? formatDebugSummary(result)
          : (result.rejectReason ?? 'rejected')
      ].join(' '));
    }
    return lines.join('\n');
  }

  private formatMetrics(snapshot: PitchDebugFrameSnapshot): string {
    const metrics = snapshot.features.metrics;
    return [
      `rms ${metrics.rmsDbfs.toFixed(1)} dBFS | peak ${metrics.peakDbfs.toFixed(1)} | crest ${metrics.crestFactor.toFixed(2)} | snr ${metrics.estimatedSnrDb.toFixed(1)} dB`,
      `noise ${metrics.estimatedNoiseFloorDb.toFixed(1)} dB | zcr ${metrics.zcr.toFixed(3)} | clip ${(metrics.clippingRatio * 100).toFixed(2)}% | gate ${snapshot.features.metrics.rms > 0.0025 ? 'open' : 'quiet'}`,
      `centroid ${metrics.spectralCentroidHz.toFixed(1)} Hz | rolloff ${metrics.spectralRolloffHz.toFixed(1)} Hz | flatness ${metrics.spectralFlatness.toFixed(3)}`,
      `low-band ratio ${metrics.lowBandEnergyRatio.toFixed(3)} | E2 ${formatMetric(metrics.energyNearE2)} | H2 ${formatMetric(metrics.energyNearE2Harmonic2)} | H3 ${formatMetric(metrics.energyNearE2Harmonic3)}`,
      `autocorr lag ${metrics.autocorrelationBestLag ?? 0} | peak ${formatMetric(metrics.autocorrelationBestPeak)} | onset ${formatMetric(metrics.onsetStrength)}`
    ].join('\n');
  }
}

function drawPanel(graphics: Phaser.GameObjects.Graphics, x: number, y: number, width: number, height: number, fillColor: number): void {
  graphics.fillStyle(fillColor, 0.95);
  graphics.fillRoundedRect(x, y, width, height, 12);
  graphics.lineStyle(1, 0x334155, 0.88);
  graphics.strokeRoundedRect(x, y, width, height, 12);
}

function addPanelTitle(scene: Phaser.Scene, x: number, y: number, label: string): void {
  scene.add.text(x, y, label, {
    color: '#93c5fd',
    fontFamily: 'Montserrat, sans-serif',
    fontSize: '12px',
    fontStyle: 'bold'
  });
}

function drawPolyline(
  graphics: Phaser.GameObjects.Graphics,
  samples: Float32Array,
  x: number,
  y: number,
  width: number,
  amplitudeHeight: number,
  color: number,
  lineWidth: number
): void {
  if (samples.length <= 0) return;
  graphics.lineStyle(lineWidth, color, 0.95);
  graphics.beginPath();
  const centerY = y + amplitudeHeight / 2;
  for (let i = 0; i < samples.length; i += 1) {
    const px = x + (i / Math.max(1, samples.length - 1)) * width;
    const py = centerY - samples[i] * (amplitudeHeight * 0.48);
    if (i === 0) graphics.moveTo(px, py);
    else graphics.lineTo(px, py);
  }
  graphics.strokePath();
}

function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : `${Math.round(value)}`;
}

function toPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDebugSummary(result: PitchDetectorResult): string {
  const debug = result.debug ?? {};
  if (result.detectorName === 'MASP') {
    return `best=${formatMetric(debug.bestScore)} margin=${formatMetric(debug.scoreMargin)} ${String(debug.validationReason ?? '')}`;
  }
  if (result.detectorName === 'ac14') {
    return `hz=${formatMetric(debug.rawCandidateHz)} conf=${formatMetric(debug.periodicity)}`;
  }
  return `best=${formatMetric(debug.bestSpectralScore ?? debug.bestScore)} margin=${formatMetric(debug.scoreMargin)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : `${value}${' '.repeat(width - value.length)}`;
}

function formatMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '-';
}
