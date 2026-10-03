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
  poo          smallint    not null default 0,     -- Anzahl Häufchen
  note         text,
  paused_at    timestamptz,                    -- Pause läuft seit
  pause_sec    integer     not null default 0, -- Summe der Pausen in Sekunden
  extra        jsonb       not null default '{}'::jsonb,
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

-- Termine und künftige Funktionen
create table if not exists public.app_data (
  id         uuid primary key,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.app_data enable row level security;
drop policy if exists "Familie liest" on public.app_data;
drop policy if exists "Familie schreibt" on public.app_data;
create policy "Familie liest" on public.app_data for select to authenticated using (true);
create policy "Familie schreibt" on public.app_data for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.app_data to authenticated;
revoke all on public.app_data from anon;
do $$
begin
  alter publication supabase_realtime add table public.app_data;
exception when duplicate_object then null;
end $$;

-- Push-Benachrichtigungen
-- Erweiterungen für den Zeitplan und Web-Aufrufe aus der Datenbank
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Angemeldete Handys (eine Zeile je Handy)
create table if not exists public.push_subs (
  endpoint   text primary key,
  sub        jsonb not null,
  walker     text,
  user_id    uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "Familie verwaltet Handys" on public.push_subs;
create policy "Familie verwaltet Handys" on public.push_subs for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.push_subs to authenticated;
revoke all on public.push_subs from anon;

-- Schlüssel für den Versand (nur für die Server-Funktion lesbar)
create table if not exists public.push_keys (
  id          integer primary key,
  public_key  text not null,
  private_key text not null
);
alter table public.push_keys enable row level security;
revoke all on public.push_keys from anon, authenticated;

-- Protokoll, damit jede Erinnerung nur einmal kommt
create table if not exists public.push_log (
  key     text primary key,
  sent_at timestamptz not null default now()
);
alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

-- Server-Funktion darf alles lesen und schreiben
grant select, insert, update, delete on public.push_subs, public.push_keys, public.push_log, public.app_data, public.walks to service_role;

-- Alle 15 Minuten nach fälligen Erinnerungen schauen
select cron.schedule(
  'ruediger-erinnerungen',
  '*/15 * * * *',
  $$ select net.http_post(
       url := 'https://tuaffkmvurmjiirloupj.supabase.co/functions/v1/reminders',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{"action": "run"}'::jsonb
     ); $$
);
