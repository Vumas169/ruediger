// Rüdigers Runden: Server-Funktion für Push-Benachrichtigungen (Supabase Edge Function "reminders").
// Wird alle 15 Minuten per Cron aufgerufen und schickt fällige Termin-Erinnerungen an alle angemeldeten Handys.
// Aktionen (POST-Body): {action:"run"} Erinnerungen prüfen, {action:"key"} öffentlichen Schlüssel holen,
// {action:"test", endpoint} Testnachricht an ein Handy.
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
type Sub = { endpoint: string; sub: webpush.PushSubscription };

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

async function runReminders() {
  const keys = await getKeys();
  const now = new Date();
  const nowL = local(now);
  const lowL = local(new Date(now.getTime() - 36 * 3600 * 1000)); // ältere verpasste Erinnerungen nicht nachsenden
  const { data: aps, error } = await sb.from("app_data").select("id, data").eq("kind", "appointment");
  if (error) throw error;
  const { data: subs } = await sb.from("push_subs").select("endpoint, sub");
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
