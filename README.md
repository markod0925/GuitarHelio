# Guitar Helio

## Avvio rapido (PC + smartphone in LAN)

1. Installa Node.js 20+ sul computer.
2. Installa le dipendenze:
   ```bash
   npm install
   ```
3. Compila i converter C++/ONNX (NeuralNote + Tempo-CNN):
   ```bash
   npm run build:nn:cli
   npm run build:tempo:cli
   ```
4. Avvia il progetto in LAN:
   ```bash
   npm run dev:mobile
   ```
5. Apri dal telefono (stessa rete Wi-Fi) l'URL mostrato come `Network`, ad esempio:
   `http://192.168.1.10:5173`

## Convertitore Audio -> MIDI (NeuralNote + Tempo-CNN C++/ONNX)

Il progetto usa una pipeline C++/ONNX vendorizzata in:

- `third_party/neuralnote_core` (trascrizione note)
- `third_party/tempocnn_core` (stima tempo via ONNX)
- `third_party/tempo_cnn/tempocnn/models/fcn.onnx` (modello Tempo-CNN)
- `third_party/onnxruntime/<platform>/lib` (runtime ONNX condiviso)

Il wrapper Node usato da Vite API è in:

- `tools/audio-midi-converter/src/neuralnote.mjs`

Compatibilità mode:
- `legacy` e `neuralnote` sono alias dello stesso backend C++/ONNX
- `ab` è disabilitato (errore esplicito lato server/native)

Il preset attivo è `balanced`.

## Android standalone (senza PC acceso come server)

Sì, è supportato: il progetto è predisposto per il packaging con **Capacitor**.

### Cosa è già preparato nel repository

- Dipendenze Capacitor in `package.json` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/filesystem`).
- Configurazione `capacitor.config.ts` con:
  - `appId: com.guitarhelio.app`
  - `appName: GuitarHelio`
  - `webDir: dist`
- Script npm dedicati per init/sync/apertura Android Studio/build APK debug.
- Plugin Capacitor `NeuralNoteConverter` (Java + JNI C++) per import audio native con NeuralNote + Tempo-CNN.
- Model files NeuralNote inclusi negli asset Android (`android/app/src/main/assets/neuralnote-model/`).
- Modello Tempo-CNN incluso negli asset Android (`android/app/src/main/assets/tempo-model/fcn.onnx`).

### Setup completo (prima volta)

1. Installa dipendenze:
   ```bash
   npm install
   ```
2. Build web:
   ```bash
   npm run build
   ```
3. Aggiungi la piattaforma Android:
   ```bash
   npm run cap:add:android
   ```
4. Sincronizza asset web dentro il progetto Android:
   ```bash
   npm run cap:sync
   ```
5. Apri Android Studio:
   ```bash
   npm run cap:open:android
   ```

Nota: il build Android richiede toolchain NDK/CMake installata in Android Studio per compilare il bridge JNI del convertitore.

### Build APK debug da terminale

```bash
npm run android:apk:debug
```

APK atteso in:
`android/app/build/outputs/apk/debug/app-debug.apk`

### Permesso microfono (importante)

L'app usa il microfono, quindi in Android devi avere il permesso `RECORD_AUDIO` in:
`android/app/src/main/AndroidManifest.xml`

Snippet atteso:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

Inoltre il permesso va richiesto a runtime (Capacitor/Android) prima di iniziare il rilevamento pitch.

## QA

- Checklist di conformità implementativa al GDD: `IMPLEMENTATION_QA_CHECKLIST.md`
- Suite test manuali runtime (Desktop + Android): `MANUAL_QA_RUNTIME_SUITE.md`

### Smoke test rapido conversione Audio -> MIDI (Server + Android)

Prerequisiti minimi:
- `Node.js 20+`
- toolchain C++ locale (`cmake`, `g++`, `make`) per i CLI NeuralNote/Tempo-CNN
- Android SDK/NDK installati (per build APK)
- JDK 21 attivo per Gradle/Capacitor Android

Checklist server (Node wrapper + CLI C++/ONNX):
1. Build dei converter C++:
   ```bash
   npm run build:nn:cli
   npm run build:tempo:cli
   ```
2. Verifica binari:
   ```bash
   ls -la third_party/neuralnote_core/bin/nn_transcriber_cli
   ls -la third_party/tempocnn_core/bin/tempo_cnn_cli
   ```
3. Conversione rapida di un file audio:
   ```bash
   node tools/audio-midi-converter/bin/convert-audio-to-midi.mjs --input /percorso/audio.wav --output /tmp/smoke.mid
   ```
4. Esito atteso:
   - output con progress fino a `Conversion complete`
   - file `/tmp/smoke.mid` creato e non vuoto
   - metadata tempo presenti nel MIDI (tempo base + tempo-map quando disponibile)

Checklist Android nativo (Capacitor plugin + JNI):
1. Build web + sync:
   ```bash
   npm run build
   npm run cap:sync
   ```
2. Build APK debug:
   ```bash
   npm run android:apk:debug
   ```
3. Esito atteso:
   - `BUILD SUCCESSFUL`
   - APK presente in `android/app/build/outputs/apk/debug/app-debug.apk`
4. Smoke funzionale su device/emulatore:
   - apri app, vai su `Import MP3/OGG`
   - importa un audio breve (5-15s)
   - verifica avanzamento fino a `Conversion complete`
   - verifica presenza nuova song con `song.mid` utilizzabile in gameplay

## Catalogo canzoni (`public/songs`)

Ogni canzone vive in una cartella dedicata sotto `public/songs/<song-id>/`.

Struttura dati nel manifest (`public/songs/manifest.json`):

```json
{
  "songs": [
    {
      "id": "example",
      "name": "Example Song",
      "folder": "example",
      "cover": "cover.svg",
      "midi": "song.mid",
      "audio": "song.mp3"
    }
  ]
}
```

Regole fallback:
- Se manca/è invalido `midi`: la canzone non viene mostrata nella schermata iniziale.
- Se manca/è invalido `cover`: viene usato `public/ui/song-cover-default.svg`.
- Se manca/è invalido `audio`: viene usato il file MIDI come riferimento audio.
- In gameplay: se `audio` punta a un WAV/MP3/OGG valido viene usato come backing track; altrimenti viene usato il playback MIDI.

## Import audio da Start Screen

Nella schermata iniziale è disponibile il pulsante `Import MP3/OGG`.

Flusso:
- selezioni un file `.mp3` o `.ogg`
- viene creata una cartella canzone con il nome del file (senza estensione)
- l'audio originale viene salvato come `song.mp3` oppure `song.ogg`
- parte la conversione audio → MIDI con barra di avanzamento
- il file MIDI generato viene salvato come `song.mid`
- se nei metadata audio è presente un'immagine embedded, viene estratta e salvata come `cover.*`
- il catalogo canzoni viene aggiornato e la lista in Start Screen si ricarica automaticamente

Persistenza per piattaforma:
- Web/Vite dev/preview: file e manifest vengono scritti in `public/songs/` (`public/songs/manifest.json`).
- Android standalone (Capacitor): file e manifest vengono salvati nello storage app (`Directory.Data/songs/manifest.json`) tramite `@capacitor/filesystem`.

Debug import source:
- In build debug/dev è visibile il selettore `Import Source` (`Auto`, `Server`, `Native`) sotto il pulsante import.
- `Auto` usa il percorso corretto in base alla piattaforma (server su web, native su Capacitor).
