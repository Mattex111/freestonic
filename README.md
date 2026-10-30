# FreeStonic – Lista Spesa Familiare Cifrata

> **App live:** [https://mattex111.github.io/freestonic/](https://mattex111.github.io/freestonic/)

Lista della spesa collaborativa per la famiglia — cifrata end-to-end, installabile come app (PWA), senza pubblicità né tracker.

---

## Funzionalità

- **Cifratura Zero-Knowledge** — i dati vengono cifrati nel browser prima di essere inviati al server. Il database non conosce mai il contenuto degli articoli.
- **Collaborazione familiare** — tutti i membri della famiglia vedono la lista in tempo reale.
- **PWA installabile** — aggiungila alla schermata Home come un'app nativa.
- **Sync istantanea** — Supabase Realtime sincronizza aggiunte, spunte ed eliminazioni tra tutti i dispositivi connessi.
- **Offline ready** — funziona anche senza connessione grazie al Service Worker.
- **Categorie** — Frutta & Verdura, Latticini, Carne & Pesce, Dispensa, Bevande, Detergenti, Altro.
- **Swipe per eliminare** — gesto nativo CSS Scroll Snap, nessuna libreria esterna.
- **Condivisione via QR o link** — invita i familiari in un tap.
- **Zero tracker, zero pubblicità**

---

## Come funziona la crittografia

```
Password famiglia + Family ID
        │
        ▼
  PBKDF2 (200.000 iterazioni, SHA-256)
        │
        ▼
  Chiave AES-GCM 256-bit  ← mai inviata al server
        │
   ┌────┴────┐
   ▼         ▼
encrypt()  decrypt()
   │         │
ciphertext  testo
 → DB      leggibile
```

- Ogni articolo viene cifrato con un **IV casuale** di 12 byte prima di essere salvato.
- Il database Supabase vede solo `ciphertext` e `iv` — **mai testo in chiaro**.
- La chiave crittografica non abbandona mai il browser (`extractable: false`).

---

## Stack Tecnico

| Layer | Tecnologia |
|---|---|
| Frontend | HTML5 + CSS (Vanilla) + JavaScript ES Modules |
| Crittografia | Web Crypto API nativa (`SubtleCrypto`) |
| Database | [Supabase](https://supabase.com) (PostgreSQL) |
| Realtime | Supabase Realtime (WebSocket) |
| PWA | Web App Manifest + Service Worker |
| Deploy | GitHub Pages |
| Dipendenze esterne | `supabase-js` v2, `qrcodejs` (solo per QR di condivisione) |

---

## Setup Locale

### 1. Clona il repository

```bash
git clone https://github.com/Mattex111/freestonic.git
cd freestonic
```

### 2. Configura Supabase

1. Crea un progetto su [supabase.com](https://supabase.com)
2. Esegui `schema.sql` nell'SQL Editor di Supabase
3. Modifica `app.js` con le tue credenziali:

```js
const SUPABASE_URL  = 'https://TUO-PROGETTO.supabase.co';
const SUPABASE_ANON = 'eyJ...'; // chiave anon legacy
```

### 3. Avvia in locale

```bash
# Richiede Python 3 — espone SOLO su localhost, nessun rischio
python3 -m http.server 8420 --bind 127.0.0.1
```

Apri [http://localhost:8420](http://localhost:8420) nel browser.

---

## 📁 Struttura del Progetto

```
freestonic/
├── index.html       # Shell HTML (Welcome, Auth, App)
├── app.js           # Logica principale + Supabase + Realtime
├── crypto.js        # PBKDF2 + AES-GCM (Web Crypto API)
├── style.css        # Design system dark glassmorphism
├── manifest.json    # PWA manifest
├── sw.js            # Service Worker (cache offline)
├── schema.sql       # Schema DB Supabase + RLS + Realtime
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

---

## 🔒 Sicurezza

| Requisito | Implementazione |
|---|---|
| Dati mai in chiaro sul server | `encrypt()` prima di ogni `insert` |
| PBKDF2 ≥ 100k iterazioni | ✅ 200.000 iterazioni |
| Salt derivato dall'ID famiglia | `SHA-256(familyId + 'freestonic-salt-v1')` |
| AES-GCM 256-bit | ✅ |
| IV casuale per ogni cifratura | `crypto.getRandomValues(new Uint8Array(12))` |
| Chiave non estraibile | `extractable: false` |
| Family ID hashato nel DB | `SHA-256(familyId)` — mai l'ID in chiaro |
| Nessuna libreria crypto esterna | Solo `window.crypto.subtle` nativa |
| Row Level Security Supabase | ✅ abilitato |

---

## 📄 Licenza

MIT — libero di usare, modificare e distribuire.

---

<p align="center">
  Fatto con ❤️ · Nessuna pubblicità · Nessun tracker · I tuoi dati rimangono tuoi
</p>
