-- Facturatie: producten, klanten, lotnummers, facturen, betaaloverzichten en nummering.
-- Facturen, klanten en nummering zijn alleen zichtbaar voor info@nmept.com.
-- Klanten, producten/prijzen en tellers staan NIET in deze (publieke) repository;
-- die worden eenmalig geladen met supabase/prive/seed-facturatie.sql (zie .gitignore).

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'info@nmept.com'
$$;
grant execute on function public.is_admin() to authenticated;

-- ---------- Producten ----------
create table if not exists public.products (
  code          text primary key,
  name          text not null,
  price         numeric(10,2) not null,
  vat           text not null default 'vrijgesteld',   -- 'vrijgesteld' of percentage, bijv. '21'
  lot_material  text,       -- tryin | pmma | tand | titanium | null
  lot_label     text,       -- tekst op de factuur, bijv. 'Lotnummer PMMA'
  ce            boolean not null default false,
  stl           boolean not null default false,
  active        boolean not null default true,
  sort          int not null default 100,
  updated_at    timestamptz not null default now()
);
alter table public.products enable row level security;
drop policy if exists "Ingelogd mag producten lezen" on public.products;
create policy "Ingelogd mag producten lezen" on public.products for select to authenticated using (true);
drop policy if exists "Beheerder beheert producten" on public.products;
create policy "Beheerder beheert producten" on public.products for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.products to authenticated;


-- ---------- Klanten ----------
create table if not exists public.customers (
  id          text primary key,           -- klantnummer, bijv. K00002
  company     text not null,
  short_name  text,                   -- korte naam voor betaaloverzicht en mapnamen
  contact     text,
  email       text,
  address     text,
  postcode    text,
  city        text,
  country     text not null default 'Nederland',
  phone       text,
  kvk         text,
  vat_number  text,
  default_vat text not null default 'vrijgesteld',
  planner     boolean not null default false,   -- opdrachten uit de planner worden aan deze klant gefactureerd
  updated_at  timestamptz not null default now()
);
alter table public.customers enable row level security;
drop policy if exists "Alleen beheerder" on public.customers;
create policy "Alleen beheerder" on public.customers for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.customers to authenticated;


-- ---------- Lotnummers ----------
-- material: tryin | pmma | titanium | tand:A1 | tand:A2 | ... (tandenboog per tandkleur)
-- Het actieve lotnummer per materiaal is de rij met de laatste activated_at.
create table if not exists public.lots (
  material      text not null,
  lot           text not null,
  created_at    timestamptz not null default now(),
  activated_at  timestamptz not null default now(),
  created_by    text,
  primary key (material, lot)
);
alter table public.lots enable row level security;
drop policy if exists "Ingelogd mag lotnummers lezen" on public.lots;
create policy "Ingelogd mag lotnummers lezen" on public.lots for select to authenticated using (true);
drop policy if exists "Beheerder beheert lotnummers" on public.lots;
create policy "Beheerder beheert lotnummers" on public.lots for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.lots to authenticated;

insert into public.lots (material, lot, created_by) values
  ('pmma', '260127', 'import'),
  ('tryin', '260117', 'import'),
  ('titanium', 'LH-21128', 'import')
on conflict do nothing;

-- ---------- Facturen ----------
create table if not exists public.invoices (
  id            text primary key,
  customer_id   text not null references public.customers(id),
  status        text not null default 'concept' check (status in ('concept','geaccepteerd','verstuurd')),
  kind          text not null default 'los',     -- patient | tryin | lepel | los
  open_key      text unique,                     -- alleen gevuld bij een open verzamelfactuur
  number        text unique,                     -- toegekend bij accepteren
  invoice_date  date,
  due_date      date,
  payment_ref   text,
  lines         jsonb not null default '[]',
  total         numeric(10,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  sent_at       timestamptz
);
alter table public.invoices enable row level security;
drop policy if exists "Alleen beheerder" on public.invoices;
create policy "Alleen beheerder" on public.invoices for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.invoices to authenticated;

-- ---------- Betaaloverzichten ----------
create table if not exists public.payment_overviews (
  ref              text primary key,       -- bijv. 202623
  customer_id      text not null references public.customers(id),
  created_at       timestamptz not null default now(),
  period_from      date,
  period_to        date,
  total            numeric(10,2) not null default 0,
  invoice_numbers  text[] not null default '{}'
);
alter table public.payment_overviews enable row level security;
drop policy if exists "Alleen beheerder" on public.payment_overviews;
create policy "Alleen beheerder" on public.payment_overviews for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.payment_overviews to authenticated;

-- ---------- Nummering ----------
create table if not exists public.counters (
  key    text not null,     -- invoice | payref
  year   int  not null,
  value  int  not null,
  primary key (key, year)
);
alter table public.counters enable row level security;
drop policy if exists "Alleen beheerder" on public.counters;
create policy "Alleen beheerder" on public.counters for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.counters to authenticated;


-- Volgend nummer ophalen (atomair, ook als twee apparaten tegelijk accepteren)
create or replace function public.next_counter(p_key text, p_year int) returns int
language plpgsql security invoker as $$
declare v int;
begin
  insert into public.counters (key, year, value) values (p_key, p_year, 1)
  on conflict (key, year) do update set value = public.counters.value + 1
  returning value into v;
  return v;
end $$;
grant execute on function public.next_counter(text, int) to authenticated;
