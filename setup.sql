-- Rüdigers Runden: Datenbank einrichten
-- In Supabase unter "SQL Editor" komplett einfügen und auf "Run" klicken.

create table if not exists public.walks (
  id           uuid primary key default gen_random_uuid(),
  day          date        not null,           -- Gassi-Tag (4:00 bis 4:00 Uhr)
  slot         smallint    not null check (slot between 1 and 4),
  walkers      text[]      not null default '{}', -- wer dabei war, mehrere = zusammen
  started_at   timestamptz,                    -- Beginn der Runde
  ended_at     timestamptz,                    -- Ende (leer = Runde läuft gerade)
  duration_min smallint,
  estimated    boolean     not null default false, -- per "Erledigt" mit Durchschnittswerten eingetragen
  poo          boolean     not null default false, -- Häufchen
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid        default auth.uid(),
  unique (day, slot)
);

-- Zugriff nur für angemeldete Nutzer (ihr beide)
alter table public.walks enable row level security;

drop policy if exists "Familie liest" on public.walks;
drop policy if exists "Familie schreibt" on public.walks;

create policy "Familie liest" on public.walks
  for select to authenticated using (true);

create policy "Familie schreibt" on public.walks
  for all to authenticated using (true) with check (true);

-- Zugriff über die Schnittstelle erlauben (bei neuen Supabase-Projekten Pflicht)
grant select, insert, update, delete on public.walks to authenticated;
revoke all on public.walks from anon;

-- Live-Abgleich zwischen den Handys
do $$
begin
  alter publication supabase_realtime add table public.walks;
exception when duplicate_object then null;
end $$;
