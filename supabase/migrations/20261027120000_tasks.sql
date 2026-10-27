-- Labplanner: database-opzet voor Supabase
-- Plak dit in Supabase > SQL Editor > New query, en klik op "Run".

-- 1. Tabel met alle opdrachten (elke opdracht als één JSON-record)
create table if not exists public.tasks (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- 2. Beveiliging: alleen ingelogde gebruikers mogen lezen en schrijven
alter table public.tasks enable row level security;

drop policy if exists "Ingelogde gebruikers mogen alles" on public.tasks;
create policy "Ingelogde gebruikers mogen alles"
  on public.tasks
  for all
  to authenticated
  using (true)
  with check (true);

-- 3. Live bijwerken: wijzigingen van de een verschijnen direct bij de ander
alter publication supabase_realtime add table public.tasks;
