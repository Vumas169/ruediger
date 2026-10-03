-- Update 3: Push-Benachrichtigungen.
-- Einmalig im Supabase SQL Editor ausführen. Kann gefahrlos mehrfach ausgeführt werden.

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
