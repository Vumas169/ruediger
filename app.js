/* Rüdigers Runden: App-Logik
   Daten liegen lokal auf dem Handy (funktioniert auch ohne Netz) und werden,
   wenn Supabase eingerichtet ist, mit der gemeinsamen Datenbank abgeglichen. */
(() => {
  "use strict";

  const APP_VERSION = "10 vom 03.10.2026";

  // ---------- Einstellungen ----------
  const CFG = Object.assign({
    WALKERS: ["Christopher", "Kim"],
    ROUNDS: [
      { name: "Morgens", time: "07:00" },
      { name: "Mittags", time: "12:30" },
      { name: "Abends", time: "18:00" },
      { name: "Letzte Runde", time: "22:30" }
    ],
    DEFAULT_MINUTES: 30,
    DAY_START_HOUR: 4,
    PUSH_FUNCTION: "reminders"
  }, window.GASSI_CONFIG || {});
  const ROUNDS = CFG.ROUNDS;
  const NR = ROUNDS.length;
  const HAS_DB = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase && window.supabase.createClient);
  const DEMO = !HAS_DB;
  const TOGETHER = "Zusammen";
  const PERIODS = [
    { id: "3", label: "3 Tage", days: 3 },
    { id: "7", label: "7 Tage", days: 7 },
    { id: "30", label: "30 Tage", days: 30 },
    { id: "all", label: "Gesamt", days: 0 }
  ];

  // Regelmäßige Behandlungen. Abstände sind Vorschläge und lassen sich je Termin ändern.
  const CARE_TYPES = [
    { id: "tick", icon: "🕷️", name: "Zeckenschutz", every: 1, unit: "m",
      hint: "Abstand hängt vom Mittel ab: Spot-on und viele Tabletten monatlich, manche Tabletten alle 12 Wochen, Halsbänder mehrere Monate." },
    { id: "worm", icon: "🪱", name: "Wurmkur", every: 3, unit: "m",
      hint: "Ohne genaue Risikoeinschätzung empfiehlt ESCCAP mindestens 4 Entwurmungen oder Kotuntersuchungen pro Jahr." },
    { id: "fecal", icon: "🔬", name: "Kotprobe", every: 3, unit: "m",
      hint: "Alternative zur Wurmkur: Kot untersuchen lassen und nur bei Befund entwurmen." },
    { id: "allergy", icon: "💊", name: "Allergietablette", every: 1, unit: "d", remind: [0],
      hint: "Abstand nach Vorgabe des Tierarztes einstellen." },
    { id: "vacc_shp", icon: "💉", name: "Impfung Staupe/Parvo/HCC", every: 3, unit: "y",
      hint: "Nach der Grundimmunisierung je nach Impfstoff bis zu alle 3 Jahre." },
    { id: "vacc_lepto", icon: "💉", name: "Impfung Leptospirose", every: 1, unit: "y",
      hint: "Wird jährlich aufgefrischt." },
    { id: "vacc_rabies", icon: "💉", name: "Impfung Tollwut", every: 3, unit: "y",
      hint: "Je nach Impfstoff alle 1 bis 3 Jahre. Für Reisen ins Ausland muss sie gültig im Heimtierausweis stehen." },
    { id: "vacc_kennel", icon: "💉", name: "Impfung Zwingerhusten", every: 1, unit: "y",
      hint: "Jährlich, sinnvoll bei viel Hundekontakt oder Hundepension." },
    { id: "checkup", icon: "🩺", name: "Tierarzt-Check", every: 1, unit: "y",
      hint: "Jährliche Untersuchung, oft zusammen mit den Impfungen." },
    { id: "claws", icon: "✂️", name: "Krallen schneiden", every: 6, unit: "w", hint: "" },
    { id: "custom", icon: "📅", name: "Eigener Termin", every: 0, unit: "0", hint: "" }
  ];
  const careType = (id) => CARE_TYPES.find((t) => t.id === id) || CARE_TYPES[CARE_TYPES.length - 1];
  const REMIND_OPTS = [{ d: 7, label: "1 Woche vorher" }, { d: 3, label: "3 Tage vorher" }, { d: 1, label: "1 Tag vorher" }, { d: 0, label: "Am Tag" }];
  const UNIT_WORD = { d: ["Tag", "Tage"], w: ["Woche", "Wochen"], m: ["Monat", "Monate"], y: ["Jahr", "Jahre"] };

  // ---------- Lokaler Speicher ----------
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } }
  };
  const P = DEMO ? "rr.demo5." : "rr.";
  let walks = ls.get(P + "walks", {});      // "YYYY-MM-DD|slot" -> Runde
  let items = ls.get(P + "items", {});      // id -> { id, kind, data, updated_at }
  let pending = ls.get(P + "pending", []);  // noch nicht abgeglichene Änderungen
  let lastSync = ls.get(P + "lastSync", null);
  let me = ls.get("rr.me", CFG.WALKERS[0]);
  if (!CFG.WALKERS.includes(me)) me = CFG.WALKERS[0];
  let period = ls.get("rr.period", "7");
  for (const r of Object.values(walks)) normalize(r);

  let sb = null, session = null, syncing = false, syncError = null;
  let view = "today";
  let lastToday = todayStr();
  let viewDay = lastToday;
  let editing = null;   // { day, slot, newSlot }
  let sheetWalkers = [me], sheetPoo = 0, deleteArmed = false;
  let apEditing = null, apRemind = [7, 3, 1], apDeleteArmed = false;

  const $ = (id) => document.getElementById(id);
  const key = (day, slot) => day + "|" + slot;
  function opKey(op) {
    if (op.op === "delete") return key(op.day, op.slot);
    if (op.op === "upsert") return key(op.rec.day, op.rec.slot);
    return "item|" + (op.item ? op.item.id : op.id);
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));

  // Farben: Christopher gelb, Kim lila, zusammen blau
  function walkerColor(w) {
    if (w === TOGETHER) return "var(--c-both)";
    const i = CFG.WALKERS.indexOf(w);
    return i < 0 ? "var(--muted)" : "var(--c" + ((i % 2) + 1) + ")";
  }
  function walkerInk(w) {
    if (w === TOGETHER) return "var(--c-both-ink)";
    const i = CFG.WALKERS.indexOf(w);
    return i < 0 ? "#fff" : "var(--c" + ((i % 2) + 1) + "-ink)";
  }
  const recColorKey = (r) => isTogether(r) ? TOGETHER : r.walkers[0];

  // Ältere Einträge an das aktuelle Format anpassen
  function normalize(r) {
    if (!r) return r;
    if (!Array.isArray(r.walkers)) r.walkers = r.walker ? [r.walker] : [];
    delete r.walker;
    r.poo = Number(r.poo) || 0;
    r.pause_sec = Number(r.pause_sec) || 0;
    if (!r.paused_at) r.paused_at = null;
    if (!r.extra || typeof r.extra !== "object") r.extra = {};
    return r;
  }
  const isTogether = (r) => r.walkers.length > 1;
  const whoText = (r) => r.walkers.length ? r.walkers.join(" & ") : "ohne Namen";

  // ---------- Datum ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function addInterval(s, every, unit) {
    const d = parseYmd(s);
    if (unit === "d") d.setDate(d.getDate() + every);
    else if (unit === "w") d.setDate(d.getDate() + every * 7);
    else if (unit === "m") { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + every); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    else if (unit === "y") d.setFullYear(d.getFullYear() + every);
    return ymd(d);
  }
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  function gassiDay(date) {
    const d = new Date(date);
    if (d.getHours() < CFG.DAY_START_HOUR) d.setDate(d.getDate() - 1);
    return ymd(d);
  }
  function todayStr() { return gassiDay(new Date()); }
  const calToday = () => ymd(new Date());   // Kalendertag für Termine
  function hm(iso) { const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function combine(day, time) {
    const [h, m] = time.split(":").map(Number);
    const d = parseYmd(day);
    if (h < CFG.DAY_START_HOUR) d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const fmtDate = (s) => parseYmd(s).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  const fmtDateShort = (s) => parseYmd(s).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "long" });
  const fmtDay = (s) => parseYmd(s).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
  const fmtDM = (s) => parseYmd(s).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  const fmtNum = (n) => n.toLocaleString("de-DE");

  // ---------- Auswertung Runden ----------
  const isDone = (r) => !!(r && r.ended_at);
  const isRunning = (r) => !!(r && r.started_at && !r.ended_at);
  const isPaused = (r) => isRunning(r) && !!r.paused_at;
  function minutesOf(r) {
    if (r.duration_min != null) return r.duration_min;
    if (r.started_at && r.ended_at) return Math.max(0, Math.round(((new Date(r.ended_at) - new Date(r.started_at)) / 1000 - (r.pause_sec || 0)) / 60));
    return 0;
  }
  // Reine Gehzeit in Sekunden (ohne Pausen)
  function activeSec(r, now) {
    const t = now || Date.now();
    let s = (t - new Date(r.started_at)) / 1000 - (r.pause_sec || 0);
    if (r.paused_at) s -= (t - new Date(r.paused_at)) / 1000;
    return Math.max(0, Math.floor(s));
  }
  function dayStats(day) {
    let rounds = 0, mins = 0;
    for (let s = 1; s <= NR; s++) { const r = walks[key(day, s)]; if (isDone(r)) { rounds++; mins += minutesOf(r); } }
    return { rounds, mins };
  }
  function history(slot) {
    const t = todayStr(), out = [];
    for (let i = 1; i <= 30; i++) {
      const r = walks[key(addDays(t, -i), slot)];
      if (isDone(r) && !r.estimated && minutesOf(r) > 0) out.push(r);
    }
    return out;
  }
  function avgDuration(slot) {
    const list = history(slot);
    if (!list.length) return CFG.DEFAULT_MINUTES;
    return Math.round(list.reduce((a, r) => a + minutesOf(r), 0) / list.length);
  }
  function typicalStart(slot) {
    const offs = history(slot).filter((r) => r.started_at).map((r) => {
      const d = new Date(r.started_at);
      return ((d.getHours() - CFG.DAY_START_HOUR + 24) % 24) * 60 + d.getMinutes();
    });
    if (!offs.length) return ROUNDS[slot - 1].time;
    const avg = Math.round(offs.reduce((a, b) => a + b, 0) / offs.length);
    const mins = (avg + CFG.DAY_START_HOUR * 60) % 1440;
    return pad(Math.floor(mins / 60)) + ":" + pad(mins % 60);
  }

  // ---------- Auswertung Termine ----------
  const appointments = () => Object.values(items).filter((i) => i.kind === "appointment" && !i.data.archived);
  const apDays = (ap) => daysBetween(calToday(), ap.data.due);
  const apTitle = (ap) => ap.data.name || careType(ap.data.type).name;
  // Vorne unter "Heute" nur, was in weniger als einer Woche fällig ist (oder überfällig)
  function apActive(ap) {
    const d = apDays(ap);
    if (d <= 0) return true;
    if (d >= 7) return false;
    const r = ap.data.remind || [];
    return r.length ? d <= Math.max(...r) : false;
  }
  function apStatus(ap) {
    const d = apDays(ap);
    if (d < 0) return { text: "überfällig seit " + (-d === 1 ? "1 Tag" : -d + " Tagen"), cls: "late" };
    if (d === 0) return { text: "heute fällig" + (ap.data.time ? " um " + ap.data.time + " Uhr" : ""), cls: "now" };
    if (d === 1) return { text: "morgen" + (ap.data.time ? " um " + ap.data.time + " Uhr" : ""), cls: "soon" };
    return { text: "in " + d + " Tagen · " + fmtDM(ap.data.due), cls: d <= 7 ? "soon" : "" };
  }
  function everyText(d) {
    if (!d.unit || d.unit === "0" || !d.every) return "einmalig";
    const w = UNIT_WORD[d.unit];
    return d.every === 1 ? (d.unit === "d" ? "täglich" : "jede" + (d.unit === "w" ? " Woche" : d.unit === "m" ? "n Monat" : "s Jahr"))
      : "alle " + d.every + " " + w[1];
  }

  // ---------- Speichern ----------
  function persist() { ls.set(P + "walks", walks); ls.set(P + "items", items); ls.set(P + "pending", pending); }
  function queue(op) { const k = opKey(op); pending = pending.filter((p) => opKey(p) !== k); pending.push(op); }

  function saveRec(rec) {
    rec.updated_at = new Date().toISOString();
    walks[key(rec.day, rec.slot)] = normalize(rec);
    if (!DEMO) queue({ op: "upsert", rec });
    persist(); render(); flush();
  }
  function deleteRec(day, slot, quiet) {
    delete walks[key(day, slot)];
    if (!DEMO) queue({ op: "delete", day, slot });
    if (quiet) return;
    persist(); render(); flush();
  }
  function saveItem(item) {
    item.updated_at = new Date().toISOString();
    items[item.id] = item;
    if (!DEMO) queue({ op: "item", item });
    persist(); render(); flush();
  }
  function deleteItem(id) {
    delete items[id];
    if (!DEMO) queue({ op: "itemDel", id });
    persist(); render(); flush();
  }

  // ---------- Abgleich mit Supabase ----------
  function rowFor(r) {
    return {
      day: r.day, slot: r.slot, walkers: r.walkers || [],
      started_at: r.started_at || null, ended_at: r.ended_at || null,
      duration_min: r.duration_min == null ? null : r.duration_min,
      estimated: !!r.estimated, poo: Number(r.poo) || 0, note: r.note || null,
      paused_at: r.paused_at || null, pause_sec: Number(r.pause_sec) || 0, extra: r.extra || {},
      updated_at: r.updated_at
    };
  }
  async function runOp(op) {
    if (op.op === "upsert") return sb.from("walks").upsert(rowFor(op.rec), { onConflict: "day,slot" });
    if (op.op === "delete") return sb.from("walks").delete().eq("day", op.day).eq("slot", op.slot);
    if (op.op === "item") return sb.from("app_data").upsert({ id: op.item.id, kind: op.item.kind, data: op.item.data, updated_at: op.item.updated_at });
    return sb.from("app_data").delete().eq("id", op.id);
  }
  async function flush() {
    if (DEMO || !session || syncing) return;
    if (!navigator.onLine) { render(); return; }
    syncing = true;
    try {
      while (pending.length) {
        const op = pending[0];
        const res = await runOp(op);
        if (res.error) throw res.error;
        pending = pending.filter((p) => p !== op);
        persist();
      }
      syncError = null;
    } catch (e) {
      syncError = (e && e.message) || String(e);
    } finally {
      syncing = false;
      render();
    }
  }
  async function fetchAll(table, order) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select("*").order(order).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
  async function pull() {
    if (DEMO || !session || !navigator.onLine) { render(); return; }
    await flush();
    const waiting = new Set(pending.map(opKey));
    let err = null;
    try {
      const data = await fetchAll("walks", "day");
      const next = {};
      for (const [k, r] of Object.entries(walks)) if (waiting.has(k)) next[k] = r;
      for (const r of data) { const k = key(r.day, r.slot); if (!waiting.has(k)) next[k] = normalize({ ...r }); }
      walks = next;
    } catch (e) { err = e; }
    try {
      const data = await fetchAll("app_data", "updated_at");
      const next = {};
      for (const [id, it] of Object.entries(items)) if (waiting.has("item|" + id)) next[id] = it;
      for (const r of data) if (!waiting.has("item|" + r.id)) next[r.id] = { id: r.id, kind: r.kind, data: r.data || {}, updated_at: r.updated_at };
      items = next;
    } catch (e) { err = err || e; }
    syncError = err ? ((err && err.message) || String(err)) : null;
    if (!err) { lastSync = new Date().toISOString(); ls.set(P + "lastSync", lastSync); }
    persist(); render();
  }
  let pullTimer = null;
  function schedulePull() { clearTimeout(pullTimer); pullTimer = setTimeout(pull, 300); }

  async function initDb() {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    try { const { data } = await sb.auth.getSession(); session = data.session; } catch { session = null; }
    showLogin(!session);
    applyLoginWalker();
    sb.auth.onAuthStateChange((_evt, s) => { session = s; showLogin(!s); if (s) { applyLoginWalker(); schedulePull(); } render(); });
    sb.channel("live")
      .on("postgres_changes", { event: "*", schema: "public", table: "walks" }, () => schedulePull())
      .on("postgres_changes", { event: "*", schema: "public", table: "app_data" }, () => schedulePull())
      .subscribe();
    if (session) schedulePull();
  }
  function showLogin(show) { $("login").hidden = !show; }

  // Wer bin ich? Gespeichert am Konto, sonst aus der E-Mail-Adresse erraten.
  function applyLoginWalker() {
    if (!session || !session.user) return;
    const saved = session.user.user_metadata && session.user.user_metadata.walker;
    let w = CFG.WALKERS.includes(saved) ? saved : null;
    if (!w) {
      const mail = (session.user.email || "").toLowerCase();
      w = CFG.WALKERS.find((n) => mail.includes(n.toLowerCase())) || null;
      if (w) saveWalkerToAccount(w);
    }
    if (w && w !== me) { me = w; ls.set("rr.me", w); render(); }
  }
  function saveWalkerToAccount(w) {
    if (!sb || !session) return;
    sb.auth.updateUser({ data: { walker: w } }).catch(() => {});
  }

  // ---------- Beispieldaten im Testmodus ----------
  function seedDemo() {
    if (ls.get(P + "seeded", false)) return;
    const t = todayStr();
    let seed = 11;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const base = [22, 45, 30, 12];
    for (let i = 90; i >= 0; i--) {
      const day = addDays(t, -i);
      ROUNDS.forEach((r, idx) => {
        const slot = idx + 1;
        if (i === 0 && slot > 1) return;
        if (rnd() > (slot === 4 ? 0.75 : 0.95)) return;
        const dur = Math.max(5, (base[idx] || 25) + Math.round((rnd() - 0.5) * 16));
        const s = new Date(new Date(combine(day, r.time)).getTime() + Math.round((rnd() - 0.5) * 50) * 60000);
        const x = rnd();
        const ws = x < 0.15 ? CFG.WALKERS.slice() : [CFG.WALKERS[x < 0.6 ? 0 : 1] || CFG.WALKERS[0]];
        walks[key(day, slot)] = normalize({
          day, slot, walkers: ws,
          started_at: s.toISOString(), ended_at: new Date(s.getTime() + dur * 60000).toISOString(),
          duration_min: dur, estimated: false, poo: rnd() < 0.45 ? (rnd() < 0.25 ? 2 : 1) : 0, note: "", updated_at: s.toISOString()
        });
      });
    }
    const ct = calToday();
    [["tick", 3, [7, 3, 1]], ["allergy", 0, [0]], ["worm", 24, [7, 3, 1]], ["vacc_lepto", 118, [7, 3, 1]]].forEach(([type, inDays, remind]) => {
      const c = careType(type);
      const id = uid();
      items[id] = { id, kind: "appointment", updated_at: new Date().toISOString(),
        data: { type, name: "", due: addDays(ct, inDays), time: "", every: c.every, unit: c.unit, remind, note: "", lastDone: null, history: [] } };
    });
    ls.set(P + "seeded", true);
    persist();
  }

  // ---------- Aktionen Runden ----------
  function startWalk(slot) {
    saveRec({ day: todayStr(), slot, walkers: [me], started_at: new Date().toISOString(), ended_at: null,
      duration_min: null, estimated: false, poo: 0, note: "", paused_at: null, pause_sec: 0 });
  }
  function pauseWalk(rec) { saveRec({ ...rec, paused_at: new Date().toISOString() }); }
  function resumeWalk(rec) {
    const add = Math.round((Date.now() - new Date(rec.paused_at)) / 1000);
    saveRec({ ...rec, paused_at: null, pause_sec: (rec.pause_sec || 0) + add });
  }
  function finished(rec, startIso) {
    const now = Date.now();
    let pause = rec.pause_sec || 0;
    if (rec.paused_at) pause += Math.round((now - new Date(rec.paused_at)) / 1000);
    const start = startIso || rec.started_at;
    const mins = Math.max(1, Math.round(((now - new Date(start)) / 1000 - pause) / 60));
    return { started_at: start, ended_at: new Date(now).toISOString(), duration_min: mins, pause_sec: pause, paused_at: null };
  }
  function stopWalk(rec) { saveRec({ ...rec, ...finished(rec) }); }
  function quickDone(day, slot) {
    const dur = avgDuration(slot);
    const usual = new Date(combine(day, typicalStart(slot)));
    const now = new Date();
    let start = usual;
    if (day === todayStr() && now > usual && now - usual < (dur + 120) * 60000) start = new Date(now.getTime() - dur * 60000);
    if (start > now) start = new Date(now.getTime() - dur * 60000);
    saveRec({ day, slot, walkers: [me], started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + dur * 60000).toISOString(),
      duration_min: dur, estimated: true, poo: 0, note: "", paused_at: null, pause_sec: 0 });
    toast(ROUNDS[slot - 1].name + " eingetragen: " + hm(start.toISOString()) + " Uhr, " + dur + " min");
  }
  function addPoo(rec) { saveRec({ ...rec, poo: (rec.poo || 0) + 1 }); }
  function toggleTogether(rec) {
    const first = rec.walkers[0] || me;
    const ws = isTogether(rec) ? [first] : [first, ...CFG.WALKERS.filter((w) => w !== first)];
    saveRec({ ...rec, walkers: ws });
  }

  // ---------- Aktionen Termine ----------
  function apDone(ap) {
    const today = calToday();
    const d = { ...ap.data, lastDone: today, history: [...(ap.data.history || []), today].slice(-50) };
    if (d.unit && d.unit !== "0" && d.every) {
      d.due = addInterval(today, d.every, d.unit);
      toast(apTitle(ap) + " erledigt. Nächster Termin: " + fmtDM(d.due));
    } else {
      d.archived = true;
      toast(apTitle(ap) + " erledigt");
    }
    saveItem({ ...ap, data: d });
  }

  function icsFor(ap) {
    const d = ap.data;
    const esc = (s) => String(s).replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
    const dt = d.due.replace(/-/g, "");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ruedigers Runden//DE", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:" + ap.id + "@ruediger", "DTSTAMP:" + stamp, "SUMMARY:" + esc("Rüdiger: " + apTitle(ap))];
    if (d.time) { L.push("DTSTART:" + dt + "T" + d.time.replace(":", "") + "00", "DURATION:PT30M"); }
    else { L.push("DTSTART;VALUE=DATE:" + dt, "DTEND;VALUE=DATE:" + addDays(d.due, 1).replace(/-/g, "")); }
    if (d.unit && d.unit !== "0" && d.every) {
      const f = { d: "DAILY", w: "WEEKLY", m: "MONTHLY", y: "YEARLY" }[d.unit];
      L.push("RRULE:FREQ=" + f + ";INTERVAL=" + d.every);
    }
    if (d.note) L.push("DESCRIPTION:" + esc(d.note));
    for (const days of d.remind || []) {
      // Ganztägig: Erinnerung um 8 Uhr am jeweiligen Tag
      const trig = d.time ? (days ? "-P" + days + "D" : "-PT1H") : (days ? "-P" + (days - 1) + "DT16H" : "PT8H");
      L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(apTitle(ap)), "TRIGGER:" + trig, "END:VALARM");
    }
    L.push("END:VEVENT", "END:VCALENDAR");
    return L.join("\r\n");
  }
  function exportIcs(ap) {
    const ics = icsFor(ap);
    const name = "ruediger-" + apTitle(ap).toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-") + ".ics";
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (ios) { location.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics); return; }
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- Bausteine ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v; else el.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) el.append(c);
    return el;
  }
  function button(label, cls, fn) { const b = h("button", { class: cls, type: "button" }, label); b.onclick = fn; return b; }
  function toggleBtn(label, cls, on, aria, fn) {
    const b = button(label, cls, fn);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", aria);
    return b;
  }
  function clock(sec) {
    const m = Math.floor(sec / 60);
    return m >= 60 ? Math.floor(m / 60) + ":" + pad(m % 60) + " h" : m + ":" + pad(sec % 60) + " min";
  }
  function metaNode(rec) {
    const span = h("span", { class: "rmeta" });
    if (!rec) { span.textContent = "Offen"; return span; }
    if (isRunning(rec)) {
      const live = h("span", { "data-run": "1", "data-start": rec.started_at, "data-pause": String(rec.pause_sec || 0), "data-paused": rec.paused_at || "" }, clock(activeSec(rec)));
      span.append(isPaused(rec) ? "Pause · " : "Läuft · ", live, isPaused(rec) ? " gelaufen" : "", " · " + whoText(rec));
      return span;
    }
    const parts = [];
    parts.push(rec.started_at ? hm(rec.started_at) + " Uhr" : "um " + hm(rec.ended_at) + " Uhr");
    const m = minutesOf(rec);
    if (m) parts.push((rec.estimated ? "ca. " : "") + m + " min");
    parts.push(whoText(rec));
    span.append(parts.join(" · "));
    if (rec.note) span.append(" · " + rec.note);
    return span;
  }

  // Karten für die vier Runden eines Tages. live = heute (▶, Pause, Erledigt), sonst Nachtragen (Ø, Genau).
  function renderRoundList(ol, day, live) {
    ol.textContent = "";
    ROUNDS.forEach((r, i) => {
      const slot = i + 1, rec = walks[key(day, slot)];
      const li = h("li", { class: "round" + (isDone(rec) ? " done" : isRunning(rec) ? " running" : "") + (isPaused(rec) ? " paused" : "") });
      if (rec) { li.style.setProperty("--wc", walkerColor(recColorKey(rec))); li.style.setProperty("--wc-ink", walkerInk(recColorKey(rec))); }
      li.append(h("span", { class: "num", "aria-hidden": "true" }, isDone(rec) ? "✓" : String(slot)));
      const body = h("button", { class: "rbody", type: "button", "aria-label": r.name + (rec ? " korrigieren" : " eintragen") });
      body.append(h("span", { class: "rname" }, r.name), metaNode(rec));
      body.onclick = () => openSheet(day, slot);
      li.append(body);
      const act = h("div", { class: "ractions" });
      const together = rec && CFG.WALKERS.length > 1
        ? toggleBtn("👥", "iconchip both", isTogether(rec), isTogether(rec) ? "Zusammen gegangen, antippen für allein" : "Zusammen gegangen?", () => toggleTogether(rec))
        : null;
      if (isRunning(rec)) {
        const pb = isPaused(rec)
          ? button("▶", "iconchip pause on", () => resumeWalk(rec))
          : button("⏸", "iconchip pause", () => pauseWalk(rec));
        pb.setAttribute("aria-label", isPaused(rec) ? "Weitergehen" : "Pause");
        const lp = toggleBtn("💩", "iconchip poo", rec.poo > 0, "Häufchen jetzt eintragen, bisher " + rec.poo, () => addPoo(rec));
        if (rec.poo > 1) lp.append(h("span", { class: "count" }, String(rec.poo)));
        act.append(together, pb, button("Stopp", "btn small run", () => stopWalk(rec)), lp);
      } else if (isDone(rec)) {
        const p = toggleBtn("💩", "iconchip poo", rec.poo > 0, "Häufchen dazuzählen, bisher " + rec.poo, () => addPoo(rec));
        if (rec.poo > 1) p.append(h("span", { class: "count" }, String(rec.poo)));
        act.append(together, p);
      } else if (live) {
        const s = button("▶", "btn small play", () => startWalk(slot));
        s.setAttribute("aria-label", "Runde starten (Zeit messen)");
        act.append(s, button("Erledigt", "btn small primary", () => quickDone(day, slot)));
      } else {
        act.append(button("Genau", "btn small", () => openSheet(day, slot, true)),
          button("Ø " + avgDuration(slot), "btn small primary", () => quickDone(day, slot)));
      }
      li.append(act);
      ol.append(li);
    });
  }

  // ---------- Push-Benachrichtigungen ----------
  let pushState = { supported: false, on: false, busy: false, msg: "" };
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function b64ToBytes(s) {
    const p = "=".repeat((4 - s.length % 4) % 4);
    const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function pushCall(body) {
    const { data, error } = await sb.functions.invoke(CFG.PUSH_FUNCTION, { body });
    if (error) throw new Error("Server-Funktion nicht erreichbar. Ist sie bei Supabase eingerichtet?");
    return data;
  }
  async function refreshPush() {
    pushState.supported = pushSupported();
    if (!pushState.supported) { pushState.on = false; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      pushState.on = !!sub && Notification.permission === "granted";
    } catch { pushState.on = false; }
  }
  async function enablePush() {
    pushState.busy = true; pushState.msg = ""; renderSettings();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Benachrichtigungen wurden nicht erlaubt. Das lässt sich in den Handy-Einstellungen für diese App ändern.");
      const { publicKey } = await pushCall({ action: "key" });
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      const { error } = await sb.from("push_subs").upsert({ endpoint: sub.endpoint, sub: sub.toJSON(), walker: me });
      if (error) throw new Error("Anmeldung des Handys hat nicht geklappt: " + error.message);
      pushState.msg = "";
    } catch (e) {
      pushState.msg = (e && e.message) || String(e);
    }
    pushState.busy = false;
    await refreshPush();
    renderSettings();
  }
  async function disablePush() {
    pushState.busy = true; pushState.msg = ""; renderSettings();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sb.from("push_subs").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      pushState.msg = "";
    } catch (e) { pushState.msg = (e && e.message) || String(e); }
    pushState.busy = false;
    await refreshPush();
    renderSettings();
  }
  async function testPush() {
    pushState.busy = true; pushState.msg = ""; renderSettings();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) throw new Error("Dieses Handy ist nicht angemeldet.");
      const r = await pushCall({ action: "test", endpoint: sub.endpoint });
      pushState.msg = r && r.ok ? "Test verschickt." : "Test hat nicht geklappt" + (r && r.error ? ": " + r.error : ".");
    } catch (e) { pushState.msg = (e && e.message) || String(e); }
    pushState.busy = false;
    renderSettings();
  }
  function renderPush() {
    const info = $("pushInfo"), tog = $("pushToggle"), test = $("pushTest");
    tog.hidden = true; test.hidden = true;
    if (DEMO) { info.textContent = "Im Testmodus nicht verfügbar."; return; }
    if (!session) { info.textContent = "Erst anmelden."; return; }
    if (!pushState.supported) {
      info.textContent = isIos() && !isStandalone()
        ? "Auf dem iPhone nur in der App vom Home-Bildschirm (ab iOS 16.4)."
        : "Dieser Browser unterstützt keine Benachrichtigungen.";
      return;
    }
    let t = pushState.on ? "An für dieses Handy." : "Aus für dieses Handy.";
    if (Notification.permission === "denied") t = "In den Handy-Einstellungen für diese App gesperrt. Dort erlauben, dann hier einschalten.";
    if (pushState.msg) t += " " + pushState.msg;
    info.textContent = t;
    tog.hidden = false;
    tog.disabled = pushState.busy;
    tog.textContent = pushState.on ? "Ausschalten" : "Einschalten";
    tog.className = "btn " + (pushState.on ? "ghost" : "primary");
    test.hidden = !pushState.on;
    test.disabled = pushState.busy;
  }

  // ---------- Darstellung ----------
  function render() {
    renderHeader();
    renderBadge();
    if (view === "today") renderToday();
    if (view === "history") renderHistory();
    if (view === "stats") renderStats();
    if (view === "care") renderCare();
    if (view === "settings") renderSettings();
  }

  const VIEW_TITLES = { history: "Verlauf", stats: "Statistik", care: "Rüdigers Termine", settings: "Optionen" };
  function renderHeader() {
    const t = todayStr();
    const compact = view !== "today";
    document.querySelector(".panel").classList.toggle("compact", compact);
    $("viewTitle").hidden = !compact;
    $("viewTitle").textContent = VIEW_TITLES[view] || "";
    document.querySelector(".daynav").hidden = compact;
    document.querySelector(".scorewrap").hidden = compact;
    $("dayEyebrow").textContent = viewDay === t ? "Heute" : viewDay === addDays(t, -1) ? "Gestern" : "Nachtragen";
    $("dayDate").textContent = fmtDateShort(viewDay);
    $("pickDay").max = t;
    $("pickDay").value = viewDay;
    $("nextDay").disabled = viewDay >= t;
    const ds = dayStats(viewDay);
    $("points").textContent = String(ds.mins);
    $("pointsOf").textContent = "Minuten draußen";
    $("roundsOf").textContent = ds.rounds + " von " + NR + " Runden";

    const C = 2 * Math.PI * 50, gap = 17, len = C / NR;
    let html = "";
    for (let i = 0; i < NR; i++) {
      const rec = walks[key(viewDay, i + 1)];
      const cls = isDone(rec) ? "seg-done" : isRunning(rec) ? "seg-run" : "seg-empty";
      const style = isDone(rec) ? ` style="stroke:${walkerColor(recColorKey(rec))}"` : "";
      html += `<circle class="${cls}"${style} cx="60" cy="60" r="50" stroke-dasharray="${(len - gap).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-(i * len + gap / 2)).toFixed(2)}"></circle>`;
    }
    $("ring").innerHTML = html;

    const st = $("status");
    let msg = "", warn = false;
    // Nur melden, wenn etwas nicht stimmt
    if (DEMO) { msg = "Testmodus"; warn = true; }
    else if (!navigator.onLine) { msg = "Offline, wird später abgeglichen"; warn = true; }
    else if (syncError) { msg = "Abgleich hat nicht geklappt"; warn = true; }
    st.textContent = msg;
    st.hidden = !msg;
    st.classList.toggle("warn", warn);
  }

  function renderBadge() {
    const n = appointments().filter(apActive).length;
    const b = $("careBadge");
    b.hidden = !n;
    b.textContent = String(n);
    try {
      if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (!n && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch { /* nicht unterstützt */ }
  }

  function renderToday() {
    const isToday = viewDay === todayStr();
    const rem = $("reminders");
    rem.textContent = "";
    if (isToday) {
      const act = appointments().filter(apActive).sort((a, b) => a.data.due.localeCompare(b.data.due));
      for (const ap of act) {
        const st = apStatus(ap);
        const row = h("div", { class: "remind " + st.cls },
          h("span", { class: "remicon", "aria-hidden": "true" }, careType(ap.data.type).icon),
          h("button", { class: "remtext", type: "button" }, h("b", {}, apTitle(ap)), h("span", {}, st.text)),
          button("✓", "iconchip ok", () => apDone(ap)));
        row.querySelector(".remtext").onclick = () => setView("care");
        row.lastChild.setAttribute("aria-label", apTitle(ap) + " erledigt");
        rem.append(row);
      }
    }
    renderRoundList($("rounds"), viewDay, isToday);
  }

  function renderHistory() {
    const t = todayStr();
    const cats = [...CFG.WALKERS, ...(CFG.WALKERS.length > 1 ? [TOGETHER] : [])];
    const last7 = Array.from({ length: 7 }, (_, i) => addDays(t, i - 6));
    const perDay = last7.map((d) => {
      const by = Object.fromEntries(cats.map((w) => [w, 0]));
      let total = 0;
      for (let s = 1; s <= NR; s++) {
        const r = walks[key(d, s)];
        if (!isDone(r)) continue;
        const m = minutesOf(r);
        total += m;
        const c = recColorKey(r);
        if (c in by) by[c] += m;
      }
      return { d, by, total };
    });
    const max = Math.max(60, ...perDay.map((x) => x.total));
    const bars = $("bars");
    bars.textContent = "";
    for (const x of perDay) {
      const track = h("div", { class: "bartrack", title: fmtDate(x.d) + ": " + x.total + " Minuten" });
      const stack = h("div", { class: "stack" });
      stack.style.height = (x.total / max * 100) + "%";
      for (const c of cats) {
        if (!x.by[c]) continue;
        const part = h("div", { class: "part" });
        part.style.flexGrow = String(x.by[c]);
        part.style.background = walkerColor(c);
        stack.append(part);
      }
      track.append(stack, h("span", { class: "barval" }, x.total ? String(x.total) : "–"));
      const bar = h("button", { class: "bar" + (x.d === t ? " today" : ""), type: "button", "aria-label": fmtDate(x.d) + " öffnen" }, track,
        h("span", { class: "barlabel" }, x.d === t ? "Heute" : WD[parseYmd(x.d).getDay()]));
      bar.onclick = () => { viewDay = x.d; setView("today", true); };
      bars.append(bar);
    }
    const keys = $("barsKeys");
    keys.textContent = "";
    for (const c of cats) {
      const dot = h("span", { class: "dot" });
      dot.style.background = walkerColor(c);
      keys.append(h("span", { class: "keyitem" }, dot, c));
    }

    const grid = $("grid4");
    grid.textContent = "";
    ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].forEach((d) => grid.append(h("span", { class: "dow" }, d)));
    const dow = (parseYmd(t).getDay() + 6) % 7;
    const start = addDays(t, -dow - 21);
    for (let i = 0; i < 28; i++) {
      const d = addDays(start, i);
      const n = dayStats(d).rounds;
      if (d > t) { grid.append(h("span", { class: "cell future" }, String(parseYmd(d).getDate()))); continue; }
      const cell = h("button", { class: "cell l" + Math.min(4, n) + (d === t ? " today" : ""), type: "button",
        "aria-label": fmtDate(d) + ": " + n + " Runden" }, String(parseYmd(d).getDate()));
      cell.onclick = () => { viewDay = d; setView("today", true); };
      grid.append(cell);
    }
  }

  // Dauer lesbar: unter einer Stunde in Minuten, sonst in Stunden mit einer Nachkommastelle
  function fmtHours(mins) {
    if (mins < 60) return { num: String(mins), unit: "Min." };
    return { num: (Math.round(mins / 6) / 10).toLocaleString("de-DE"), unit: "Std." };
  }
  const fmtDur = (mins) => { const f = fmtHours(mins); return f.num + " " + f.unit; };
  function fmtHM(mins) {
    const hh = Math.floor(mins / 60), mm = mins % 60;
    return hh ? hh + " Std. " + (mm ? mm + " Min." : "") : mm + " Min.";
  }
  const startOffset = (iso) => { const d = new Date(iso); return ((d.getHours() - CFG.DAY_START_HOUR + 24) % 24) * 60 + d.getMinutes(); };

  // Gemeinsame Runden zählen bei jeder beteiligten Person voll, bei "Alle Runden" nur einmal.
  function periodStats(p) {
    const t = todayStr();
    const from = p.days ? addDays(t, -(p.days - 1)) : null;
    const by = Object.fromEntries(CFG.WALKERS.map((w) => [w, { rounds: 0, mins: 0, together: 0, togetherMins: 0 }]));
    const total = { rounds: 0, mins: 0, together: 0, togetherMins: 0 };
    const slots = ROUNDS.map(() => Object.fromEntries([...CFG.WALKERS, TOGETHER].map((w) => [w, 0])));
    let first = null, longest = null, earliest = null, latest = null;
    for (const r of Object.values(walks)) {
      if (!isDone(r) || r.day > t || (from && r.day < from)) continue;
      const m = minutesOf(r);
      total.rounds++; total.mins += m;
      if (isTogether(r)) { total.together++; total.togetherMins += m; }
      if (!first || r.day < first) first = r.day;
      for (const w of r.walkers) {
        if (!(w in by)) continue;
        by[w].rounds++; by[w].mins += m;
        if (isTogether(r)) { by[w].together++; by[w].togetherMins += m; }
      }
      const ck = recColorKey(r);
      if (slots[r.slot - 1] && ck in slots[r.slot - 1]) slots[r.slot - 1][ck]++;
      if (!r.estimated) {
        if (!longest || m > minutesOf(longest)) longest = r;
        if (r.started_at) {
          const o = startOffset(r.started_at);
          if (!earliest || o < startOffset(earliest.started_at)) earliest = r;
          if (!latest || o > startOffset(latest.started_at)) latest = r;
        }
      }
    }
    const days = p.days || (first ? daysBetween(first, t) + 1 : 0);
    return { by, total, first, slots, longest, earliest, latest, days };
  }

  function bigFig(mins) {
    const f = fmtHours(mins);
    return h("span", { class: "fig" }, h("b", {}, f.num), h("span", {}, " " + f.unit));
  }

  function renderStats() {
    const seg = $("periodSeg");
    seg.textContent = "";
    for (const p of PERIODS) {
      const b = button(p.label, "segbtn", () => { period = p.id; ls.set("rr.period", p.id); renderStats(); });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(p.id === period));
      seg.append(b);
    }
    const p = PERIODS.find((x) => x.id === period) || PERIODS[1];
    const s = periodStats(p);
    const span = p.days ? "letzte " + p.days + " Tage inkl. heute" : (s.first ? "seit " + fmtDay(s.first) : "noch keine Runden");

    // 1. Zeit draußen
    const tb = $("timeBlock");
    tb.textContent = "";
    tb.append(h("h2", {}, "Zeit draußen ", h("span", { class: "sub" }, span)));
    const maxM = Math.max(1, ...Object.values(s.by).map((x) => x.mins));
    for (const w of CFG.WALKERS) {
      const x = s.by[w];
      const share = s.total.mins ? Math.round(x.mins / s.total.mins * 100) : 0;
      const fill = h("div", { class: "fill" });
      fill.style.width = (x.mins / maxM * 100) + "%";
      fill.style.background = walkerColor(w);
      const card = h("div", { class: "whocard" },
        h("div", { class: "whohead" }, h("span", { class: "whoname" }, w), bigFig(x.mins)),
        h("div", { class: "track" }, fill),
        h("div", { class: "whometa" }, "bei " + share + " % der Zeit dabei · Ø " + (x.rounds ? Math.round(x.mins / x.rounds) : 0) + " Min. pro Runde"));
      card.style.borderLeftColor = walkerColor(w);
      tb.append(card);
    }
    tb.append(h("p", { class: "legend" }, "Insgesamt " + fmtHM(s.total.mins) + ", davon " + fmtHM(s.total.togetherMins) + " zusammen."));

    // 2. Anzahl Runden
    const rb = $("roundsBlock");
    rb.textContent = "";
    rb.append(h("h2", {}, "Runden"));
    const maxR = Math.max(1, ...Object.values(s.by).map((x) => x.rounds));
    for (const w of CFG.WALKERS) {
      const x = s.by[w];
      const fill = h("div", { class: "fill" });
      fill.style.width = (x.rounds / maxR * 100) + "%";
      fill.style.background = walkerColor(w);
      rb.append(h("div", { class: "who" }, h("span", {}, w), h("div", { class: "track" }, fill), h("b", {}, String(x.rounds))));
    }
    rb.append(h("p", { class: "legend" }, "Alle Runden: " + s.total.rounds + ", davon " + s.total.together + " zusammen."));

    // 3. Wer geht welche Runde?
    const sl = $("slotBlock");
    sl.textContent = "";
    sl.append(h("h2", {}, "Wer geht welche Runde?"));
    const cats = [...CFG.WALKERS, TOGETHER];
    ROUNDS.forEach((r, i) => {
      const c = s.slots[i];
      const sum = cats.reduce((a, k) => a + c[k], 0);
      const bar = h("div", { class: "splitbar" });
      for (const k of cats) {
        if (!c[k]) continue;
        const part = h("div", { class: "part", title: k + ": " + c[k] }, String(c[k]));
        part.style.flexGrow = String(c[k]);
        part.style.background = walkerColor(k);
        part.style.color = walkerInk(k);
        bar.append(part);
      }
      if (!sum) bar.append(h("div", { class: "part none" }, "–"));
      sl.append(h("div", { class: "splitrow" }, h("span", {}, r.name), bar));
    });
    const keys = h("div", { class: "keys" });
    for (const k of cats) { const dot = h("span", { class: "dot" }); dot.style.background = walkerColor(k); keys.append(h("span", { class: "keyitem" }, dot, k)); }
    sl.append(keys);

    // 4. Rekorde und Durchschnitte
    const fb = $("factsBlock");
    fb.textContent = "";
    fb.append(h("h2", {}, "Rekorde"));
    const grid = h("div", { class: "facts" });
    const fact = (label, value, detail) => grid.append(h("div", { class: "fact" }, h("span", { class: "flabel" }, label), h("b", {}, value), h("span", { class: "fdetail" }, detail || "")));
    const who = (r) => r ? whoText(r) + " · " + fmtDM(r.day) : "";
    fact("Ø pro Tag draußen", s.days ? fmtHM(Math.round(s.total.mins / s.days)) : "–", s.days ? "über " + s.days + (s.days === 1 ? " Tag" : " Tage") : "");
    fact("Längste Runde", s.longest ? fmtHM(minutesOf(s.longest)) : "–", who(s.longest));
    fact("Frühester Start", s.earliest ? hm(s.earliest.started_at) + " Uhr" : "–", who(s.earliest));
    fact("Spätester Start", s.latest ? hm(s.latest.started_at) + " Uhr" : "–", who(s.latest));
    fb.append(grid);

    // 5. Alle Zeiträume im Vergleich
    const tbl = $("statTable");
    tbl.textContent = "";
    const all = PERIODS.map(periodStats);
    tbl.append(h("thead", {}, h("tr", {}, h("th", {}, ""), ...PERIODS.map((x) => h("th", { scope: "col" }, x.label)))));
    const body = h("tbody");
    const cell = (v) => h("td", {}, h("b", {}, v.mins < 60 ? v.mins + " min" : (Math.round(v.mins / 6) / 10).toLocaleString("de-DE") + " h"),
      h("small", {}, v.rounds + (v.rounds === 1 ? " Runde" : " Runden")));
    for (const w of CFG.WALKERS) body.append(h("tr", {}, h("th", { scope: "row" }, w), ...all.map((x) => cell(x.by[w]))));
    body.append(h("tr", { class: "sum" }, h("th", { scope: "row" }, "Alle"), ...all.map((x) => cell(x.total))));
    tbl.append(body);

    // 6. Durchschnitt je Runde (Grundlage für "Erledigt")
    const al = $("avgList");
    al.textContent = "";
    ROUNDS.forEach((r, i) => {
      const list = history(i + 1);
      al.append(h("div", { class: "avgrow" }, h("span", {}, r.name),
        h("b", {}, "Ø " + avgDuration(i + 1) + " Min."),
        h("small", {}, list.length ? list.length + " gemessen · meist ab " + typicalStart(i + 1) + " Uhr" : "noch keine Werte, Vorgabe")));
    });
  }

  function renderCare() {
    const list = appointments().sort((a, b) => a.data.due.localeCompare(b.data.due));
    const ol = $("careList");
    ol.textContent = "";
    $("careEmpty").hidden = list.length > 0;
    for (const ap of list) {
      const st = apStatus(ap);
      const t = careType(ap.data.type);
      const body = h("button", { class: "carebody", type: "button", "aria-label": apTitle(ap) + " bearbeiten" },
        h("span", { class: "carename" }, apTitle(ap)),
        h("span", { class: "carestatus " + st.cls }, st.text),
        h("span", { class: "caremeta" }, everyText(ap.data) + (ap.data.lastDone ? " · zuletzt " + fmtDM(ap.data.lastDone) : "")));
      body.onclick = () => openApSheet(ap);
      const ok = button("✓", "iconchip ok", () => apDone(ap));
      ok.setAttribute("aria-label", apTitle(ap) + " erledigt");
      ol.append(h("li", { class: "careitem " + st.cls }, h("span", { class: "careicon", "aria-hidden": "true" }, t.icon), body, ok));
    }
  }

  function renderSettings() {
    const chips = $("meChips");
    chips.textContent = "";
    for (const w of CFG.WALKERS) {
      const b = button(w, "chip", () => { me = w; ls.set("rr.me", w); saveWalkerToAccount(w); renderSettings(); });
      b.setAttribute("aria-pressed", String(w === me));
      b.style.setProperty("--chip-on", walkerColor(w));
      b.style.setProperty("--chip-on-ink", walkerInk(w));
      chips.append(b);
    }
    let info;
    if (DEMO) info = "Testmodus ohne Datenbank.";
    else if (!session) info = "Nicht angemeldet.";
    else {
      info = (session.user && session.user.email) || "Angemeldet";
      info += lastSync ? " · abgeglichen " + hm(lastSync) + " Uhr" : "";
      if (pending.length) info += " · " + pending.length + " offen";
      if (syncError) info += " · Fehler: " + syncError;
    }
    info += " · Version " + APP_VERSION;
    $("syncInfo").textContent = info;
    $("syncNow").hidden = DEMO;
    $("logout").hidden = DEMO || !session;
    $("demoBlock").hidden = !DEMO;
    renderPush();
    renderInfo();
  }

  // Alle Erklärungen gesammelt an einer Stelle
  function renderInfo() {
    const body = $("infoBody");
    if (body.childElementCount) return;
    const sec = (title, lines) => body.append(h("h3", {}, title), h("ul", {}, ...lines.map((l) => h("li", {}, l))));
    sec("Runden", [
      "Der Gassi-Tag läuft von " + CFG.DAY_START_HOUR + ":00 bis " + CFG.DAY_START_HOUR + ":00 Uhr. Eine Runde um 0:30 Uhr zählt zum Vortag.",
      "▶ startet die Zeitmessung, ⏸ pausiert. Pausen zählen nicht zur Dauer.",
      "Erledigt bzw. Ø trägt eine Runde mit der Durchschnittsdauer genau dieser Runde aus den letzten 30 Tagen ein, ohne Werte mit " + CFG.DEFAULT_MINUTES + " Minuten. Solche Einträge sind mit \"ca.\" markiert und zählen nicht für spätere Durchschnitte.",
      "👥 heißt zusammen gegangen. Im Formular lassen sich auch beide oder nur die andere Person auswählen.",
      "💩 zählt bei jedem Antippen ein Häufchen dazu, auch während der Runde. Korrigieren über die Runde.",
      "Frühere Tage: Pfeile oben oder auf das Datum tippen. Jede Runde lässt sich antippen und korrigieren oder löschen."
    ]);
    sec("Statistik", [
      "Farben: " + CFG.WALKERS.join(" und ") + " jeweils eigene Farbe, zusammen blau.",
      "Gemeinsame Runden zählen bei beiden Personen, in der Gesamtsumme nur einmal.",
      "Im Kalender unter Verlauf gilt: je kräftiger die Farbe, desto mehr Runden."
    ]);
    sec("Termine", [
      "Unter Heute erscheinen Termine, die in weniger als einer Woche fällig oder überfällig sind.",
      "✓ hakt ab. Wiederkehrende Termine springen auf den nächsten Termin, gerechnet ab dem Tag des Abhakens.",
      "Benachrichtigungen kommen zu den beim Termin gewählten Zeitpunkten, bei Terminen ohne Uhrzeit um 8 Uhr."
    ]);
    sec("Übliche Abstände", CARE_TYPES.filter((t) => t.hint).map((t) => t.name + ": " + t.hint));
    body.append(h("p", { class: "legend" }, "Die Abstände sind Richtwerte. Im Zweifel mit dem Tierarzt abstimmen."));
  }

  // ---------- Runde bearbeiten ----------
  function renderSheetChips() {
    const sc = $("slotChips");
    sc.textContent = "";
    ROUNDS.forEach((r, i) => {
      const slot = i + 1;
      const taken = slot !== editing.slot && walks[key(editing.day, slot)];
      const b = button(r.name, "chip" + (taken ? " taken" : ""), () => { editing.newSlot = slot; $("sheetError").textContent = ""; renderSheetChips(); });
      b.setAttribute("aria-pressed", String(slot === editing.newSlot));
      sc.append(b);
    });
    const wc = $("walkerChips");
    wc.textContent = "";
    for (const w of CFG.WALKERS) {
      const b = button(w, "chip", () => {
        if (sheetWalkers.includes(w)) { if (sheetWalkers.length > 1) sheetWalkers = sheetWalkers.filter((x) => x !== w); }
        else sheetWalkers = CFG.WALKERS.filter((x) => x === w || sheetWalkers.includes(x));
        renderSheetChips();
      });
      b.setAttribute("aria-pressed", String(sheetWalkers.includes(w)));
      b.style.setProperty("--chip-on", walkerColor(w));
      b.style.setProperty("--chip-on-ink", walkerInk(w));
      wc.append(b);
    }
    $("pooVal").textContent = sheetPoo ? "💩".repeat(Math.min(sheetPoo, 5)) + (sheetPoo > 5 ? " " + sheetPoo : "") : "keins";
    $("pooMinus").disabled = sheetPoo === 0;
    $("fDur").placeholder = "Ø " + avgDuration(editing.newSlot);
    const rec = walks[key(editing.day, editing.slot)];

  }
  function openSheet(day, slot, exact) {
    const rec = walks[key(day, slot)];
    editing = { day, slot, newSlot: slot };
    sheetWalkers = rec && rec.walkers.length ? rec.walkers.slice() : [me];
    sheetPoo = (rec && rec.poo) || 0;
    deleteArmed = false;
    $("sheetTitle").textContent = rec ? "Runde korrigieren" : "Runde eintragen";
    $("sheetSub").textContent = fmtDate(day);
    $("sheetError").textContent = "";
    $("fTime").value = rec ? hm(rec.started_at || rec.ended_at) : typicalStart(slot);
    $("fDur").value = rec ? (isRunning(rec) ? "" : (minutesOf(rec) || "")) : (exact ? avgDuration(slot) : "");
    $("fDur").disabled = isRunning(rec);
    $("fNote").value = (rec && rec.note) || "";
    $("fDelete").hidden = !rec;
    $("fDelete").textContent = "Löschen";
    $("fStop").hidden = !isRunning(rec);
    renderSheetChips();
    $("sheet").hidden = false;
    $("sheetBg").hidden = false;
  }
  function closeSheet() { $("sheet").hidden = true; $("apSheet").hidden = true; $("sheetBg").hidden = true; editing = null; apEditing = null; }

  function submitSheet(stopNow) {
    if (!editing) return;
    const { day, slot, newSlot } = editing;
    const old = walks[key(day, slot)];
    if (newSlot !== slot && walks[key(day, newSlot)]) {
      $("sheetError").textContent = ROUNDS[newSlot - 1].name + " ist an diesem Tag schon eingetragen. Bitte zuerst dort korrigieren oder löschen.";
      return;
    }
    const time = $("fTime").value || typicalStart(newSlot);
    const durRaw = $("fDur").value.trim();
    const dur = durRaw === "" ? null : Math.max(1, Math.min(300, parseInt(durRaw, 10) || 1));
    const rec = {
      day, slot: newSlot, walkers: sheetWalkers.slice(), poo: sheetPoo, estimated: false,
      note: $("fNote").value.trim(), started_at: combine(day, time), ended_at: null, duration_min: null,
      paused_at: null, pause_sec: 0, extra: (old && old.extra) || {}
    };
    if (isRunning(old) && !stopNow) {
      rec.paused_at = old.paused_at; rec.pause_sec = old.pause_sec;
    } else if (isRunning(old) && stopNow) {
      Object.assign(rec, finished(old, rec.started_at));
    } else {
      let d = dur;
      if (!d) { d = avgDuration(newSlot); rec.estimated = true; }
      else if (old && old.estimated && old.duration_min === d) rec.estimated = true;
      rec.ended_at = new Date(new Date(rec.started_at).getTime() + d * 60000).toISOString();
      rec.duration_min = d;
      if (old && old.duration_min === d) rec.pause_sec = old.pause_sec || 0;
    }
    if (newSlot !== slot && old) deleteRec(day, slot, true);
    saveRec(rec);
    closeSheet();
    toast(old ? "Korrektur gespeichert" : ROUNDS[newSlot - 1].name + " eingetragen");
  }

  // ---------- Termin bearbeiten ----------
  function renderApRemind() {
    const box = $("apRemind");
    box.textContent = "";
    for (const o of REMIND_OPTS) {
      const b = button(o.label, "chip", () => {
        apRemind = apRemind.includes(o.d) ? apRemind.filter((x) => x !== o.d) : [...apRemind, o.d].sort((a, b) => b - a);
        renderApRemind();
      });
      b.setAttribute("aria-pressed", String(apRemind.includes(o.d)));
      box.append(b);
    }
  }
  function applyTypeDefaults(typeId, keepName) {
    const t = careType(typeId);
    if (!keepName) $("apName").value = "";
    $("apName").placeholder = t.id === "custom" ? "z. B. Hundefriseur" : t.name + " (optional genauer, z. B. Mittel)";
    $("apEvery").value = t.every || 1;
    $("apUnit").value = t.unit;
    $("apEvery").disabled = t.unit === "0";
    apRemind = (t.remind || [7, 3, 1]).slice();
    renderApRemind();
  }
  function openApSheet(ap) {
    apEditing = ap ? ap.id : "new";
    apDeleteArmed = false;
    const sel = $("apType");
    if (!sel.options.length) for (const t of CARE_TYPES) sel.append(h("option", { value: t.id }, t.icon + " " + t.name));
    $("apTitle").textContent = ap ? "Termin bearbeiten" : "Neuer Termin";
    if (ap) {
      const d = ap.data;
      sel.value = careType(d.type).id;
      $("apName").value = d.name || "";
      $("apDate").value = d.due;
      $("apTime").value = d.time || "";
      $("apEvery").value = d.every || 1;
      $("apUnit").value = d.unit || "0";
      $("apEvery").disabled = (d.unit || "0") === "0";
      $("apNote").value = d.note || "";
      apRemind = (d.remind || []).slice();
      renderApRemind();
      $("apLast").textContent = d.lastDone ? "Zuletzt erledigt am " + fmtDay(d.lastDone) + (d.history && d.history.length > 1 ? " (" + d.history.length + "× insgesamt)" : "") : "";
    } else {
      sel.value = "tick";
      applyTypeDefaults("tick");
      $("apDate").value = calToday();
      $("apTime").value = "";
      $("apNote").value = "";
      $("apLast").textContent = "";
    }
    $("apDelete").hidden = !ap;
    $("apDelete").textContent = "Löschen";
    $("apIcs").hidden = !ap;
    $("apSheet").hidden = false;
    $("sheetBg").hidden = false;
  }
  function submitApSheet() {
    const old = apEditing !== "new" ? items[apEditing] : null;
    const type = $("apType").value;
    const unit = $("apUnit").value;
    const data = {
      ...(old ? old.data : { lastDone: null, history: [] }),
      type, name: $("apName").value.trim(), due: $("apDate").value || calToday(), time: $("apTime").value || "",
      every: unit === "0" ? 0 : Math.max(1, parseInt($("apEvery").value, 10) || 1), unit,
      remind: apRemind.slice(), note: $("apNote").value.trim(), archived: false
    };
    const item = old ? { ...old, data } : { id: uid(), kind: "appointment", data };
    saveItem(item);
    closeSheet();
    toast(old ? "Termin gespeichert" : apTitle(item) + " angelegt");
  }

  // ---------- Ereignisse ----------
  function setView(v, keepDay) {
    view = v;
    for (const name of ["today", "history", "stats", "care", "settings"]) $("view-" + name).hidden = name !== v;
    document.querySelectorAll(".tab").forEach((t) => {
      if (t.dataset.view === v) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (!keepDay) viewDay = todayStr();
    render();
    window.scrollTo(0, 0);
  }

  function bind() {
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
    $("prevDay").onclick = () => { viewDay = addDays(viewDay, -1); if (view !== "today") setView("today", true); else render(); };
    $("nextDay").onclick = () => { if (viewDay < todayStr()) { viewDay = addDays(viewDay, 1); if (view !== "today") setView("today", true); else render(); } };
    $("pickDay").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v && v <= todayStr()) { viewDay = v; setView("today", true); }
    });
    $("sheetClose").onclick = closeSheet;
    $("apClose").onclick = closeSheet;
    $("sheetBg").onclick = closeSheet;
    $("sheet").addEventListener("submit", (e) => { e.preventDefault(); submitSheet(false); });
    $("fStop").onclick = () => submitSheet(true);
    $("pooPlus").onclick = () => { sheetPoo++; renderSheetChips(); };
    $("pooMinus").onclick = () => { if (sheetPoo > 0) sheetPoo--; renderSheetChips(); };
    $("fDelete").onclick = () => {
      if (!editing) return;
      if (!deleteArmed) { deleteArmed = true; $("fDelete").textContent = "Wirklich löschen?"; return; }
      deleteRec(editing.day, editing.slot);
      closeSheet();
      toast("Runde gelöscht");
    };
    $("addCare").onclick = () => openApSheet(null);
    $("apType").addEventListener("change", (e) => applyTypeDefaults(e.target.value));
    $("apUnit").addEventListener("change", (e) => { $("apEvery").disabled = e.target.value === "0"; });
    $("apSheet").addEventListener("submit", (e) => { e.preventDefault(); submitApSheet(); });
    $("apDelete").onclick = () => {
      if (!apEditing || apEditing === "new") return;
      if (!apDeleteArmed) { apDeleteArmed = true; $("apDelete").textContent = "Wirklich löschen?"; return; }
      deleteItem(apEditing);
      closeSheet();
      toast("Termin gelöscht");
    };
    $("apIcs").onclick = () => { if (apEditing && items[apEditing]) exportIcs(items[apEditing]); };
    $("syncNow").onclick = () => pull();
    $("logout").onclick = async () => { if (sb) await sb.auth.signOut(); };
    $("clearDemo").onclick = () => { walks = {}; items = {}; persist(); render(); };
    $("reloadApp").onclick = () => location.reload();
    $("pushToggle").onclick = () => { if (pushState.busy) return; if (pushState.on) disablePush(); else enablePush(); };
    $("pushTest").onclick = () => { if (!pushState.busy) testPush(); };
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("loginError").textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPw").value });
      if (error) $("loginError").textContent = "Anmeldung hat nicht geklappt. Bitte E-Mail und Passwort prüfen.";
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
    window.addEventListener("online", () => { render(); pull(); });
    window.addEventListener("offline", render);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const t = todayStr();
      if (viewDay === lastToday && view === "today") viewDay = t;
      lastToday = t;
      render();
      schedulePull();
    });
    setInterval(() => {
      document.querySelectorAll("[data-run]").forEach((el) => {
        el.textContent = clock(activeSec({ started_at: el.dataset.start, pause_sec: Number(el.dataset.pause), paused_at: el.dataset.paused || null }));
      });
    }, 1000);
    setInterval(() => { if (document.visibilityState === "visible") pull(); }, 60000);
  }

  // ---------- Start ----------
  if (DEMO) seedDemo();
  bind();
  if (location.hash === "#care") setView("care"); else render();
  refreshPush().then(() => { if (view === "settings") renderSettings(); });
  if (HAS_DB) initDb();
})();
