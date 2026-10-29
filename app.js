/**
 * FreeStonic – app.js
 * ============================================================
 * Logica principale dell'applicazione
 *
 * Stack:
 *  - Supabase JS v2 (CDN, no bundler)
 *  - Web Crypto API nativa (via crypto.js)
 *  - Swipe-to-delete CSS Scroll Snap (da modern-web-guidance)
 *
 * Flusso dati:
 *  1. Utente inserisce articolo in chiaro nel browser
 *  2. encrypt() produce { ciphertext, iv } → salvati su Supabase
 *  3. Supabase Realtime notifica gli altri dispositivi
 *  4. decrypt() ripristina il testo → mostrato nell'UI
 *  5. Il DB non vede MAI testo in chiaro
 * ============================================================
 */

import {
  deriveKey,
  encrypt,
  decrypt,
  hashFamilyId,
  generateFamilyId,
  bufToBase64,
  base64ToBuf,
} from './crypto.js';

'use strict';

// ──────────────────────────────────────────────────────────────
// CONFIG – sostituisci con le tue credenziali Supabase
// ──────────────────────────────────────────────────────────────
const SUPABASE_URL    = 'https://nsqpyainmwpujiudfoxj.supabase.co';
const SUPABASE_ANON   = 'sb_publishable_tXdMAddtFGahCZ-b1XUsEA_8DePEt4O';

// ──────────────────────────────────────────────────────────────
// CATEGORIE
// ──────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'frutta',    emoji: '🍎', label: 'Frutta & Verdura' },
  { id: 'latticini', emoji: '🧀', label: 'Latticini' },
  { id: 'carne',     emoji: '🥩', label: 'Carne & Pesce' },
  { id: 'dispensa',  emoji: '🥫', label: 'Dispensa' },
  { id: 'bevande',   emoji: '🥤', label: 'Bevande' },
  { id: 'detergenti',emoji: '🧹', label: 'Detergenti' },
  { id: 'altro',     emoji: '🛒', label: 'Altro' },
];

// Suggerimenti di completamento rapido per categoria
const SUGGESTIONS = {
  frutta:     ['Mele', 'Banane', 'Pomodori', 'Insalata', 'Arance', 'Carote'],
  latticini:  ['Latte', 'Uova', 'Burro', 'Yogurt', 'Parmigiano', 'Mozzarella'],
  carne:      ['Pollo', 'Manzo', 'Salmone', 'Tonno', 'Prosciutto'],
  dispensa:   ['Pasta', 'Riso', 'Farina', 'Olio', 'Sale', 'Zucchero', 'Pane'],
  bevande:    ['Acqua', 'Succo', 'Caffè', 'Tè', 'Vino'],
  detergenti: ['Detersivo', 'Shampoo', 'Sapone', 'Carta igienica'],
  altro:      [],
};

// ──────────────────────────────────────────────────────────────
// STATO APPLICAZIONE
// ──────────────────────────────────────────────────────────────
let supabase      = null;
let realtimeChannel = null;
let cryptoKey     = null;         // CryptoKey AES-GCM – MAI serializzata
let familyId      = null;         // ID famiglia in chiaro (solo in memoria/localStorage)
let familyIdHash  = null;         // SHA-256 dell'ID (usato nelle query DB)
let items         = [];           // Array locale articoli decifrati
let selectedCategory = 'altro';
let filterCategory   = 'all';
let authMode         = 'create';  // 'create' | 'join'
let realtimeSub   = null;

// ──────────────────────────────────────────────────────────────
// INIZIALIZZAZIONE
// ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // Stato rete
  window.addEventListener('online',  () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
  setOnline(navigator.onLine);

  // Gestione deep-link di invito (?join=...)
  handleInviteLink();

  // Sessione salvata?
  const savedSession = loadSession();
  if (savedSession) {
    await restoreSession(savedSession);
  } else {
    showScreen('welcome');
  }

  // Event listeners UI
  bindWelcomeEvents();
  bindAuthEvents();
  bindAppEvents();
  buildCategoryOptions();
  buildCategoryFilter();
});

// ──────────────────────────────────────────────────────────────
// SUPABASE
// ──────────────────────────────────────────────────────────────
function initSupabase() {
  if (supabase) return;
  // @ts-ignore – Supabase caricato da CDN
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

// ──────────────────────────────────────────────────────────────
// SESSIONE
// ──────────────────────────────────────────────────────────────
function saveSession(id, password) {
  localStorage.setItem('fs_family_id', id);
  localStorage.setItem('fs_family_pwd', password); // necessario per re-derivare la chiave
}

function loadSession() {
  const id  = localStorage.getItem('fs_family_id');
  const pwd = localStorage.getItem('fs_family_pwd');
  if (id && pwd) return { id, pwd };
  return null;
}

function clearSession() {
  localStorage.removeItem('fs_family_id');
  localStorage.removeItem('fs_family_pwd');
}

async function restoreSession({ id, pwd }) {
  showScreen('loading');
  try {
    familyId     = id;
    familyIdHash = await hashFamilyId(id);
    cryptoKey    = await deriveKey(pwd, id);
    initSupabase();
    await loadItems();
    subscribeRealtime();
    showScreen('app');
    updateTopbar();
  } catch (err) {
    console.error('Restore session error:', err);
    clearSession();
    showScreen('welcome');
  }
}

// ──────────────────────────────────────────────────────────────
// NAVIGAZIONE SCHERMATE
// ──────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add('active');
}

// ──────────────────────────────────────────────────────────────
// WELCOME SCREEN EVENTS
// ──────────────────────────────────────────────────────────────
function bindWelcomeEvents() {
  document.getElementById('btn-create').addEventListener('click', () => {
    authMode = 'create';
    showAuthScreen('create');
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    authMode = 'join';
    showAuthScreen('join');
  });
}

function showAuthScreen(mode) {
  const el = document.getElementById('screen-auth');
  el.querySelector('.auth-title').textContent =
    mode === 'create' ? 'Crea nuova Famiglia' : 'Unisciti a una Famiglia';

  // Mostra/nascondi campo ID
  document.getElementById('auth-id-group').classList.toggle('hidden', mode === 'create');
  document.getElementById('auth-newid-group').classList.toggle('hidden', mode === 'join');

  if (mode === 'create') {
    // Genera un ID casuale e mostralo
    const newId = generateFamilyId();
    document.getElementById('auth-newid-display').textContent = newId;
    document.getElementById('auth-newid-display').dataset.id = newId;
  }

  clearAuthError();
  showScreen('auth');
}

// ──────────────────────────────────────────────────────────────
// AUTH SCREEN EVENTS
// ──────────────────────────────────────────────────────────────
function bindAuthEvents() {
  document.getElementById('auth-back').addEventListener('click', () => {
    showScreen('welcome');
  });

  document.getElementById('auth-newid-copy').addEventListener('click', () => {
    const id = document.getElementById('auth-newid-display').dataset.id;
    navigator.clipboard.writeText(id).then(() => showToast('ID copiato!', 'success'));
  });

  document.getElementById('btn-auth-submit').addEventListener('click', handleAuthSubmit);

  document.getElementById('auth-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAuthSubmit();
  });
  document.getElementById('auth-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAuthSubmit();
  });
}

async function handleAuthSubmit() {
  clearAuthError();

  const password = document.getElementById('auth-password').value.trim();
  if (!password) {
    showAuthError('Inserisci una password per la famiglia.');
    return;
  }
  if (password.length < 4) {
    showAuthError('La password deve essere di almeno 4 caratteri.');
    return;
  }

  let id;
  if (authMode === 'create') {
    id = document.getElementById('auth-newid-display').dataset.id;
  } else {
    id = document.getElementById('auth-id-input').value.trim();
    if (!id) {
      showAuthError('Inserisci l\'ID della famiglia.');
      return;
    }
  }

  setAuthLoading(true);

  try {
    familyId     = id;
    familyIdHash = await hashFamilyId(id);
    // Derivazione chiave – può richiedere 1-2s per 200k iterazioni
    cryptoKey    = await deriveKey(password, id);

    initSupabase();

    if (authMode === 'join') {
      // Verifica che esistano articoli per questa famiglia (hash)
      const { data, error } = await supabase
        .from('groceries')
        .select('id')
        .eq('family_id', familyIdHash)
        .limit(1);

      if (error) throw error;
      // Nota: se non ci sono dati è ok – la famiglia potrebbe essere vuota.
      // La vera verifica è che il testo si decifri correttamente.
    }

    saveSession(id, password);
    await loadItems();
    subscribeRealtime();
    showScreen('app');
    updateTopbar();

  } catch (err) {
    console.error('Auth error:', err);
    showAuthError('Errore di connessione o credenziali non valide.');
  } finally {
    setAuthLoading(false);
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}

function setAuthLoading(loading) {
  const btn = document.getElementById('btn-auth-submit');
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

// ──────────────────────────────────────────────────────────────
// APP EVENTS
// ──────────────────────────────────────────────────────────────
function bindAppEvents() {
  // Pulsante logout / cambio famiglia
  document.getElementById('btn-logout').addEventListener('click', () => {
    if (!confirm('Disconnettersi dalla famiglia? Dovrai reinserire le credenziali.')) return;
    logout();
  });

  // Pulsante condividi
  document.getElementById('btn-share').addEventListener('click', openShareModal);

  // Aggiunta articolo
  document.getElementById('add-btn').addEventListener('click', handleAddItem);
  document.getElementById('item-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddItem();
  });
  document.getElementById('item-input').addEventListener('input', updateSuggestions);

  // Category picker
  document.getElementById('category-picker-btn').addEventListener('click', openCategoryModal);

  // Modal overlay click-to-close
  document.getElementById('category-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('category-modal')) closeCategoryModal();
  });
  document.getElementById('share-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('share-modal')) closeShareModal();
  });

  // Pulsante copia link condivisione
  document.getElementById('btn-copy-link').addEventListener('click', copyShareLink);
}

function logout() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  clearSession();
  cryptoKey    = null;
  familyId     = null;
  familyIdHash = null;
  items        = [];
  showScreen('welcome');
}

// ──────────────────────────────────────────────────────────────
// TOPBAR
// ──────────────────────────────────────────────────────────────
function updateTopbar() {
  const shortId = familyId ? familyId.slice(0, 8) + '…' : '—';
  document.getElementById('family-short-id').textContent = `Famiglia ${shortId}`;
}

// ──────────────────────────────────────────────────────────────
// CARICAMENTO ARTICOLI DA SUPABASE
// ──────────────────────────────────────────────────────────────
async function loadItems() {
  showSkeletons(true);

  const { data, error } = await supabase
    .from('groceries')
    .select('*')
    .eq('family_id', familyIdHash)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Load error:', error);
    showToast('Errore nel caricamento degli articoli', 'error');
    showSkeletons(false);
    return;
  }

  items = await decryptAll(data || []);
  renderList();
  showSkeletons(false);
}

/** Decifra tutti gli articoli dal DB */
async function decryptAll(rows) {
  const results = await Promise.allSettled(
    rows.map(async row => {
      try {
        const name     = await decrypt(row.ciphertext, row.iv, cryptoKey);
        const category = row.category_ciphertext
          ? await decrypt(row.category_ciphertext, row.category_iv, cryptoKey)
          : 'altro';
        return {
          id:          row.id,
          name,
          category,
          is_completed: row.is_completed,
          created_at:  row.created_at,
        };
      } catch {
        // Se la decifratura fallisce (password sbagliata), mostra placeholder
        return {
          id:           row.id,
          name:         '🔒 (non decifrabile)',
          category:     'altro',
          is_completed: row.is_completed,
          created_at:   row.created_at,
        };
      }
    })
  );
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

// ──────────────────────────────────────────────────────────────
// AGGIUNTA ARTICOLO
// ──────────────────────────────────────────────────────────────
async function handleAddItem() {
  const input = document.getElementById('item-input');
  const name  = input.value.trim();
  if (!name) return;

  input.value = '';
  updateSuggestions();

  try {
    // Cifra nome e categoria
    const { ciphertext, iv }                   = await encrypt(name, cryptoKey);
    const { ciphertext: catCt, iv: catIv }     = await encrypt(selectedCategory, cryptoKey);

    const row = {
      family_id:          familyIdHash,
      ciphertext,
      iv,
      category_ciphertext: catCt,
      category_iv:         catIv,
      is_completed:        false,
    };

    const { data, error } = await supabase
      .from('groceries')
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    // Aggiungi localmente (Realtime lo sincronizzerà agli altri)
    items.push({
      id:           data.id,
      name,
      category:     selectedCategory,
      is_completed: false,
      created_at:   data.created_at,
    });
    renderList();

  } catch (err) {
    console.error('Add error:', err);
    showToast('Errore nell\'aggiunta dell\'articolo', 'error');
  }
}

// ──────────────────────────────────────────────────────────────
// TOGGLE COMPLETAMENTO
// ──────────────────────────────────────────────────────────────
async function toggleItem(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;

  const newState = !item.is_completed;
  item.is_completed = newState;
  renderList();

  const { error } = await supabase
    .from('groceries')
    .update({ is_completed: newState })
    .eq('id', id);

  if (error) {
    console.error('Toggle error:', error);
    item.is_completed = !newState; // rollback
    renderList();
    showToast('Errore nell\'aggiornamento', 'error');
  }
}

// ──────────────────────────────────────────────────────────────
// ELIMINAZIONE ARTICOLO
// ──────────────────────────────────────────────────────────────
async function deleteItem(id) {
  items = items.filter(i => i.id !== id);

  const { error } = await supabase
    .from('groceries')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Delete error:', error);
    showToast('Errore nell\'eliminazione', 'error');
    await loadItems(); // ricarica stato reale
  }
}

// ──────────────────────────────────────────────────────────────
// SUPABASE REALTIME
// ──────────────────────────────────────────────────────────────
function subscribeRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);

  realtimeChannel = supabase
    .channel(`groceries:${familyIdHash}`)
    .on(
      'postgres_changes',
      {
        event:  '*',
        schema: 'public',
        table:  'groceries',
        filter: `family_id=eq.${familyIdHash}`,
      },
      handleRealtimeEvent
    )
    .subscribe(status => {
      if (status === 'SUBSCRIBED') setOnline(true);
    });
}

async function handleRealtimeEvent(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;

  if (eventType === 'INSERT') {
    // Evita duplicati (già aggiunto localmente)
    if (items.find(i => i.id === newRow.id)) return;
    try {
      const name     = await decrypt(newRow.ciphertext, newRow.iv, cryptoKey);
      const category = newRow.category_ciphertext
        ? await decrypt(newRow.category_ciphertext, newRow.category_iv, cryptoKey)
        : 'altro';
      items.push({ id: newRow.id, name, category, is_completed: newRow.is_completed, created_at: newRow.created_at });
      renderList();
      showToast(`📥 "${name}" aggiunto da un altro dispositivo`, 'success');
    } catch { /* decifratura fallita */ }

  } else if (eventType === 'UPDATE') {
    const item = items.find(i => i.id === newRow.id);
    if (item) {
      item.is_completed = newRow.is_completed;
      renderList();
    }

  } else if (eventType === 'DELETE') {
    items = items.filter(i => i.id !== oldRow.id);
    renderList();
  }
}

// ──────────────────────────────────────────────────────────────
// RENDER
// ──────────────────────────────────────────────────────────────
function renderList() {
  const container = document.getElementById('grocery-list-container');
  container.innerHTML = '';

  // Separa completati / non completati
  const active    = items.filter(i => !i.is_completed);
  const completed = items.filter(i => i.is_completed);

  // Filtra per categoria se selezionata
  const filterFn = item =>
    filterCategory === 'all' || item.category === filterCategory;

  const activeFiltered    = active.filter(filterFn);
  const completedFiltered = completed.filter(filterFn);

  if (activeFiltered.length === 0 && completedFiltered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <p>La lista è vuota.<br>Aggiungi il primo articolo qui sotto!</p>
      </div>`;
    return;
  }

  // Raggruppa per categoria
  const grouped = groupByCategory(activeFiltered);
  for (const [catId, catItems] of Object.entries(grouped)) {
    const cat = CATEGORIES.find(c => c.id === catId) || CATEGORIES.at(-1);
    container.appendChild(buildCategorySection(cat, catItems));
  }

  // Sezione completati
  if (completedFiltered.length > 0) {
    const cat = { emoji: '✅', label: 'Già nel carrello' };
    const section = buildCategorySection(cat, completedFiltered, true);
    container.appendChild(section);
  }

  // Attiva swipe-to-delete su tutti i nuovi item
  initSwipeableList();
}

function groupByCategory(arr) {
  const groups = {};
  for (const item of arr) {
    const cat = item.category || 'altro';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  return groups;
}

function buildCategorySection(cat, catItems, isCompleted = false) {
  const section = document.createElement('section');
  section.className = 'category-section';

  const label = document.createElement('div');
  label.className = 'category-label';
  label.innerHTML = `<span>${cat.emoji} ${cat.label}</span>`;
  section.appendChild(label);

  const ul = document.createElement('ul');
  ul.className = 'SwipeableList';

  for (const item of catItems) {
    ul.appendChild(buildItemEl(item, isCompleted));
  }

  section.appendChild(ul);
  return section;
}

function buildItemEl(item, isCompleted = false) {
  const li = document.createElement('li');
  li.className = 'SwipeableList-item' + (isCompleted ? ' is-done' : '');
  li.dataset.id = item.id;

  const timeAgo = formatTimeAgo(item.created_at);

  li.innerHTML = `
    <div class="SwipeableList-track">
      <div class="SwipeableList-content" tabindex="0" role="row">
        <button
          class="grocery-checkbox ${item.is_completed ? 'checked' : ''}"
          aria-label="${item.is_completed ? 'Rimuovi spunta da' : 'Spunta'} ${item.name}"
          data-id="${item.id}"
        ></button>
        <div class="grocery-text-wrap">
          <div class="grocery-name ${item.is_completed ? 'completed' : ''}">${escapeHtml(item.name)}</div>
        </div>
        <span class="grocery-time">${timeAgo}</span>
      </div>
    </div>`;

  // Toggle completamento
  li.querySelector('.grocery-checkbox').addEventListener('click', e => {
    e.stopPropagation();
    toggleItem(item.id);
  });

  return li;
}

// ──────────────────────────────────────────────────────────────
// SWIPE-TO-DELETE (da modern-web-guidance: swipe-to-remove)
// ──────────────────────────────────────────────────────────────
const swipeObservers = new WeakMap();

/** Funziona su qualsiasi nuovo .SwipeableList aggiunto al DOM */
function initSwipeableList() {
  document.querySelectorAll('.SwipeableList').forEach(setupList);
}

const needsScrollWorkaround = !CSS.supports('scroll-initial-target', 'nearest');

const viewportObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const item = entry.target;
    if (entry.isIntersecting) {
      const handle = swipeObservers.get(item) ?? setupSwipeItem(item);
      if (handle) handle.observer.observe(handle.content);
    } else {
      const handle = swipeObservers.get(item);
      if (handle) handle.observer.unobserve(handle.content);
    }
  }
});

function setupList(list) {
  for (const item of list.children) {
    if (item.matches('.SwipeableList-item')) viewportObserver.observe(item);
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE &&
            node.matches('.SwipeableList-item')) {
          viewportObserver.observe(node);
        }
      }
    }
  }).observe(list, { childList: true });
}

function setupSwipeItem(item) {
  const track   = item.querySelector('.SwipeableList-track');
  const content = track?.querySelector('.SwipeableList-content');
  if (!track || !content) return null;

  item.classList.add('is-initialized');

  // Workaround per browser senza scroll-initial-target
  if (needsScrollWorkaround) {
    const ro = new ResizeObserver(() => {
      track.scrollLeft = content.offsetLeft;
      ro.disconnect();
    });
    ro.observe(track);
  }

  const activateThreshold = 0.8;
  const commitThreshold   = 0.2;

  const observer = new IntersectionObserver((entries, obs) => {
    const entry = entries.at(-1);
    const ratio = entry.intersectionRatio;

    const direction =
      (entry.boundingClientRect.x - entry.rootBounds.x) > 0 ? 'left' : 'right';

    if (ratio < commitThreshold) {
      const itemId = item.dataset.id;
      removeItemEl(item, content, direction, entry);
      viewportObserver.unobserve(item);
      obs.disconnect();
      if (itemId) deleteItem(itemId);
      return;
    }

    item.classList.toggle('is-activating', ratio < activateThreshold);
    if (entry.boundingClientRect.x !== entry.rootBounds.x) {
      item.dataset.swipeDirection = direction;
    }
  }, {
    root:      track,
    threshold: [commitThreshold, activateThreshold],
  });

  const handle = { observer, content };
  swipeObservers.set(item, handle);
  return handle;
}

async function removeItemEl(item, content, direction, entry) {
  const opts = { duration: 280, easing: 'ease', fill: 'forwards' };
  const rect = entry.boundingClientRect;
  const x    = rect.x - entry.rootBounds.x;
  const translate = direction === 'left'
    ? rect.width - x
    : -(x + rect.width);

  item.classList.add('is-removing');
  item.animate([{ height: `${rect.height}px` }, { height: '0px' }], opts);
  content.animate([{ translate: `${translate}px` }], opts);

  await Promise.allSettled(
    item.getAnimations({ subtree: true }).map(a => a.finished)
  );

  // Safari bug workaround
  if (typeof GestureEvent !== 'undefined') {
    item.inert = true;
    setTimeout(() => item.remove(), 3000);
  } else {
    item.remove();
  }
}

// ──────────────────────────────────────────────────────────────
// CATEGORY MODAL
// ──────────────────────────────────────────────────────────────
function buildCategoryOptions() {
  const grid = document.getElementById('category-options');
  grid.innerHTML = '';
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.className = 'cat-option' + (cat.id === selectedCategory ? ' selected' : '');
    btn.dataset.id = cat.id;
    btn.innerHTML = `
      <span class="cat-opt-emoji">${cat.emoji}</span>
      <span class="cat-opt-name">${cat.label}</span>`;
    btn.addEventListener('click', () => selectCategory(cat.id));
    grid.appendChild(btn);
  }
}

function buildCategoryFilter() {
  const bar = document.getElementById('category-filter-bar');
  bar.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = 'cat-chip active';
  allChip.dataset.cat = 'all';
  allChip.textContent = '🛒 Tutti';
  allChip.addEventListener('click', () => setFilterCategory('all', allChip));
  bar.appendChild(allChip);

  for (const cat of CATEGORIES) {
    const chip = document.createElement('button');
    chip.className = 'cat-chip';
    chip.dataset.cat = cat.id;
    chip.innerHTML = `${cat.emoji} ${cat.label}`;
    chip.addEventListener('click', () => setFilterCategory(cat.id, chip));
    bar.appendChild(chip);
  }
}

function setFilterCategory(catId, chipEl) {
  filterCategory = catId;
  document.querySelectorAll('#category-filter-bar .cat-chip')
    .forEach(c => c.classList.toggle('active', c === chipEl));
  renderList();
}

function selectCategory(catId) {
  selectedCategory = catId;
  const cat = CATEGORIES.find(c => c.id === catId);
  const btn = document.getElementById('category-picker-btn');
  btn.querySelector('.cat-emoji').textContent  = cat.emoji;
  btn.querySelector('.cat-label').textContent  = cat.label;
  document.querySelectorAll('.cat-option')
    .forEach(o => o.classList.toggle('selected', o.dataset.id === catId));
  updateSuggestions();
  closeCategoryModal();
}

function openCategoryModal() {
  document.getElementById('category-modal').classList.add('open');
}
function closeCategoryModal() {
  document.getElementById('category-modal').classList.remove('open');
}

// ──────────────────────────────────────────────────────────────
// SUGGERIMENTI RAPIDI
// ──────────────────────────────────────────────────────────────
function updateSuggestions() {
  const input       = document.getElementById('item-input').value.toLowerCase();
  const suggs       = SUGGESTIONS[selectedCategory] || [];
  const filtered    = input
    ? suggs.filter(s => s.toLowerCase().startsWith(input))
    : suggs;

  const container   = document.getElementById('suggestions-bar');
  container.innerHTML = '';

  for (const s of filtered.slice(0, 6)) {
    const chip = document.createElement('button');
    chip.className = 'suggestion-chip';
    chip.textContent = s;
    chip.addEventListener('click', () => {
      document.getElementById('item-input').value = s;
      handleAddItem();
    });
    container.appendChild(chip);
  }
}

// ──────────────────────────────────────────────────────────────
// SHARE MODAL + QR CODE
// ──────────────────────────────────────────────────────────────
function buildShareLink() {
  const pwd    = localStorage.getItem('fs_family_pwd') || '';
  const base   = `${location.origin}${location.pathname}`;
  return `${base}#join?id=${encodeURIComponent(familyId)}&pwd=${encodeURIComponent(pwd)}`;
}

async function openShareModal() {
  const link     = buildShareLink();
  const modal    = document.getElementById('share-modal');
  const linkBox  = document.getElementById('share-link-display');
  linkBox.textContent = link;

  // Genera QR code
  const qrContainer = document.getElementById('qr-canvas-wrapper');
  qrContainer.innerHTML = '';
  try {
    // Usa la lib QRCode.js caricata da CDN
    // @ts-ignore
    new QRCode(qrContainer, {
      text:          link,
      width:         220,
      height:        220,
      colorDark:     '#6C63FF',
      colorLight:    '#FFFFFF',
      correctLevel:  QRCode.CorrectLevel.M,
    });
  } catch {
    qrContainer.textContent = 'QR non disponibile (richiede connessione per caricare la libreria)';
  }

  modal.classList.add('open');
}

function closeShareModal() {
  document.getElementById('share-modal').classList.remove('open');
}

function copyShareLink() {
  const link = buildShareLink();
  navigator.clipboard.writeText(link)
    .then(() => showToast('Link di condivisione copiato! 🔗', 'success'))
    .catch(() => showToast('Impossibile copiare il link', 'error'));
}

// ──────────────────────────────────────────────────────────────
// GESTIONE DEEP LINK DI INVITO
// ──────────────────────────────────────────────────────────────
function handleInviteLink() {
  const hash = location.hash;
  if (!hash.startsWith('#join?')) return;

  const params = new URLSearchParams(hash.slice(6));
  const id     = params.get('id');
  const pwd    = params.get('pwd');

  if (id && pwd) {
    // Pre-compila il form di join
    sessionStorage.setItem('fs_invite_id',  id);
    sessionStorage.setItem('fs_invite_pwd', pwd);
    // Pulisce l'URL (sicurezza)
    history.replaceState(null, '', location.pathname);
  }
}

// Dopo DOMContentLoaded, controlla il pending invite
function checkPendingInvite() {
  const id  = sessionStorage.getItem('fs_invite_id');
  const pwd = sessionStorage.getItem('fs_invite_pwd');
  if (!id || !pwd) return;
  sessionStorage.removeItem('fs_invite_id');
  sessionStorage.removeItem('fs_invite_pwd');

  authMode = 'join';
  showAuthScreen('join');
  document.getElementById('auth-id-input').value    = id;
  document.getElementById('auth-password').value    = pwd;
  setTimeout(handleAuthSubmit, 100);
}

// ──────────────────────────────────────────────────────────────
// STATO RETE
// ──────────────────────────────────────────────────────────────
function setOnline(online) {
  const banner = document.getElementById('offline-banner');
  const dot    = document.getElementById('connection-dot');
  banner?.classList.toggle('visible', !online);
  dot?.classList.toggle('offline', !online);
}

// ──────────────────────────────────────────────────────────────
// SKELETON
// ──────────────────────────────────────────────────────────────
function showSkeletons(show) {
  const wrapper  = document.getElementById('grocery-list-container');
  const skeleton = document.getElementById('skeleton-list');
  if (skeleton) skeleton.classList.toggle('hidden', !show);
  if (wrapper)  wrapper.classList.toggle('hidden', show);
}

// ──────────────────────────────────────────────────────────────
// TOAST
// ──────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ──────────────────────────────────────────────────────────────
// UTILITÀ
// ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60_000)  return 'ora';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}g`;
}

// Aggiunge check del pending invite dopo che DOMContentLoaded è completo
setTimeout(checkPendingInvite, 200);
