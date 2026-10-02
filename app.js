/* Rüdigers Runden: App-Logik
   Daten liegen lokal auf dem Handy (funktioniert auch ohne Netz) und werden,
   wenn Supabase eingerichtet ist, mit der gemeinsamen Datenbank abgeglichen. */
(() => {
  "use strict";

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
    DAY_START_HOUR: 4
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

  // ---------- Lokaler Speicher ----------
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } }
  };
  const P = DEMO ? "rr.demo4." : "rr.";
  let walks = ls.get(P + "walks", {});      // "YYYY-MM-DD|slot" -> Runde
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

  const $ = (id) => document.getElementById(id);
  const key = (day, slot) => day + "|" + slot;
  const opKey = (op) => op.op === "delete" ? key(op.day, op.slot) : key(op.rec.day, op.rec.slot);
  const walkerColor = (w) => w === TOGETHER ? "var(--w3)" : "var(--w" + ((CFG.WALKERS.indexOf(w) % 2) + 1) + ")";

  // Ältere Einträge (ein Name) in die Liste "walkers" umwandeln
  function normalize(r) {
    if (!r) return r;
    if (!Array.isArray(r.walkers)) r.walkers = r.walker ? [r.walker] : [];
    delete r.walker;
    r.poo = Number(r.poo) || 0;   // früher ja/nein, jetzt Anzahl
    return r;
  }
  const isTogether = (r) => r.walkers.length > 1;
  const whoText = (r) => r.walkers.length ? r.walkers.join(" & ") : "ohne Namen";

  // ---------- Datum ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function gassiDay(date) {
    const d = new Date(date);
    if (d.getHours() < CFG.DAY_START_HOUR) d.setDate(d.getDate() - 1);
    return ymd(d);
  }
  function todayStr() { return gassiDay(new Date()); }
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
  const fmtNum = (n) => n.toLocaleString("de-DE");

  // ---------- Auswertung ----------
  const isDone = (r) => !!(r && r.ended_at);
  const isRunning = (r) => !!(r && r.started_at && !r.ended_at);
  function minutesOf(r) {
    if (r.duration_min != null) return r.duration_min;
    if (r.started_at && r.ended_at) return Math.max(0, Math.round((new Date(r.ended_at) - new Date(r.started_at)) / 60000));
    return 0;
  }
  function dayStats(day) {
    let rounds = 0, mins = 0;
    for (let s = 1; s <= NR; s++) { const r = walks[key(day, s)]; if (isDone(r)) { rounds++; mins += minutesOf(r); } }
    return { rounds, mins };
  }
  // Gemessene Runden einer Runde aus den letzten 30 Tagen (ohne geschätzte Einträge)
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
  // Übliche Startzeit, gerechnet ab Tagesbeginn (4:00), damit 23:50 und 0:10 sauber mitteln
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

  // ---------- Speichern ----------
  function persist() { ls.set(P + "walks", walks); ls.set(P + "pending", pending); }
  function queue(op) { const k = opKey(op); pending = pending.filter((p) => opKey(p) !== k); pending.push(op); }

  function saveRec(rec) {
    rec.updated_at = new Date().toISOString();
    walks[key(rec.day, rec.slot)] = rec;
    if (!DEMO) queue({ op: "upsert", rec });
    persist(); render(); flush();
  }
  function deleteRec(day, slot, quiet) {
    delete walks[key(day, slot)];
    if (!DEMO) queue({ op: "delete", day, slot });
    if (quiet) return;
    persist(); render(); flush();
  }

  // ---------- Abgleich mit Supabase ----------
  function rowFor(r) {
    return {
      day: r.day, slot: r.slot, walkers: r.walkers || [],
      started_at: r.started_at || null, ended_at: r.ended_at || null,
      duration_min: r.duration_min == null ? null : r.duration_min,
      estimated: !!r.estimated, poo: Number(r.poo) || 0, note: r.note || null, updated_at: r.updated_at
    };
  }
  async function flush() {
    if (DEMO || !session || syncing) return;
    if (!navigator.onLine) { render(); return; }
    syncing = true;
    try {
      while (pending.length) {
        const op = pending[0];
        const res = op.op === "upsert"
          ? await sb.from("walks").upsert(rowFor(op.rec), { onConflict: "day,slot" })
          : await sb.from("walks").delete().eq("day", op.day).eq("slot", op.slot);
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
  async function fetchAll() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("walks").select("*").order("day").range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
  async function pull() {
    if (DEMO || !session || !navigator.onLine) { render(); return; }
    await flush();
    let data;
    try { data = await fetchAll(); } catch (e) { syncError = (e && e.message) || String(e); render(); return; }
    const waiting = new Set(pending.map(opKey));
    const next = {};
    for (const [k, r] of Object.entries(walks)) if (waiting.has(k)) next[k] = r;
    for (const r of data) { const k = key(r.day, r.slot); if (!waiting.has(k)) next[k] = normalize({ ...r }); }
    walks = next;
    lastSync = new Date().toISOString();
    ls.set(P + "lastSync", lastSync);
    syncError = null;
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
    sb.channel("walks-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "walks" }, () => schedulePull())
      .subscribe();
    if (session) schedulePull();
  }
  function showLogin(show) { $("login").hidden = !show; }

  // Wer bin ich? Gespeichert am Konto, sonst aus der E-Mail-Adresse erraten (z. B. kim.xyz@... = Kim).
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
        const walkers = x < 0.15 ? CFG.WALKERS.slice() : [CFG.WALKERS[x < 0.6 ? 0 : 1] || CFG.WALKERS[0]];
        walks[key(day, slot)] = {
          day, slot, walkers,
          started_at: s.toISOString(), ended_at: new Date(s.getTime() + dur * 60000).toISOString(),
          duration_min: dur, estimated: false, poo: rnd() < 0.45 ? (rnd() < 0.25 ? 2 : 1) : 0, note: "", updated_at: s.toISOString()
        };
      });
    }
    ls.set(P + "seeded", true);
    persist();
  }

  // ---------- Aktionen ----------
  function startWalk(slot) {
    saveRec({ day: todayStr(), slot, walkers: [me], started_at: new Date().toISOString(), ended_at: null,
      duration_min: null, estimated: false, poo: 0, note: "" });
  }
  function stopWalk(rec) {
    const now = new Date();
    saveRec({ ...rec, ended_at: now.toISOString(),
      duration_min: Math.max(1, Math.round((now - new Date(rec.started_at)) / 60000)) });
  }
  // Ein Tipp: Runde mit der Durchschnittsdauer genau dieser Runde eintragen.
  // Heute und gerade zurück? Dann endet die Runde jetzt. Sonst zur üblichen Zeit der Runde.
  function quickDone(day, slot) {
    const dur = avgDuration(slot);
    const usual = new Date(combine(day, typicalStart(slot)));
    const now = new Date();
    let start = usual;
    if (day === todayStr() && now > usual && now - usual < (dur + 120) * 60000) {
      start = new Date(now.getTime() - dur * 60000);
    }
    if (start > now) start = new Date(now.getTime() - dur * 60000);
    saveRec({ day, slot, walkers: [me], started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + dur * 60000).toISOString(),
      duration_min: dur, estimated: true, poo: 0, note: "" });
    toast(ROUNDS[slot - 1].name + " eingetragen: " + hm(start.toISOString()) + " Uhr, " + dur + " min. Antippen zum Ändern.");
  }
  function addPoo(rec) { saveRec({ ...rec, poo: (rec.poo || 0) + 1 }); }
  // Zu zweit an/aus. Die Person, die die Runde angelegt hat, bleibt vorne.
  function toggleTogether(rec) {
    const first = rec.walkers[0] || me;
    const walkers = isTogether(rec) ? [first] : [first, ...CFG.WALKERS.filter((w) => w !== first)];
    saveRec({ ...rec, walkers });
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
  function elapsed(iso) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? Math.floor(m / 60) + ":" + pad(m % 60) + " h" : m + ":" + pad(s % 60) + " min";
  }
  function metaNode(rec) {
    const span = h("span", { class: "rmeta" });
    if (!rec) { span.textContent = "Offen"; return span; }
    if (isRunning(rec)) {
      span.append("Läuft seit ", h("span", { "data-since": rec.started_at }, elapsed(rec.started_at)), " · " + whoText(rec));
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

  // Karten für die vier Runden eines Tages.
  // live = Heute-Ansicht für den heutigen Tag (▶ und Erledigt), sonst Nachtragen (Ø und Genau).
  function renderRoundList(ol, day, live) {
    ol.textContent = "";
    ROUNDS.forEach((r, i) => {
      const slot = i + 1, rec = walks[key(day, slot)];
      const li = h("li", { class: "round" + (isDone(rec) ? " done" : isRunning(rec) ? " running" : "") });
      li.append(h("span", { class: "num", "aria-hidden": "true" }, isDone(rec) ? "✓" : String(slot)));
      const body = h("button", { class: "rbody", type: "button", "aria-label": r.name + (rec ? " korrigieren" : " eintragen") });
      body.append(h("span", { class: "rname" }, r.name), metaNode(rec));
      body.onclick = () => openSheet(day, slot);
      li.append(body);
      const act = h("div", { class: "ractions" });
      const together = rec && CFG.WALKERS.length > 1
        ? toggleBtn("👥", "iconchip", isTogether(rec), isTogether(rec) ? "Zusammen gegangen, antippen für allein" : "Zusammen gegangen?", () => toggleTogether(rec))
        : null;
      if (isRunning(rec)) {
        act.append(together, button("Stopp", "btn small run", () => stopWalk(rec)));
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

  // ---------- Darstellung ----------
  function render() {
    renderHeader();
    if (view === "today") renderToday();
    if (view === "add") renderAdd();
    if (view === "history") renderHistory();
    if (view === "stats") renderStats();
    if (view === "settings") renderSettings();
  }

  function renderHeader() {
    const t = todayStr();
    $("dayEyebrow").textContent = viewDay === t ? "Heute" : viewDay === addDays(t, -1) ? "Gestern" : "Nachtragen";
    $("dayDate").textContent = fmtDateShort(viewDay);
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
      html += `<circle class="${cls}" cx="60" cy="60" r="50" stroke-dasharray="${(len - gap).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-(i * len + gap / 2)).toFixed(2)}"></circle>`;
    }
    $("ring").innerHTML = html;

    const st = $("status");
    let msg = "", warn = false;
    if (DEMO) { msg = "Testmodus: Daten bleiben auf diesem Gerät"; warn = true; }
    else if (!navigator.onLine) { msg = "Offline. Wird später abgeglichen"; warn = true; }
    else if (syncError) { msg = "Abgleich hat nicht geklappt. Nächster Versuch läuft automatisch"; warn = true; }
    else if (pending.length) msg = pending.length === 1 ? "1 Änderung wird abgeglichen" : pending.length + " Änderungen werden abgeglichen";
    else if (lastSync) msg = "Abgeglichen um " + hm(lastSync) + " Uhr";
    st.textContent = msg;
    st.classList.toggle("warn", warn);
  }

  function renderToday() {
    const isToday = viewDay === todayStr();
    renderRoundList($("rounds"), viewDay, isToday);

  }

  function renderAdd() {
    const t = todayStr();
    const inp = $("addDate");
    inp.max = t;
    inp.value = viewDay;
    const chips = $("dateChips");
    chips.textContent = "";
    [["Heute", t], ["Gestern", addDays(t, -1)], ["Vorgestern", addDays(t, -2)]].forEach(([label, d]) => {
      const b = button(label, "chip", () => { viewDay = d; render(); });
      b.setAttribute("aria-pressed", String(viewDay === d));
      chips.append(b);
    });
    renderRoundList($("addRounds"), viewDay, false);
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
        const c = isTogether(r) ? TOGETHER : r.walkers[0];
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
      keys.append(h("span", { class: "keyitem" }, dot, c === TOGETHER ? "Zusammen" : c));
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

  // Gemeinsame Runden zählen bei jeder beteiligten Person voll, in "Alle Runden" nur einmal.
  function periodStats(p) {
    const t = todayStr();
    const from = p.days ? addDays(t, -(p.days - 1)) : null;
    const by = Object.fromEntries(CFG.WALKERS.map((w) => [w, { rounds: 0, mins: 0, poo: 0, together: 0 }]));
    const total = { rounds: 0, mins: 0, poo: 0, together: 0 };
    let first = null;
    for (const r of Object.values(walks)) {
      if (!isDone(r) || r.day > t || (from && r.day < from)) continue;
      const m = minutesOf(r);
      total.rounds++; total.mins += m; total.poo += r.poo || 0; if (isTogether(r)) total.together++;
      if (!first || r.day < first) first = r.day;
      for (const w of r.walkers) {
        if (!(w in by)) continue;
        by[w].rounds++; by[w].mins += m; by[w].poo += r.poo || 0; if (isTogether(r)) by[w].together++;
      }
    }
    return { by, total, first };
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

    const wb = $("whoBlock");
    wb.textContent = "";
    const span = p.days ? "letzte " + p.days + " Tage inkl. heute"
      : (s.first ? "seit " + fmtDay(s.first) : "noch keine Runden");
    wb.append(h("h2", {}, "Wer war wie oft draußen? ", h("span", { class: "sub" }, span)));
    const maxR = Math.max(1, ...Object.values(s.by).map((x) => x.rounds));
    for (const w of CFG.WALKERS) {
      const x = s.by[w];
      const share = s.total.rounds ? Math.round(x.rounds / s.total.rounds * 100) : 0;
      const fill = h("div", { class: "fill" });
      fill.style.width = (x.rounds / maxR * 100) + "%";
      fill.style.background = walkerColor(w);
      wb.append(h("div", { class: "whocard" },
        h("div", { class: "whohead" }, h("span", { class: "whoname" }, w), h("span", { class: "whobig" }, String(x.rounds)),
          h("span", { class: "whounit" }, x.rounds === 1 ? "Runde" : "Runden")),
        h("div", { class: "track" }, fill),
        h("div", { class: "whometa" }, "bei " + share + " % aller Runden dabei · davon " + x.together + " zusammen · " + fmtNum(x.mins) + " min · " + x.poo + " 💩")));
    }
    wb.append(h("p", { class: "legend" }, "Alle Runden: " + s.total.rounds + ", davon " + s.total.together + " zusammen. " +
      fmtNum(s.total.mins) + " Minuten, " + s.total.poo + " Häufchen. Gemeinsame Runden zählen bei beiden."));

    const tbl = $("statTable");
    tbl.textContent = "";
    const all = PERIODS.map(periodStats);
    tbl.append(h("thead", {}, h("tr", {}, h("th", {}, ""), ...PERIODS.map((x) => h("th", { scope: "col" }, x.label)))));
    const tb = h("tbody");
    const cell = (v) => h("td", {}, h("b", {}, String(v.rounds)), h("small", {}, fmtNum(v.mins) + " min"));
    for (const w of CFG.WALKERS) tb.append(h("tr", {}, h("th", { scope: "row" }, w), ...all.map((x) => cell(x.by[w]))));
    tb.append(h("tr", { class: "sum" }, h("th", { scope: "row" }, "Alle Runden"), ...all.map((x) => cell(x.total))));
    tbl.append(tb);

    const al = $("avgList");
    al.textContent = "";
    ROUNDS.forEach((r, i) => {
      const list = history(i + 1);
      al.append(h("div", { class: "avgrow" }, h("span", {}, r.name),
        h("b", {}, "Ø " + avgDuration(i + 1) + " min"),
        h("small", {}, list.length ? list.length + " gemessen · meist ab " + typicalStart(i + 1) + " Uhr" : "noch keine Werte, Vorgabe")));
    });
  }

  function renderSettings() {
    const chips = $("meChips");
    chips.textContent = "";
    for (const w of CFG.WALKERS) {
      const b = button(w, "chip", () => { me = w; ls.set("rr.me", w); saveWalkerToAccount(w); renderSettings(); });
      b.setAttribute("aria-pressed", String(w === me));
      chips.append(b);
    }
    let info;
    if (DEMO) info = "Keine Datenbank eingetragen (config.js). Die App läuft im Testmodus.";
    else if (!session) info = "Nicht angemeldet.";
    else {
      info = "Angemeldet als " + ((session.user && session.user.email) || "unbekannt") + ". ";
      info += lastSync ? "Zuletzt abgeglichen um " + hm(lastSync) + " Uhr." : "Noch nicht abgeglichen.";
      if (pending.length) info += " " + pending.length + " Änderung(en) warten.";
      if (syncError) info += " Letzter Fehler: " + syncError;
    }
    $("syncInfo").textContent = info;
    $("syncNow").hidden = DEMO;
    $("logout").hidden = DEMO || !session;
    $("demoBlock").hidden = !DEMO;
    $("rulesInfo").textContent =
      "Der Gassi-Tag läuft von " + CFG.DAY_START_HOUR + ":00 bis " + CFG.DAY_START_HOUR + ":00 Uhr, eine Runde um 0:30 Uhr zählt also zum Vortag. " +
      "Erledigt und Ø nehmen die durchschnittliche Dauer derselben Runde aus den letzten 30 Tagen. Gibt es dafür noch keine Werte, sind es " + CFG.DEFAULT_MINUTES + " Minuten. " +
      "Solche Einträge sind mit ca. markiert und fließen nicht in spätere Durchschnitte ein. Gemeinsame Runden zählen in der Statistik bei beiden.";
  }

  // ---------- Bearbeiten ----------
  function renderSheetChips() {
    const sc = $("slotChips");
    sc.textContent = "";
    ROUNDS.forEach((r, i) => {
      const slot = i + 1;
      const taken = slot !== editing.slot && walks[key(editing.day, slot)];
      const b = button(r.name, "chip" + (taken ? " taken" : ""), () => { editing.newSlot = slot; $("sheetError").textContent = ""; renderSheetChips(); });
      b.setAttribute("aria-pressed", String(slot === editing.newSlot));
      if (taken) b.title = "Schon eingetragen";
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
      wc.append(b);
    }
    $("pooVal").textContent = sheetPoo ? "💩".repeat(Math.min(sheetPoo, 5)) + (sheetPoo > 5 ? " " + sheetPoo : "") : "keins";
    $("pooMinus").disabled = sheetPoo === 0;
    $("fDur").placeholder = "Ø " + avgDuration(editing.newSlot);
    $("durHint").textContent = isRunning(walks[key(editing.day, editing.slot)])
      ? "Die Runde läuft noch. Jetzt beenden stoppt die Zeit."
      : "Dauer leer lassen = Ø dieser Runde (" + avgDuration(editing.newSlot) + " min).";
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
    $("fDur").value = rec ? (minutesOf(rec) || "") : (exact ? avgDuration(slot) : "");
    $("fDur").disabled = isRunning(rec);
    $("fNote").value = (rec && rec.note) || "";
    $("fDelete").hidden = !rec;
    $("fDelete").textContent = "Löschen";
    $("fStop").hidden = !isRunning(rec);
    renderSheetChips();
    $("sheet").hidden = false;
    $("sheetBg").hidden = false;
    if (exact) setTimeout(() => $("fTime").focus(), 50);
  }
  function closeSheet() { $("sheet").hidden = true; $("sheetBg").hidden = true; editing = null; }

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
      note: $("fNote").value.trim(), started_at: combine(day, time), ended_at: null, duration_min: null
    };
    if (isRunning(old) && !stopNow) {
      // Runde läuft weiter
    } else if (isRunning(old) && stopNow) {
      const now = new Date();
      rec.ended_at = now.toISOString();
      rec.duration_min = Math.max(1, Math.round((now - new Date(rec.started_at)) / 60000));
    } else {
      let d = dur;
      if (!d) { d = avgDuration(newSlot); rec.estimated = true; }
      else if (old && old.estimated && old.duration_min === d) rec.estimated = true;
      rec.ended_at = new Date(new Date(rec.started_at).getTime() + d * 60000).toISOString();
      rec.duration_min = d;
    }
    if (newSlot !== slot && old) deleteRec(day, slot, true);
    saveRec(rec);
    closeSheet();
    toast(old ? "Korrektur gespeichert" : ROUNDS[newSlot - 1].name + " eingetragen");
  }

  // ---------- Ereignisse ----------
  function setView(v, keepDay) {
    view = v;
    for (const name of ["today", "add", "history", "stats", "settings"]) $("view-" + name).hidden = name !== v;
    document.querySelectorAll(".tab").forEach((t) => {
      if (t.dataset.view === v) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (!keepDay) viewDay = v === "add" ? addDays(todayStr(), -1) : todayStr();
    render();
    window.scrollTo(0, 0);
  }

  function bind() {
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
    $("prevDay").onclick = () => {
      viewDay = addDays(viewDay, -1);
      if (view !== "today" && view !== "add") setView("today", true); else render();
    };
    $("nextDay").onclick = () => { if (viewDay < todayStr()) { viewDay = addDays(viewDay, 1); render(); } };
    $("addDate").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v && v <= todayStr()) { viewDay = v; render(); }
    });
    $("sheetClose").onclick = closeSheet;
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
    $("syncNow").onclick = () => pull();
    $("logout").onclick = async () => { if (sb) await sb.auth.signOut(); };
    $("clearDemo").onclick = () => { walks = {}; persist(); render(); };
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("loginError").textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPw").value });
      if (error) $("loginError").textContent = "Anmeldung hat nicht geklappt. Bitte E-Mail und Passwort prüfen.";
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && editing) closeSheet(); });
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
      document.querySelectorAll("[data-since]").forEach((el) => { el.textContent = elapsed(el.dataset.since); });
    }, 1000);
    setInterval(() => { if (document.visibilityState === "visible") pull(); }, 60000);
  }

  // ---------- Start ----------
  if (DEMO) seedDemo();
  bind();
  render();
  if (HAS_DB) initDb();
})();
