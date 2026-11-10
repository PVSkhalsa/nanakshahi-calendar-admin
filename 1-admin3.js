import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id), LANGS = ["pa","hi","en"];
const say = m => { $("status").textContent = m; };
let meta = null, months = {}, current = null, pendingImport = null;

$("signIn").onclick = async () => { try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { say("Sign-in failed: " + e.code); } };
$("signOut").onclick = () => signOut(auth);
onAuthStateChanged(auth, async u => {
  const ok = u && u.emailVerified && u.email === OWNER_EMAIL;
  $("signIn").hidden = !!u; $("signOut").hidden = !u; $("app").hidden = !ok;
  if (u && !ok) { say("This Google account is not the owner. You are signed out."); signOut(auth); return; }
  if (ok) { say("Signed in as owner. Loading data."); await load(); }
  else say("Not signed in.");
});

async function load() {
  const m = await getDoc(doc(db, "calendar", "meta"));
  meta = m.exists() ? m.data() : { title: {pa:"",hi:"",en:""}, samvat: "" };
  months = {};
  (await getDocs(collection(db, "calendar"))).forEach(d => { if (d.id.startsWith("month_")) months[d.id] = d.data(); });
  $("samvat").value = typeof meta.samvat === "string" ? meta.samvat : (meta.samvat?.pa || "");
  LANGS.forEach(l => $("t_" + l).value = meta.title?.[l] || "");
  const sel = $("monthSel"); sel.innerHTML = "";
  Object.entries(months).sort((a,b)=>(a[1].order??0)-(b[1].order??0)).forEach(([id,d]) => {
    const o = document.createElement("option"); o.value = id; o.textContent = d.title?.en || d.title?.pa || id; sel.append(o); });
  sel.onchange = () => showMonth(sel.value);
  if (sel.options.length) showMonth(sel.options[0].value);
  const p = await getDoc(doc(db, "announcements", "current"));
  if (p.exists()) { LANGS.forEach(l => $("p_" + l).value = p.data().text?.[l] || ""); $("p_on").value = p.data().active ? "on" : "off"; }
  say("Loaded " + Object.keys(months).length + " months.");
}

/* ---- Date-entry editor: explicit day + month pickers, chronological order, originals preserved ---- */
const GM = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DIG = { pa: "੦੧੨੩੪੫੬੭੮੯", hi: "०१२३४५६७८९", en: "0123456789" };
const loc = (n, l, pad) => String(pad ? String(n).padStart(2, "0") : n).replace(/\d/g, c => DIG[l][+c]);
const DRE = { en: /\((\d+)(?:-(\d+))? ([A-Za-z]+)\)/, pa: /\((\d+)(?:-(\d+))? ([^)]+)\)/, hi: /\((\d+)(?:-(\d+))? ([^)]+)\)/ };
let work = [], sel = 0, gmNames = null;
function learnNames() {
  gmNames = { pa: {}, hi: {}, en: {} };
  GM.forEach((m, i) => { gmNames.en[i] = m; });
  for (const d of Object.values(months)) {
    const n = Math.min(...LANGS.map(l => (d.events?.[l] || []).length));
    for (let i = 0; i < n; i++) { const e = d.events.en[i].match(DRE.en); if (!e) continue; const mi = GM.indexOf(e[3]); if (mi < 0) continue;
      ["pa", "hi"].forEach(l => { const x = d.events[l][i].match(DRE[l]); if (x) gmNames[l][mi] = x[3]; }); }
  }
}
const gmName = (mi, l) => { if (!gmNames) learnNames(); return gmNames[l][mi] || new Intl.DateTimeFormat(l === "pa" ? "pa-IN" : l === "hi" ? "hi-IN" : "en-GB", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, mi, 1))); };
const orderedIds = () => Object.entries(months).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0)).map(([id]) => id);
function monthStart(id) { // {date (UTC ms), year}
  const ids = orderedIds(), startYear = +((meta?.title?.en || "").match(/(\d{4})/)?.[1] || 2026);
  let year = startYear, prev = 0, res = null;
  for (const k of ids) { const s = months[k].sangrand?.en?.match(/(\d+) ([A-Za-z]+)/); if (!s) continue; const mi = GM.indexOf(s[2]); if (mi < prev) year++; prev = mi; if (k === id) res = Date.UTC(year, mi, +s[1]); }
  return res;
}
function monthEnd(id) { // exclusive: next sangrand, or 14 March after the first sangrand year for the last month
  const ids = orderedIds(), i = ids.indexOf(id);
  if (i < ids.length - 1) return monthStart(ids[i + 1]);
  const s0 = monthStart(ids[0]); const d = new Date(s0); return Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate());
}
function entryMs(e, id) { const s = new Date(monthStart(id)); let y = s.getUTCFullYear(); if (e.mon < s.getUTCMonth()) y++; const t = Date.UTC(y, e.mon, e.day); const ok = new Date(t); return ok.getUTCMonth() === e.mon && ok.getUTCDate() === e.day ? t : NaN; }
function buildWork(id) {
  const d = months[id], n = Math.max(...LANGS.map(l => (d.events?.[l] || []).length), 0), out = [];
  for (let i = 0; i < n; i++) {
    const e = { text: {}, raw: {}, day: 0, mon: 0, end: 0 };
    LANGS.forEach(l => { const t = d.events?.[l]?.[i] || "", k = t.indexOf("): "); e.raw[l] = k >= 0 ? t.slice(0, k + 3) : ""; e.text[l] = k >= 0 ? t.slice(k + 3) : t; });
    const m = (d.events?.en?.[i] || "").match(DRE.en);
    if (m) { e.day = +m[1]; e.end = m[2] ? +m[2] : 0; e.mon = GM.indexOf(m[3]); }
    e.orig = { day: e.day, mon: e.mon };
    out.push(e);
  }
  return out;
}
const nanakNum = (e, id) => { const t = entryMs(e, id); return isNaN(t) ? NaN : Math.round((t - monthStart(id)) / 86400000) + 1; };
function prefix(e, l, id) {
  if (e.raw[l] && e.day === e.orig.day && e.mon === e.orig.mon) return e.raw[l];
  const nm = (months[id].title?.[l] || "").split(" (")[0], n = nanakNum(e, id);
  return `${loc(n, l, true)} ${nm} (${e.day}${e.end ? "-" + e.end : ""} ${gmName(e.mon, l)}): `;
}
function sortWork() { const cur = work[sel]; work.sort((a, b) => { const x = entryMs(a, current), y = entryMs(b, current); return (isNaN(x) ? 9e15 : x) - (isNaN(y) ? 9e15 : y); }); sel = Math.max(0, work.indexOf(cur)); }
const label = (e, i) => { const n = nanakNum(e, current); return (i + 1) + ". " + (e.day ? e.day + " " + GM[e.mon] : "no date") + (isNaN(n) ? "" : " (day " + n + ")") + ": " + (e.text.en || e.text.pa || "(empty)").slice(0, 40); };
function showMonth(id) { current = id; sel = 0; const d = months[id];
  LANGS.forEach(l => { $("mt_" + l).value = d.title?.[l] || ""; $("sg_" + l).value = d.sangrand?.[l] || ""; });
  work = buildWork(id); renderEvents(); }
function renderEvents() {
  const box = $("events"), es = $("entrySel"); box.innerHTML = ""; es.innerHTML = "";
  work.forEach((e, i) => { const o = document.createElement("option"); o.value = i; o.textContent = label(e, i); es.append(o); });
  es.value = String(sel); es.onchange = () => { collect(); sel = +es.value; renderEvents(); };
  if (!work.length) { box.textContent = "No entries in this month yet. Use the add button."; return; }
  const e = work[sel], f = document.createElement("fieldset");
  const dayOpts = Array.from({ length: 31 }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join("");
  const monOpts = GM.map((m, k) => `<option value="${k}">${m}</option>`).join("");
  f.innerHTML = `<legend>Entry ${sel + 1} of ${work.length}</legend>
    <label for="eDay">Date of this entry: day</label><select id="eDay">${dayOpts}</select>
    <label for="eMon">Date of this entry: month</label><select id="eMon">${monOpts}</select>
    <p id="eInfo" role="status"></p>` + LANGS.map(l =>
    `<label>Entry ${sel + 1} text, ${{ pa: "Punjabi", hi: "Hindi", en: "English" }[l]} (the date is added automatically)<textarea data-l="${l}" lang="${l}" rows="3"></textarea></label>`).join("") +
    `<button type="button" class="danger">Delete entry ${sel + 1}</button>`;
  box.append(f);
  $("eDay").value = String(e.day || 1); $("eMon").value = String(e.mon);
  LANGS.forEach(l => f.querySelector(`[data-l=${l}]`).value = e.text[l]);
  const info = () => { const n = nanakNum({ ...e, day: +$("eDay").value, mon: +$("eMon").value }, current); $("eInfo").textContent = isNaN(n) ? "This date does not exist." : (n < 1 || entryMs({ day: +$("eDay").value, mon: +$("eMon").value }, current) >= monthEnd(current) ? "This date is outside this Nanakshahi month." : "This is day " + n + " of this month."); };
  info();
  $("eDay").onchange = $("eMon").onchange = () => { collect(); info(); sortWork(); renderEvents(); say("Date changed. The entry moved to its place in date order."); };
  f.querySelector("button").onclick = () => { collect(); work.splice(sel, 1); sel = Math.max(0, sel - 1); renderEvents(); say("Entry deleted here. Not published yet."); };
}
function collect() {
  const d = months[current]; d.title = {}; d.sangrand = {};
  LANGS.forEach(l => { d.title[l] = $("mt_" + l).value.trim(); d.sangrand[l] = $("sg_" + l).value.trim(); });
  const f = document.querySelector("#events fieldset");
  if (f && work[sel]) { const e = work[sel]; e.day = +$("eDay").value; e.mon = +$("eMon").value; LANGS.forEach(l => e.text[l] = f.querySelector(`[data-l=${l}]`).value.trim()); }
  d.events = { pa: [], hi: [], en: [] };
  work.forEach(e => LANGS.forEach(l => d.events[l].push(prefix(e, l, current) + e.text[l])));
  return d;
}
$("addEvent").onclick = () => { collect(); const s = new Date(monthStart(current)); const e = { text: { pa: "", hi: "", en: "" }, raw: { pa: "", hi: "", en: "" }, day: s.getUTCDate(), mon: s.getUTCMonth(), end: 0, orig: { day: 0, mon: 0 } };
  work.push(e); sel = work.length - 1; sortWork(); renderEvents(); say("New entry added with the first day of this month as its date. Choose its day and month, fill all three languages, then Publish this month."); };
function validateMonth(d) {
  const errs = [], len = d.events.pa.length, lo = monthStart(current), hi = monthEnd(current);
  LANGS.forEach(l => { if (d.events[l].length !== len) errs.push("Language lists differ in length"); });
  if (!d.title.en || !d.sangrand.en) errs.push("Month name and Sangrand are required in English");
  work.forEach((e, i) => { const t = entryMs(e, current);
    if (!e.day) errs.push(`Entry ${i + 1}: choose its date`);
    else if (isNaN(t)) errs.push(`Entry ${i + 1}: that date does not exist`);
    else if (t < lo || t >= hi) errs.push(`Entry ${i + 1}: date is outside this Nanakshahi month`);
    LANGS.forEach(l => { if (!e.text[l]) errs.push(`Entry ${i + 1} is empty in ${{ pa: "Punjabi", hi: "Hindi", en: "English" }[l]}`); if (e.text[l].length > 600) errs.push(`Entry ${i + 1} is too long in ${l}`); }); });
  return errs;
}
/* ---- Import from TXT or PDF: reads only lines it clearly understands, never guesses ---- */
function monthIndex(name) {
  const n = name.trim().replace(/\.$/, "");
  let i = GM.findIndex(m => m.toLowerCase() === n.toLowerCase() || m.slice(0, 3).toLowerCase() === n.toLowerCase());
  if (i >= 0) return i;
  if (!gmNames) learnNames();
  for (const l of ["pa", "hi"]) for (const [k, v] of Object.entries(gmNames[l])) if (v === n) return +k;
  return -1;
}
const WDIG = s => s.replace(/[੦-੯]/g, c => "੦੧੨੩੪੫੬੭੮੯".indexOf(c)).replace(/[०-९]/g, c => "०१२३४५६७८९".indexOf(c));
function parseLines(lines) {
  const ok = [], flagged = [];
  const BR = /\((\d{1,2})(?:\s*-\s*\d{1,2})? ([^)\d]+)\)\s*[:\-–]\s*(.+)$/, PL = /^\s*(\d{1,2})\s+([^\d:\-–()]+?)\s*[:\-–]\s*(.+)$/;
  lines.map(s => WDIG(s.replace(/\s+/g, " ").trim())).filter(Boolean).forEach(line => {
    const m = line.match(BR) || line.match(PL);
    if (!m) { flagged.push({ line, why: "no clear date found" }); return; }
    const mi = monthIndex(m[2]), day = +m[1];
    if (mi < 0) { flagged.push({ line, why: "month name not recognised" }); return; }
    if (!(day >= 1 && day <= 31)) { flagged.push({ line, why: "day number not valid" }); return; }
    const text = m[3].trim();
    if (text.length < 3) { flagged.push({ line, why: "no text after the date" }); return; }
    ok.push({ day, mon: mi, text, line });
  });
  return { ok, flagged };
}
function place(rows) {
  const ids = orderedIds(), placed = [], flagged = [];
  rows.forEach(r => {
    let target = null;
    for (const id of ids) { const e = { day: r.day, mon: r.mon }; const t = entryMs(e, id); if (!isNaN(t) && t >= monthStart(id) && t < monthEnd(id)) { target = id; break; } }
    if (!target) { flagged.push({ line: r.line, why: "date is not inside this calendar year" }); return; }
    const d = months[target], dup = (d.events.en || []).concat(d.events.pa || [], d.events.hi || []).some(t => t.endsWith(": " + r.text) && new RegExp("\\(" + r.day + " ").test(t));
    if (dup) { flagged.push({ line: r.line, why: "already in the calendar, skipped" }); return; }
    placed.push({ ...r, id: target });
  });
  return { placed, flagged };
}
async function pdfLines(file) {
  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = (await (await pdf.getPage(p)).getTextContent()).items.filter(i => i.str && i.str.trim()), rows = [];
    items.forEach(i => { const y = Math.round(i.transform[5]); let r = rows.find(r => Math.abs(r.y - y) <= 2); if (!r) rows.push(r = { y, parts: [] }); r.parts.push([i.transform[4], i.str]); });
    rows.sort((a, b) => b.y - a.y).forEach(r => out.push(r.parts.sort((a, b) => a[0] - b[0]).map(x => x[1]).join(" ")));
  }
  return out;
}
let docPlaced = [];
$("readDoc").onclick = async () => {
  try {
    const f = $("docFile").files[0]; if (!f) { say("Choose a PDF or TXT file first."); return; }
    const lines = /\.pdf$/i.test(f.name) ? await pdfLines(f) : (await f.text()).split(/\r?\n/);
    const { ok, flagged: f1 } = parseLines(lines), { placed, flagged: f2 } = place(ok), flagged = f1.concat(f2); docPlaced = placed;
    const garbled = lines.join("").replace(/[\s\d\W]/g, "").length > 0 && !/[A-Za-z਀-੿ऀ-ॿ]{3}/.test(lines.join(" "));
    $("docPreview").textContent = (garbled ? "WARNING: the text in this file could not be read properly (it may be scanned or use an old font). Nothing was added.\n\n" : "") +
      "Understood: " + placed.length + " entries\n" + placed.map(p => `- ${p.day} ${GM[p.mon]} -> ${months[p.id].title.en}: ${p.text.slice(0, 80)}`).join("\n") +
      "\n\nNOT understood (" + flagged.length + "), left out, not guessed:\n" + flagged.map(x => `- ${x.line.slice(0, 90)}  [${x.why}]`).join("\n");
    if (garbled) docPlaced = [];
    say(placed.length + " entries understood, " + flagged.length + " lines not understood. Check the list, then press Add.");
  } catch (e) { say("Could not read the file: " + e.message); }
};
$("applyDoc").onclick = () => {
  if (!docPlaced.length) { say("Nothing to add. Read a file first."); return; }
  if (current) collect();
  const lang = $("docLang").value, keep = current, ids = [...new Set(docPlaced.map(p => p.id))];
  ids.forEach(id => { current = id; work = buildWork(id); sel = 0;
    docPlaced.filter(p => p.id === id).forEach(p => { const t = { pa: "", hi: "", en: "" }; t[lang] = p.text; work.push({ text: t, raw: { pa: "", hi: "", en: "" }, day: p.day, mon: p.mon, end: 0, orig: { day: 0, mon: 0 } }); });
    sortWork(); LANGS.forEach(l => { $("mt_" + l).value = months[id].title?.[l] || ""; $("sg_" + l).value = months[id].sangrand?.[l] || ""; }); collect(); });
  const n = docPlaced.length; docPlaced = []; showMonth(keep || ids[0]); $("monthSel").value = current;
  say(n + " entries added to " + ids.length + " month(s) in this page only. For each, fill the other two languages, then Preview and Publish that month.");
};
$("previewMonth").onclick = () => { const d = collect(), e = validateMonth(d);
  $("preview").textContent = (e.length ? "PROBLEMS:\n" + e.join("\n") + "\n\n" : "No problems found.\n\n") + JSON.stringify(d, null, 2);
  say(e.length ? e.length + " problems found." : "Preview ready, no problems."); };
async function saveHistory(id, data) { await setDoc(doc(collection(db, "admin", "history", "versions")), { id, data, savedAt: serverTimestamp() }); }
$("publishMonth").onclick = async () => { const d = collect(), e = validateMonth(d); if (e.length) { say("Not published. " + e[0]); return; }
  await saveHistory(current, months[current]); d.updatedAt = serverTimestamp(); await setDoc(doc(db, "calendar", current), d);
  const back = (await getDoc(doc(db, "calendar", current))).data(); say(back ? "Published " + current + " and read it back." : "Publish could not be confirmed."); };
$("publishMeta").onclick = async () => { const title = {}; LANGS.forEach(l => title[l] = $("t_" + l).value.trim()); const samvat = $("samvat").value.trim();
  if (!samvat || !title.en) { say("Not published. Samvat and English title are required."); return; }
  await setDoc(doc(db, "calendar", "meta"), { ...meta, title, samvat, updatedAt: serverTimestamp() }); meta = { ...meta, title, samvat }; say("Title and Samvat published."); };
$("publishPopup").onclick = async () => { const text = {}; LANGS.forEach(l => text[l] = $("p_" + l).value.trim());
  const active = $("p_on").value === "on"; if (active && !text.pa && !text.en) { say("Not published. Add text first."); return; }
  await setDoc(doc(db, "announcements", "current"), { text, active, id: String(Date.now()), updatedAt: serverTimestamp() }); say(active ? "Popup is ON." : "Popup is OFF."); };

$("validateImport").onclick = async () => { try { const f = $("importFile").files[0]; const j = JSON.parse(await f.text());
  const e = []; if (!Array.isArray(j.months) || !j.months.length) e.push("months missing"); if (!j.samvat) e.push("samvat missing"); if (!j.title) e.push("title missing");
  (j.months || []).forEach((m,k) => { if (!m.id) e.push("month " + (k+1) + " has no id"); LANGS.forEach(l => { if (!Array.isArray(m.events?.[l])) e.push(`${m.id}: events.${l} missing`); }); });
  if (e.length) { pendingImport = null; say("File has problems: " + e.slice(0,3).join("; ")); } else { pendingImport = j; say("File is valid: " + j.months.length + " months. You may publish it."); } } catch (x) { say("Cannot read file: " + x.message); } };
$("publishImport").onclick = async () => { if (!pendingImport) { say("Check a valid file first."); return; }
  const j = pendingImport, b = writeBatch(db), keep = new Set();
  const { months: ms, ...rest } = j; b.set(doc(db, "calendar", "meta"), { ...rest, updatedAt: serverTimestamp() });
  ms.forEach((m,k) => { const id = "month_" + m.id; keep.add(id); b.set(doc(db, "calendar", id), { ...m, order: k, updatedAt: serverTimestamp() }); });
  await b.commit();
  const check = (await getDocs(collection(db, "calendar"))); let found = 0; check.forEach(d => { if (keep.has(d.id)) found++; });
  if (found !== keep.size) { say("New data not confirmed. Old data was kept."); return; }
  let removed = 0; for (const d of check.docs) if (d.id.startsWith("month_") && !keep.has(d.id)) { await deleteDoc(d.ref); removed++; }
  say("New year published and confirmed. Removed " + removed + " old months."); await load(); };
$("exportAll").onclick = async () => { const out = { meta, months }; const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" })); a.download = "nanakshahi-backup.json"; a.click(); say("Backup downloaded."); };
