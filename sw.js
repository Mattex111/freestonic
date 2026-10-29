/**
 * FreeStonic – sw.js (Service Worker)
 * ============================================================
 * PWA Offline Shell Cache Strategy
 *
 * Strategia: Cache-First per le risorse statiche (shell),
 * Network-First per le chiamate Supabase (dati live).
 *
 * Nessun dato sensibile viene mai memorizzato nella cache
 * del Service Worker (solo HTML/CSS/JS/manifest).
 * ============================================================
 */

'use strict';

const CACHE_NAME    = 'freestonic-shell-v1';
const SUPABASE_HOST = 'supabase.co'; // dominio delle API Supabase

/** Risorse della shell app da precachare all'installazione */
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './crypto.js',
  './manifest.json',
  // Icone PWA
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Font Google precaricato (opzionale, funziona anche offline grazie alla cache)
];

// ──────────────────────────────────────────────────────────────
// INSTALL: pre-cache la shell app
// ──────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // addAll fallisce silenziosamente sulle risorse mancanti
      // (icone non ancora generate) – usiamo add individuale
      return Promise.allSettled(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Pre-cache fallita per ${url}:`, err)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ──────────────────────────────────────────────────────────────
// ACTIVATE: pulisce le vecchie cache
// ──────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ──────────────────────────────────────────────────────────────
// FETCH: strategia ibrida
// ──────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Richieste Supabase/API → Network-First (dati live, non cacheare)
  if (url.hostname.includes(SUPABASE_HOST) ||
      url.pathname.startsWith('/rest/') ||
      url.pathname.startsWith('/realtime/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // 2. Solo GET → Cache-First per la shell
  if (event.request.method !== 'GET') return;

  // 3. Richieste cross-origin (CDN font, ecc.) → Network-First con cache fallback
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // 4. Shell app → Cache-First
  event.respondWith(cacheFirst(event.request));
});

// ──────────────────────────────────────────────────────────────
// Strategie di caching
// ──────────────────────────────────────────────────────────────

/**
 * Cache-First: serve dalla cache, aggiorna in background.
 * Ideale per risorse statiche della shell.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Aggiorna silenziosamente in background (stale-while-revalidate)
    fetchAndUpdate(request);
    return cached;
  }
  return fetchAndUpdate(request);
}

/**
 * Recupera dalla rete e aggiorna la cache.
 */
async function fetchAndUpdate(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Nessuna rete e nessuna cache → fallback alla index (SPA)
    const cached = await caches.match('./index.html');
    return cached ?? new Response('Offline', { status: 503 });
  }
}

/**
 * Network-First: prova la rete, cade sulla cache se offline.
 * Usata per le API Supabase (non cacheamo dati sensibili).
 */
async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response(
      JSON.stringify({ error: 'Offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
