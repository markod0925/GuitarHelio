# Guitar Helio

## Avvio rapido (PC + smartphone in LAN)

1. Installa Node.js 20+ sul computer.
2. Installa le dipendenze:
   ```bash
   npm install
   ```
3. Avvia il progetto in LAN:
   ```bash
   npm run dev:mobile
   ```
4. Apri dal telefono (stessa rete Wi-Fi) l'URL mostrato come `Network`, ad esempio:
   `http://192.168.1.10:5173`

## Android standalone (senza PC acceso come server)

Sì, è supportato: il progetto è predisposto per il packaging con **Capacitor**.

### Cosa è già preparato nel repository

- Dipendenze Capacitor in `package.json` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/filesystem`).
- Configurazione `capacitor.config.ts` con:
  - `appId: com.guitarhelio.app`
  - `appName: GuitarHelio`
  - `webDir: dist`
- Script npm dedicati per init/sync/apertura Android Studio/build APK debug.

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
