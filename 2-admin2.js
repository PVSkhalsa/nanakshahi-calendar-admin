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

function showMonth(id) {
  current = id; sel = 0; const d = months[id];
  LANGS.forEach(l => { $("mt_" + l).value = d.title?.[l] || ""; $("sg_" + l).value = d.sangrand?.[l] || ""; });
  renderEvents(d);
}
let sel = 0;
const evLabel = (d, i) => (i + 1) + ". " + ((d.events.en[i] || d.events.pa[i] || "(new, empty)").slice(0, 60));
function renderEvents(d) {
  const box = $("events"), es = $("entrySel"); box.innerHTML = ""; es.innerHTML = "";
  const n = Math.max(...LANGS.map(l => (d.events?.[l] || []).length), 0);
  if (sel >= n) sel = Math.max(0, n - 1);
  for (let i = 0; i < n; i++) { const o = document.createElement("option"); o.value = i; o.textContent = evLabel(d, i); es.append(o); }
  es.value = String(sel); es.onchange = () => { collect(); sel = +es.value; renderEvents(months[current]); };
  if (!n) { box.textContent = "No entries in this month yet. Use the add button."; return; }
  const i = sel, f = document.createElement("fieldset"); f.dataset.i = i;
  f.innerHTML = `<legend>Entry ${i + 1} of ${n}</legend>` + LANGS.map(l =>
    `<label>Entry ${i + 1}, ${{pa:"Punjabi",hi:"Hindi",en:"English"}[l]}<textarea data-l="${l}" lang="${l}" rows="3"></textarea></label>`).join("") +
    `<p>English text must contain the date in brackets, for example: 05 Chet (19 March): Name of the day</p>` +
    `<button type="button" class="danger">Delete entry ${i + 1}</button>`;
  LANGS.forEach(l => f.querySelector(`[data-l=${l}]`).value = d.events?.[l]?.[i] || "");
  f.querySelector("button").onclick = () => { collect(); LANGS.forEach(l => months[current].events[l].splice(i, 1)); renderEvents(months[current]); say("Entry deleted here. Not published yet."); };
  box.append(f);
}
function collect() {
  const d = months[current];
  d.title = {}; d.sangrand = {};
  LANGS.forEach(l => { d.title[l] = $("mt_" + l).value.trim(); d.sangrand[l] = $("sg_" + l).value.trim(); });
  const f = document.querySelector("#events fieldset");
  if (f) LANGS.forEach(l => { d.events[l][+f.dataset.i] = f.querySelector(`[data-l=${l}]`).value.trim(); });
  return d;
}
$("addEvent").onclick = () => { collect(); LANGS.forEach(l => months[current].events[l].push("")); sel = months[current].events.en.length - 1; renderEvents(months[current]); say("New empty entry added at the end of this month. Fill all three languages, then Publish this month."); };
function validateMonth(d) {
  const errs = [], len = d.events.pa.length;
  LANGS.forEach(l => { if (d.events[l].length !== len) errs.push("Language lists differ in length"); d.events[l].forEach((t,i) => { if (!t) errs.push(`Entry ${i+1} is empty in ${l}`); if (t.length > 600) errs.push(`Entry ${i+1} too long in ${l}`); }); if (!d.title[l]) errs.push("Month name missing in " + l); });
  d.events.en.forEach((t,i) => { if (!/\((\d+)(?:-(\d+))? ([A-Za-z]+)\)/.test(t)) errs.push(`Entry ${i+1}: English text needs the date in brackets, like (19 March)`); });
  return errs;
}
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
