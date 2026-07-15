import { firebaseConfig, ADMIN_PIN } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, addDoc, query, where, orderBy, onSnapshot, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------- constants ----------------
const DAY_HOURS = 8; // 10am - 6pm
const DAY_START_CLOCK = "10:00";
const BAY_IDS = [1, 2, 3, 4, 5, 6];
const POSITION_DEFS = [
  { id: "chair1", name: "Chair 1" },
  { id: "chair2", name: "Chair 2" },
  { id: "jetty", name: "Jetty" },
  { id: "walker", name: "Walker" },
];
const HOUR_OPTIONS = Array.from({ length: DAY_HOURS * 2 + 1 }, (_, i) => i * 0.5);

// ---------------- firebase ----------------
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------------- helpers ----------------
function fmtHours(h) {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh <= 0 && mm <= 0) return "0m";
  if (hh === 0) return `${mm}m`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h ${mm}m`;
}

function clockLabel(hoursFromStart) {
  const [sh, sm] = DAY_START_CLOCK.split(":").map(Number);
  const totalMin = sh * 60 + sm + Math.round(hoursFromStart * 60);
  const wrapped = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
  let hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  const ap = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm.toString().padStart(2, "0")} ${ap}`;
}

function clockTimeLabel(ms) {
  const d = new Date(ms);
  let hh = d.getHours();
  const mm = d.getMinutes();
  const ap = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm.toString().padStart(2, "0")} ${ap}`;
}

function todayStartMs() {
  const now = new Date();
  const [sh, sm] = DAY_START_CLOCK.split(":").map(Number);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0, 0);
  // if it's after midnight but before today's start (e.g. testing at 2am), still anchor to today
  return start.getTime();
}

// Query boundary — deliberately earlier than the 10am shift start, so a
// guard who checks in early (to set up before opening) isn't silently
// excluded from the live data. The 10am boundary above is only used for
// "hours from shift start" math, not for what counts as "today".
function todayMidnightMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateStrLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Local-midnight-to-local-midnight range in ms for a given "YYYY-MM-DD" string.
function dateStrToRange(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

// ---------------- local device state ----------------
let myRole = localStorage.getItem("bay_myRole") || null; // "lifeguard" | "admin" | null
let myName = localStorage.getItem("bay_myName") || "";
let adminUnlocked = sessionStorage.getItem("bay_adminUnlocked") === "1";

// notifications + chat (UI state; the panels/FAB live outside the main
// render() cycle so they aren't wiped out by every re-render)
let notifications = []; // { id, text, type, at }
let unreadNotif = 0;
let notifOpen = false;
let chatMessages = [];
let unreadChat = 0;
let chatOpen = false;

function setRole(role) {
  myRole = role;
  localStorage.setItem("bay_myRole", role);
  render();
}
function setMyName(name) {
  myName = name;
  localStorage.setItem("bay_myName", name);
  requestNotifPermission();
  render();
}
function signOutRole() {
  myRole = null;
  adminUnlocked = false;
  sessionStorage.removeItem("bay_adminUnlocked");
  localStorage.removeItem("bay_myRole");
  render();
}

function requestNotifPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

// OS-level notification — only useful while this tab/browser is still
// running (in the background is fine, fully closed is not, since there's
// no push server behind this). Only fires when the tab isn't in front, so
// it doesn't double up with the in-app toast someone's already looking at.
function osNotify(title, body) {
  if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
    try { new Notification(title, { body }); } catch (e) { /* ignore */ }
  }
}

// ---------------- live data ----------------
let bays = {}; // { [bayId]: { open, positions: { chair1: {on,hours}, ... } } }
let events = []; // today's events, ascending by time: { guard, bay, at }
let dataReady = false;
const loadedBays = new Set();

async function seedBaysIfNeeded() {
  for (const id of BAY_IDS) {
    const ref = doc(db, "bays", String(id));
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const positions = {};
      POSITION_DEFS.forEach((p) => {
        positions[p.id] = { on: true, hours: p.id === "walker" ? 7 : 8 };
      });
      await setDoc(ref, { open: id <= 5, positions });
    }
  }
}

function listenBays() {
  BAY_IDS.forEach((id) => {
    const ref = doc(db, "bays", String(id));
    let prev = null;
    let first = true;
    onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (!first && prev) {
          if (prev.open !== data.open) {
            pushNotification(`Bay ${id} ${data.open ? "opened" : "closed"}`, data.open ? "info" : "warning");
          }
          POSITION_DEFS.forEach((p) => {
            const wasOn = prev.positions[p.id]?.on;
            const isOn = data.positions[p.id]?.on;
            if (wasOn !== isOn) {
              pushNotification(`${p.name} at Bay ${id} turned ${isOn ? "on" : "off"}`, isOn ? "info" : "warning");
            }
          });
        }
        prev = data;
        first = false;
        bays[id] = data;
        loadedBays.add(id);
        if (loadedBays.size === BAY_IDS.length) dataReady = true;
        render();
      }
    });
  });
}

let activeDayStr = todayDateStr();
let unsubscribeEvents = null;

function listenEvents() {
  if (unsubscribeEvents) unsubscribeEvents();
  const q = query(
    collection(db, "events"),
    where("at", ">=", todayMidnightMs()),
    orderBy("at", "asc")
  );
  let first = true;
  const lastKnownBay = {};
  unsubscribeEvents = onSnapshot(q, (snap) => {
    events = snap.docs.map((d) => d.data());
    if (first) {
      // seed silently — these are pre-existing events from earlier today,
      // not new activity, so they shouldn't fire notifications
      events.forEach((e) => { lastKnownBay[e.guard] = e.bay; });
    } else {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        const e = change.doc.data();
        const prevBay = lastKnownBay[e.guard];
        let msg;
        if (e.bay === null) {
          msg = prevBay ? `${e.guard} checked out of Bay ${prevBay}` : `${e.guard} checked out`;
        } else if (prevBay === undefined || prevBay === null) {
          msg = `${e.guard} checked into Bay ${e.bay}`;
        } else if (prevBay === e.bay) {
          msg = null; // redundant same-bay tap — nothing actually changed
        } else {
          msg = `${e.guard} moved from Bay ${prevBay} to Bay ${e.bay}`;
        }
        lastKnownBay[e.guard] = e.bay;
        if (msg) pushNotification(msg, "info");
      });
    }
    first = false;
    render();
  });
}

// The Firestore query above bakes in "today's" midnight boundary at the
// moment it's created — it does NOT update itself as time passes. If the
// admin leaves the tab open overnight, without this check it would keep
// showing yesterday's data forever. This runs periodically and
// re-subscribes with a fresh boundary the moment the date actually rolls
// over, so the live view genuinely clears itself at midnight.
function checkDayRollover() {
  const nowStr = todayDateStr();
  if (nowStr !== activeDayStr) {
    activeDayStr = nowStr;
    listenEvents();
    listenChat();
    priorShortage = {};
    notifiedLongShift.clear();
    render();
  }
}

async function checkIn(bayId) {
  if (!myName) return;
  await addDoc(collection(db, "events"), { guard: myName, bay: bayId, at: Date.now() });
}
async function checkOut() {
  if (!myName) return;
  await addDoc(collection(db, "events"), { guard: myName, bay: null, at: Date.now() });
}
async function adminMoveGuard(guardName, bayId) {
  await addDoc(collection(db, "events"), { guard: guardName, bay: bayId, at: Date.now() });
}
async function toggleBayOpen(bayId) {
  const ref = doc(db, "bays", String(bayId));
  await updateDoc(ref, { open: !bays[bayId].open });
}
async function togglePositionOn(bayId, posId) {
  const bay = bays[bayId];
  const positions = { ...bay.positions, [posId]: { ...bay.positions[posId], on: !bay.positions[posId].on } };
  await updateDoc(doc(db, "bays", String(bayId)), { positions });
}
async function setPositionHours(bayId, posId, hours) {
  const bay = bays[bayId];
  const positions = { ...bay.positions, [posId]: { ...bay.positions[posId], hours: parseFloat(hours) } };
  await updateDoc(doc(db, "bays", String(bayId)), { positions });
}

// ---------------- derived state ----------------
// Build, per guard, chronological intervals of which bay they were in.
function buildTimelines() {
  const byGuard = {};
  events.forEach((e) => {
    if (!byGuard[e.guard]) byGuard[e.guard] = [];
    byGuard[e.guard].push(e);
  });
  const now = Date.now();
  const dayStart = todayStartMs();

  // per-bay list of {guard, start, end} intervals for today (end = now if ongoing)
  const bayIntervals = {};
  BAY_IDS.forEach((id) => (bayIntervals[id] = []));

  // current live status per guard: { bay: id|null, since: ms }
  const currentStatus = {};

  Object.entries(byGuard).forEach(([guard, evs]) => {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.bay !== null) {
        const start = Math.max(e.at, dayStart);
        const end = evs[i + 1] ? evs[i + 1].at : now;
        if (end > start) {
          bayIntervals[e.bay].push({ guard, start, end, ongoing: !evs[i + 1] });
        }
      }
    }
    const last = evs[evs.length - 1];
    currentStatus[guard] = last.bay !== null ? { bay: last.bay, since: last.at } : { bay: null, since: last.at };
  });

  return { bayIntervals, currentStatus };
}

function currentHeadcount(bayIntervals, bayId) {
  return bayIntervals[bayId].filter((iv) => iv.ongoing).length;
}

function guardsInBay(currentStatus, bayId) {
  return Object.entries(currentStatus)
    .filter(([, s]) => s.bay === bayId)
    .map(([guard, s]) => ({ guard, since: s.since }))
    .sort((a, b) => a.since - b.since);
}

// remaining-today duty split for a bay, given who's there right now
function remainingSplit(bay, headcount) {
  const now = Date.now();
  const dayStart = todayStartMs();
  const hoursNow = Math.max(0, Math.min(DAY_HOURS, (now - dayStart) / 3600000));

  const onPositions = POSITION_DEFS.filter((p) => bay.positions[p.id]?.on);
  let remainingMin = 0;
  onPositions.forEach((p) => {
    const posHours = bay.positions[p.id].hours;
    const remaining = Math.max(0, Math.min(posHours, DAY_HOURS) - hoursNow);
    remainingMin += remaining * 60;
  });

  const activeStandsNow = onPositions.filter((p) => bay.positions[p.id].hours > hoursNow).length;
  const shortage = headcount > 0 && headcount < activeStandsNow;

  let breakdown = null;
  if (headcount > 0 && remainingMin > 0) {
    const totalBlocks = Math.round(remainingMin / 30);
    const baseBlocks = Math.floor(totalBlocks / headcount);
    const extra = totalBlocks - baseBlocks * headcount;
    breakdown = {
      groupA: { count: headcount - extra, minutes: baseBlocks * 30 },
      groupB: extra > 0 ? { count: extra, minutes: (baseBlocks + 1) * 30 } : null,
    };
  }
  return { remainingMin, breakdown, shortage, activeStandsNow, hoursNow };
}

// ---------------- notifications ----------------
function pushNotification(text, type = "info") {
  const entry = { id: `${Date.now()}_${Math.random()}`, text, type, at: Date.now() };
  notifications.unshift(entry);
  if (notifications.length > 60) notifications.length = 60;
  unreadNotif++;
  renderNotifBadge();
  if (notifOpen) renderNotifList();
  showToast(text, type);
  osNotify("Bay Board", text);
  updateFabVisibility();
}

function showToast(text, type) {
  const holder = document.getElementById("toastRoot");
  if (!holder) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = text;
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

function showChatPopout(sender, text) {
  const holder = document.getElementById("chatPopoutRoot");
  if (!holder) return;
  const el = document.createElement("div");
  el.className = "chat-popout";
  el.innerHTML = `<div class="chat-popout-sender">💬 ${escapeHtml(sender)}</div><div class="chat-popout-text">${escapeHtml(text)}</div>`;
  el.onclick = () => { openChat(); el.remove(); };
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 6000);
}

function renderNotifBadge() {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;
  if (unreadNotif > 0) { badge.style.display = "flex"; badge.textContent = unreadNotif > 9 ? "9+" : unreadNotif; }
  else badge.style.display = "none";
}

function renderNotifList() {
  const list = document.getElementById("notifList");
  if (!list) return;
  list.innerHTML = notifications.length
    ? notifications.map((n) => `
        <div class="notif-row ${n.type === "warning" ? "notif-warning" : ""}">
          <span class="notif-time">${clockTimeLabel(n.at)}</span>
          <span>${escapeHtml(n.text)}</span>
        </div>
      `).join("")
    : `<div class="empty-msg none-needed" style="padding:20px 0;">No notifications yet</div>`;
}

function openNotif() {
  notifOpen = true;
  unreadNotif = 0;
  renderNotifBadge();
  renderNotifList();
  document.getElementById("notifPanel").style.display = "flex";
  closeChat();
}
function closeNotif() {
  notifOpen = false;
  document.getElementById("notifPanel").style.display = "none";
}

// ---------------- chat ----------------
let unsubscribeChat = null;

function listenChat() {
  if (unsubscribeChat) unsubscribeChat();
  const q = query(
    collection(db, "messages"),
    where("at", ">=", todayMidnightMs()),
    orderBy("at", "asc")
  );
  let first = true;
  unsubscribeChat = onSnapshot(q, (snap) => {
    chatMessages = snap.docs.map((d) => d.data());
    if (!first) {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        const m = change.doc.data();
        if (m.sender === myName) return; // don't notify yourself about your own message
        unreadChat++;
        updateChatBadge();
        pushNotification(`💬 ${m.sender}: ${m.text}`, "chat");
        if (!chatOpen) showChatPopout(m.sender, m.text);
      });
    }
    first = false;
    if (chatOpen) renderChatMessages();
  });
}

async function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  const sender = myName || (myRole === "admin" ? "Admin" : "Lifeguard");
  input.value = "";
  await addDoc(collection(db, "messages"), { sender, text, at: Date.now() });
}

function renderChatMessages() {
  const el = document.getElementById("chatMessages");
  if (!el) return;
  el.innerHTML = chatMessages.length
    ? chatMessages.map((m) => `
        <div class="chat-msg ${m.sender === myName ? "mine" : ""}">
          <div class="chat-msg-meta"><b>${escapeHtml(m.sender)}</b> · ${clockTimeLabel(m.at)}</div>
          <div class="chat-msg-text">${escapeHtml(m.text)}</div>
        </div>
      `).join("")
    : `<div class="empty-msg none-needed" style="padding:20px 0;">No messages yet — say hi</div>`;
  el.scrollTop = el.scrollHeight;
}

function updateChatBadge() {
  const badge = document.getElementById("chatBadge");
  if (!badge) return;
  if (unreadChat > 0) { badge.style.display = "flex"; badge.textContent = unreadChat > 9 ? "9+" : unreadChat; }
  else badge.style.display = "none";
}

function openChat() {
  chatOpen = true;
  unreadChat = 0;
  updateChatBadge();
  renderChatMessages();
  document.getElementById("chatPanel").style.display = "flex";
  closeNotif();
  document.getElementById("chatInput").focus();
}
function closeChat() {
  chatOpen = false;
  document.getElementById("chatPanel").style.display = "none";
}

function updateFabVisibility() {
  const show = !!(myRole && (myRole === "admin" ? adminUnlocked : myName));
  const bell = document.getElementById("notifBell");
  const chatFab = document.getElementById("chatFab");
  if (bell) bell.style.display = show ? "flex" : "none";
  if (chatFab) chatFab.style.display = show ? "flex" : "none";
}

function wireFloatingUI() {
  document.getElementById("notifBell").onclick = openNotif;
  document.getElementById("notifClose").onclick = closeNotif;
  document.getElementById("chatFab").onclick = openChat;
  document.getElementById("chatClose").onclick = closeChat;
  document.getElementById("chatSend").onclick = sendChatMessage;
  document.getElementById("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });
}

// ---------------- alerts (shortage + long-shift reminders) ----------------
let priorShortage = {}; // bayId -> bool, so we only notify on the transition
let notifiedLongShift = new Set(); // guards already reminded today

function checkAlerts() {
  if (!dataReady) return;
  const { bayIntervals, currentStatus } = buildTimelines();

  BAY_IDS.forEach((id) => {
    const bay = bays[id];
    if (!bay.open) { priorShortage[id] = false; return; }
    const count = currentHeadcount(bayIntervals, id);
    const split = remainingSplit(bay, count);
    const wasShort = !!priorShortage[id];
    if (split.shortage && !wasShort) {
      pushNotification(`Bay ${id} is short-staffed — only ${count} for ${split.activeStandsNow} stands`, "warning");
    } else if (!split.shortage && wasShort) {
      pushNotification(`Bay ${id} is back to full coverage`, "info");
    }
    priorShortage[id] = split.shortage;
  });

  const now = Date.now();
  Object.entries(currentStatus).forEach(([guard, s]) => {
    if (s.bay && now - s.since >= 3 * 3600000 && !notifiedLongShift.has(guard)) {
      pushNotification(`${guard} has been on Bay ${s.bay} for 3+ hours — maybe rotate them out`, "reminder");
      notifiedLongShift.add(guard);
    }
  });
}

// ---------------- history (past days) ----------------
async function fetchDayEvents(dateStr) {
  const { start, end } = dateStrToRange(dateStr);
  const q = query(
    collection(db, "events"),
    where("at", ">=", start),
    where("at", "<", end),
    orderBy("at", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// Builds per-bay durations, per-guard totals, and a plain-English
// chronological log for an arbitrary day's events. endCapMs is what an
// unfinished ("forgot to check out") stretch is measured against — now,
// if it's today, otherwise that day's midnight.
function buildDayReport(dayEvents, endCapMs) {
  const byGuard = {};
  dayEvents.forEach((e) => {
    if (!byGuard[e.guard]) byGuard[e.guard] = [];
    byGuard[e.guard].push(e);
  });

  const bayIntervals = {};
  BAY_IDS.forEach((id) => (bayIntervals[id] = []));
  const guardTotals = {};

  Object.entries(byGuard).forEach(([guard, evs]) => {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.bay !== null) {
        const start = e.at;
        const end = evs[i + 1] ? evs[i + 1].at : endCapMs;
        if (end > start) {
          bayIntervals[e.bay].push({ guard, start, end });
          guardTotals[guard] = (guardTotals[guard] || 0) + (end - start);
        }
      }
    }
  });

  const lastBay = {};
  const log = dayEvents.map((e) => {
    const prev = lastBay[e.guard];
    let action;
    if (e.bay === null) {
      action = prev !== undefined && prev !== null ? `checked out (was Bay ${prev})` : "checked out";
    } else if (prev === undefined || prev === null) {
      action = `checked into Bay ${e.bay}`;
    } else if (prev === e.bay) {
      action = `checked into Bay ${e.bay}`;
    } else {
      action = `moved from Bay ${prev} to Bay ${e.bay}`;
    }
    lastBay[e.guard] = e.bay;
    return { guard: e.guard, at: e.at, action };
  });

  return { bayIntervals, guardTotals, log };
}

// ---------------- history UI state ----------------
let adminTab = "live"; // "live" | "history"
let historyDate = todayDateStr();
let historyLoading = false;
let historyReport = null;

async function loadHistory(dateStr) {
  historyDate = dateStr;
  historyLoading = true;
  historyReport = null;
  render();
  const dayEvents = await fetchDayEvents(dateStr);
  const endCap = dateStr === todayDateStr() ? Date.now() : dateStrToRange(dateStr).end;
  historyReport = buildDayReport(dayEvents, endCap);
  historyLoading = false;
  render();
}
const root = document.getElementById("root");

function headerHtml(title, sub) {
  return `
    <div class="header">
      <div class="header-badge">🛟</div>
      <div>
        <div class="header-title">${escapeHtml(title)}</div>
        <div class="header-sub">${escapeHtml(sub)}</div>
      </div>
    </div>
    <div class="wave-divider">
      <svg viewBox="0 0 120 16" preserveAspectRatio="none"><path d="M0,8 C10,14 20,2 30,8 C40,14 50,2 60,8 C70,14 80,2 90,8 C100,14 110,2 120,8 L120,16 L0,16 Z"/></svg>
    </div>
  `;
}

function render() {
  if (!dataReady) {
    root.innerHTML = `<div class="loading">Connecting…</div>`;
    return;
  }
  if (!myRole) {
    renderRoleGate();
  } else if (myRole === "lifeguard") {
    renderLifeguard();
  } else if (myRole === "admin") {
    if (!adminUnlocked) renderAdminPinGate();
    else renderAdmin();
  }
  updateFabVisibility();
}

function renderRoleGate() {
  root.innerHTML = `
    ${headerHtml("Bay Board", "10:00 AM – 6:00 PM")}
    <div class="board-overview">${overviewHtml()}</div>
    <div class="role-pick">
      <button class="role-btn" id="pickLifeguard">🏖️ I'm a Lifeguard</button>
      <button class="role-btn secondary" id="pickAdmin">🗝️ I'm the Admin</button>
    </div>
    <a class="link-btn" href="calculator.html">🧮 Just calculate a bay split (no login)</a>
  `;
  document.getElementById("pickLifeguard").onclick = () => setRole("lifeguard");
  document.getElementById("pickAdmin").onclick = () => setRole("admin");
}

function overviewHtml() {
  const { bayIntervals, currentStatus } = buildTimelines();
  return BAY_IDS.map((id) => {
    const bay = bays[id];
    const count = currentHeadcount(bayIntervals, id);
    const roster = bay.open ? guardsInBay(currentStatus, id) : [];
    return `
      <div class="mini-bay ${bay.open ? "" : "closed"}">
        <div class="mini-bay-head">
          <span class="mini-bay-name">Bay ${id}</span>
          <span class="mini-bay-status">${bay.open ? `${count} on it` : "Closed"}</span>
        </div>
        ${bay.open && roster.length ? `
          <div class="mini-bay-roster">
            ${roster.map((g) => `<span class="roster-chip">${escapeHtml(g.guard)}</span>`).join("")}
          </div>
        ` : ""}
        ${bay.open && !roster.length ? `<div class="mini-bay-empty">No one here yet</div>` : ""}
      </div>
    `;
  }).join("");
}

function renderAdminPinGate() {
  root.innerHTML = `
    ${headerHtml("Admin Login", "Enter PIN")}
    <div class="section">
      <input type="password" inputmode="numeric" id="pinInput" class="pin-input" placeholder="• • • •" />
      <button class="add-row" id="pinSubmit" style="margin-top:10px;">Unlock</button>
      <div id="pinError" class="pin-error"></div>
    </div>
    <button class="link-btn" id="backBtn">← back</button>
  `;
  document.getElementById("backBtn").onclick = signOutRole;
  document.getElementById("pinSubmit").onclick = tryPin;
  document.getElementById("pinInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryPin();
  });
  function tryPin() {
    const val = document.getElementById("pinInput").value;
    if (val === ADMIN_PIN) {
      adminUnlocked = true;
      sessionStorage.setItem("bay_adminUnlocked", "1");
      requestNotifPermission();
      render();
    } else {
      document.getElementById("pinError").textContent = "Wrong PIN";
    }
  }
}

function renderLifeguard() {
  if (!myName) {
    root.innerHTML = `
      ${headerHtml("What's your name?", "10:00 AM – 6:00 PM")}
      <div class="section">
        <input type="text" id="nameInput" class="pin-input" placeholder="Your name" />
        <button class="add-row" id="nameSubmit" style="margin-top:10px;">Continue</button>
      </div>
      <button class="link-btn" id="backBtn">← back</button>
    `;
    document.getElementById("backBtn").onclick = signOutRole;
    document.getElementById("nameSubmit").onclick = submit;
    document.getElementById("nameInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    function submit() {
      const val = document.getElementById("nameInput").value.trim();
      if (val) setMyName(val);
    }
    return;
  }

  const { bayIntervals, currentStatus } = buildTimelines();
  const my = currentStatus[myName] || { bay: null, since: null };

  const bayButtons = BAY_IDS.filter((id) => bays[id].open).map((id) => {
    const count = currentHeadcount(bayIntervals, id);
    const mine = my.bay === id;
    return `
      <button class="bay-tile ${mine ? "mine" : ""}" data-bay="${id}">
        <span class="bay-tile-name">Bay ${id}</span>
        <span class="bay-tile-count">${count} here</span>
        ${mine ? `<span class="bay-tile-tag">You're here</span>` : ""}
      </button>
    `;
  }).join("");

  let statusHtml = "";
  if (my.bay) {
    const elapsed = Date.now() - my.since;
    const bay = bays[my.bay];
    const count = currentHeadcount(bayIntervals, my.bay);
    const split = remainingSplit(bay, count);
    statusHtml = `
      <div class="duty-card">
        <div class="duty-banner">
          <span class="duty-time">Bay ${my.bay} · since ${clockTimeLabel(my.since)}</span>
          <span class="duty-people">${fmtHours(elapsed / 3600000)} so far</span>
        </div>
        <div class="duty-body">
          ${split.breakdown ? `
            <div class="stat-row">
              <div class="stat-block">
                <div class="stat-count">${split.breakdown.groupA.count}</div>
                <div class="stat-people-label">${split.breakdown.groupA.count === 1 ? "person" : "people"}</div>
                <div class="stat-time">${fmtHours(split.breakdown.groupA.minutes / 60)}</div>
                <div class="stat-each">left today</div>
              </div>
              ${split.breakdown.groupB ? `
                <div class="stat-divider"></div>
                <div class="stat-block">
                  <div class="stat-count">${split.breakdown.groupB.count}</div>
                  <div class="stat-people-label">${split.breakdown.groupB.count === 1 ? "person" : "people"}</div>
                  <div class="stat-time">${fmtHours(split.breakdown.groupB.minutes / 60)}</div>
                  <div class="stat-each">left today</div>
                </div>
              ` : ""}
            </div>
          ` : `<div class="empty-msg none-needed">No more coverage needed today</div>`}
          ${split.shortage ? `<div class="shortage"><span>⚠️</span><span>Only ${count} for ${split.activeStandsNow} stands right now.</span></div>` : ""}
        </div>
      </div>
      <button class="add-row danger" id="checkOutBtn">Check out of Bay ${my.bay}</button>
    `;
  }

  root.innerHTML = `
    ${headerHtml(`Hey, ${myName}`, "10:00 AM – 6:00 PM")}

    ${statusHtml}

    <div class="section">
      <div class="section-label">🌊 Tap the bay you're on</div>
      <div class="bay-grid">${bayButtons || `<div class="empty-msg none-needed">No bays open right now</div>`}</div>
    </div>

    <button class="link-btn" id="switchName">Not ${escapeHtml(myName)}? Switch name</button>
    <button class="link-btn" id="backBtn">← back to role select</button>
    <a class="link-btn" href="calculator.html">🧮 Just calculate a bay split</a>
  `;

  root.querySelectorAll(".bay-tile").forEach((btn) => {
    const bayId = parseInt(btn.dataset.bay, 10);
    btn.onclick = () => { if (bayId !== my.bay) checkIn(bayId); };
  });
  const coBtn = document.getElementById("checkOutBtn");
  if (coBtn) coBtn.onclick = checkOut;
  document.getElementById("switchName").onclick = () => setMyName("");
  document.getElementById("backBtn").onclick = signOutRole;
}

function renderAdmin() {
  root.innerHTML = `
    ${headerHtml("Admin Dashboard", "10:00 AM – 6:00 PM")}
    <div class="tab-row">
      <button class="tab-btn ${adminTab === "live" ? "active" : ""}" id="tabLive">Live</button>
      <button class="tab-btn ${adminTab === "history" ? "active" : ""}" id="tabHistory">History</button>
    </div>
    <div id="adminContent"></div>
    <button class="link-btn" id="backBtn">← sign out of admin</button>
    <a class="link-btn" href="calculator.html">🧮 Just calculate a bay split</a>
  `;
  document.getElementById("tabLive").onclick = () => { adminTab = "live"; render(); };
  document.getElementById("tabHistory").onclick = () => {
    adminTab = "history";
    if (!historyReport && !historyLoading) loadHistory(historyDate);
    render();
  };
  document.getElementById("backBtn").onclick = signOutRole;

  if (adminTab === "live") renderAdminLive();
  else renderAdminHistory();
}

function renderAdminLive() {
  const el = document.getElementById("adminContent");
  const { bayIntervals, currentStatus } = buildTimelines();

  const bayCards = BAY_IDS.map((id) => {
    const bay = bays[id];
    const roster = guardsInBay(currentStatus, id);
    const count = roster.length;
    const split = remainingSplit(bay, count);

    const positionRows = POSITION_DEFS.map((p) => {
      const pos = bay.positions[p.id];
      return `
        <div class="row ${pos.on ? "" : "dim"}">
          <button class="switch ${pos.on ? "on" : ""}" data-toggle-pos="${id}|${p.id}"><span class="knob"></span></button>
          <span class="name-label">${p.name}</span>
          <select data-set-hours="${id}|${p.id}" ${pos.on ? "" : "disabled"} style="width:84px;">
            ${HOUR_OPTIONS.map((h) => `<option value="${h}" ${h === pos.hours ? "selected" : ""}>${fmtHours(h)}</option>`).join("")}
          </select>
        </div>
      `;
    }).join("");

    const rosterRows = roster.length
      ? roster.map((g) => `
          <div class="roster-row">
            <span>${escapeHtml(g.guard)}</span>
            <span class="roster-time">${fmtHours((Date.now() - g.since) / 3600000)}</span>
            <select class="roster-move" data-move-guard="${escapeHtml(g.guard)}">
              <option value="">Move to…</option>
              ${BAY_IDS.filter((b) => b !== id && bays[b].open).map((b) => `<option value="${b}">Bay ${b}</option>`).join("")}
            </select>
          </div>
        `).join("")
      : `<div class="empty-msg none-needed" style="padding:6px 0;">No one here</div>`;

    return `
      <div class="admin-bay-card ${bay.open ? "" : "bay-closed"}">
        <div class="admin-bay-head">
          <button class="switch ${bay.open ? "on" : ""}" data-toggle-bay="${id}"><span class="knob"></span></button>
          <span class="admin-bay-title">Bay ${id}</span>
          <span class="admin-bay-count">${bay.open ? `${count} on it` : "Closed"}</span>
        </div>
        ${bay.open ? `
          <div class="admin-bay-body">
            <div class="positions-block">${positionRows}</div>
            <div class="roster-block">${rosterRows}</div>
            ${split.breakdown ? `
              <div class="mini-split">
                Rest of day: <b>${split.breakdown.groupA.count}</b> do <b>${fmtHours(split.breakdown.groupA.minutes / 60)}</b>${
                  split.breakdown.groupB ? `, <b>${split.breakdown.groupB.count}</b> do <b>${fmtHours(split.breakdown.groupB.minutes / 60)}</b>` : ""
                }
              </div>
            ` : ""}
            ${split.shortage ? `<div class="shortage"><span>⚠️</span><span>Only ${count} for ${split.activeStandsNow} stands right now.</span></div>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }).join("");

  el.innerHTML = `<div id="adminBays">${bayCards}</div>`;

  el.querySelectorAll("[data-toggle-bay]").forEach((btn) => {
    btn.onclick = () => toggleBayOpen(parseInt(btn.dataset.toggleBay, 10));
  });
  el.querySelectorAll("[data-toggle-pos]").forEach((btn) => {
    btn.onclick = () => {
      const [bayId, posId] = btn.dataset.togglePos.split("|");
      togglePositionOn(parseInt(bayId, 10), posId);
    };
  });
  el.querySelectorAll("[data-set-hours]").forEach((sel) => {
    sel.onchange = () => {
      const [bayId, posId] = sel.dataset.setHours.split("|");
      setPositionHours(parseInt(bayId, 10), posId, sel.value);
    };
  });
  el.querySelectorAll("[data-move-guard]").forEach((sel) => {
    sel.onchange = () => {
      if (sel.value) adminMoveGuard(sel.dataset.moveGuard, parseInt(sel.value, 10));
      sel.value = "";
    };
  });
}

function renderAdminHistory() {
  const el = document.getElementById("adminContent");
  const quickDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  let bodyHtml;
  if (historyLoading) {
    bodyHtml = `<div class="loading" style="padding:30px 0;">Loading ${dateStrLabel(historyDate)}…</div>`;
  } else if (!historyReport) {
    bodyHtml = "";
  } else {
    const r = historyReport;
    const bayBlocks = BAY_IDS.map((id) => {
      const intervals = r.bayIntervals[id];
      if (!intervals.length) return "";
      return `
        <div class="history-bay">
          <div class="history-bay-title">Bay ${id}</div>
          ${intervals.map((iv) => `
            <div class="roster-row">
              <span>${escapeHtml(iv.guard)}</span>
              <span class="roster-time">${fmtHours((iv.end - iv.start) / 3600000)}</span>
              <span class="history-time-range">${clockTimeLabel(iv.start)} – ${clockTimeLabel(iv.end)}</span>
            </div>
          `).join("")}
        </div>
      `;
    }).join("");

    const totalsBlock = Object.entries(r.guardTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([guard, ms]) => `
        <div class="roster-row">
          <span>${escapeHtml(guard)}</span>
          <span class="roster-time">${fmtHours(ms / 3600000)}</span>
        </div>
      `).join("");

    const logBlock = r.log.length
      ? r.log.map((e) => `
          <div class="log-row">
            <span class="log-time">${clockTimeLabel(e.at)}</span>
            <span><b>${escapeHtml(e.guard)}</b> ${e.action}</span>
          </div>
        `).join("")
      : `<div class="empty-msg none-needed">No activity this day</div>`;

    bodyHtml = `
      <div class="section">
        <div class="section-label">👥 Who worked where</div>
        ${bayBlocks || `<div class="empty-msg none-needed">No one checked in this day</div>`}
      </div>
      <div class="section">
        <div class="section-label">⏱️ Totals for the day</div>
        ${totalsBlock || `<div class="empty-msg none-needed">Nothing to total</div>`}
      </div>
      <div class="section">
        <div class="section-label">📋 Full activity log</div>
        <div class="log-list">${logBlock}</div>
      </div>
    `;
  }

  el.innerHTML = `
    <div class="section">
      <div class="section-label">📅 Pick a day</div>
      <input type="date" id="historyDateInput" value="${historyDate}" max="${todayDateStr()}" />
      <div class="quick-days">
        ${quickDays.map((d) => `<button class="quick-day-btn ${d === historyDate ? "active" : ""}" data-day="${d}">${dateStrLabel(d)}</button>`).join("")}
      </div>
    </div>
    ${bodyHtml}
  `;

  document.getElementById("historyDateInput").onchange = (e) => {
    if (e.target.value) loadHistory(e.target.value);
  };
  el.querySelectorAll("[data-day]").forEach((btn) => {
    btn.onclick = () => loadHistory(btn.dataset.day);
  });
}

// ---------------- boot ----------------
(async function boot() {
  wireFloatingUI();
  await seedBaysIfNeeded();
  listenBays();
  listenEvents();
  listenChat();
  setInterval(render, 30000); // keep elapsed-time displays fresh
  setInterval(checkDayRollover, 30000); // auto-reset the live view at midnight
  setInterval(checkAlerts, 30000); // shortage + long-shift reminders
})();
