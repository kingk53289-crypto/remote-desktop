import RFB from "./vendor/novnc/core/rfb.js";

// State - initialized dynamically based on target count
const state = {
  targets: [],
  connections: [],
  statuses: [],
  expandedSlot: -1,
  reconnectTimers: [],
  credentials: JSON.parse(localStorage.getItem("vnc_credentials") || "{}"),
  authFailed: [],
  pendingAuth: [],
  passwordQueue: [],
  passwordPromptActive: false,
  pendingPasswordResolve: null,
  currentPromptSlotId: -1,
};

// DOM references
const grid = document.getElementById("vnc-grid");
const statusText = document.getElementById("status-text");
const btnGrid = document.getElementById("btn-grid");
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const settingsList = document.getElementById("settings-list");
const passwordModal = document.getElementById("password-modal");
const pwTitle = document.getElementById("pw-title");
const pwUsername = document.getElementById("pw-username");
const pwInput = document.getElementById("pw-input");
const pwSubmit = document.getElementById("pw-submit");
const pwSkip = document.getElementById("pw-skip");
const pwApplyAll = document.getElementById("pw-apply-all");

// SVG icons
const ICON_EXPAND = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M2 0a2 2 0 00-2 2v2h2V2h2V0H2zm10 0h-2v2h2v2h2V2a2 2 0 00-2-2zM0 10v2a2 2 0 002 2h2v-2H2v-2H0zm14 0v2a2 2 0 01-2 2h-2v-2h2v-2h2z"/></svg>';
const ICON_RECONNECT = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M7 1a6 6 0 015.6 3.8l-1.8.7A4 4 0 003 7a4 4 0 004 4 4 4 0 003.5-2H8V7h5v5h-2V9.7A6 6 0 017 13 6 6 0 017 1z"/></svg>';

// ============================================================
// Grid Generation
// ============================================================
function calcGrid(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

function buildGrid(targets) {
  const { cols, rows } = calcGrid(targets.length);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  grid.innerHTML = "";

  targets.forEach((t, i) => {
    const cell = document.createElement("div");
    cell.className = "vnc-cell";
    cell.dataset.slot = i;
    cell.innerHTML = `
      <div class="vnc-label">
        <span class="vnc-dot" data-status="disconnected"></span>
        <span class="vnc-name">${t.name}</span>
      </div>
      <div class="vnc-screen" id="screen-${i}"></div>
      <div class="vnc-overlay" id="overlay-${i}">
        <span class="overlay-text">Disconnected</span>
      </div>
      <div class="vnc-toolbar">
        <button class="tool-btn expand-btn" data-slot="${i}" title="Expand">${ICON_EXPAND}</button>
        <button class="tool-btn reconnect-btn" data-slot="${i}" title="Reconnect">${ICON_RECONNECT}</button>
      </div>`;
    grid.appendChild(cell);
  });

  // Observe screen containers for resize
  ro.disconnect();
  grid.querySelectorAll(".vnc-screen").forEach((el) => ro.observe(el));
}

function initState(n) {
  state.connections = new Array(n).fill(null);
  state.statuses = new Array(n).fill("disconnected");
  state.reconnectTimers = new Array(n).fill(null);
  state.authFailed = new Array(n).fill(false);
  state.pendingAuth = new Array(n).fill(false);
}

// ============================================================
// Init
// ============================================================
async function init() {
  try {
    const res = await fetch("/api/targets");
    const data = await res.json();
    state.targets = data.targets;
  } catch (e) {
    console.error("Failed to load targets:", e);
    return;
  }

  initState(state.targets.length);
  buildGrid(state.targets);
  updateStatusText();
  bindEvents();

  for (let i = 0; i < state.targets.length; i++) {
    connectSlot(i);
  }
}

// ============================================================
// VNC Connection
// ============================================================
function connectSlot(slotId) {
  disconnectSlot(slotId);

  const target = state.targets[slotId];
  if (!target) return;

  const container = document.getElementById(`screen-${slotId}`);
  if (!container) return;

  container.innerHTML = "";
  state.authFailed[slotId] = false;
  state.pendingAuth[slotId] = false;
  setStatus(slotId, "connecting");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/vnc/${slotId}`;

  let rfb;
  try {
    rfb = new RFB(container, wsUrl, {
      scaleViewport: true,
      clipViewport: false,
      shared: true,
      qualityLevel: 1,
      compressionLevel: 9,
    });
  } catch (e) {
    console.error(`[${slotId}] Failed to create RFB:`, e);
    setStatus(slotId, "error");
    scheduleReconnect(slotId);
    return;
  }

  rfb.addEventListener("connect", () => {
    console.log(`[${slotId}] Connected to ${target.name}`);
    state.authFailed[slotId] = false;
    setStatus(slotId, "connected");
    forceRescale(rfb);
  });

  rfb.addEventListener("disconnect", (e) => {
    console.log(`[${slotId}] Disconnected from ${target.name}`, e.detail);
    state.connections[slotId] = null;

    if (state.pendingAuth[slotId]) {
      setStatus(slotId, "auth");
    } else if (state.authFailed[slotId]) {
      setStatus(slotId, "auth");
    } else {
      setStatus(slotId, "disconnected");
      scheduleReconnect(slotId);
    }
  });

  rfb.addEventListener("credentialsrequired", (e) => {
    const types = e.detail ? e.detail.types : [];
    console.log(`[${slotId}] Credentials required for ${target.name}`, types);
    state.pendingAuth[slotId] = true;
    handleCredentials(slotId, rfb, types);
  });

  rfb.addEventListener("securityfailure", (e) => {
    console.warn(`[${slotId}] Security failure for ${target.name}:`, e.detail);
    state.authFailed[slotId] = true;
    delete state.credentials[slotId];
    saveCredentials();
    setStatus(slotId, "auth");
  });

  rfb.addEventListener("desktopname", (e) => {
    const cell = document.querySelector(`.vnc-cell[data-slot="${slotId}"]`);
    if (cell && e.detail && e.detail.name) {
      cell.querySelector(".vnc-name").textContent = target.name;
    }
  });

  rfb.focusOnClick = true;
  state.connections[slotId] = rfb;
}

function disconnectSlot(slotId) {
  clearReconnect(slotId);
  const rfb = state.connections[slotId];
  if (rfb) {
    try { rfb.disconnect(); } catch {}
    state.connections[slotId] = null;
  }
}

async function handleCredentials(slotId, rfb, types) {
  const target = state.targets[slotId];
  const needsUsername = types.includes("username");

  const stored = state.credentials[slotId];
  if (stored && stored.password) {
    state.pendingAuth[slotId] = false;
    const creds = { password: stored.password };
    if (needsUsername && stored.username) creds.username = stored.username;
    try { rfb.sendCredentials(creds); } catch {}
    return;
  }

  try {
    const res = await fetch(`/api/targets/${slotId}/password`);
    const data = await res.json();
    if (data.password) {
      state.pendingAuth[slotId] = false;
      const creds = { password: data.password };
      if (needsUsername && data.username) creds.username = data.username;
      state.credentials[slotId] = { username: data.username || "", password: data.password };
      saveCredentials();
      try { rfb.sendCredentials(creds); } catch {}
      return;
    }
  } catch {}

  const result = await queueCredentialPrompt(slotId, target.name, needsUsername);
  state.pendingAuth[slotId] = false;
  if (result) {
    state.credentials[slotId] = result;
    saveCredentials();
    if (state.connections[slotId] === rfb) {
      const creds = { password: result.password };
      if (needsUsername && result.username) creds.username = result.username;
      try { rfb.sendCredentials(creds); } catch {}
    } else {
      connectSlot(slotId);
    }
  } else {
    state.authFailed[slotId] = true;
    setStatus(slotId, "auth");
  }
}

function queueCredentialPrompt(slotId, targetName, needsUsername) {
  const existing = state.passwordQueue.find((e) => e.slotId === slotId);
  if (existing) {
    return new Promise((resolve) => {
      const oldResolve = existing.resolve;
      existing.resolve = (value) => { oldResolve(null); resolve(value); };
    });
  }
  return new Promise((resolve) => {
    state.passwordQueue.push({ slotId, targetName, needsUsername, resolve });
    processPasswordQueue();
  });
}

function processPasswordQueue() {
  if (state.passwordPromptActive || state.passwordQueue.length === 0) return;

  state.passwordPromptActive = true;
  const { slotId, targetName, needsUsername, resolve } = state.passwordQueue.shift();
  state.currentPromptSlotId = slotId;

  pwTitle.textContent = `${targetName} - Login`;
  pwUsername.value = "";
  pwInput.value = "";
  pwUsername.style.display = needsUsername ? "" : "none";

  passwordModal.classList.remove("hidden");
  if (needsUsername) { pwUsername.focus(); } else { pwInput.focus(); }

  state.pendingPasswordResolve = (value) => {
    resolve(value);
    state.passwordPromptActive = false;
    setTimeout(processPasswordQueue, 100);
  };
}

function scheduleReconnect(slotId) {
  clearReconnect(slotId);
  state.reconnectTimers[slotId] = setTimeout(() => {
    if (state.statuses[slotId] !== "connected" && !state.authFailed[slotId] && !state.pendingAuth[slotId]) {
      console.log(`[${slotId}] Reconnecting...`);
      connectSlot(slotId);
    }
  }, 4000);
}

function clearReconnect(slotId) {
  if (state.reconnectTimers[slotId]) {
    clearTimeout(state.reconnectTimers[slotId]);
    state.reconnectTimers[slotId] = null;
  }
}

// ============================================================
// Status
// ============================================================
function setStatus(slotId, status) {
  state.statuses[slotId] = status;

  const cell = document.querySelector(`.vnc-cell[data-slot="${slotId}"]`);
  if (cell) {
    const dot = cell.querySelector(".vnc-dot");
    if (dot) dot.setAttribute("data-status", status);
  }

  const overlay = document.getElementById(`overlay-${slotId}`);
  if (overlay) {
    overlay.querySelectorAll(".overlay-reconnect").forEach((b) => b.remove());

    if (status === "connected") {
      overlay.classList.add("hidden");
    } else {
      overlay.classList.remove("hidden");
      const text = overlay.querySelector(".overlay-text");
      if (text) {
        const labels = {
          connecting: "Connecting...",
          disconnected: "Disconnected",
          error: "Connection Error",
          auth: "Login Required",
        };
        text.textContent = labels[status] || status;
      }

      if (status === "auth") {
        const btn = document.createElement("button");
        btn.className = "btn btn-primary overlay-reconnect";
        btn.textContent = "Enter Credentials";
        btn.style.marginTop = "12px";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.authFailed[slotId] = false;
          connectSlot(slotId);
        });
        overlay.appendChild(btn);
      }
    }
  }

  updateStatusText();
}

function updateStatusText() {
  const connected = state.statuses.filter((s) => s === "connected").length;
  const total = state.targets.length;
  statusText.textContent = `${connected}/${total} connected`;
}

// ============================================================
// View Management
// ============================================================
function expandSlot(slotId) {
  state.expandedSlot = slotId;
  grid.classList.add("grid-expanded");

  document.querySelectorAll(".vnc-cell").forEach((cell) => {
    cell.classList.remove("expanded");
    if (parseInt(cell.dataset.slot) === slotId) {
      cell.classList.add("expanded");
    }
  });

  const rfb = state.connections[slotId];
  if (rfb) rfb.focus();
  setTimeout(rescaleAll, 50);
}

function collapseToGrid() {
  state.expandedSlot = -1;
  grid.classList.remove("grid-expanded");

  document.querySelectorAll(".vnc-cell").forEach((cell) => {
    cell.classList.remove("expanded");
  });
  setTimeout(rescaleAll, 50);
}

// ============================================================
// Settings
// ============================================================
function openSettings() {
  renderSettings();
  settingsModal.classList.remove("hidden");
}

function closeSettings() {
  settingsModal.classList.add("hidden");
}

function renderSettings() {
  settingsList.innerHTML = state.targets
    .map(
      (t, i) => `
    <div class="settings-target" data-slot="${i}">
      <div class="settings-target-header">
        <input type="text" class="settings-pw-input settings-name" data-slot="${i}"
               value="${t.name}" placeholder="Name" style="font-weight:600;flex:1;">
        <button class="btn btn-sm btn-ghost settings-delete" data-slot="${i}" title="Remove">&times;</button>
      </div>
      <div class="settings-pw-row" style="margin-bottom: 6px;">
        <input type="text" class="settings-pw-input settings-host" data-slot="${i}"
               value="${t.host}" placeholder="Host (IP or hostname)" style="flex:2;">
        <input type="number" class="settings-pw-input settings-port" data-slot="${i}"
               value="${t.port || 5900}" placeholder="Port" style="width:80px;flex:none;">
      </div>
      <div class="settings-pw-row" style="margin-bottom: 6px;">
        <input type="text" class="settings-pw-input settings-username" data-slot="${i}"
               value="${(state.credentials[i] && state.credentials[i].username) || ""}" placeholder="macOS username">
      </div>
      <div class="settings-pw-row">
        <input type="password" class="settings-pw-input settings-password" data-slot="${i}"
               value="${(state.credentials[i] && state.credentials[i].password) || ""}" placeholder="macOS password">
      </div>
    </div>
  `
    )
    .join("");

  // Add target button + Save all button
  settingsList.innerHTML += `
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button id="settings-add" class="btn btn-ghost" style="flex:1;">+ Add Target</button>
      <button id="settings-save-all" class="btn btn-primary" style="flex:1;">Save & Reconnect</button>
    </div>`;

  document.getElementById("settings-add").addEventListener("click", () => {
    state.targets.push({ name: "", host: "", port: 5900 });
    renderSettings();
    // Focus the new name input
    const inputs = settingsList.querySelectorAll(".settings-name");
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById("settings-save-all").addEventListener("click", saveAllSettings);

  settingsList.querySelectorAll(".settings-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slot = parseInt(btn.dataset.slot);
      state.targets.splice(slot, 1);
      // Shift credentials
      const newCreds = {};
      Object.keys(state.credentials).forEach((k) => {
        const ki = parseInt(k);
        if (ki < slot) newCreds[ki] = state.credentials[ki];
        else if (ki > slot) newCreds[ki - 1] = state.credentials[ki];
      });
      state.credentials = newCreds;
      saveCredentials();
      renderSettings();
    });
  });
}

async function saveAllSettings() {
  // Collect all target data from inputs
  const targets = [];
  const slots = settingsList.querySelectorAll(".settings-target");
  slots.forEach((el) => {
    const name = el.querySelector(".settings-name")?.value || "";
    const host = el.querySelector(".settings-host")?.value || "";
    const port = parseInt(el.querySelector(".settings-port")?.value) || 5900;
    const username = el.querySelector(".settings-username")?.value || "";
    const password = el.querySelector(".settings-password")?.value || "";
    targets.push({ name, host, port, username, password });

    // Save credentials locally
    state.credentials[targets.length - 1] = { username, password };
  });

  saveCredentials();

  // Save to server
  try {
    const res = await fetch("/api/targets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
    if (!res.ok) throw new Error("Save failed");
  } catch (e) {
    console.error("Failed to save targets:", e);
    return;
  }

  // Disconnect all existing connections
  for (let i = 0; i < state.connections.length; i++) {
    disconnectSlot(i);
  }

  // Reload targets and rebuild
  state.targets = targets.map((t) => ({ name: t.name, host: t.host, port: t.port }));
  initState(state.targets.length);
  buildGrid(state.targets);
  closeSettings();

  for (let i = 0; i < state.targets.length; i++) {
    connectSlot(i);
  }
}

function saveCredentials() {
  localStorage.setItem("vnc_credentials", JSON.stringify(state.credentials));
}

// ============================================================
// Event Binding
// ============================================================
function bindEvents() {
  btnGrid.addEventListener("click", collapseToGrid);

  btnSettings.addEventListener("click", openSettings);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
  settingsModal.querySelector(".modal-backdrop").addEventListener("click", closeSettings);

  // Use event delegation on grid for dynamically created cells
  grid.addEventListener("click", (e) => {
    const expandBtn = e.target.closest(".expand-btn");
    if (expandBtn) {
      e.stopPropagation();
      const slot = parseInt(expandBtn.dataset.slot);
      if (state.expandedSlot === slot) { collapseToGrid(); } else { expandSlot(slot); }
      return;
    }

    const reconnectBtn = e.target.closest(".reconnect-btn");
    if (reconnectBtn) {
      e.stopPropagation();
      const slot = parseInt(reconnectBtn.dataset.slot);
      state.authFailed[slot] = false;
      connectSlot(slot);
    }
  });

  grid.addEventListener("dblclick", (e) => {
    if (e.target.closest(".vnc-toolbar")) return;
    if (e.target.closest(".overlay-reconnect")) return;
    const cell = e.target.closest(".vnc-cell");
    if (!cell) return;
    const slot = parseInt(cell.dataset.slot);
    if (state.expandedSlot === slot) { collapseToGrid(); } else { expandSlot(slot); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!passwordModal.classList.contains("hidden")) {
        passwordModal.classList.add("hidden");
        if (state.pendingPasswordResolve) {
          state.pendingPasswordResolve(null);
          state.pendingPasswordResolve = null;
        }
      } else if (!settingsModal.classList.contains("hidden")) {
        closeSettings();
      } else if (state.expandedSlot >= 0) {
        collapseToGrid();
      }
    }
  });

  pwSubmit.addEventListener("click", () => {
    passwordModal.classList.add("hidden");
    if (!state.pendingPasswordResolve) return;

    const creds = {
      username: pwUsername.value || "",
      password: pwInput.value || "",
    };
    if (!creds.password) {
      state.pendingPasswordResolve(null);
      state.pendingPasswordResolve = null;
      return;
    }

    if (pwApplyAll.checked && state.passwordQueue.length > 0) {
      const remaining = [...state.passwordQueue];
      state.passwordQueue = [];
      for (const entry of remaining) {
        state.credentials[entry.slotId] = { ...creds };
        state.pendingAuth[entry.slotId] = false;
        entry.resolve(null);
      }
      saveCredentials();
      for (const entry of remaining) {
        connectSlot(entry.slotId);
      }
    }

    state.pendingPasswordResolve(creds);
    state.pendingPasswordResolve = null;
  });

  pwSkip.addEventListener("click", () => {
    passwordModal.classList.add("hidden");
    if (state.pendingPasswordResolve) {
      state.pendingPasswordResolve(null);
      state.pendingPasswordResolve = null;
    }
  });

  pwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); pwSubmit.click(); }
  });

  pwUsername.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); pwInput.focus(); }
  });

  passwordModal.querySelector(".modal-backdrop").addEventListener("click", () => {
    passwordModal.classList.add("hidden");
    if (state.pendingPasswordResolve) {
      state.pendingPasswordResolve(null);
      state.pendingPasswordResolve = null;
    }
  });
}

// ============================================================
// Resize handling
// ============================================================
function forceRescale(rfb) {
  try {
    rfb.scaleViewport = false;
    rfb.scaleViewport = true;
  } catch {}
}

function rescaleAll() {
  for (let i = 0; i < state.connections.length; i++) {
    const rfb = state.connections[i];
    if (rfb) forceRescale(rfb);
  }
}

window.addEventListener("resize", rescaleAll);

const ro = new ResizeObserver(() => rescaleAll());

// ============================================================
// Start
// ============================================================
init();
