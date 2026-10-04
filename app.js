/* Piepmanns (früher Rüdigers Runden): App-Logik
   Daten liegen lokal auf dem Handy (funktioniert auch ohne Netz) und werden,
   wenn Supabase eingerichtet ist, mit der gemeinsamen Datenbank abgeglichen. */
(() => {
  "use strict";

  const APP_VERSION = "0.9.1 vom 04.10.2026";

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
  const P = DEMO ? "rr.demo6." : "rr.";
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
  let hiddenAt = Date.now();
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
    else if (unit === "m" || unit === "y") { if (unit === "y") every *= 12; const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + every); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
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
  let touched = new Set(); // seit Beginn des laufenden Abrufs lokal geänderte Schlüssel
  function queue(op) { const k = opKey(op); touched.add(k); pending = pending.filter((p) => opKey(p) !== k); pending.push(op); }

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
  // Läuft schon ein Abgleich, wird auf denselben gewartet (wichtig für die "Neuer Termin"-Nachricht)
  let flushing = null;
  function flush() {
    if (DEMO || !session) return Promise.resolve();
    if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }
  async function doFlush() {
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
  async function fetchAll(table, order, tie) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      // eindeutige Sortierung, sonst können beim Blättern Zeilen fehlen
      const { data, error } = await sb.from(table).select("*").order(order).order(tie).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
  async function pull() {
    if (DEMO || !session || !navigator.onLine) { render(); return; }
    await flush();
    touched = new Set();
    // Schlüssel mit lokalen, noch nicht bestätigten Änderungen erst nach dem Laden bestimmen
    const keep = () => new Set([...pending.map(opKey), ...touched]);
    let err = null;
    try {
      const data = await fetchAll("walks", "day", "slot");
      const waiting = keep();
      const next = {};
      for (const [k, r] of Object.entries(walks)) if (waiting.has(k)) next[k] = r;
      for (const r of data) { const k = key(r.day, r.slot); if (!waiting.has(k)) next[k] = normalize({ ...r }); }
      walks = next;
    } catch (e) { err = e; }
    try {
      const data = await fetchAll("app_data", "updated_at", "id");
      const waiting = keep();
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
    const evs = [
      { title: "Abendessen bei Schmidti", who: CFG.WALKERS.slice(), allDay: false, start: addDays(ct, 1) + "T19:00", end: addDays(ct, 1) + "T22:00", location: "Kastanienallee 12, Berlin", remind: [60] },
      { title: "Zahnarzt", who: [CFG.WALKERS[1] || CFG.WALKERS[0]], allDay: false, start: addDays(ct, 3) + "T08:30", end: addDays(ct, 3) + "T09:30", location: "", remind: [1440] },
      { title: "Fußball", who: [CFG.WALKERS[0]], allDay: false, start: ct + "T19:30", end: ct + "T21:00", location: "Sportplatz", remind: [60], repeat: { freq: "w", until: "" } },
      { title: "Wochenende Ostsee", who: CFG.WALKERS.slice(), allDay: true, start: addDays(ct, 8) + "T00:00", end: addDays(ct, 10) + "T23:59", location: "Warnemünde", remind: [10080] }
    ];
    for (const e of evs) { const id = uid(); items[id] = { id, kind: "event", updated_at: new Date().toISOString(), data: { note: "", exdates: [], repeat: { freq: "0", until: "" }, ...e } }; }
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
      const trig = d.time ? (days ? "-P" + days + "D" : "PT0M") : (days ? "-P" + (days - 1) + "DT16H" : "PT8H");
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
  // Eine Runden-Karte. live = heute (▶, Pause, Erledigt), sonst Nachtragen (Ø, Genau).
  function roundCard(day, slot, live) {
    const r = ROUNDS[slot - 1], rec = walks[key(day, slot)];
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
    return li;
  }
  // filter wählt aus, welche Runden in diese Liste gehören
  function renderRoundList(ol, day, live, filter) {
    ol.textContent = "";
    for (let slot = 1; slot <= NR; slot++) {
      if (!filter || filter(walks[key(day, slot)])) ol.append(roundCard(day, slot, live));
    }
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

  // ---------- Kalender ----------
  // Termine liegen als kind "event" in app_data, Zeiten als Ortszeit "YYYY-MM-DDTHH:MM".
  // Feiertage werden berechnet, nicht gespeichert.
  const REMIND_TIMED = [15, 60, 240, 1440, 4320, 10080];
  const REMIND_ALLDAY = [0, 1440, 4320, 10080];
  const EV_COLORS = [
    { c: "", label: "Standard (nach Person)" }, { c: "#e5484d", label: "Rot" }, { c: "#f76b15", label: "Orange" },
    { c: "#7a8b22", label: "Oliv" }, { c: "#d6409f", label: "Pink" }, { c: "#8d6e63", label: "Braun" },
    { c: "#475569", label: "Schiefer" }
  ];
  const STATES = {
    "": "Keine", BW: "Baden-Württemberg", BY: "Bayern", BE: "Berlin", BB: "Brandenburg", HB: "Bremen", HH: "Hamburg",
    HE: "Hessen", MV: "Mecklenburg-Vorpommern", NI: "Niedersachsen", NW: "Nordrhein-Westfalen", RP: "Rheinland-Pfalz",
    SL: "Saarland", SN: "Sachsen", ST: "Sachsen-Anhalt", SH: "Schleswig-Holstein", TH: "Thüringen"
  };
  let holidayState = ls.get("rr.holidays", "BE");
  let calMonth = calToday().slice(0, 8) + "01";
  let calSel = calToday();
  let calMode = ls.get("rr.calMode", "week"); // "month" oder "week" (7 Tage ab calWeekStart)
  let calWeekStart = calToday();
  let evEditing = null, evWho = [me], evAllDay = false, evRemind = [60], evColorSel = "", evOcc = null, evDelArmed = false;

  const calEvents = () => Object.values(items).filter((i) => i.kind === "event" && i.data && i.data.start);
  const whoKey = (who) => !who || !who.length ? null : who.length > 1 ? TOGETHER : who[0];
  const evColor = (ev) => { if (ev.data.color) return ev.data.color; const k = whoKey(ev.data.who); return k ? walkerColor(k) : "var(--muted)"; };
  const evInk = (ev) => { if (ev.data.color) return "#fff"; const k = whoKey(ev.data.who); return k ? walkerInk(k) : "#fff"; };
  const isRecurring = (d) => !!(d.repeat && d.repeat.freq && d.repeat.freq !== "0");
  const isAppleTouch = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;

  function remindLabel(m, allDay) {
    if (m === 0) return allDay ? "Am Tag, 8 Uhr" : "Zum Beginn";
    const suffix = allDay ? " vorher" : "";
    if (m % 10080 === 0) return (m / 10080 === 1 ? "1 Woche" : m / 10080 + " Wochen") + suffix;
    if (m % 1440 === 0) return (m / 1440 === 1 ? "1 Tag" : m / 1440 + " Tage") + suffix;
    if (m % 60 === 0) return m / 60 + " Std." + suffix;
    return m + " Min." + suffix;
  }

  // Gesetzliche Feiertage je Bundesland (Stand der Landesgesetze; einmalige Sonderfeiertage fehlen)
  function easterSunday(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), hh = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7, m = Math.floor((a + 11 * hh + 22 * l) / 451);
    const month = Math.floor((hh + l - 7 * m + 114) / 31), day = ((hh + l - 7 * m + 114) % 31) + 1;
    return y + "-" + pad(month) + "-" + pad(day);
  }
  const holidayCache = {};
  function holidaysOf(y, st) {
    const ck = y + st;
    if (holidayCache[ck]) return holidayCache[ck];
    const map = {};
    if (st) {
      const e = easterSunday(y);
      const add = (date, name, states) => { if (!states || states.includes(st)) map[date] = name; };
      add(y + "-01-01", "Neujahr");
      add(y + "-01-06", "Heilige Drei Könige", ["BW", "BY", "ST"]);
      add(y + "-03-08", "Frauentag", ["BE", "MV"]);
      add(addDays(e, -2), "Karfreitag");
      add(e, "Ostersonntag", ["BB"]);
      add(addDays(e, 1), "Ostermontag");
      add(y + "-05-01", "Tag der Arbeit");
      add(addDays(e, 39), "Christi Himmelfahrt");
      add(addDays(e, 49), "Pfingstsonntag", ["BB"]);
      add(addDays(e, 50), "Pfingstmontag");
      add(addDays(e, 60), "Fronleichnam", ["BW", "BY", "HE", "NW", "RP", "SL"]);
      add(y + "-08-15", "Mariä Himmelfahrt", ["SL"]);
      add(y + "-09-20", "Weltkindertag", ["TH"]);
      add(y + "-10-03", "Tag der Deutschen Einheit");
      add(y + "-10-31", "Reformationstag", ["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"]);
      add(y + "-11-01", "Allerheiligen", ["BW", "BY", "NW", "RP", "SL"]);
      const nov22 = y + "-11-22";
      add(addDays(nov22, -((parseYmd(nov22).getDay() - 3 + 7) % 7)), "Buß- und Bettag", ["SN"]);
      add(y + "-12-25", "1. Weihnachtstag");
      add(y + "-12-26", "2. Weihnachtstag");
      // gesetzlich keine Feiertage, für uns aber schon
      add(y + "-12-24", "Heiligabend");
      add(y + "-12-31", "Silvester");
    }
    return (holidayCache[ck] = map);
  }
  const holidayOn = (ymd) => holidaysOf(Number(ymd.slice(0, 4)), holidayState)[ymd] || null;

  function repeatStep(base, freq, n) {
    if (freq === "d") return addDays(base, n);
    if (freq === "w") return addDays(base, 7 * n);
    if (freq === "2w") return addDays(base, 14 * n);
    if (freq === "m") return addInterval(base, n, "m");
    if (freq === "y") return addInterval(base, n, "y");
    return base;
  }
  const inPause = (d, day) => !!(d.pause && d.pause.from && d.pause.to && day >= d.pause.from && day <= d.pause.to);
  // Alle Vorkommen eines Termins, die den Zeitraum [from, to] berühren. Ab dem n-ten Schritt
  // vom Starttag aus gerechnet, damit Monatsenden (31.) nicht wandern.
  function evOccurrences(ev, from, to) {
    const d = ev.data, out = [];
    const sDate = d.start.slice(0, 10);
    const span = Math.max(0, daysBetween(sDate, (d.end || d.start).slice(0, 10)));
    const freq = isRecurring(d) ? d.repeat.freq : null;
    const until = freq && d.repeat.until ? d.repeat.until : null;
    const ex = new Set(d.exdates || []);
    for (let n = 0; n < 4000; n++) {
      const cur = freq ? repeatStep(sDate, freq, n) : sDate;
      if (cur > to || (until && cur > until)) break;
      const end = addDays(cur, span);
      if (end >= from && !ex.has(cur) && !inPause(d, cur)) out.push({ ev, date: cur, endDate: end });
      if (!freq) break;
    }
    return out;
  }
  // Tag -> Einträge (Feiertage, Termine, Rüdigers Behandlungen) für den Zeitraum [from, to]
  function calMap(from, to) {
    const map = {};
    const put = (day, entry) => { (map[day] = map[day] || []).push(entry); };
    for (let d = from; d <= to; d = addDays(d, 1)) { const name = holidayOn(d); if (name) put(d, { type: "hol", name, day: d }); }
    for (const ev of calEvents()) {
      for (const o of evOccurrences(ev, from, to)) {
        for (let d = o.date < from ? from : o.date; d <= o.endDate && d <= to; d = addDays(d, 1)) put(d, { type: "ev", ev, occ: o, day: d });
      }
    }
    for (const ap of appointments()) if (ap.data.due >= from && ap.data.due <= to) put(ap.data.due, { type: "care", ap, day: ap.data.due });
    for (const k of Object.keys(map)) map[k].sort(entrySort);
    return map;
  }
  const isSpan = (e) => e.type === "ev" && e.occ.endDate > e.occ.date;
  function entryTime(e) {
    if (e.type === "care") return e.ap.data.time || "";
    if (e.type !== "ev" || e.ev.data.allDay || e.day !== e.occ.date) return "";
    return e.ev.data.start.slice(11, 16);
  }
  // Reihenfolge: Feiertag, mehrtägige, ganztägige, dann nach Uhrzeit
  function entrySort(a, b) {
    const rank = (e) => e.type === "hol" ? 0 : isSpan(e) ? 1 : entryTime(e) ? 3 : 2;
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return a.occ.date.localeCompare(b.occ.date) || b.occ.endDate.localeCompare(a.occ.endDate);
    return entryTime(a).localeCompare(entryTime(b));
  }
  function entryWhen(e) {
    if (e.type === "hol") return "Feiertag · " + STATES[holidayState];
    if (e.type === "care") return e.ap.data.time ? e.ap.data.time + " Uhr" : "Rüdiger";
    const d = e.ev.data;
    if (d.allDay) return e.occ.date === e.occ.endDate ? "Ganztägig" : "bis " + fmtDM(e.occ.endDate);
    const st = d.start.slice(11, 16), en = (d.end || d.start).slice(11, 16);
    if (e.occ.date === e.occ.endDate) return st + (en && en !== st ? " – " + en : "") + " Uhr";
    if (e.day === e.occ.date) return "ab " + st + " Uhr";
    if (e.day === e.occ.endDate) return "bis " + en + " Uhr";
    return "ganztägig";
  }
  function entryNode(e, showDate) {
    const prefix = showDate ? fmtDM(e.day) + " · " : "";
    if (e.type === "hol") {
      return h("li", { class: "ev hol" }, h("span", { class: "evbar" }),
        h("div", { class: "evbody" }, h("span", { class: "evtitle" }, e.name), h("span", { class: "evmeta" }, prefix + entryWhen(e))));
    }
    if (e.type === "care") {
      const li = h("li", { class: "ev care" }, h("span", { class: "evbar" }),
        h("button", { class: "evbody", type: "button" },
          h("span", { class: "evtitle" }, careType(e.ap.data.type).icon + " " + apTitle(e.ap)),
          h("span", { class: "evmeta" }, prefix + entryWhen(e))));
      li.querySelector(".evbody").onclick = () => openApSheet(e.ap);
      return li;
    }
    const d = e.ev.data;
    const meta = [prefix + entryWhen(e)];
    if (d.who && d.who.length) meta.push(d.who.length > 1 ? "Beide" : d.who[0]);
    const title = h("span", { class: "evtitle" }, d.title || "Termin");
    if (isRecurring(d)) title.append(h("span", { class: "evrep", "aria-label": "wiederholt sich" }, " ↻"));
    const body = h("button", { class: "evbody", type: "button" }, title, h("span", { class: "evmeta" }, meta.join(" · ")));
    if (d.location) body.append(h("span", { class: "evloc" }, "📍 " + d.location));
    body.onclick = () => openEvSheet(e.ev, e.occ);
    const li = h("li", { class: "ev" }, h("span", { class: "evbar" }), body);
    li.style.setProperty("--evc", evColor(e.ev));
    return li;
  }

  // Monatsraster: mehrtägige Termine bekommen pro Woche eine feste Zeile ("Spur"),
  // damit sie als durchgehender Balken über die Tage laufen.
  const CELL_CHIPS = 3;
  function weekLanes(weekStart, map) {
    const spans = [];
    const seen = new Set();
    for (let i = 0; i < 7; i++) {
      for (const e of map[addDays(weekStart, i)] || []) {
        if (!isSpan(e)) continue;
        const id = e.ev.id + "|" + e.occ.date;
        if (!seen.has(id)) { seen.add(id); spans.push(e.occ); }
      }
    }
    spans.sort((a, b) => a.date.localeCompare(b.date) || b.endDate.localeCompare(a.endDate));
    const lanes = [];   // lanes[i] = letzter belegter Tag
    const laneOf = {};
    for (const o of spans) {
      const s = o.date < weekStart ? weekStart : o.date;
      let i = lanes.findIndex((last) => last < s);
      if (i < 0) { i = lanes.length; lanes.push(""); }
      lanes[i] = o.endDate;
      laneOf[o.ev.id + "|" + o.date] = i;
    }
    return { laneOf, count: lanes.length };
  }
  function calChip(e, day, weekStart) {
    if (e.type === "hol") return h("span", { class: "calchip hol" }, e.name);
    if (e.type === "care") return h("span", { class: "calchip care" }, "🐶 " + apTitle(e.ap));
    const chip = h("span", { class: "calchip" }, e.ev.data.title || "Termin");
    chip.style.background = evColor(e.ev);
    chip.style.color = evInk(e.ev);
    if (isSpan(e)) {
      const first = day === e.occ.date || day === weekStart;
      chip.classList.add("span");
      if (day !== e.occ.date && day !== weekStart) chip.classList.add("cont-l");
      if (day !== e.occ.endDate && parseYmd(day).getDay() !== 0) chip.classList.add("cont-r");
      if (!first) chip.textContent = " ";
      else if (chip.classList.contains("cont-r")) {
        // Titel über die ganze Balkenlänge der Woche lesbar machen
        const weekEnd = addDays(weekStart, 6);
        const n = daysBetween(day, e.occ.endDate < weekEnd ? e.occ.endDate : weekEnd) + 1;
        chip.classList.add("head");
        chip.style.width = "calc(" + n * 100 + "% + " + (n - 1) * 9 + "px)"; // 9px = Abstand + Rand + Innenabstand der Zellen (styles.css .calgrid/.calcell)
      }
    }
    return chip;
  }
  function renderCal() {
    const week = calMode === "week";
    document.querySelectorAll("#calMode .segbtn").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === calMode)));
    $("calMonthWrap").hidden = week;
    $("calDayBlock").hidden = week;
    $("calWeekList").hidden = !week;
    if (week) { renderWeek(); renderUpcoming(addDays(calWeekStart, 7)); return; }
    const lead = (parseYmd(calMonth).getDay() + 6) % 7;
    const gridStart = addDays(calMonth, -lead);
    const monthEnd = addDays(addInterval(calMonth, 1, "m"), -1);
    const weeks = Math.ceil((lead + daysBetween(calMonth, monthEnd) + 1) / 7);
    const gridEnd = addDays(gridStart, weeks * 7 - 1);
    const map = calMap(gridStart, gridEnd);
    const t = calToday();
    const grid = $("calGrid");
    grid.textContent = "";
    for (let w = 0; w < weeks; w++) {
      const weekStart = addDays(gridStart, w * 7);
      const { laneOf, count } = weekLanes(weekStart, map);
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        const list = map[d] || [];
        const hol = list.find((e) => e.type === "hol");
        const cell = h("button", {
          class: "calcell" + (d.slice(0, 7) !== calMonth.slice(0, 7) ? " other" : "") + (d === t ? " today" : "") + (d === calSel ? " sel" : "") + (hol ? " holiday" : ""),
          type: "button", "aria-label": fmtDate(d) + (hol ? ", " + hol.name : "") + (list.length ? ", " + list.length + " Einträge" : "")
        });
        cell.append(h("span", { class: "calnum" }, String(parseYmd(d).getDate())));
        // feste Spuren für mehrtägige Termine, Lücken als Platzhalter
        const slots = Array(Math.min(count, CELL_CHIPS)).fill(null);
        const rest = [];
        for (const e of list) {
          const lane = isSpan(e) ? laneOf[e.ev.id + "|" + e.occ.date] : undefined;
          if (lane !== undefined && lane < slots.length) slots[lane] = e; else if (lane === undefined) rest.push(e);
        }
        while (slots.length && !slots[slots.length - 1]) slots.pop(); // keine leeren Spuren am Ende
        const chips = slots.map((e) => e ? calChip(e, d, weekStart) : h("span", { class: "calchip gap" }, " "));
        for (const e of rest) chips.push(calChip(e, d, weekStart));
        chips.slice(0, CELL_CHIPS).forEach((c) => cell.append(c));
        const hidden = list.length - chips.slice(0, CELL_CHIPS).filter((c) => !c.classList.contains("gap")).length;
        if (hidden > 0) cell.append(h("span", { class: "calmore" }, "+" + hidden));
        cell.onclick = () => { calSel = d; renderCal(); };
        grid.append(cell);
      }
    }
    // gewählter Tag
    $("calDayTitle").textContent = (calSel === t ? "Heute · " : "") + fmtDateShort(calSel);
    const dayList = $("calDayList");
    dayList.textContent = "";
    const sel = (calSel >= gridStart && calSel <= gridEnd ? map : calMap(calSel, calSel))[calSel] || [];
    if (!sel.length) dayList.append(h("li", { class: "evempty" }, "Keine Termine"));
    for (const e of sel) dayList.append(entryNode(e, false));
    // Demnächst: die nächsten Einträge nach dem gewählten Tag (mindestens ab morgen)
    renderUpcoming(addDays(calSel > t ? calSel : t, 1));
  }
  function renderUpcoming(upFrom) {
    const upMap = calMap(upFrom, addDays(upFrom, 60));
    const up = [], seen = new Set();
    for (const day of Object.keys(upMap).sort()) {
      for (const e of upMap[day]) {
        const id = e.type === "ev" ? e.ev.id + e.occ.date : e.type === "care" ? "care" + e.ap.id : e.type + day;
        if (!seen.has(id)) { seen.add(id); up.push(e); }
      }
      if (up.length >= 6) break;
    }
    $("calUpBlock").hidden = !up.length;
    $("calUpBlock").querySelector("h2").textContent = calMode === "week" ? "Danach" : "Demnächst";
    const ul = $("calUpcoming");
    ul.textContent = "";
    for (const e of up.slice(0, 6)) ul.append(entryNode(e, true));
  }
  function calGoToday() { calSel = calWeekStart = calToday(); calMonth = calSel.slice(0, 8) + "01"; }
  function calStep(dir) {
    if (calMode === "week") { calWeekStart = addDays(calWeekStart, 7 * dir); calSel = calWeekStart; calMonth = calSel.slice(0, 8) + "01"; }
    else calMonth = addInterval(calMonth, dir, "m");
    render();
  }
  function calTitle() {
    if (calMode !== "week") return parseYmd(calMonth).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
    const a = parseYmd(calWeekStart), b = parseYmd(addDays(calWeekStart, 6));
    const left = a.getMonth() === b.getMonth() ? a.getDate() + "." : a.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
    return left + " – " + b.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }
  // Wochenansicht: 7 Tage untereinander, Termine in voller Länge
  function renderWeek() {
    const t = calToday();
    const end = addDays(calWeekStart, 6);
    const map = calMap(calWeekStart, end);
    const ol = $("calWeekList");
    ol.textContent = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(calWeekStart, i);
      const list = map[d] || [];
      const rel = d === t ? "Heute" : d === addDays(t, 1) ? "Morgen" : "";
      const add = button("+", "iconbtn dark small", () => openEvSheet(null, null, d));
      add.setAttribute("aria-label", "Termin am " + fmtDate(d) + " eintragen");
      const head = h("div", { class: "weekhead" },
        h("span", { class: "weekday" }, parseYmd(d).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" })),
        h("span", { class: "weekrel" }, rel), add);
      const items = h("ol", { class: "evlist compact" });
      if (!list.length) items.append(h("li", { class: "evempty" }, "Frei"));
      for (const e of list) items.append(entryNode(e, false));
      ol.append(h("li", { class: "weekdayrow" + (d === t ? " today" : "") + (list.some((e) => e.type === "hol") ? " holiday" : "") }, head, items));
    }
  }

  function renderTodayEvents(isToday) {
    const box = $("todayEvents");
    box.textContent = "";
    if (!isToday) return;
    const day = calToday();
    const list = (calMap(day, day)[day] || []).filter((e) => e.type !== "care");
    if (!list.length) return;
    const ol = h("ol", { class: "evlist compact" });
    for (const e of list) ol.append(entryNode(e, false));
    box.append(h("div", { class: "todayhead" }, h("span", {}, "Heute im Kalender"),
      button("Kalender", "linkbtn", () => setView("cal"))), ol);
  }

  // ---------- Termin-Formular ----------
  function chip(label, pressed, onClick, color, ink) {
    const b = button(label, "chip", onClick);
    b.setAttribute("aria-pressed", String(pressed));
    if (color) { b.style.setProperty("--chip-on", color); b.style.setProperty("--chip-on-ink", ink); }
    return b;
  }
  function renderEvForm() {
    const wc = $("evWho");
    wc.textContent = "";
    for (const w of CFG.WALKERS) {
      wc.append(chip(w, evWho.length === 1 && evWho[0] === w, () => { evWho = [w]; renderEvForm(); }, walkerColor(w), walkerInk(w)));
    }
    if (CFG.WALKERS.length > 1) {
      wc.append(chip("Beide", evWho.length > 1, () => { evWho = CFG.WALKERS.slice(); renderEvForm(); }, walkerColor(TOGETHER), walkerInk(TOGETHER)));
    }
    const cc = $("evColors");
    cc.textContent = "";
    for (const o of EV_COLORS) {
      const sw = button("", "swatch" + (o.c ? "" : " std"), () => { evColorSel = o.c; renderEvForm(); });
      sw.style.setProperty("--sw", o.c || walkerColor(whoKey(evWho) || TOGETHER));
      sw.setAttribute("aria-label", o.label);
      sw.setAttribute("aria-pressed", String(evColorSel === o.c));
      cc.append(sw);
    }
    $("evAllDay").setAttribute("aria-pressed", String(evAllDay));
    document.querySelectorAll(".evtime").forEach((el) => { el.hidden = evAllDay; });
    const rc = $("evRemind");
    rc.textContent = "";
    const opts = [...new Set([...(evAllDay ? REMIND_ALLDAY : REMIND_TIMED), ...evRemind])].sort((a, b) => a - b);
    for (const m of opts) {
      rc.append(chip(remindLabel(m, evAllDay), evRemind.includes(m), () => {
        evRemind = evRemind.includes(m) ? evRemind.filter((x) => x !== m) : [...evRemind, m];
        renderEvForm();
      }));
    }
    const recurring = $("evRepeat").value !== "0";
    $("evUntilWrap").hidden = !recurring;
    $("evPauseWrap").hidden = !recurring;
    const loc = $("evLocation").value.trim();
    const mapLink = $("evMap");
    mapLink.hidden = !loc;
    if (loc) mapLink.href = (isAppleTouch() ? "https://maps.apple.com/?q=" : "https://www.google.com/maps/search/?api=1&query=") + encodeURIComponent(loc);
  }
  function openEvSheet(ev, occ, presetDay) {
    evEditing = ev ? ev.id : "new";
    evOcc = occ || null;
    evDelArmed = false;
    const d = ev ? ev.data : null;
    $("evTitleHead").textContent = ev ? "Termin bearbeiten" : "Neuer Termin";
    $("evError").textContent = "";
    $("evTitle").value = d ? d.title || "" : "";
    evWho = d && d.who && d.who.length ? d.who.slice() : [me];
    evAllDay = d ? !!d.allDay : false;
    evRemind = d ? (d.remind || []).slice() : [60];
    evColorSel = d ? d.color || "" : "";
    let sDate, sTime, eDate, eTime;
    if (d) {
      sDate = d.start.slice(0, 10); sTime = d.allDay ? "" : d.start.slice(11, 16);
      eDate = (d.end || d.start).slice(0, 10); eTime = d.allDay ? "" : (d.end || d.start).slice(11, 16);
    } else {
      const hh = Math.min(22, new Date().getHours() + 1);
      sDate = eDate = presetDay || calSel;
      sTime = pad(hh) + ":00"; eTime = pad(hh + 1) + ":00";
    }
    $("evStartDate").value = sDate; $("evStartTime").value = sTime || "18:00";
    $("evEndDate").value = eDate; $("evEndTime").value = eTime || "19:00";
    $("evLocation").value = d ? d.location || "" : "";
    $("evRepeat").value = d && d.repeat ? d.repeat.freq || "0" : "0";
    $("evUntil").value = d && d.repeat ? d.repeat.until || "" : "";
    $("evPauseFrom").value = d && d.pause ? d.pause.from || "" : "";
    $("evPauseTo").value = d && d.pause ? d.pause.to || "" : "";
    $("evNote").value = d ? d.note || "" : "";
    $("evCustomNum").value = "";
    $("evDelete").hidden = !ev;
    $("evDelete").textContent = "Löschen";
    $("evActions").hidden = false;
    $("evDelChoice").hidden = true;
    renderEvForm();
    $("evSheet").hidden = false;
    $("sheetBg").hidden = false;
    if (!ev) setTimeout(() => $("evTitle").focus(), 60);
  }
  function submitEv() {
    const title = $("evTitle").value.trim();
    if (!title) { $("evError").textContent = "Bitte einen Titel eingeben."; return; }
    const sDate = $("evStartDate").value;
    if (!sDate) { $("evError").textContent = "Bitte ein Datum wählen."; return; }
    const eDate = $("evEndDate").value && $("evEndDate").value >= sDate ? $("evEndDate").value : sDate;
    const sTime = $("evStartTime").value || "00:00";
    let eTime = $("evEndTime").value || sTime;
    if (eDate === sDate && eTime < sTime) eTime = sTime;
    const freq = $("evRepeat").value;
    const pFrom = $("evPauseFrom").value, pTo = $("evPauseTo").value;
    const old = evEditing !== "new" ? items[evEditing] : null;
    if (evEditing !== "new" && !old) { $("evError").textContent = "Dieser Termin wurde inzwischen gelöscht."; return; }
    const data = {
      ...(old ? old.data : {}),
      title, who: evWho.slice(), allDay: evAllDay, color: evColorSel,
      start: evAllDay ? sDate + "T00:00" : sDate + "T" + sTime,
      end: evAllDay ? eDate + "T23:59" : eDate + "T" + eTime,
      location: $("evLocation").value.trim(), note: $("evNote").value.trim(),
      repeat: { freq, until: freq !== "0" ? $("evUntil").value || "" : "" },
      pause: freq !== "0" && pFrom && pTo && pTo >= pFrom ? { from: pFrom, to: pTo } : null,
      remind: evRemind.slice().sort((a, b) => a - b),
      exdates: old && old.data.exdates ? old.data.exdates : [],
      createdBy: old && old.data.createdBy ? old.data.createdBy : me
    };
    const item = old ? { ...old, data } : { id: uid(), kind: "event", data };
    saveItem(item);
    closeSheet();
    // bei Serien auf dem bearbeiteten Tag bleiben, sonst zum (neuen) Beginn springen
    if (!(old && evOcc && isRecurring(data))) {
      calSel = sDate; calMonth = sDate.slice(0, 8) + "01";
      if (sDate < calWeekStart || sDate > addDays(calWeekStart, 6)) calWeekStart = sDate;
    }
    render();
    toast(old ? "Termin gespeichert" : "Termin eingetragen");
    // Die anderen informieren, sobald der Termin in der Datenbank ist
    if (!old && !DEMO && session) setTimeout(async () => {
      await flush();
      if (!pending.some((p) => opKey(p) === "item|" + item.id)) pushCall({ action: "notify", id: item.id, by: me }).catch(() => {});
    }, 500);
  }
  function evDelete(all) {
    const ev = items[evEditing];
    if (!ev) return;
    if (!all && isRecurring(ev.data) && evOcc) {
      saveItem({ ...ev, data: { ...ev.data, exdates: [...(ev.data.exdates || []), evOcc.date] } });
    } else deleteItem(ev.id);
    closeSheet();
    toast("Termin gelöscht");
  }
  function addCustomRemind() {
    const n = parseInt($("evCustomNum").value, 10);
    if (!n || n < 1) return;
    const m = n * Number($("evCustomUnit").value);
    if (!evRemind.includes(m)) evRemind.push(m);
    $("evCustomNum").value = "";
    renderEvForm();
  }
  async function updatePushWalker() {
    if (DEMO || !session || !pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sb.from("push_subs").update({ walker: me }).eq("endpoint", sub.endpoint);
    } catch { /* nicht kritisch */ }
  }

  function bindCalendar() {
    $("calPrev").onclick = () => calStep(-1);
    $("calNextBtn").onclick = () => calStep(1);
    document.querySelectorAll("#calMode .segbtn").forEach((b) => b.addEventListener("click", () => {
      calMode = b.dataset.mode; ls.set("rr.calMode", calMode);
      calWeekStart = calSel; // Woche beginnt beim gewählten Tag
      render();
    }));
    $("calMonthBtn").onclick = () => { calGoToday(); render(); };
    // Monat wechseln durch Wischen über das Raster
    let touch = null;
    for (const el of [$("calGrid"), $("calWeekList")]) {
      el.addEventListener("touchstart", (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
      el.addEventListener("touchend", (e) => {
        if (!touch) return;
        const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
        touch = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) calStep(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
    $("calAdd").onclick = () => openEvSheet(null);
    $("evClose").onclick = closeSheet;
    $("evSheet").addEventListener("submit", (e) => { e.preventDefault(); submitEv(); });
    $("evAllDay").onclick = () => { evAllDay = !evAllDay; evRemind = evAllDay ? [1440] : [60]; renderEvForm(); };
    $("evRepeat").addEventListener("change", renderEvForm);
    $("evLocation").addEventListener("input", renderEvForm);
    $("evCustomAdd").onclick = addCustomRemind;
    $("evStartDate").addEventListener("change", () => { if ($("evEndDate").value < $("evStartDate").value) $("evEndDate").value = $("evStartDate").value; });
    $("evStartTime").addEventListener("change", () => {
      const [hh, mm] = $("evStartTime").value.split(":").map(Number);
      if (!isNaN(hh) && $("evEndDate").value === $("evStartDate").value) $("evEndTime").value = pad(Math.min(23, hh + 1)) + ":" + pad(mm);
    });
    $("evDelete").onclick = () => {
      const ev = items[evEditing];
      if (ev && isRecurring(ev.data)) { $("evActions").hidden = true; $("evDelChoice").hidden = false; return; }
      if (!evDelArmed) { evDelArmed = true; $("evDelete").textContent = "Wirklich löschen?"; return; }
      evDelete(true);
    };
    $("evDelOne").onclick = () => evDelete(false);
    $("evDelAll").onclick = () => evDelete(true);
    $("evDelCancel").onclick = () => { $("evActions").hidden = false; $("evDelChoice").hidden = true; };
    $("holidaySel").addEventListener("change", (e) => { holidayState = e.target.value; ls.set("rr.holidays", holidayState); render(); });
  }

  // ---------- Darstellung ----------
  function render() {
    renderHeader();
    renderBadge();
    if (view === "today") renderToday();
    if (view === "cal") renderCal();
    if (view === "stats") { renderStats(); renderHistory(); }
    if (view === "care") renderCare();
    if (view === "settings") renderSettings();
  }

  const VIEW_TITLES = { stats: "Statistik", care: "Rüdigers Termine", settings: "Optionen" };
  function renderHeader() {
    const t = todayStr();
    const compact = view !== "today"; // Kopfbereich ist immer kompakt; auf "Heute" mit Tagesnavigation statt Titel
    $("viewTitle").hidden = !compact || view === "cal";
    $("viewTitle").textContent = VIEW_TITLES[view] || "";
    $("calNav").hidden = view !== "cal";
    $("calMonthBtn").textContent = calTitle();
    document.querySelector(".daynav").hidden = compact;
    $("dayEyebrow").textContent = viewDay === t ? "Heute" : viewDay === addDays(t, -1) ? "Gestern" : "Nachtragen";
    $("dayDate").textContent = fmtDateShort(viewDay);
    $("pickDay").max = t;
    $("pickDay").value = viewDay;
    $("nextDay").disabled = viewDay >= t;
    const ds = dayStats(viewDay);
    $("points").textContent = String(ds.mins);
    $("pointsOf").textContent = "Min. draußen";
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
    renderTodayEvents(isToday);
    // Heute: erledigte Runden eingeklappt, offene oben. Frühere Tage: alles sichtbar zum Nachtragen.
    const box = $("doneBox");
    if (isToday) {
      renderRoundList($("rounds"), viewDay, true, (r) => !isDone(r));
      renderRoundList($("doneRounds"), viewDay, true, isDone);
      const ds = dayStats(viewDay);
      box.hidden = !ds.rounds;
      $("doneSum").textContent = "Erledigt: " + ds.rounds + (ds.rounds === 1 ? " Runde" : " Runden") + " · " + fmtHM(ds.mins);
      if (ds.rounds === NR) $("rounds").append(h("li", { class: "evempty" }, "Alle Runden für heute erledigt."));
    } else {
      renderRoundList($("rounds"), viewDay, false);
      box.hidden = true;
    }
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
      const b = button(w, "chip", () => { me = w; ls.set("rr.me", w); saveWalkerToAccount(w); updatePushWalker(); renderSettings(); });
      b.setAttribute("aria-pressed", String(w === me));
      b.style.setProperty("--chip-on", walkerColor(w));
      b.style.setProperty("--chip-on-ink", walkerInk(w));
      chips.append(b);
    }
    const hs = $("holidaySel");
    if (!hs.options.length) for (const [k, v] of Object.entries(STATES)) hs.append(h("option", { value: k }, v));
    hs.value = holidayState;
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
    sec("Kalender", [
      "Termine gelten für eine Person oder für beide. Standardfarbe nach Person: " + CFG.WALKERS.join(" und ") + " jeweils eigene Farbe, beide blau. Im Termin lässt sich auch eine andere Farbe wählen.",
      "Rüdigers Behandlungen sind türkis, Feiertage rot hinterlegt. Das Bundesland für die Feiertage steht unter Optionen.",
      "Mehrtägige Termine erscheinen als durchgehender Balken.",
      "Oben zwischen Woche und Monat umschalten. Die Woche zeigt 7 Tage ab dem gewählten Tag mit vollständigen Terminen. Blättern: Pfeile oben oder seitlich wischen. Tippen auf den Monat springt zu heute. Beim Öffnen des Kalenders ist immer heute gewählt.",
      "Tippen auf einen Tag zeigt seine Termine, + Termin legt einen neuen Termin für diesen Tag an.",
      "Erinnerungen: Zeitpunkte antippen oder unter \"Eigene\" einen eigenen Wert hinzufügen. Sie kommen nur an die Personen, für die der Termin gilt, bei ganztägigen Terminen um 8 Uhr.",
      "Trägt jemand einen neuen Termin ein, bekommt die andere Person eine Benachrichtigung.",
      "Wiederkehrende Termine lassen sich für einen Zeitraum pausieren, z. B. in den Ferien. Beim Löschen lässt sich wählen: nur dieser Tag oder die ganze Serie.",
      "Android: lange auf das App-Symbol drücken öffnet Abkürzungen für Neuer Termin, Kalender und Heute."
    ]);
    sec("Statistik", [
      "Farben: " + CFG.WALKERS.join(" und ") + " jeweils eigene Farbe, zusammen blau.",
      "Gemeinsame Runden zählen bei beiden Personen, in der Gesamtsumme nur einmal.",
      "Bei \"Runden pro Tag\" gilt: je kräftiger die Farbe, desto mehr Runden."
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
  function closeSheet() { $("sheet").hidden = true; $("apSheet").hidden = true; $("evSheet").hidden = true; $("sheetBg").hidden = true; editing = null; apEditing = null; evEditing = null; }

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
    for (const name of ["today", "cal", "stats", "care", "settings"]) $("view-" + name).hidden = name !== v;
    document.querySelectorAll(".tab").forEach((t) => {
      if (t.dataset.view === v) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (!keepDay) { viewDay = todayStr(); if (v === "cal") calGoToday(); }
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
    bindCalendar();
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
      // nach längerer Abwesenheit startet der Kalender wieder bei heute
      if (view === "cal" && $("evSheet").hidden && Date.now() - hiddenAt > 10 * 60000) calGoToday();
      lastToday = t;
      render();
      schedulePull();
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hiddenAt = Date.now(); });
    setInterval(() => {
      document.querySelectorAll("[data-run]").forEach((el) => {
        el.textContent = clock(activeSec({ started_at: el.dataset.start, pause_sec: Number(el.dataset.pause), paused_at: el.dataset.paused || null }));
      });
    }, 1000);
    setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // Tageswechsel um 4 Uhr auch bei dauerhaft geöffneter App mitnehmen
      const t = todayStr();
      if (t !== lastToday) { if (viewDay === lastToday) viewDay = t; lastToday = t; render(); }
      pull();
    }, 60000);
  }

  // ---------- Start ----------
  if (DEMO) seedDemo();
  bind();
  // Sprungziele für Benachrichtigungen und App-Verknüpfungen (lange auf das App-Symbol drücken)
  function routeHash() {
    const hsh = location.hash;
    if (!hsh) return false;
    if (hsh === "#care") setView("care");
    else if (hsh === "#cal") setView("cal");
    else if (hsh === "#today") setView("today");
    else if (hsh === "#new-event") { setView("cal"); openEvSheet(null, null, calToday()); }
    else return false;
    window.history.replaceState(null, "", location.pathname + location.search);
    return true;
  }
  window.addEventListener("hashchange", routeHash);
  if (!routeHash()) render();
  refreshPush().then(() => { if (view === "settings") renderSettings(); });
  if (HAS_DB) initDb();
})();
