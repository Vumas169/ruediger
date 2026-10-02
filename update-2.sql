-- Update 2: Pause-Funktion, Rüdigers Termine und Platz für künftige Erweiterungen.
-- Einmalig im Supabase SQL Editor ausführen. Kann gefahrlos mehrfach ausgeführt werden.

-- Häufchen als Anzahl (falls update-haeufchen.sql noch nicht gelaufen ist)
do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'walks' and column_name = 'poo') = 'boolean' then
    alter table public.walks alter column poo drop default;
    alter table public.walks alter column poo type smallint using (case when poo then 1 else 0 end);
    alter table public.walks alter column poo set default 0;
  end if;
end $$;

-- Pause beim Gassi gehen
alter table public.walks add column if not exists paused_at timestamptz;
alter table public.walks add column if not exists pause_sec integer not null default 0;
-- Freies Zusatzfeld, damit künftige Funktionen keine Datenbankänderung mehr brauchen
alter table public.walks add column if not exists extra jsonb not null default '{}'::jsonb;

-- Allgemeine Ablage für Termine und künftige Funktionen
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
