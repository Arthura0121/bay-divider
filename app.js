import { firebaseConfig, ADMIN_PIN } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, addDoc, query, where, orderBy, onSnapshot,
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------- local device state ----------------
let myRole = localStorage.getItem("bay_myRole") || null; // "lifeguard" | "admin" | null
let myName = localStorage.getItem("bay_myName") || "";
let adminUnlocked = sessionStorage.getItem("bay_adminUnlocked") === "1";

function setRole(role) {
  myRole = role;
  localStorage.setItem("bay_myRole", role);
  render();
}
function setMyName(name) {
  myName = name;
  localStorage.setItem("bay_myName", name);
  render();
}
function signOutRole() {
  myRole = null;
  adminUnlocked = false;
  sessionStorage.removeItem("bay_adminUnlocked");
  localStorage.removeItem("bay_myRole");
  render();
}

// ---------------- live data ----------------
let bays = {}; // { [bayId]: { open, positions: { chair1: {on,hours}, ... } } }
let events = []; // today's events, ascending by time: { guard, bay, at }
let dataReady = false;

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
    onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        bays[id] = snap.data();
        dataReady = true;
        render();
      }
    });
  });
}

function listenEvents() {
  const q = query(
    collection(db, "events"),
    where("at", ">=", todayStartMs()),
    orderBy("at", "asc")
  );
  onSnapshot(q, (snap) => {
    events = snap.docs.map((d) => d.data());
    render();
  });
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
  const now = Date.now();
  return bayIntervals[bayId].filter((iv) => iv.ongoing || iv.end >= now - 1000).length;
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
  const hoursNow = Math.min(DAY_HOURS, (now - dayStart) / 3600000);

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

// ---------------- rendering ----------------
const root = document.getElementById("root");

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
}

function renderRoleGate() {
  root.innerHTML = `
    <div class="header">
      <div class="header-badge">🛟</div>
      <div>
        <div class="header-title">Bay Board</div>
        <div class="header-sub">10:00 AM – 6:00 PM</div>
      </div>
    </div>
    <div class="board-overview">${overviewHtml()}</div>
    <div class="role-pick">
      <button class="role-btn" id="pickLifeguard">I'm a Lifeguard</button>
      <button class="role-btn secondary" id="pickAdmin">I'm the Admin</button>
    </div>
  `;
  document.getElementById("pickLifeguard").onclick = () => setRole("lifeguard");
  document.getElementById("pickAdmin").onclick = () => setRole("admin");
}

function overviewHtml() {
  const { bayIntervals } = buildTimelines();
  return BAY_IDS.map((id) => {
    const bay = bays[id];
    const count = currentHeadcount(bayIntervals, id);
    return `
      <div class="mini-bay ${bay.open ? "" : "closed"}">
        <span class="mini-bay-name">Bay ${id}</span>
        <span class="mini-bay-status">${bay.open ? `${count} on it` : "Closed"}</span>
      </div>
    `;
  }).join("");
}

function renderAdminPinGate() {
  root.innerHTML = `
    <div class="header">
      <div class="header-badge">🛟</div>
      <div>
        <div class="header-title">Admin Login</div>
        <div class="header-sub">Enter PIN</div>
      </div>
    </div>
    <div class="section">
      <input type="password" inputmode="numeric" id="pinInput" class="pin-input" placeholder="PIN" />
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
      render();
    } else {
      document.getElementById("pinError").textContent = "Wrong PIN";
    }
  }
}

function renderLifeguard() {
  if (!myName) {
    root.innerHTML = `
      <div class="header">
        <div class="header-badge">🛟</div>
        <div>
          <div class="header-title">What's your name?</div>
          <div class="header-sub">10:00 AM – 6:00 PM</div>
        </div>
      </div>
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
    <div class="header">
      <div class="header-badge">🛟</div>
      <div>
        <div class="header-title">Hey, ${escapeHtml(myName)}</div>
        <div class="header-sub">10:00 AM – 6:00 PM</div>
      </div>
    </div>

    ${statusHtml}

    <div class="section">
      <div class="section-label">🌊 Tap the bay you're on</div>
      <div class="bay-grid">${bayButtons || `<div class="empty-msg none-needed">No bays open right now</div>`}</div>
    </div>

    <button class="link-btn" id="switchName">Not ${escapeHtml(myName)}? Switch name</button>
    <button class="link-btn" id="backBtn">← back to role select</button>
  `;

  root.querySelectorAll(".bay-tile").forEach((btn) => {
    btn.onclick = () => checkIn(parseInt(btn.dataset.bay, 10));
  });
  const coBtn = document.getElementById("checkOutBtn");
  if (coBtn) coBtn.onclick = checkOut;
  document.getElementById("switchName").onclick = () => setMyName("");
  document.getElementById("backBtn").onclick = signOutRole;
}

function renderAdmin() {
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

  root.innerHTML = `
    <div class="header">
      <div class="header-badge">🛟</div>
      <div>
        <div class="header-title">Admin Dashboard</div>
        <div class="header-sub">10:00 AM – 6:00 PM</div>
      </div>
    </div>
    <div id="adminBays">${bayCards}</div>
    <button class="link-btn" id="backBtn">← sign out of admin</button>
  `;

  root.querySelectorAll("[data-toggle-bay]").forEach((btn) => {
    btn.onclick = () => toggleBayOpen(parseInt(btn.dataset.toggleBay, 10));
  });
  root.querySelectorAll("[data-toggle-pos]").forEach((btn) => {
    btn.onclick = () => {
      const [bayId, posId] = btn.dataset.togglePos.split("|");
      togglePositionOn(parseInt(bayId, 10), posId);
    };
  });
  root.querySelectorAll("[data-set-hours]").forEach((sel) => {
    sel.onchange = () => {
      const [bayId, posId] = sel.dataset.setHours.split("|");
      setPositionHours(parseInt(bayId, 10), posId, sel.value);
    };
  });
  root.querySelectorAll("[data-move-guard]").forEach((sel) => {
    sel.onchange = () => {
      if (sel.value) adminMoveGuard(sel.dataset.moveGuard, parseInt(sel.value, 10));
      sel.value = "";
    };
  });
  document.getElementById("backBtn").onclick = signOutRole;
}

// ---------------- boot ----------------
(async function boot() {
  await seedBaysIfNeeded();
  listenBays();
  listenEvents();
  setInterval(render, 30000); // keep elapsed-time displays fresh
})();
