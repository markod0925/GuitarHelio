---
name: build-windows-android
description: Compilare GuitarHelio per Windows desktop (.exe con electron-builder) e Android (.apk debug con Capacitor/Gradle). Usare quando viene richiesto di rigenerare artefatti release/debug per entrambe le piattaforme, verificare output build, o risolvere errori ricorrenti di packaging (win-unpacked lock, dipendenze opzionali Rollup mancanti, sync Capacitor/Gradle).
---

# Build Windows Android

## Overview

Eseguire una procedura ripetibile per generare build Windows e Android del progetto GuitarHelio.
Usare comandi Windows (`cmd.exe`) anche quando la sessione parte da shell Linux/WSL.

## Workflow

0. Preparare dipendenze con pipeline install corretta per piattaforma.
1. Eseguire la build Windows.
2. Eseguire la build Android.
3. Verificare i file di output con path assoluti.
4. Rieseguire `npm install` nell'ambiente server (bash/Linux) dopo le build multipiattaforma.

## Install pipeline separate

Server Linux + Android:

```bash
npm run install:linux-android
```

Windows packaging:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run install:windows"
```

## Build Windows (.exe)

Eseguire:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run build:windows:clean"
```

Verificare output:

- `C:\Dati\Marco\GameDev\GuitarHelio\release\GuitarHelio-0.1.0-x64.exe`
- `C:\Dati\Marco\GameDev\GuitarHelio\release\win-unpacked\`

## Build Android (APK debug)

Eseguire:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run build && npx cap sync android && cd android && gradlew.bat :app:assembleDebug"
```

Verificare output:

- `C:\Dati\Marco\GameDev\GuitarHelio\android\app\build\outputs\apk\debug\app-debug.apk`

## Troubleshooting

### Errore `cmd: not found`

Usare sempre `cmd.exe /c` per le build Windows/Android.

### Errore `Cannot find module @rollup/rollup-win32-x64-msvc`

Eseguire:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm install -D @rollup/rollup-win32-x64-msvc"
```

Poi rilanciare `npm run build:windows:clean`.

### Errore `Access is denied` su `release\win-unpacked\...`

Usare lo script pulito già presente:

```bat
npm run build:windows:clean
```

Lo script chiude processi `GuitarHelio.exe/electron.exe/app-builder.exe`, rimuove attributo read-only e cancella `release\win-unpacked` prima della build.

### Ambiente server non allineato dopo build Windows/Android

Eseguire sempre:

```bash
npm install
```

Usare `npm run install:windows` solo in ambiente Windows per installare anche la dipendenza Win-only `@rollup/rollup-win32-x64-msvc` senza persisterla in `package.json`.

### Errore `wine is required` durante build Windows

Non cross-compilare da Linux puro.
Lanciare la build in ambiente Windows (`cmd.exe`) oppure in WSL con accesso a `cmd.exe`.

## Note operative

- Accettare warning non bloccanti (`chunk > 500kB`, `description/author`, `asar usage is disabled`) se la build termina con successo.
- Considerare valida la build Android solo con `BUILD SUCCESSFUL` da Gradle.
