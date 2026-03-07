### Refactor `SongSelectScene` in “List-Only Core” Mode

**Summary**
- Obiettivo: trasformare [SongSelectScene.ts](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/ui/SongSelectScene.ts) in una scena focalizzata solo su rendering lista, scroll e selezione.
- Vincoli confermati: architettura a controller per feature, migrazione incrementale, parity funzionale/UI totale.
- Risultato atteso: la scena non gestisce più direttamente import, tuner, settings/session, quit/back lifecycle.

**API/Interfacce (nuove interne)**
- Aggiungere un contesto condiviso `SongSelectSceneContext` con sole primitive necessarie ai controller: `scene`, `scale`, `refreshUI()`, `getSongs()/setSongs()`, `getSelectedIndex()/setSelectedIndex()`, `isSceneActive()`.
- Standardizzare i controller con interfaccia comune: `mount()`, `bindEvents()`, `refresh()`, `destroy()`.
- Nessuna modifica all’API esterna: key scena resta `SongSelectScene`, payload verso `PlayScene` invariato.

**Implementazione Incrementale**
1. Creare struttura feature in [song-select/](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/ui/song-select) e spostare helper puri (parse manifest, mime/import kind, sanitize/format) in un modulo `utils` testabile.
2. Estrarre `SongCatalogService` (manifest web/native, `resolveSongEntry`, `assetExists`, cover lazy loading).  
   `SongSelectScene` continua a usarlo per popolare e visualizzare la lista, senza logica di rete inline.
3. Estrarre `SongImportController` (overlay import, picker file, route native/server, polling job, remove song/long-press side effects).  
   La scena mantiene solo callback di refresh lista/selezione.
4. Estrarre `SongSessionController` (difficulty + settings overlay + persistenza preferenze + start session).  
   `SongSelectScene` non possiede più stato `selectedStrings/Fingers/Frets/settingsOpen`.
5. Estrarre `SongTunerController` (overlay tuner, start/stop, calibrate/reset, mic lifecycle, needle/tuned sequence).  
   `SongSelectScene` non possiede più stato/audio resources del tuner.
6. Estrarre `SongLifecycleController` in [controllers/](/mnt/c/Dati/Marco/GameDev/GuitarHelio/src/ui/song-select/controllers) (quit confirm overlay, ESC/back native, appStateChange, cleanup unificato).
7. Rifinire `SongSelectScene` come orchestratore leggero: costruzione list view, scroll/selection input, delega ai controller, refresh centrale unico.

**Test Plan**
1. Automated: `npm run lint` e `npm run test` dopo ogni step.
2. Unit test nuovi per utility estratte: manifest parsing/fallback, import mime detection, sanitize settings, path resolution.
3. Smoke manuale regressione UI:
   1. caricamento catalogo + placeholder cover
   2. scroll/drag/wheel + selezione keyboard/mouse
   3. import (success/failure/progress) e refresh lista
   4. remove song via long-press
   5. settings persistiti e validazione start
   6. tuner start/stop/calibrazione/reset
   7. quit confirm su ESC/back native e stop tuner su app inactive
   8. avvio `PlayScene` con payload invariato.

**Assunzioni e default**
- Nessun cambio prodotto/UX: solo rifattorizzazione strutturale.
- `SongSelectScene` mantiene solo responsabilità “lista canzoni” (render+scroll+select) come core.
- `GDD.md` non richiede update se resta parity; va aggiornato solo se emerge un cambiamento di comportamento/spec.
