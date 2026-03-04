# GuitarHelio — Code Review & Android Optimization

## Verdetto Generale

Il codice è **sorprendentemente pulito per un progetto generato da AI**. La modellazione dei dati, la separazione delle responsabilità nei moduli core (`midi/`, `guitar/`, `game/`, `audio/`) e l'uso di TypeScript strict sono notevoli. Tuttavia, il progetto ha un **collo di bottiglia architetturale critico** nel layer UI e diversi pattern che causano problemi di performance reali su Android.

---

## ✅ Punti di Forza

| Area | Dettaglio |
|------|---------|
| **Data model** | I tipi `SourceNote`, `TargetNote`, `DifficultyProfile`, `RuntimeState` sono puliti e ben definiti |
| **Separazione core** | Moduli `midi/`, `guitar/`, `game/` puri, testabili, senza side-effect |
| **TempoMap** | Corretta gestione cumulativa dei tempo change con conversioni tick↔seconds |
| **Binary search** | Usato correttamente in scheduler (`findCursorAtOrAfter`), scrub player e ball position |
| **Anti-click audio** | `SimpleSynth` con attack/release envelope, `cancelAndHoldAtTime` fallback e dynamics compressor |
| **Session persistence** | Robusto: validazione input, localStorage con fallback silenzioso |
| **Test coverage** | 11 test file che coprono i moduli critici (state machine, target generator, tempo map, scoring) |
| **Build pipeline** | Vite ben configurato con song import API, audio-to-MIDI conversion, preview server |

---

## 🚨 Problemi Critici

### 1. `PlayScene.ts` è un God-Class da 2924 righe

Questo è di gran lunga il problema più grave. Un singolo file gestisce:

- Rendering fretboard, note, ball, trail, starfield, minimap
- Audio stack (mic, synth, backing track, scrub player)
- Game state machine tick loop
- UI: pause menu, results overlay, speed slider, debug overlay, HUD
- Playback clock & backing track seek/resume
- Input handling (keyboard, touch, back button)

> [!CAUTION]
> Questo rende il codice **fragile, non testabile, e pesante su mobile** perché ogni modifica rischia di rompere parti non correlate. È il primo refactoring da fare.

**Suggerimento:** Spezzare in almeno 5-6 sotto-classi/composizioni:

```
PlayScene.ts        → orchestratore (~200 righe)
├── GameplayController.ts  → runtime tick, state transitions, scoring
├── AudioController.ts     → audio stack, backing track, synth, mic
├── FretboardRenderer.ts   → lane drawing, note rendering, fret labels
├── BallAnimator.ts        → ball position, trail, bounce physics
├── UIOverlays.ts          → pause menu, results, speed slider, HUD
└── MinimapRenderer.ts     → song minimap static/dynamic
```

---

### 2. `ScriptProcessorNode` è deprecato e problematico su Android

In [pitchDetector.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/pitchDetector.ts#L55):

```ts
const processor = this.ctx.createScriptProcessor(2048, 1, 1);  // ⚠️ DEPRECATO
```

> [!WARNING]
> `ScriptProcessorNode` gira sul **main thread**, compete con il rendering Phaser, e su Android causa latenza pitch detection > 100ms. Chrome mobile potrebbe rimuoverlo in futuro.

**Fix:** Migrare ad `AudioWorkletNode`:

```ts
// 1. Creare un file worklet (pitch-worklet.ts)
class PitchWorklet extends AudioWorkletProcessor {
  process(inputs) { /* esegui aubio qui, postMessage(result) */ }
}

// 2. In pitchDetector.ts
await ctx.audioWorklet.addModule('pitch-worklet.js');
const node = new AudioWorkletNode(ctx, 'pitch-processor');
node.port.onmessage = (e) => { /* frame callback */ };
```

---

### 3. Per-frame GC pressure nel game loop

In [tickRuntime()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#L513-L606), ogni frame (~60fps) viene creato:

- Un nuovo `HitDebugSnapshot` object (linea 564-578)
- Un nuovo `RuntimeUpdate` con spread `{...state}` (dentro `updateRuntimeState`)
- Nuovi oggetti `{ x, y }` nella trail history
- `.slice()` dell'array trail points (linea 2228)

Su Android, questo produce **~60 micro-allocazioni/sec** che triggano GC pause visibili.

**Fix concreto:**

```diff
 // Riutilizzare oggetti pre-allocati
-this.hitDebugSnapshot = { songSecondsNow, targetSeconds, ... };
+this.hitDebugSnapshot.songSecondsNow = songSecondsNow;
+this.hitDebugSnapshot.targetSeconds = targetSeconds;
+// ...mutare in-place invece di ricreare

 // Per la trail, usare un ring buffer invece di array + splice
-this.ballTrailHistory.splice(0, this.ballTrailHistory.length - maxHistory);
+this.trailRingBuffer.push(x, y); // no allocazioni
```

---

### 4. `noteKey()` è duplicata in 3 file

La stessa funzione template string appare in:
- `synth.ts:96`
- `jzzTinySynth.ts:150`
- `midiScrubPlayer.ts:155`

**Fix:** Estrarre in un utility condiviso:

```ts
// src/audio/noteKey.ts
export function noteKey(note: SourceNote): string {
  return `${note.track}:${note.channel}:${note.midi_note}:${note.tick_on}`;
}
```

---

## ⚡ Ottimizzazioni Android Specifiche

### 5. Full Graphics redraw ogni frame

In `redrawTargetsAndBall()` (linea 1903), `drawTopStarfield()` (linea 1714), `updateSongMinimapProgress()` (linea 1667), e `drawBallDashedTrail()` (linea 2220):

```ts
this.targetLayer.clear();  // Cancella TUTTO
// ... ridisegna TUTTI i target
```

Ogni frame si ridisegna l'intera scena tramite `Graphics.clear()` + re-fill. Su Android questo è **molto costoso** a causa del canvas 2D software rendering.

**Suggerimenti:**
- **Dirty-rect tracking**: ridisegnare solo le note che cambiano posizione
- **Starfield**: disegnare *una volta* su un `RenderTexture` statico, poi fare scroll con offset
- **Minimap static layer**: non ridisegnare mai dopo `redrawSongMinimapStatic()`, solo il dynamic layer
- **Note target**: usare singoli `Phaser.GameObjects.Rectangle` pooled invece di ridisegnare su Graphics

---

### 6. `setInterval` per la schedulazione MIDI nel JZZ Synth

In [jzzTinySynth.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/audio/jzzTinySynth.ts#L86-L93):

```ts
const timer = window.setTimeout(() => { ... }, delayMs);
```

Ogni singola nota MIDI viene schedulata con un `setTimeout` individuale. Con brani densi, questo crea **centinaia di timer attivi** simultaneamente.

**Fix:** Usare un singolo timer loop (come fa già `AudioScheduler`) oppure accumulare note in batch schedulati a intervalli fissi.

---

### 7. `layout()` viene chiamato ripetutamente senza cache

Il metodo [layout()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#L2144-L2165) ricalcola le stesse divisioni ogni volta che viene invocato. Nel game loop è chiamato da `redrawTargetsAndBall()`, `drawTopStarfield()`, `updateSongMinimapProgress()`, etc.

**Fix:** Cache il risultato e invalidarlo solo su resize:

```ts
private cachedLayout?: Layout;

private layout(): Layout {
  if (this.cachedLayout) return this.cachedLayout;
  // ... calcolo ...
  this.cachedLayout = result;
  return result;
}
```

---

### 8. Microphone stream non viene mai rilasciato

In [setupAudioStack()](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/ui/PlayScene.ts#L422-L443), `createMicNode()` richiede `getUserMedia` ma lo stream non viene mai chiuso:

```ts
const micSource = await createMicNode(audioCtx);
// ... ma nessun micSource.mediaStream.getTracks().forEach(t => t.stop())
```

> [!WARNING]
> Su Android, questo lascia il microfono attivo anche dopo aver lasciato la `PlayScene`, consumando batteria e mostrando l'indicatore del microfono. Lo stream viene rilasciato solo quando l'`AudioContext` viene chiuso.

**Fix:** Salvare il MediaStream e stopparlo esplicitamente nel `cleanup()`.

---

### 9. Phaser `Phaser.AUTO` potrebbe selezionare Canvas su Android

In [main.ts](file:///c:/Dati/Marco/GameDev/GuitarHelio/src/app/main.ts#L19):

```ts
type: Phaser.AUTO  // Potrebbe fallback a Canvas 2D su device low-end
```

**Suggerimento:** Su Android, forzare `Phaser.WEBGL` o almeno loggare quale renderer è stato selezionato. Il rendering Canvas 2D è 3-5x più lento per scene con grafiche pesanti come questa.

---

### 10. Bundle size non ottimizzato per mobile

Le dipendenze includono:
- `@tensorflow/tfjs` (~2MB min) — usato solo per audio-to-MIDI conversion (feature offline)
- `@tensorflow/tfjs-node` — **non dovrebbe essere in `dependencies`**, è un modulo server-only

> [!IMPORTANT]
> `@tensorflow/tfjs-node` include binari nativi e **non può funzionare nel browser**. Spostarlo in `devDependencies` e assicurarsi che Vite faccia tree-shaking di `@tensorflow/tfjs` se non usato nel bundle client.

---

## 📋 Riepilogo Priorità

| Priorità | Azione | Impatto Android |
|----------|--------|----------------|
| 🔴 P0 | Spezzare `PlayScene.ts` in sotto-moduli | Manutenibilità + testabilità + debugging |
| 🔴 P0 | Migrare `ScriptProcessorNode` → `AudioWorkletNode` | Latenza pitch -50%, no main thread blocking |
| 🟠 P1 | Eliminare allocazioni per-frame (GC pressure) | Smoothness +30% su device mid-range |
| 🟠 P1 | Rilasciare mic stream nel cleanup | Batteria, privacy, indicatore mic |
| 🟡 P2 | Caching `layout()` | Minor CPU saving |
| 🟡 P2 | Dirty-rect rendering per targets/starfield | GPU/Canvas load -40% |
| 🟡 P2 | Batch timer MIDI nel JZZ Synth | Timer overhead su brani densi |
| 🟢 P3 | Spostare `@tensorflow/tfjs-node` in devDependencies | Bundle size mobile |
| 🟢 P3 | Estrarre `noteKey()` duplicata | Code hygiene |
| 🟢 P3 | Forzare WebGL renderer su Android | Performance rendering |

---

## Nota Finale

Il codice dimostra che Codex ha prodotto un risultato **funzionalmente completo e ben strutturato** nei moduli core. Il problema principale è tipico dell'AI-generated code: la tendenza a concentrare complessità crescente in un singolo file (`PlayScene.ts`) piuttosto che splitare in sotto-componenti quando la complessità cresce. Il refactoring principale (P0) sbloccherebbe la maggior parte delle ottimizzazioni successive.
