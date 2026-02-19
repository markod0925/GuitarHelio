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

- Dipendenze Capacitor in `package.json` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`).
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
