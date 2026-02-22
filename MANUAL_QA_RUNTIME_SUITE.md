# GuitarHelio - Manual Runtime QA Suite

Scope: validazione manuale end-to-end di gameplay, audio, mic, scoring e packaging Android.

Related docs:
- `GDD.md`
- `IMPLEMENTATION_QA_CHECKLIST.md`

## 1. Prerequisiti

- Node.js 20+
- Dipendenze installate: `npm install`
- Build locale valida: `npm run build`
- Almeno un dispositivo desktop con Chrome/Edge recente
- Almeno un dispositivo Android (per sezione Android)
- Strumento per produrre note (chitarra reale, tastiera, app generatore tono)

## 2. Regole risultato

- `PASS`: comportamento coerente con expected result
- `FAIL`: comportamento divergente, bug riproducibile
- `BLOCKED`: test non eseguibile per mancanza prerequisiti

## 3. Setup rapido ambiente test

### Desktop/LAN

1. Avvia:
   ```bash
   npm run dev:mobile
   ```
2. Apri URL locale su browser desktop.
3. Verifica che `public/songs/example.mid` sia disponibile in song select.

### Android debug

1. Build + sync:
   ```bash
   npm run build
   npm run cap:sync
   ```
2. Build APK:
   ```bash
   npm run android:apk:debug
   ```
3. Installa `android/app/build/outputs/apk/debug/app-debug.apk`.

## 4. Test cases Desktop

### DSK-01 - Boot e Song Select

- Obiettivo: verificare avvio scene e selezione song/difficulty.
- Passi:
  1. Apri l'app.
  2. Verifica presenza schermata Song Select.
  3. Cambia song con click o frecce sinistra/destra.
  4. Cambia difficulty con click o frecce su/giu.
  5. Premi `Start Session`.
- Expected:
  - La scena `PlayScene` parte.
  - Song e difficulty selezionate vengono applicate.

### DSK-02 - Audio sincronizzato col gating

- Obiettivo: confermare sincronizzazione playhead/audio durante il gating.
- Passi:
  1. Avvia una sessione.
  2. Non suonare alcuna nota quando arriva il primo target.
  3. Osserva playhead/target e ascolta audio.
- Expected:
  - Visuale si ferma in `WaitingForHit` sul target.
  - L'audio si ferma insieme al playhead.
  - Dopo hit valida (o timeout), audio e playhead ripartono allineati.

### DSK-03 - Progressione su hit valida

- Obiettivo: validare transizione `WaitingForHit -> Playing`.
- Passi:
  1. Durante `WaitingForHit`, suona una nota corretta (entro tolleranza difficulty).
  2. Mantienila brevemente (>= hold time).
- Expected:
  - Target viene validato.
  - Sessione riprende avanzamento.
  - HUD mostra feedback (`Perfect/Great/OK`) e incremento score.

### DSK-04 - Nessuna progressione su hit invalida

- Obiettivo: evitare falsi positivi.
- Passi:
  1. Arriva in `WaitingForHit`.
  2. Suona nota sbagliata o rumore non intonato.
- Expected:
  - Nessuna progressione al target successivo.
  - Lo stato resta in attesa finche non arriva nota valida (o timeout se configurato).

### DSK-05 - Timeout miss (fallback senza mic)

- Obiettivo: verificare gestione timeout opzionale.
- Passi:
  1. Blocca permesso microfono per il sito.
  2. Ricarica e avvia sessione.
  3. Attendi il primo target in waiting.
- Expected:
  - Messaggio mic non disponibile.
  - Dopo timeout fallback, target marcato `Miss`.
  - Avanzamento riprende automaticamente.

### DSK-06 - Scoring e streak

- Obiettivo: validare accumulo score e streak reset.
- Passi:
  1. Esegui almeno 3 target validi consecutivi.
  2. Forza almeno un `Miss` (timeout o hit errata prolungata).
- Expected:
  - Score totale cresce sui target validi.
  - Streak cresce sui validi e si azzera al `Miss`.
  - Distribuzione hit coerente a fine brano.

### DSK-07 - Fine brano e results panel

- Obiettivo: validare stato `Finished` e riepilogo.
- Passi:
  1. Completa sessione fino a fine target.
  2. Verifica pannello risultati.
  3. Premi tap/Enter per tornare alla selezione.
- Expected:
  - App mostra score, hit distribution, avg reaction, longest streak.
  - Ritorno a Song Select senza crash.

### DSK-08 - Resize/responsività minima

- Obiettivo: verificare layout su dimensioni diverse.
- Passi:
  1. Ridimensiona finestra desktop (larga -> stretta).
  2. Osserva lanes, hit line, bars, HUD.
- Expected:
  - Elementi restano visibili e leggibili.
  - Nessun overlap critico o canvas corrotto.

## 5. Test cases Android

### AND-01 - Avvio app e permission mic

- Obiettivo: validare bootstrap Android e prompt runtime.
- Passi:
  1. Installa/apri APK debug.
  2. Avvia sessione.
  3. Quando richiesto, concedi permesso microfono.
- Expected:
  - Nessun crash all'avvio.
  - Permesso richiesto correttamente.
  - Sessione inizia con audio e UI attivi.

### AND-02 - Gameplay base con mic abilitato

- Obiettivo: verificare gating e hit detection su device.
- Passi:
  1. Raggiungi `WaitingForHit`.
  2. Suona nota valida.
  3. Ripeti con nota non valida.
- Expected:
  - Con nota valida avanza.
  - Con nota non valida resta in attesa.

### AND-03 - Mic negato e fallback resiliente

- Obiettivo: validare degradazione controllata.
- Passi:
  1. Revoca permesso mic all'app nelle impostazioni Android.
  2. Riavvia app e sessione.
- Expected:
  - App non crasha.
  - Messaggio errore mic presente.
  - Progressione possibile tramite timeout fallback.

### AND-04 - Background/foreground stability

- Obiettivo: verificare stabilità ciclo vita base.
- Passi:
  1. Avvia sessione.
  2. Manda app in background 5-10 secondi.
  3. Torna in foreground.
- Expected:
  - App resta stabile (no crash, no schermata nera).
  - Sessione resta utilizzabile (anche con eventuale restart manuale).

## 6. Template esecuzione test run

Compila questa tabella ad ogni run:

| Campo | Valore |
| --- | --- |
| Data |  |
| Tester |  |
| Commit/Branch |  |
| Device Desktop |  |
| Browser Desktop |  |
| Device Android |  |
| Build app |  |

Risultati test:

| Test ID | Stato (PASS/FAIL/BLOCKED) | Note | Evidence (screenshot/video/log) |
| --- | --- | --- | --- |
| DSK-01 |  |  |  |
| DSK-02 |  |  |  |
| DSK-03 |  |  |  |
| DSK-04 |  |  |  |
| DSK-05 |  |  |  |
| DSK-06 |  |  |  |
| DSK-07 |  |  |  |
| DSK-08 |  |  |  |
| AND-01 |  |  |  |
| AND-02 |  |  |  |
| AND-03 |  |  |  |
| AND-04 |  |  |  |

## 7. Exit criteria suggeriti

- Nessun `FAIL` nei test critici: `DSK-02`, `DSK-03`, `DSK-07`, `AND-01`, `AND-02`.
- Almeno un run completo su desktop e un run completo su Android.
- Tutte le regressioni documentate con riproduzione e evidence.
