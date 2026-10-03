// Rüdigers Runden: Server-Funktion für Push-Benachrichtigungen (Supabase Edge Function "reminders").
// Wird alle 15 Minuten per Cron aufgerufen und schickt fällige Termin-Erinnerungen an alle angemeldeten Handys.
// Aktionen (POST-Body): {action:"run"} Erinnerungen prüfen, {action:"key"} öffentlichen Schlüssel holen,
// {action:"test", endpoint} Testnachricht an ein Handy, {action:"notify", id, by} neuer Termin an die anderen.
// "test" und "notify" erfordern eine Anmeldung in der App.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const TZ = "Europe/Berlin";
const APP_URL = "https://vumas169.github.io/ruediger/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TYPES: Record<string, [string, string]> = {
  tick: ["🕷️", "Zeckenschutz"], worm: ["🪱", "Wurmkur"], fecal: ["🔬", "Kotprobe"],
  allergy: ["💊", "Allergietablette"], vacc_shp: ["💉", "Impfung Staupe/Parvo/HCC"],
  vacc_lepto: ["💉", "Impfung Leptospirose"], vacc_rabies: ["💉", "Impfung Tollwut"],
  vacc_kennel: ["💉", "Impfung Zwingerhusten"], checkup: ["🩺", "Tierarzt-Check"],
  claws: ["✂️", "Krallen schneiden"], custom: ["📅", "Termin"],
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Keys = { public_key: string; private_key: string };
type Sub = { endpoint: string; sub: webpush.PushSubscription; walker?: string | null };

// Schlüsselpaar einmalig selbst erzeugen und in einer geschützten Tabelle ablegen
async function getKeys(): Promise<Keys> {
  const { data } = await sb.from("push_keys").select("public_key, private_key").eq("id", 1).maybeSingle();
  if (data) return data as Keys;
  const k = webpush.generateVAPIDKeys();
  const row = { id: 1, public_key: k.publicKey, private_key: k.privateKey };
  const { error } = await sb.from("push_keys").insert(row);
  if (error) {
    const again = await sb.from("push_keys").select("public_key, private_key").eq("id", 1).single();
    if (again.error) throw again.error;
    return again.data as Keys;
  }
  return row;
}

// Ortszeit als "YYYY-MM-DDTHH:MM", damit Vergleiche ohne Zeitzonen-Rechnerei gehen
function local(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function fmtDM(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

async function send(sub: Sub, payload: Record<string, unknown>, keys: Keys): Promise<number> {
  const d = webpush.generateRequestDetails(sub.sub, JSON.stringify(payload), {
    vapidDetails: { subject: APP_URL, publicKey: keys.public_key, privateKey: keys.private_key },
    TTL: 60 * 60 * 24,
  });
  const res = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body });
  if (res.status === 404 || res.status === 410) await sb.from("push_subs").delete().eq("endpoint", sub.endpoint);
  return res.status;
}

// Ortszeit-Text um Minuten verschieben (rechnet die Ortszeit wie UTC, das ist für Differenzen exakt)
function shiftLocal(l: string, minutes: number): string {
  return new Date(new Date(l + ":00Z").getTime() + minutes * 60000).toISOString().slice(0, 16);
}
function stepRepeat(base: string, freq: string, n: number): string {
  const [y, m, d] = base.split("-").map(Number);
  if (freq === "d") return addDays(base, n);
  if (freq === "w") return addDays(base, 7 * n);
  if (freq === "2w") return addDays(base, 14 * n);
  if (freq === "m" || freq === "y") {
    const months = freq === "m" ? n : 12 * n;
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0, 10);
  }
  return base;
}
// Startdaten der Vorkommen eines Kalendertermins zwischen from und to
function occurrences(ev: Record<string, any>, from: string, to: string): string[] {
  const out: string[] = [];
  const base = String(ev.start).slice(0, 10);
  const freq = ev.repeat && ev.repeat.freq && ev.repeat.freq !== "0" ? ev.repeat.freq : null;
  const until = freq && ev.repeat.until ? ev.repeat.until : null;
  const ex = new Set(ev.exdates || []);
  const pause = freq && ev.pause && ev.pause.from && ev.pause.to ? ev.pause : null;
  for (let n = 0; n < 4000; n++) {
    const cur = freq ? stepRepeat(base, freq, n) : base;
    if (cur > to || (until && cur > until)) break;
    const paused = pause && cur >= pause.from && cur <= pause.to;
    if (cur >= from && !ex.has(cur) && !paused) out.push(cur);
    if (!freq) break;
  }
  return out;
}
// Text für "X Minuten vorher", passend für beliebige eigene Werte
function relText(off: number, allDay: boolean): string {
  if (off === 0) return allDay ? "Heute" : "Jetzt";
  if (off === 1440) return "Morgen";
  if (off === 10080) return "In einer Woche";
  if (off % 1440 === 0) return `In ${off / 1440} Tagen`;
  if (off % 60 === 0) return off === 60 ? "In 1 Stunde" : `In ${off / 60} Stunden`;
  if (off > 60) return `In ${Math.floor(off / 60)} Std. ${off % 60} Min.`;
  return `In ${off} Minuten`;
}
const forWho = (subs: Sub[], who: string[] | undefined) =>
  !who || !who.length ? subs : subs.filter((s) => !s.walker || who.includes(s.walker));
function evWhen(ev: Record<string, any>, day: string): string {
  if (ev.allDay) return fmtDM(day) + ", ganztägig";
  return fmtDM(day) + ", " + String(ev.start).slice(11, 16) + " Uhr";
}

async function runReminders() {
  const keys = await getKeys();
  const now = new Date();
  const nowL = local(now);
  const lowL = local(new Date(now.getTime() - 36 * 3600 * 1000)); // ältere verpasste Erinnerungen nicht nachsenden
  const { data: aps, error } = await sb.from("app_data").select("id, data").eq("kind", "appointment");
  if (error) throw error;
  const { data: subs } = await sb.from("push_subs").select("endpoint, sub, walker");
  if (!subs || !subs.length) return { sent: 0, subs: 0 };

  let sent = 0;
  for (const ap of aps || []) {
    const d = ap.data || {};
    if (d.archived || !d.due) continue;
    for (const off of (d.remind || []) as number[]) {
      const moment = `${addDays(d.due, -off)}T${d.time || "08:00"}`;
      if (moment > nowL || moment < lowL) continue;
      const key = `${ap.id}|${d.due}|${off}`;
      const ins = await sb.from("push_log").upsert({ key }, { onConflict: "key", ignoreDuplicates: true }).select();
      if (ins.error || !ins.data || !ins.data.length) continue; // schon verschickt
      const [icon, typeName] = TYPES[d.type] || TYPES.custom;
      const name = d.name || typeName;
      const at = d.time ? ` um ${d.time} Uhr` : "";
      const body = off === 0 ? `Heute fällig${at}.`
        : off === 1 ? `Morgen fällig${at}.`
        : off === 7 ? `In einer Woche fällig (${fmtDM(d.due)}${at}).`
        : `In ${off} Tagen fällig (${fmtDM(d.due)}${at}).`;
      for (const s of subs as Sub[]) {
        try { await send(s, { title: `${icon} ${name}`, body, tag: key, url: "./#care" }, keys); sent++; } catch (_) { /* nächstes Handy */ }
      }
    }
  }
  // Kalendertermine: Erinnerung X Minuten vor Beginn, ganztägige ab 8 Uhr am Tag
  const { data: evs } = await sb.from("app_data").select("id, data").eq("kind", "event");
  const today = nowL.slice(0, 10);
  for (const row of evs || []) {
    const ev = row.data || {};
    if (!ev.start || !(ev.remind || []).length) continue;
    const maxOff = Math.max(...(ev.remind as number[]));
    for (const day of occurrences(ev, addDays(today, -2), addDays(today, Math.ceil(maxOff / 1440) + 2))) {
      const startL = ev.allDay ? `${day}T08:00` : `${day}T${String(ev.start).slice(11, 16)}`;
      for (const off of ev.remind as number[]) {
        const moment = shiftLocal(startL, -off);
        if (moment > nowL || moment < lowL) continue;
        const key = `ev|${row.id}|${day}|${off}`;
        const ins = await sb.from("push_log").upsert({ key }, { onConflict: "key", ignoreDuplicates: true }).select();
        if (ins.error || !ins.data || !ins.data.length) continue;
        const rel = relText(off, !!ev.allDay);
        const body = `${rel}: ${evWhen(ev, day)}` + (ev.location ? ` · ${ev.location}` : "");
        for (const s of forWho(subs as Sub[], ev.who)) {
          try { await send(s, { title: `📅 ${ev.title || "Termin"}`, body, tag: key, url: "./#cal" }, keys); sent++; } catch (_) { /* weiter */ }
        }
      }
    }
  }
  // Protokoll klein halten
  await sb.from("push_log").delete().lt("sent_at", new Date(now.getTime() - 120 * 86400 * 1000).toISOString());
  return { sent, subs: subs.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "run";
    if (action === "key") return json({ publicKey: (await getKeys()).public_key });
    // Nachrichten an Handys nur für angemeldete Nutzer der App (Registrierung ist abgeschaltet)
    if (action === "notify" || action === "test") {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = token ? await sb.auth.getUser(token) : { data: { user: null } };
      if (!u || !u.user) return json({ ok: false, error: "Nicht angemeldet." }, 401);
    }
    if (action === "notify") {
      // Neuer Termin: die anderen Beteiligten informieren
      const { data: row } = await sb.from("app_data").select("data").eq("id", body.id).eq("kind", "event").maybeSingle();
      if (!row) return json({ ok: false }, 404);
      const ev = row.data || {};
      const { data: subs } = await sb.from("push_subs").select("endpoint, sub, walker");
      const targets = forWho((subs || []) as Sub[], ev.who).filter((s) => s.walker && s.walker !== body.by);
      const keys = await getKeys();
      const day = String(ev.start).slice(0, 10);
      for (const s of targets) {
        try {
          await send(s, { title: `📅 Neuer Termin von ${body.by || "jemandem"}`, body: `${ev.title || "Termin"} · ${evWhen(ev, day)}` + (ev.location ? ` · ${ev.location}` : ""), tag: `new|${body.id}`, url: "./#cal" }, keys);
        } catch (_) { /* weiter */ }
      }
      return json({ ok: true, sent: targets.length });
    }
    if (action === "test") {
      const { data } = await sb.from("push_subs").select("endpoint, sub").eq("endpoint", body.endpoint).maybeSingle();
      if (!data) return json({ ok: false, error: "Dieses Handy ist nicht angemeldet." }, 404);
      const status = await send(data as Sub, { title: "🐶 Rüdiger", body: "Benachrichtigungen funktionieren.", tag: "test", url: "./" }, await getKeys());
      return json({ ok: status >= 200 && status < 300, status });
    }
    return json(await runReminders());
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
