-- ============================================================
--  FreeStonic – Grocery Shopping App
--  Supabase Schema SQL
--  Zero-Knowledge: il DB vede solo ciphertext, mai plaintext
-- ============================================================

-- Abilita l'estensione UUID
create extension if not exists "pgcrypto";

-- ============================================================
-- TABELLA PRINCIPALE: groceries
-- ============================================================
create table if not exists public.groceries (
  id            uuid             primary key default gen_random_uuid(),

  -- Hash SHA-256 dell'ID famiglia (mai l'ID in chiaro)
  family_id     text             not null,

  -- Testo cifrato AES-GCM (Base64url)
  ciphertext    text             not null,

  -- Initialization Vector AES-GCM (Base64url, 12 byte → 16 char base64)
  iv            text             not null,

  -- Categoria cifrata separatamente
  category_ciphertext text       not null default '',
  category_iv         text       not null default '',

  -- Stato articolo (spuntato/non spuntato) – non è dato sensibile
  is_completed  boolean          not null default false,

  -- Ordine all'interno della categoria
  sort_order    integer          not null default 0,

  -- Timestamp server (UTC)
  created_at    timestamptz      not null default now(),
  updated_at    timestamptz      not null default now()
);

-- Indice su family_id per query rapide
create index if not exists idx_groceries_family_id on public.groceries(family_id);
create index if not exists idx_groceries_family_completed on public.groceries(family_id, is_completed);

-- Trigger per aggiornare updated_at automaticamente
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_groceries_updated_at
  before update on public.groceries
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
alter table public.groceries enable row level security;

-- Policy: chiunque può LEGGERE le righe (protezione reale = crittografia E2E)
create policy "Family members can read their groceries"
  on public.groceries for select
  using (true);

-- Policy: chiunque può INSERIRE articoli
create policy "Family members can insert groceries"
  on public.groceries for insert
  with check (true);

-- Policy: chiunque può AGGIORNARE articoli (toggle completamento)
create policy "Family members can update groceries"
  on public.groceries for update
  using (true);

-- Policy: chiunque può ELIMINARE articoli
create policy "Family members can delete groceries"
  on public.groceries for delete
  using (true);

-- ============================================================
-- SUPABASE REALTIME
-- ============================================================
alter publication supabase_realtime add table public.groceries;

-- ============================================================
-- COMMENTI DESCRITTIVI
-- ============================================================
comment on table public.groceries is
  'Lista della spesa cifrata. ciphertext contiene testo AES-GCM 256-bit. Il DB non conosce il contenuto.';

comment on column public.groceries.family_id is
  'Hash SHA-256 dell ID famiglia. Mai memorizzare l ID in chiaro.';

comment on column public.groceries.ciphertext is
  'Testo articolo cifrato con AES-GCM, codificato in Base64url.';

comment on column public.groceries.iv is
  'IV AES-GCM (12 byte), codificato in Base64url. Generato fresh ad ogni cifratura.';
