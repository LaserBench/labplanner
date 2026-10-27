-- Patiënten als eigen tabel: één rij per patiëntnummer.
-- Opdrachten (tasks) verwijzen naar een patiënt via data->>'patientNr'.
-- Basis voor facturen per patiënt.

create table if not exists public.patients (
  nr            text primary key,
  name          text not null default '',
  created_at    timestamptz not null default now(),
  created_by    text,
  last_used_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.patients enable row level security;

drop policy if exists "Ingelogde gebruikers mogen alles" on public.patients;
create policy "Ingelogde gebruikers mogen alles"
  on public.patients
  for all
  to authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on public.patients to authenticated;

-- Bestaande opdrachten: patiënten eruit overnemen (laatst gebruikte naam wint)
insert into public.patients (nr, name, created_at, created_by, last_used_at)
select distinct on (data->>'patientNr')
  data->>'patientNr',
  coalesce(data->>'patientName', ''),
  coalesce((data->>'createdAt')::timestamptz, now()),
  data->>'createdBy',
  coalesce((data->>'updatedAt')::timestamptz, now())
from public.tasks
where coalesce(data->>'patientNr', '') <> ''
order by data->>'patientNr', data->>'updatedAt' desc nulls last
on conflict (nr) do nothing;

-- Live bijwerken
alter publication supabase_realtime add table public.patients;
