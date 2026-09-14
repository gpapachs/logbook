// ============================================================
// HACCP Logbook — app.js
// Θερμοκρασίες ψυγείων + Πλάνο καθαρισμού.
// Vanilla JS, χωρίς build step. Χρησιμοποιεί το Supabase JS SDK
// (φορτωμένο από CDN στο index.html) για auth + database.
// ============================================================

// Ώρα-όριο (τοπική ώρα συσκευής) μέχρι την οποία πρέπει να έχει γίνει η
// υποχρεωτική ημερήσια καταγραφή κάθε ψυγείου. Μετά από αυτή την ώρα, ένα
// ψυγείο χωρίς σημερινή καταγραφή εμφανίζεται κόκκινο "Δεν καταγράφηκε".
const DAILY_DEADLINE_HOUR = 12;

// Ώρα-όριο για τις εργασίες καθαρισμού. Για ημερήσιες εργασίες ισχύει
// για την ίδια μέρα· για εβδομαδιαίες/μηνιαίες ισχύει μόνο την τελευταία
// μέρα της περιόδου (π.χ. Κυριακή για εβδομαδιαία, τελευταία μέρα μήνα
// για μηνιαία) — πριν από αυτό εμφανίζονται ως "Εκκρεμεί", όχι κόκκινα.
const CLEANING_DAILY_DEADLINE_HOUR = 20;

const cfg = window.SUPABASE_CONFIG || {};
if (!cfg.url || !cfg.anonKey || cfg.url.includes("ΤΟ-PROJECT")) {
  document.body.innerHTML =
    '<div style="max-width:560px;margin:15vh auto;padding:2rem;font-family:sans-serif;line-height:1.6">' +
    "<h2>Λείπει ρύθμιση Supabase</h2>" +
    "<p>Δημιούργησε ένα αρχείο <code>config.js</code> (δες <code>config.example.js</code>) με το " +
    "URL και το anon key του project σου από το Supabase Dashboard → Project Settings → API.</p>" +
    "</div>";
  throw new Error("Missing Supabase config");
}

const sb = window.supabase.createClient(cfg.url, cfg.anonKey);
// Edge Function που διαχειρίζεται χρήστες σύνδεσης (καρτέλα "Χρήστες").
// Δες Βήμα 8 στο README για ανάπτυξη (deploy) και ρύθμιση του ADMIN_EMAIL.
const USERS_FUNCTION_URL = cfg.url.replace(/\/+$/, "") + "/functions/v1/manage-users";

// ---------------- state ----------------
let currentUser = null;
let fridges = []; // [{id, name, serial_number, type, min_temp, max_temp, location, sort_order, active}]
let latestByFridge = new Map(); // fridge_id -> log row (most recent)
let historyRows = [];
let activeView = "dashboard";
let realtimeChannel = null;

let cleaningTasks = []; // [{id, name, area, frequency, sort_order, active}]
let latestByTask = new Map(); // task_id -> cleaning_log row (most recent)
let cleaningHistoryRows = [];
let historyType = "fridges"; // "fridges" | "cleaning" — τι δείχνει η καρτέλα Ιστορικό

let appUsers = []; // [{id, email, created_at, last_sign_in_at}] — από το Edge Function

// ---------------- helpers ----------------
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function fmtTemp(t) { return (t > 0 ? "+" : "") + Number(t).toFixed(1) + "°C"; }
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("el-GR") + " " + d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" });
}
function toLocalDatetimeInputValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isoDateOnly(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isInRange(temp, fridge) { return temp >= fridge.min_temp && temp <= fridge.max_temp; }
// Δέχεται τιμές με κόμμα Ή τελεία ως δεκαδικό (π.χ. "3,5" ή "3.5").
function parseNum(str) {
  if (str == null) return NaN;
  const cleaned = String(str).trim().replace(",", ".");
  return cleaned === "" ? NaN : Number(cleaned);
}
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.style.background = isError ? "var(--danger)" : "var(--text)";
  el.style.color = isError ? "#fff" : "var(--bg)";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------- auth ----------------
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  handleSession(session);
  sb.auth.onAuthStateChange((_event, session) => handleSession(session));
}

function handleSession(session) {
  currentUser = session?.user ?? null;
  if (currentUser) {
    $("#loginScreen").hidden = true;
    $("#app").hidden = false;
    $("#userEmail").textContent = currentUser.email || "";
    boot();
  } else {
    $("#app").hidden = true;
    $("#loginScreen").hidden = false;
    teardownRealtime();
  }
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const errEl = $("#loginError");
  errEl.hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message === "Invalid login credentials"
      ? "Λάθος email ή κωδικός."
      : error.message;
    errEl.hidden = false;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
});

// ---------------- boot (after login) ----------------
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  $("#todayDate").textContent = new Date().toLocaleDateString("el-GR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  $("#cleaningTodayDate").textContent = $("#todayDate").textContent;
  const today = new Date();
  $("#filterFrom").value = isoDateOnly(new Date(today.getTime() - 6 * 86400000));
  $("#filterTo").value = isoDateOnly(today);

  await loadFridges();
  await loadLatestLogs();
  await loadCleaningTasks();
  await loadLatestCleaningLogs();
  await loadHistory();
  renderDashboard();
  renderCleaningDashboard();
  setupRealtime();
}

// ---------------- data loading ----------------
async function loadFridges() {
  const { data, error } = await sb.from("fridges").select("*").eq("active", true).order("sort_order", { ascending: true });
  if (error) { toast("Σφάλμα φόρτωσης ψυγείων: " + error.message, true); return; }
  fridges = data || [];
  populateFridgeFilter();
  renderFridgeSettings();
}

async function loadLatestLogs() {
  // Φέρνουμε τις πιο πρόσφατες καταγραφές και κρατάμε μία ανά ψυγείο.
  const { data, error } = await sb.from("logs").select("*").order("logged_at", { ascending: false }).limit(300);
  if (error) { toast("Σφάλμα φόρτωσης καταγραφών: " + error.message, true); return; }
  latestByFridge = new Map();
  for (const row of data || []) {
    if (!latestByFridge.has(row.fridge_id)) latestByFridge.set(row.fridge_id, row);
  }
}

async function loadHistory() {
  const fridgeId = $("#filterFridge").value;
  const from = $("#filterFrom").value;
  const to = $("#filterTo").value;
  const status = $("#filterStatus").value;

  let q = sb.from("logs").select("*").order("logged_at", { ascending: false }).limit(1000);
  if (fridgeId) q = q.eq("fridge_id", fridgeId);
  if (from) q = q.gte("logged_at", new Date(from + "T00:00:00").toISOString());
  if (to) q = q.lte("logged_at", new Date(to + "T23:59:59").toISOString());
  if (status === "ok") q = q.eq("in_range", true);
  if (status === "out") q = q.eq("in_range", false);

  const { data, error } = await q;
  if (error) { toast("Σφάλμα φόρτωσης ιστορικού: " + error.message, true); return; }
  historyRows = data || [];
  renderHistory();
}

function loadCurrentHistory() {
  return historyType === "cleaning" ? loadCleaningHistory() : loadHistory();
}

// ---------------- cleaning plan: data loading ----------------
async function loadCleaningTasks() {
  const { data, error } = await sb.from("cleaning_tasks").select("*").eq("active", true).order("sort_order", { ascending: true });
  if (error) { toast("Σφάλμα φόρτωσης πλάνου καθαρισμού: " + error.message, true); return; }
  cleaningTasks = data || [];
  populateTaskFilter();
  renderCleaningTaskSettings();
}

async function loadLatestCleaningLogs() {
  const { data, error } = await sb.from("cleaning_logs").select("*").order("logged_at", { ascending: false }).limit(500);
  if (error) { toast("Σφάλμα φόρτωσης καταγραφών καθαρισμού: " + error.message, true); return; }
  latestByTask = new Map();
  for (const row of data || []) {
    if (!latestByTask.has(row.task_id)) latestByTask.set(row.task_id, row);
  }
}

async function loadCleaningHistory() {
  const taskId = $("#filterTask").value;
  const from = $("#filterFrom").value;
  const to = $("#filterTo").value;
  const freq = $("#filterFrequency").value;

  let q = sb.from("cleaning_logs").select("*").order("logged_at", { ascending: false }).limit(1000);
  if (taskId) q = q.eq("task_id", taskId);
  if (from) q = q.gte("logged_at", new Date(from + "T00:00:00").toISOString());
  if (to) q = q.lte("logged_at", new Date(to + "T23:59:59").toISOString());
  if (freq) q = q.eq("frequency", freq);

  const { data, error } = await q;
  if (error) { toast("Σφάλμα φόρτωσης ιστορικού καθαρισμού: " + error.message, true); return; }
  cleaningHistoryRows = data || [];
  renderCleaningHistory();
}

// Υπολογίζει την αρχή της τρέχουσας περιόδου μιας εργασίας (ημέρα /
// εβδομάδα από Δευτέρα / μήνας).
function cleaningPeriodStart(freq, now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (freq === "weekly") {
    const dow = (d.getDay() + 6) % 7; // 0 = Δευτέρα
    d.setDate(d.getDate() - dow);
  } else if (freq === "monthly") {
    d.setDate(1);
  }
  return d;
}
function cleaningPeriodEnd(freq, start) {
  const d = new Date(start);
  if (freq === "weekly") d.setDate(d.getDate() + 7);
  else if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 1);
  return d;
}
// Κατάσταση εργασίας καθαρισμού: "ok" | "out" (καταγράφηκε ως μη ολοκληρωμένη)
// | "missing" (πέρασε η προθεσμία χωρίς καταγραφή) | "pending" (εκκρεμεί ακόμα).
function cleaningTaskStatus(task, lastLog) {
  const now = new Date();
  const start = cleaningPeriodStart(task.frequency, now);
  const doneInPeriod = lastLog && new Date(lastLog.logged_at) >= start;
  if (doneInPeriod) return lastLog.done ? "ok" : "out";

  if (task.frequency === "daily") {
    return now.getHours() >= CLEANING_DAILY_DEADLINE_HOUR ? "missing" : "pending";
  }
  const end = cleaningPeriodEnd(task.frequency, start);
  const msLeft = end - now;
  const isFinalDay = msLeft <= 86400000;
  return isFinalDay && now.getHours() >= CLEANING_DAILY_DEADLINE_HOUR ? "missing" : "pending";
}
function frequencyLabel(freq) {
  return freq === "weekly" ? "Εβδομαδιαία" : freq === "monthly" ? "Μηνιαία" : "Καθημερινά";
}

// ---------------- realtime ----------------
function setupRealtime() {
  teardownRealtime();
  realtimeChannel = sb
    .channel("logbook-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "logs" }, async () => {
      await loadLatestLogs();
      renderDashboard();
      if (activeView === "history" && historyType === "fridges") await loadHistory();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "fridges" }, async () => {
      await loadFridges();
      renderDashboard();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "cleaning_logs" }, async () => {
      await loadLatestCleaningLogs();
      renderCleaningDashboard();
      if (activeView === "history" && historyType === "cleaning") await loadCleaningHistory();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "cleaning_tasks" }, async () => {
      await loadCleaningTasks();
      renderCleaningDashboard();
    })
    .subscribe();
}
function teardownRealtime() {
  if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  booted = false;
}

// ---------------- navigation ----------------
$all(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
function switchView(view) {
  activeView = view;
  $all(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $all(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "history") loadCurrentHistory();
  if (view === "fridges") renderFridgeSettings();
  if (view === "cleaning") renderCleaningDashboard();
  if (view === "cleaningTasks") renderCleaningTaskSettings();
  if (view === "users") loadUsers();
}

// ---------------- dashboard render ----------------
function renderDashboard() {
  const grid = $("#fridgeGrid");
  if (fridges.length === 0) {
    grid.innerHTML = '<p class="muted">Δεν υπάρχουν ψυγεία ακόμα. Πρόσθεσε ένα από την καρτέλα "Ψυγεία".</p>';
    $("#summaryPills").innerHTML = "";
    return;
  }

  let okCount = 0, outCount = 0, missingCount = 0, pendingCount = 0;
  const now = new Date();
  const todayStr = isoDateOnly(now);
  const deadlinePassed = now.getHours() >= DAILY_DEADLINE_HOUR;

  grid.innerHTML = fridges.map((f) => {
    const log = latestByFridge.get(f.id);
    const loggedToday = log && isoDateOnly(new Date(log.logged_at)) === todayStr;
    let status;
    if (loggedToday) {
      status = log.in_range ? "ok" : "out";
    } else if (deadlinePassed) {
      status = "missing";
    } else {
      status = "pending";
    }
    if (status === "ok") okCount++;
    else if (status === "out") outCount++;
    else if (status === "missing") missingCount++;
    else pendingCount++;

    const tempHtml = loggedToday
      ? `<span class="fridge-temp status-${status}">${fmtTemp(log.temperature)}</span>`
      : status === "missing"
        ? `<span class="fridge-temp status-missing">Δεν καταγράφηκε</span>`
        : `<span class="fridge-temp status-pending">— χωρίς καταγραφή —</span>`;

    const statusLabel = status === "ok" ? "Εντός ορίων" : status === "out" ? "Εκτός ορίων" : status === "missing" ? "Δεν καταγράφηκε" : "Εκκρεμεί";
    const metaText = loggedToday
      ? `Σήμερα στις ${fmtDateTime(log.logged_at).split(" ")[1]}`
      : status === "missing"
        ? `Έπρεπε να έχει καταγραφεί μέχρι τις ${String(DAILY_DEADLINE_HOUR).padStart(2, "0")}:00`
        : log
          ? `Τελευταία καταγραφή: ${fmtDateTime(log.logged_at)}`
          : "Δεν έχει καταγραφεί ακόμα";

    return `
      <div class="fridge-card status-${status}">
        <div class="fridge-card-head">
          <h3>${escapeHtml(f.name)}</h3>
          <span class="fridge-type-badge">${escapeHtml(f.type)}</span>
        </div>
        <div class="fridge-range">Όριο: ${fmtTemp(f.min_temp)} έως ${fmtTemp(f.max_temp)}</div>
        <div class="fridge-reading">
          ${tempHtml}
          <span class="status-badge status-${status}">${statusLabel}</span>
        </div>
        <div class="fridge-meta">${metaText}${f.location ? " · " + escapeHtml(f.location) : ""}${f.serial_number ? " · SN " + escapeHtml(f.serial_number) : ""}</div>
        <div class="fridge-card-actions">
          <button class="btn btn-primary btn-sm" data-log-fridge="${f.id}">+ Καταγραφή</button>
        </div>
      </div>`;
  }).join("");

  $("#summaryPills").innerHTML = `
    <span class="pill pill-ok"><span class="dot"></span>${okCount} εντός</span>
    <span class="pill pill-out"><span class="dot"></span>${outCount} εκτός</span>
    <span class="pill pill-missing"><span class="dot"></span>${missingCount} δεν καταγράφηκαν</span>
    <span class="pill pill-pending"><span class="dot"></span>${pendingCount} εκκρεμούν</span>
  `;

  $all("[data-log-fridge]", grid).forEach((btn) => {
    btn.addEventListener("click", () => openLogModal(btn.dataset.logFridge));
  });
}

// ---------------- cleaning dashboard render ----------------
function renderCleaningDashboard() {
  const wrap = $("#cleaningGroups");
  if (cleaningTasks.length === 0) {
    wrap.innerHTML = '<p class="muted">Δεν υπάρχουν εργασίες καθαρισμού ακόμα. Πρόσθεσε μία από την καρτέλα "Πλάνο καθαρισμού".</p>';
    $("#cleaningSummaryPills").innerHTML = "";
    return;
  }

  let okCount = 0, outCount = 0, missingCount = 0, pendingCount = 0;
  const statusLabel = (s) => s === "ok" ? "Ολοκληρώθηκε" : s === "out" ? "Δεν έγινε" : s === "missing" ? "Δεν καταγράφηκε" : "Εκκρεμεί";

  const byFreq = { daily: [], weekly: [], monthly: [] };
  for (const t of cleaningTasks) (byFreq[t.frequency] || byFreq.daily).push(t);

  const groupHtml = (freq, title) => {
    const tasks = byFreq[freq];
    if (tasks.length === 0) return "";
    const cards = tasks.map((t) => {
      const log = latestByTask.get(t.id);
      const status = cleaningTaskStatus(t, log);
      if (status === "ok") okCount++;
      else if (status === "out") outCount++;
      else if (status === "missing") missingCount++;
      else pendingCount++;

      const metaText = log
        ? `Τελευταία καταγραφή: ${fmtDateTime(log.logged_at)}${log.responsible ? " · " + escapeHtml(log.responsible) : ""}`
        : "Δεν έχει καταγραφεί ακόμα";

      return `
        <div class="fridge-card status-${status}">
          <div class="fridge-card-head">
            <h3>${escapeHtml(t.name)}</h3>
            <span class="frequency-badge">${frequencyLabel(t.frequency)}</span>
          </div>
          <div class="fridge-reading">
            <span class="status-badge status-${status}">${statusLabel(status)}</span>
          </div>
          <div class="fridge-meta">${metaText}${t.area ? " · " + escapeHtml(t.area) : ""}</div>
          <div class="fridge-card-actions">
            <button class="btn btn-primary btn-sm" data-log-task="${t.id}">+ Καταγραφή</button>
          </div>
        </div>`;
    }).join("");
    return `<div class="cleaning-group"><h3>${title}</h3><div class="fridge-grid">${cards}</div></div>`;
  };

  wrap.innerHTML = groupHtml("daily", "Καθημερινά") + groupHtml("weekly", "Εβδομαδιαία") + groupHtml("monthly", "Μηνιαία");

  $("#cleaningSummaryPills").innerHTML = `
    <span class="pill pill-ok"><span class="dot"></span>${okCount} ολοκληρωμένα</span>
    <span class="pill pill-out"><span class="dot"></span>${outCount} μη ολοκληρωμένα</span>
    <span class="pill pill-missing"><span class="dot"></span>${missingCount} δεν καταγράφηκαν</span>
    <span class="pill pill-pending"><span class="dot"></span>${pendingCount} εκκρεμούν</span>
  `;

  $all("[data-log-task]", wrap).forEach((btn) => {
    btn.addEventListener("click", () => openCleaningLogModal(btn.dataset.logTask));
  });
}

// ---------------- log temperature modal ----------------
const logModal = $("#logModal");
const logForm = $("#logForm");

function openLogModal(fridgeId) {
  const f = fridges.find((x) => x.id === fridgeId);
  if (!f) return;
  $("#logFridgeId").value = f.id;
  $("#logModalTitle").textContent = "Καταγραφή — " + f.name;
  $("#logModalRange").textContent = `Αποδεκτό εύρος: ${fmtTemp(f.min_temp)} έως ${fmtTemp(f.max_temp)}` + (f.serial_number ? ` · SN ${f.serial_number}` : "");
  $("#logTemp").value = "";
  $("#logTime").value = toLocalDatetimeInputValue(new Date());
  $("#logCorrective").value = "";
  $("#logNote").value = "";
  $("#logOutOfRangeBox").hidden = true;
  $("#logFormError").hidden = true;
  logModal.hidden = false;
  setTimeout(() => $("#logTemp").focus(), 50);
}

$("#logTemp").addEventListener("input", () => {
  const f = fridges.find((x) => x.id === $("#logFridgeId").value);
  const temp = parseNum($("#logTemp").value);
  if (!f || Number.isNaN(temp)) { $("#logOutOfRangeBox").hidden = true; return; }
  $("#logOutOfRangeBox").hidden = isInRange(temp, f);
});

logForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = fridges.find((x) => x.id === $("#logFridgeId").value);
  const temp = parseNum($("#logTemp").value);
  const errEl = $("#logFormError");
  errEl.hidden = true;
  if (!f || Number.isNaN(temp)) return;

  const inRange = isInRange(temp, f);
  const corrective = $("#logCorrective").value.trim();
  if (!inRange && !corrective) {
    errEl.textContent = "Η θερμοκρασία είναι εκτός ορίων — συμπλήρωσε διορθωτική ενέργεια.";
    errEl.hidden = false;
    return;
  }

  const loggedAt = new Date($("#logTime").value).toISOString();
  const { error } = await sb.from("logs").insert({
    fridge_id: f.id,
    fridge_name: f.name,
    fridge_serial: f.serial_number || null,
    temperature: temp,
    logged_at: loggedAt,
    in_range: inRange,
    corrective_action: corrective || null,
    note: $("#logNote").value.trim() || null,
    created_by: currentUser?.email || null,
  });

  if (error) {
    errEl.textContent = "Σφάλμα αποθήκευσης: " + error.message;
    errEl.hidden = false;
    return;
  }

  logModal.hidden = true;
  toast("Η καταγραφή αποθηκεύτηκε.");
  await loadLatestLogs();
  renderDashboard();
});

// ---------------- cleaning log modal ----------------
const cleaningLogModal = $("#cleaningLogModal");
const cleaningLogForm = $("#cleaningLogForm");

function openCleaningLogModal(taskId) {
  const t = cleaningTasks.find((x) => x.id === taskId);
  if (!t) return;
  $("#cleaningTaskId").value = t.id;
  $("#cleaningLogModalTitle").textContent = "Καταγραφή — " + t.name;
  $("#cleaningLogModalSub").textContent = `${frequencyLabel(t.frequency)}${t.area ? " · " + t.area : ""}`;
  $("#cleaningDone").value = "true";
  $("#cleaningResponsible").value = "";
  $("#cleaningTime").value = toLocalDatetimeInputValue(new Date());
  $("#cleaningNote").value = "";
  $("#cleaningLogFormError").hidden = true;
  cleaningLogModal.hidden = false;
  setTimeout(() => $("#cleaningResponsible").focus(), 50);
}

cleaningLogForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = cleaningTasks.find((x) => x.id === $("#cleaningTaskId").value);
  const errEl = $("#cleaningLogFormError");
  errEl.hidden = true;
  if (!t) return;

  const responsible = $("#cleaningResponsible").value.trim();
  if (!responsible) {
    errEl.textContent = "Συμπλήρωσε τον υπεύθυνο/η.";
    errEl.hidden = false;
    return;
  }

  const loggedAt = new Date($("#cleaningTime").value).toISOString();
  const { error } = await sb.from("cleaning_logs").insert({
    task_id: t.id,
    task_name: t.name,
    frequency: t.frequency,
    done: $("#cleaningDone").value === "true",
    responsible,
    logged_at: loggedAt,
    note: $("#cleaningNote").value.trim() || null,
    created_by: currentUser?.email || null,
  });

  if (error) {
    errEl.textContent = "Σφάλμα αποθήκευσης: " + error.message;
    errEl.hidden = false;
    return;
  }

  cleaningLogModal.hidden = true;
  toast("Η καταγραφή αποθηκεύτηκε.");
  await loadLatestCleaningLogs();
  renderCleaningDashboard();
});

// ---------------- history ----------------
$("#applyFilters").addEventListener("click", loadCurrentHistory);
$all('#filterFridge, #filterFrom, #filterTo, #filterStatus, #filterTask, #filterFrequency').forEach((el) => {
  el.addEventListener("change", loadCurrentHistory);
});

$("#historyType").addEventListener("change", () => {
  historyType = $("#historyType").value;
  const isCleaning = historyType === "cleaning";
  $("#fridgeFiltersGroup").hidden = isCleaning;
  $("#cleaningFiltersGroup").hidden = !isCleaning;
  $("#fridgeHistoryTable").hidden = isCleaning;
  $("#cleaningHistoryTable").hidden = !isCleaning;
  loadCurrentHistory();
});

function renderHistory() {
  const body = $("#historyBody");
  if (historyRows.length === 0) {
    body.innerHTML = "";
    $("#historyEmpty").hidden = false;
    return;
  }
  $("#historyEmpty").hidden = true;
  body.innerHTML = historyRows.map((r) => `
    <tr>
      <td>${fmtDateTime(r.logged_at)}</td>
      <td>${escapeHtml(r.fridge_name)}</td>
      <td>${escapeHtml(r.fridge_serial || "—")}</td>
      <td class="num">${fmtTemp(r.temperature)}</td>
      <td><span class="status-badge status-${r.in_range ? "ok" : "out"}">${r.in_range ? "Εντός ορίων" : "Εκτός ορίων"}</span></td>
      <td>${escapeHtml(r.corrective_action || "—")}</td>
      <td>${escapeHtml(r.note || "—")}</td>
    </tr>`).join("");
}

function populateFridgeFilter() {
  const sel = $("#filterFridge");
  const current = sel.value;
  sel.innerHTML = '<option value="">Όλα</option>' +
    fridges.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");
  sel.value = current;
}

function renderCleaningHistory() {
  const body = $("#cleaningHistoryBody");
  if (cleaningHistoryRows.length === 0) {
    body.innerHTML = "";
    $("#cleaningHistoryEmpty").hidden = false;
    return;
  }
  $("#cleaningHistoryEmpty").hidden = true;
  body.innerHTML = cleaningHistoryRows.map((r) => `
    <tr>
      <td>${fmtDateTime(r.logged_at)}</td>
      <td>${escapeHtml(r.task_name)}</td>
      <td>${frequencyLabel(r.frequency)}</td>
      <td><span class="status-badge status-${r.done ? "ok" : "out"}">${r.done ? "Ολοκληρώθηκε" : "Δεν έγινε"}</span></td>
      <td>${escapeHtml(r.responsible)}</td>
      <td>${escapeHtml(r.note || "—")}</td>
    </tr>`).join("");
}

function populateTaskFilter() {
  const sel = $("#filterTask");
  const current = sel.value;
  sel.innerHTML = '<option value="">Όλες</option>' +
    cleaningTasks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  sel.value = current;
}

const EXPORT_HEADER = ["Ημερομηνία", "Ώρα", "Θερμοκρασία (°C)", "Κατάσταση", "Διορθωτική ενέργεια", "Σημείωση", "Καταχωρήθηκε από"];
function rowToExportLine(r) {
  const d = new Date(r.logged_at);
  return [
    d.toLocaleDateString("el-GR"),
    d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" }),
    r.temperature,
    r.in_range ? "Εντός ορίων" : "Εκτός ορίων",
    r.corrective_action || "",
    r.note || "",
    r.created_by || "",
  ];
}
// Ομαδοποιεί τις τρέχουσες γραμμές ιστορικού ανά ψυγείο, ώστε η
// εξαγωγή να παράγει ένα ξεχωριστό φύλλο/σελίδα ανά ψυγείο αντί για
// έναν ενιαίο πίνακα με όλα μαζί.
function groupRowsByFridge() {
  const order = new Map(fridges.map((f, i) => [f.id, i]));
  const groups = new Map(); // fridge_id -> { name, serial, range, rows: [] }
  for (const r of historyRows) {
    if (!groups.has(r.fridge_id)) {
      const f = fridges.find((x) => x.id === r.fridge_id);
      groups.set(r.fridge_id, {
        name: r.fridge_name,
        serial: r.fridge_serial || "",
        range: f ? `${fmtTemp(f.min_temp)} έως ${fmtTemp(f.max_temp)}` : "",
        rows: [],
      });
    }
    groups.get(r.fridge_id).rows.push(r);
  }
  return [...groups.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
    .map(([, g]) => g);
}
const CLEANING_EXPORT_HEADER = ["Ημερομηνία", "Ώρα", "Εργασία", "Συχνότητα", "Κατάσταση", "Υπεύθυνος", "Σημείωση"];
function cleaningRowToExportLine(r) {
  const d = new Date(r.logged_at);
  return [
    d.toLocaleDateString("el-GR"),
    d.toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" }),
    r.task_name,
    frequencyLabel(r.frequency),
    r.done ? "Ολοκληρώθηκε" : "Δεν έγινε",
    r.responsible || "",
    r.note || "",
  ];
}
// Ομαδοποιεί τις τρέχουσες γραμμές ιστορικού καθαρισμού ανά εργασία, ώστε
// η εξαγωγή να παράγει ένα ξεχωριστό φύλλο/σελίδα ανά εργασία.
function groupRowsByTask() {
  const order = new Map(cleaningTasks.map((t, i) => [t.id, i]));
  const groups = new Map(); // task_id -> { name, area, frequency, rows: [] }
  for (const r of cleaningHistoryRows) {
    if (!groups.has(r.task_id)) {
      const t = cleaningTasks.find((x) => x.id === r.task_id);
      groups.set(r.task_id, {
        name: r.task_name,
        area: t ? (t.area || "") : "",
        frequency: r.frequency,
        rows: [],
      });
    }
    groups.get(r.task_id).rows.push(r);
  }
  return [...groups.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
    .map(([, g]) => g);
}
function safeSheetName(name, used) {
  let base = String(name || "Ψυγείο").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Ψυγείο";
  let candidate = base, n = 2;
  while (used.has(candidate)) { candidate = `${base} (${n++})`; }
  used.add(candidate);
  return candidate;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$("#exportCsv").addEventListener("click", () => {
  const isCleaning = historyType === "cleaning";
  const rows = isCleaning ? cleaningHistoryRows : historyRows;
  if (rows.length === 0) { toast("Δεν υπάρχουν δεδομένα για εξαγωγή.", true); return; }
  const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const groups = isCleaning ? groupRowsByTask() : groupRowsByFridge();
  const header = isCleaning ? CLEANING_EXPORT_HEADER : EXPORT_HEADER;
  const lineFn = isCleaning ? cleaningRowToExportLine : rowToExportLine;
  const lines = [];
  for (const g of groups) {
    const title = isCleaning
      ? `Εργασία: ${g.name}${g.area ? " (" + g.area + ")" : ""}`
      : `Ψυγείο: ${g.name}${g.serial ? " (SN " + g.serial + ")" : ""}`;
    lines.push(csvEscape(title));
    lines.push(header.map(csvEscape).join(","));
    for (const r of g.rows) lines.push(lineFn(r).map(csvEscape).join(","));
    lines.push("");
  }
  const filenamePrefix = isCleaning ? "plano-katharismou" : "logbook-thermokrasion";
  downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }), `${filenamePrefix}-${isoDateOnly(new Date())}.csv`);
});

$("#exportExcel").addEventListener("click", () => {
  const isCleaning = historyType === "cleaning";
  const rows = isCleaning ? cleaningHistoryRows : historyRows;
  if (rows.length === 0) { toast("Δεν υπάρχουν δεδομένα για εξαγωγή.", true); return; }
  if (!window.XLSX) { toast("Η βιβλιοθήκη Excel δεν φορτώθηκε — έλεγξε τη σύνδεση internet.", true); return; }
  const groups = isCleaning ? groupRowsByTask() : groupRowsByFridge();
  const header = isCleaning ? CLEANING_EXPORT_HEADER : EXPORT_HEADER;
  const lineFn = isCleaning ? cleaningRowToExportLine : rowToExportLine;
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const g of groups) {
    const title = isCleaning
      ? `Εργασία: ${g.name}${g.area ? " · " + g.area : ""} · ${frequencyLabel(g.frequency)}`
      : `Ψυγείο: ${g.name}${g.serial ? " · SN " + g.serial : ""}${g.range ? " · Όριο " + g.range : ""}`;
    const ws = XLSX.utils.aoa_to_sheet([[title], header, ...g.rows.map(lineFn)]);
    ws["!cols"] = header.map(() => ({ wch: 16 }));
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(g.name, used));
  }
  const filenamePrefix = isCleaning ? "plano-katharismou" : "logbook-thermokrasion";
  XLSX.writeFile(wb, `${filenamePrefix}-${isoDateOnly(new Date())}.xlsx`);
});

$("#exportPdf").addEventListener("click", () => {
  const isCleaning = historyType === "cleaning";
  const rows = isCleaning ? cleaningHistoryRows : historyRows;
  if (rows.length === 0) { toast("Δεν υπάρχουν δεδομένα για εξαγωγή.", true); return; }
  if (!window.jspdf) { toast("Η βιβλιοθήκη PDF δεν φορτώθηκε — έλεγξε τη σύνδεση internet.", true); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape" });
  const useFont = !!window.DEJAVU_SANS_BASE64;
  // Οι ενσωματωμένες γραμματοσειρές του jsPDF δεν έχουν ελληνικούς
  // χαρακτήρες — χωρίς αυτό, τα ελληνικά βγαίνουν "κινέζικα" στο PDF.
  if (useFont) {
    doc.addFileToVFS("DejaVuSans.ttf", window.DEJAVU_SANS_BASE64);
    doc.addFont("DejaVuSans.ttf", "DejaVuSans", "normal");
    doc.setFont("DejaVuSans");
  }
  const groups = isCleaning ? groupRowsByTask() : groupRowsByFridge();
  const header = isCleaning ? CLEANING_EXPORT_HEADER : EXPORT_HEADER;
  const lineFn = isCleaning ? cleaningRowToExportLine : rowToExportLine;
  const docTitle = isCleaning ? "Πλάνο Καθαρισμού" : "Logbook Θερμοκρασιών";
  groups.forEach((g, i) => {
    if (i > 0) doc.addPage();
    if (useFont) doc.setFont("DejaVuSans");
    doc.setFontSize(13);
    doc.text(`${docTitle} — ${g.name}`, 14, 15);
    doc.setFontSize(9);
    const subLine = isCleaning
      ? [g.area ? `Χώρος ${g.area}` : null, `Συχνότητα ${frequencyLabel(g.frequency)}`, `Εξήχθη ${new Date().toLocaleString("el-GR")}`].filter(Boolean).join("  ·  ")
      : [g.serial ? `SN ${g.serial}` : null, g.range ? `Όριο ${g.range}` : null, `Εξήχθη ${new Date().toLocaleString("el-GR")}`].filter(Boolean).join("  ·  ");
    doc.text(subLine, 14, 21);
    doc.autoTable({
      startY: 26,
      head: [header],
      body: g.rows.map(lineFn),
      styles: { fontSize: 8, font: useFont ? "DejaVuSans" : undefined },
      headStyles: { fillColor: [11, 122, 140], font: useFont ? "DejaVuSans" : undefined },
    });
  });
  const filenamePrefix = isCleaning ? "plano-katharismou" : "logbook-thermokrasion";
  doc.save(`${filenamePrefix}-${isoDateOnly(new Date())}.pdf`);
});

// ---------------- fridge settings ----------------
function renderFridgeSettings() {
  const list = $("#fridgeList");
  if (fridges.length === 0) {
    list.innerHTML = '<p class="muted">Δεν υπάρχουν ψυγεία ακόμα.</p>';
    return;
  }
  list.innerHTML = fridges.map((f) => `
    <div class="fridge-settings-row">
      <span class="fs-name">${escapeHtml(f.name)}${f.serial_number ? ` <span class="muted small">SN ${escapeHtml(f.serial_number)}</span>` : ""}</span>
      <span class="fridge-type-badge">${escapeHtml(f.type)}</span>
      <span class="fs-meta">${fmtTemp(f.min_temp)} έως ${fmtTemp(f.max_temp)}</span>
      <span class="muted small">${escapeHtml(f.location || "")}</span>
      <span class="spacer"></span>
      <button class="btn btn-secondary btn-sm" data-edit-fridge="${f.id}">Επεξεργασία</button>
    </div>`).join("");
  $all("[data-edit-fridge]", list).forEach((btn) => {
    btn.addEventListener("click", () => openFridgeModal(btn.dataset.editFridge));
  });
}

$("#newFridgeBtn").addEventListener("click", () => openFridgeModal(null));

const fridgeModal = $("#fridgeModal");
const fridgeForm = $("#fridgeForm");

function openFridgeModal(fridgeId) {
  const f = fridgeId ? fridges.find((x) => x.id === fridgeId) : null;
  $("#fridgeModalTitle").textContent = f ? "Επεξεργασία ψυγείου" : "Νέο ψυγείο";
  $("#fridgeId").value = f?.id || "";
  $("#fridgeName").value = f?.name || "";
  $("#fridgeSerial").value = f?.serial_number || "";
  $("#fridgeType").value = f?.type || "ψυγείο";
  $("#fridgeMin").value = f?.min_temp ?? "";
  $("#fridgeMax").value = f?.max_temp ?? "";
  $("#fridgeLocation").value = f?.location || "";
  $("#deleteFridgeBtn").hidden = !f;
  $("#fridgeFormError").hidden = true;
  fridgeModal.hidden = false;
}

fridgeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#fridgeId").value;
  const min = parseNum($("#fridgeMin").value);
  const max = parseNum($("#fridgeMax").value);
  const errEl = $("#fridgeFormError");
  errEl.hidden = true;
  if (Number.isNaN(min) || Number.isNaN(max)) {
    errEl.textContent = "Συμπλήρωσε έγκυρες τιμές θερμοκρασίας (π.χ. 0 ή -18).";
    errEl.hidden = false;
    return;
  }
  if (min >= max) {
    errEl.textContent = "Η ελάχιστη θερμοκρασία πρέπει να είναι μικρότερη από τη μέγιστη.";
    errEl.hidden = false;
    return;
  }
  const payload = {
    name: $("#fridgeName").value.trim(),
    serial_number: $("#fridgeSerial").value.trim() || null,
    type: $("#fridgeType").value,
    min_temp: min,
    max_temp: max,
    location: $("#fridgeLocation").value.trim() || null,
  };
  let error;
  if (id) {
    ({ error } = await sb.from("fridges").update(payload).eq("id", id));
  } else {
    payload.sort_order = fridges.length;
    ({ error } = await sb.from("fridges").insert(payload));
  }
  if (error) {
    errEl.textContent = "Σφάλμα αποθήκευσης: " + error.message;
    errEl.hidden = false;
    return;
  }
  fridgeModal.hidden = true;
  toast("Το ψυγείο αποθηκεύτηκε.");
  await loadFridges();
  await loadLatestLogs();
  renderDashboard();
});

$("#deleteFridgeBtn").addEventListener("click", async () => {
  const id = $("#fridgeId").value;
  if (!id) return;
  if (!confirm("Να διαγραφεί το ψυγείο; Οι παλιές καταγραφές παραμένουν στο ιστορικό.")) return;
  const { error } = await sb.from("fridges").update({ active: false }).eq("id", id);
  if (error) { toast("Σφάλμα διαγραφής: " + error.message, true); return; }
  fridgeModal.hidden = true;
  toast("Το ψυγείο διαγράφηκε.");
  await loadFridges();
  renderDashboard();
});

// ---------------- cleaning task settings ----------------
function renderCleaningTaskSettings() {
  const list = $("#cleaningTaskList");
  if (cleaningTasks.length === 0) {
    list.innerHTML = '<p class="muted">Δεν υπάρχουν εργασίες καθαρισμού ακόμα.</p>';
    return;
  }
  list.innerHTML = cleaningTasks.map((t) => `
    <div class="fridge-settings-row">
      <span class="fs-name">${escapeHtml(t.name)}</span>
      <span class="frequency-badge">${frequencyLabel(t.frequency)}</span>
      <span class="muted small">${escapeHtml(t.area || "")}</span>
      <span class="spacer"></span>
      <button class="btn btn-secondary btn-sm" data-edit-task="${t.id}">Επεξεργασία</button>
    </div>`).join("");
  $all("[data-edit-task]", list).forEach((btn) => {
    btn.addEventListener("click", () => openCleaningTaskModal(btn.dataset.editTask));
  });
}

$("#newCleaningTaskBtn").addEventListener("click", () => openCleaningTaskModal(null));

const cleaningTaskModal = $("#cleaningTaskModal");
const cleaningTaskForm = $("#cleaningTaskForm");

function openCleaningTaskModal(taskId) {
  const t = taskId ? cleaningTasks.find((x) => x.id === taskId) : null;
  $("#cleaningTaskModalTitle").textContent = t ? "Επεξεργασία εργασίας" : "Νέα εργασία καθαρισμού";
  $("#cleaningTaskFormId").value = t?.id || "";
  $("#cleaningTaskName").value = t?.name || "";
  $("#cleaningTaskArea").value = t?.area || "";
  $("#cleaningTaskFrequency").value = t?.frequency || "daily";
  $("#deleteCleaningTaskBtn").hidden = !t;
  $("#cleaningTaskFormError").hidden = true;
  cleaningTaskModal.hidden = false;
}

cleaningTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#cleaningTaskFormId").value;
  const name = $("#cleaningTaskName").value.trim();
  const errEl = $("#cleaningTaskFormError");
  errEl.hidden = true;
  if (!name) {
    errEl.textContent = "Συμπλήρωσε τι καθαρίζεται.";
    errEl.hidden = false;
    return;
  }
  const payload = {
    name,
    area: $("#cleaningTaskArea").value.trim() || null,
    frequency: $("#cleaningTaskFrequency").value,
  };
  let error;
  if (id) {
    ({ error } = await sb.from("cleaning_tasks").update(payload).eq("id", id));
  } else {
    payload.sort_order = cleaningTasks.length;
    ({ error } = await sb.from("cleaning_tasks").insert(payload));
  }
  if (error) {
    errEl.textContent = "Σφάλμα αποθήκευσης: " + error.message;
    errEl.hidden = false;
    return;
  }
  cleaningTaskModal.hidden = true;
  toast("Η εργασία αποθηκεύτηκε.");
  await loadCleaningTasks();
  await loadLatestCleaningLogs();
  renderCleaningDashboard();
});

$("#deleteCleaningTaskBtn").addEventListener("click", async () => {
  const id = $("#cleaningTaskFormId").value;
  if (!id) return;
  if (!confirm("Να διαγραφεί η εργασία καθαρισμού; Οι παλιές καταγραφές παραμένουν στο ιστορικό.")) return;
  const { error } = await sb.from("cleaning_tasks").update({ active: false }).eq("id", id);
  if (error) { toast("Σφάλμα διαγραφής: " + error.message, true); return; }
  cleaningTaskModal.hidden = true;
  toast("Η εργασία διαγράφηκε.");
  await loadCleaningTasks();
  renderCleaningDashboard();
});

// ---------------- users ----------------
// Καλεί το Edge Function "manage-users" (service_role key μένει μόνο εκεί).
async function callUsersFunction(action, extra) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Δεν είσαι συνδεδεμένος/η.");
  const res = await fetch(USERS_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + session.access_token,
      "apikey": cfg.anonKey,
    },
    body: JSON.stringify({ action, ...extra }),
  });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new Error(body?.error || `Σφάλμα (${res.status})`);
  return body;
}

async function loadUsers() {
  const errEl = $("#usersError");
  errEl.hidden = true;
  try {
    const { users } = await callUsersFunction("list");
    appUsers = users || [];
    renderUsersList();
  } catch (e) {
    appUsers = [];
    $("#userList").innerHTML = "";
    errEl.textContent = "Δεν ήταν δυνατή η φόρτωση χρηστών: " + e.message +
      " — έχει γίνει deploy το Edge Function \"manage-users\" και έχει οριστεί το secret ADMIN_EMAIL; Δες Βήμα 8 στο README.";
    errEl.hidden = false;
  }
}

function renderUsersList() {
  const list = $("#userList");
  if (appUsers.length === 0) {
    list.innerHTML = '<p class="muted">Δεν βρέθηκαν χρήστες.</p>';
    return;
  }
  list.innerHTML = appUsers.map((u) => `
    <div class="fridge-settings-row">
      <span class="fs-name">${escapeHtml(u.email)}${u.email === currentUser?.email ? ' <span class="muted small">(εσύ)</span>' : ""}</span>
      <span class="muted small">Δημιουργήθηκε: ${fmtDateTime(u.created_at)}</span>
      <span class="muted small">${u.last_sign_in_at ? "Τελευταία σύνδεση: " + fmtDateTime(u.last_sign_in_at) : "Δεν έχει συνδεθεί ακόμα"}</span>
      <span class="spacer"></span>
      ${u.email === currentUser?.email ? "" : `<button class="btn btn-danger-ghost btn-sm" data-delete-user="${u.id}">Διαγραφή</button>`}
    </div>`).join("");
  $all("[data-delete-user]", list).forEach((btn) => {
    btn.addEventListener("click", () => deleteUser(btn.dataset.deleteUser));
  });
}

$("#newUserBtn").addEventListener("click", () => {
  $("#newUserEmail").value = "";
  $("#newUserPassword").value = "";
  $("#userFormError").hidden = true;
  userModal.hidden = false;
  setTimeout(() => $("#newUserEmail").focus(), 50);
});

const userModal = $("#userModal");
const userForm = $("#userForm");
userForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#userFormError");
  errEl.hidden = true;
  try {
    await callUsersFunction("create", {
      email: $("#newUserEmail").value.trim(),
      password: $("#newUserPassword").value,
    });
    userModal.hidden = true;
    toast("Ο χρήστης δημιουργήθηκε.");
    await loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

async function deleteUser(userId) {
  const u = appUsers.find((x) => x.id === userId);
  if (!u) return;
  if (!confirm(`Να διαγραφεί ο χρήστης ${u.email}; Δεν θα μπορεί πλέον να συνδεθεί.`)) return;
  try {
    await callUsersFunction("delete", { userId });
    toast("Ο χρήστης διαγράφηκε.");
    await loadUsers();
  } catch (err) {
    toast("Σφάλμα διαγραφής: " + err.message, true);
  }
}

// ---------------- modal close handlers ----------------
$all("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => {
    logModal.hidden = true;
    fridgeModal.hidden = true;
    cleaningLogModal.hidden = true;
    cleaningTaskModal.hidden = true;
    userModal.hidden = true;
  });
});
[logModal, fridgeModal, cleaningLogModal, cleaningTaskModal, userModal].forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.hidden = true; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    logModal.hidden = true;
    fridgeModal.hidden = true;
    cleaningLogModal.hidden = true;
    cleaningTaskModal.hidden = true;
    userModal.hidden = true;
  }
});

// ---------------- start ----------------
initAuth();
