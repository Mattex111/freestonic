/**
 * FreeStonic – crypto.js
 * ============================================================
 * Zero-Knowledge Encryption Layer
 * Usa esclusivamente la Web Crypto API nativa (SubtleCrypto).
 * NESSUNA libreria esterna. Funziona offline.
 *
 * Algoritmi:
 *  - Derivazione chiave : PBKDF2 + SHA-256, 200.000 iterazioni
 *  - Cifratura          : AES-GCM 256-bit, IV 12 byte random
 *  - Hash family_id     : SHA-256 (per il campo DB family_id)
 *
 * Il browser non invia MAI dati in chiaro al database.
 * ============================================================
 */

'use strict';

// ──────────────────────────────────────────────────────────────
// Utilità di encoding / decoding Base64url ↔ Uint8Array
// ──────────────────────────────────────────────────────────────

/**
 * Converte un ArrayBuffer o Uint8Array in stringa Base64url (senza padding).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function bufToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Converte una stringa Base64url in Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBuf(b64) {
  // Aggiunge padding se necessario
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padLen  = (4 - (padded.length % 4)) % 4;
  const binary  = atob(padded + '='.repeat(padLen));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

// ──────────────────────────────────────────────────────────────
// Hash dell'ID famiglia (per il campo DB)
// ──────────────────────────────────────────────────────────────

/**
 * Calcola lo SHA-256 dell'ID famiglia e lo restituisce come hex string.
 * Usato come valore del campo `family_id` nel database (mai l'ID raw).
 * @param {string} familyId – ID famiglia in chiaro
 * @returns {Promise<string>} hex string SHA-256
 */
export async function hashFamilyId(familyId) {
  const encoded = new TextEncoder().encode(familyId);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ──────────────────────────────────────────────────────────────
// Derivazione della chiave di cifratura (PBKDF2)
// ──────────────────────────────────────────────────────────────

/**
 * Deriva una CryptoKey AES-GCM 256-bit dalla password della famiglia.
 *
 * Il salt è derivato deterministicamente dal familyId in modo che
 * tutti i dispositivi con le stesse credenziali ottengano la stessa chiave,
 * senza mai trasmettere la chiave stessa.
 *
 * @param {string} password  – Password della famiglia (in chiaro, solo in memoria)
 * @param {string} familyId  – ID famiglia (usato come base per il salt PBKDF2)
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, familyId) {
  const enc = new TextEncoder();

  // 1. Importa la password come materiale grezzo per PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // 2. Salt = SHA-256(familyId + 'freestonic-salt-v1')
  //    Deterministico e specifico per questa app → nessuna collisione cross-app.
  const saltSource = enc.encode(familyId + 'freestonic-salt-v1');
  const saltBuffer = await crypto.subtle.digest('SHA-256', saltSource);

  // 3. Deriva la chiave AES-GCM 256-bit con 200.000 iterazioni PBKDF2
  const cryptoKey = await crypto.subtle.deriveKey(
    {
      name:       'PBKDF2',
      hash:       'SHA-256',
      salt:       saltBuffer,
      iterations: 200_000,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,         // non estraibile → la chiave non abbandona il contesto WebCrypto
    ['encrypt', 'decrypt']
  );

  return cryptoKey;
}

// ──────────────────────────────────────────────────────────────
// Cifratura AES-GCM
// ──────────────────────────────────────────────────────────────

/**
 * Cifra un testo con AES-GCM 256-bit.
 *
 * Genera un IV casuale di 12 byte per ogni chiamata.
 * NON riutilizzare mai lo stesso (IV, key) → garantito dalla generazione random.
 *
 * @param {string}    plaintext – Testo da cifrare
 * @param {CryptoKey} key       – Chiave derivata da deriveKey()
 * @returns {Promise<{ ciphertext: string, iv: string }>}
 *          ciphertext e iv sono stringhe Base64url pronte per il DB.
 */
export async function encrypt(plaintext, key) {
  // IV casuale: 12 byte (96 bit) – raccomandato per AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  return {
    ciphertext: bufToBase64(ciphertextBuffer),
    iv:         bufToBase64(iv),
  };
}

// ──────────────────────────────────────────────────────────────
// Decifratura AES-GCM
// ──────────────────────────────────────────────────────────────

/**
 * Decifra un ciphertext AES-GCM.
 *
 * Lancia un errore se la chiave è sbagliata o i dati sono stati alterati
 * (il tag GCM garantisce l'autenticità).
 *
 * @param {string}    ciphertextB64 – Ciphertext in Base64url (dal DB)
 * @param {string}    ivB64         – IV in Base64url (dal DB)
 * @param {CryptoKey} key           – Chiave derivata da deriveKey()
 * @returns {Promise<string>} Testo in chiaro
 * @throws {DOMException} Se la decifratura fallisce (password errata / dati corrotti)
 */
export async function decrypt(ciphertextB64, ivB64, key) {
  const ciphertextBytes = base64ToBuf(ciphertextB64);
  const ivBytes         = base64ToBuf(ivB64);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    ciphertextBytes
  );

  return new TextDecoder().decode(plaintextBuffer);
}

// ──────────────────────────────────────────────────────────────
// Generatore ID famiglia sicuro
// ──────────────────────────────────────────────────────────────

/**
 * Genera un ID famiglia casuale di 128 bit come stringa Base64url (22 char).
 * Non ha bisogno di essere un UUID: è solo un token opaco condivisibile.
 * @returns {string}
 */
export function generateFamilyId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bufToBase64(bytes);
}
