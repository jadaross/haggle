/**
 * sidebar.js — Haggle sidebar injected into Vinted pages.
 *
 * Renders inside a Shadow DOM to isolate styles from Vinted's CSS.
 * Communicates with the background service worker via chrome.runtime messages.
 */

(function () {
  "use strict";

  if (document.getElementById("haggle-sidebar-host")) return;

  // ── State ──────────────────────────────────────────────────────────────────

  let state = {
    enabled: false,
    mode: "auto",
    globalFloorPct: 75,
    dailyLimit: 20,
    minDelayMin: 5,
    maxDelayMin: 30,
    apiKey: "",
    pendingQueue: [],
    likesLog: [],
    sentToday: 0,
  };

  let activeTab = "pending";
  let showSettings = false;
  let settingsTab = "floors";
  let showModePicker = false;
  const editingPending = {}; // notifId → boolean
  const EXAMPLE_PRICE = 50;

  function discountToFloor(d) { return 100 - d; }
  function floorToDiscount(f) { return 100 - f; }

  // ── Shadow DOM setup ───────────────────────────────────────────────────────

  // Inject Google Fonts into the host document so fonts cascade into shadow DOM
  if (!document.getElementById("haggle-fonts-link")) {
    const fontLink = document.createElement("link");
    fontLink.id = "haggle-fonts-link";
    fontLink.rel = "stylesheet";
    fontLink.href =
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Sans:wght@400;500;600&display=swap";
    document.head.appendChild(fontLink);
  }

  const host = document.createElement("div");
  host.id = "haggle-sidebar-host";
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    right: "0",
    width: "300px",
    height: "100vh",
    zIndex: "2147483647",
    pointerEvents: "auto",
  });
  document.documentElement.appendChild(host);

  // Push Vinted content left so it doesn't sit under the sidebar
  document.documentElement.style.setProperty("padding-right", "300px");

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = SIDEBAR_CSS();
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.id = "sidebar";
  shadow.appendChild(root);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const AVATAR_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#6366f1"];

  function avatarColor(handle) {
    let hash = 0;
    const s = String(handle || "?");
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function timeAgo(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ── Render: components ──────────────────────────────────────────────────────

  function hIconHtml(size) {
    const r = (size * 0.26).toFixed(2);
    const fs = Math.round(size * 0.54);
    const barH = Math.max(2, Math.round(size * 0.08));
    return `
      <div class="h-icon" style="width:${size}px;height:${size}px;border-radius:${r}px;">
        <span class="h-char" style="font-size:${fs}px;margin-bottom:${barH}px;">h</span>
        <div class="h-bar" style="height:${barH}px;"></div>
      </div>
    `;
  }

  function statusPillHtml(status) {
    const map = {
      queued:      { color: "#60a5fa", bg: "rgba(96,165,250,0.10)" },
      pending:     { color: "#60a5fa", bg: "rgba(96,165,250,0.10)" },
      sent:        { color: "#60a5fa", bg: "rgba(96,165,250,0.10)" },
      negotiating: { color: "#f59e0b", bg: "rgba(245,158,11,0.10)" },
      sold:        { color: "#22c55e", bg: "rgba(34,197,94,0.10)"  },
      skipped:     { color: "#525252", bg: "rgba(82,82,82,0.20)"   },
    };
    const t = map[status] || map.queued;
    return `<span class="status-pill" style="color:${t.color};background:${t.bg};">${escapeHtml(status)}</span>`;
  }

  function renderHeader() {
    const modeLabel = state.mode.toUpperCase();
    const isManual = state.mode === "manual";
    const modeBg = isManual ? "rgba(245,158,11,0.12)" : "rgba(34,197,94,0.10)";
    const modeColor = isManual ? "#f59e0b" : "#22c55e";

    const activeColor = state.enabled ? "#22c55e" : "#525252";
    const activeBg = state.enabled ? "rgba(34,197,94,0.10)" : "rgba(82,82,82,0.20)";
    const activeBorder = state.enabled ? "rgba(34,197,94,0.28)" : "rgba(82,82,82,0.30)";
    const activeText = state.enabled ? "agent active" : "agent off";

    return `
      <header class="sidebar-header">
        <div class="header-left">
          ${hIconHtml(26)}
          <span class="wordmark">haggle</span>
          <button class="mode-badge mode-badge-button" data-action="toggle-mode-picker"
                  style="color:${modeColor};background:${modeBg};">
            ${modeLabel} <span class="mode-caret">▾</span>
          </button>
        </div>
        <div class="agent-active-pill" style="color:${activeColor};background:${activeBg};border-color:${activeBorder};">
          <span class="active-dot" style="background:${activeColor};box-shadow:0 0 4px ${activeColor};"></span>
          ${activeText}
        </div>
      </header>
      ${showModePicker ? renderModePicker() : ""}
    `;
  }

  function renderModePicker() {
    const modes = [
      { id: "auto", label: "Auto", desc: "Acts within your floor" },
      { id: "threshold", label: "Approve below floor", desc: "Asks before going lower" },
      { id: "manual", label: "Manual", desc: "Approve every message" },
    ];
    return `
      <div class="mode-picker-backdrop" data-action="close-mode-picker"></div>
      <div class="mode-picker">
        ${modes.map((m) => `
          <button class="mode-picker-option${state.mode === m.id ? " active" : ""}"
                  data-action="pick-mode" data-mode="${m.id}">
            <div class="mode-radio-dot${state.mode === m.id ? " checked" : ""}"></div>
            <div class="mode-text">
              <span class="mode-label">${escapeHtml(m.label)}</span>
              <span class="mode-desc">${escapeHtml(m.desc)}</span>
            </div>
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderSummary() {
    const pendingCount = state.pendingQueue.length;
    const dayMs = 86_400_000;
    const likesToday = state.likesLog.filter((e) => (e.likedAt || 0) > Date.now() - dayMs).length;
    const earned = state.likesLog
      .filter((e) => e.agentStatus === "sold")
      .reduce((s, e) => s + (e.itemPrice || 0), 0);
    const earnedStr = earned > 0 ? `£${earned.toFixed(0)}` : "—";
    const pendingColor = pendingCount > 0 ? "#f59e0b" : "var(--text)";

    return `
      <div class="summary-strip">
        <div class="summary-col">
          <span class="summary-val" style="color:${pendingColor};">${pendingCount}</span>
          <span class="summary-lbl">PENDING</span>
        </div>
        <div class="summary-col">
          <span class="summary-val">${likesToday}</span>
          <span class="summary-lbl">LIKES TODAY</span>
        </div>
        <div class="summary-col">
          <span class="summary-val" style="color:#22c55e;">${earnedStr}</span>
          <span class="summary-lbl">EARNED</span>
        </div>
      </div>
    `;
  }

  function renderTabsBar() {
    if (showSettings) {
      return `
        <div class="tabs-bar settings-bar">
          <button class="back-btn" data-action="close-settings">← back</button>
          <span class="settings-title">settings</span>
        </div>
      `;
    }
    const pending = state.pendingQueue.length;
    const likesActive = state.likesLog.filter((e) =>
      ["queued", "pending", "sent", "negotiating"].includes(e.agentStatus)
    ).length;
    const done = state.likesLog.filter(
      (e) => e.agentStatus === "sold" || e.agentStatus === "skipped"
    ).length;

    const tabs = [
      { id: "pending", label: `pending${pending > 0 ? ` (${pending})` : ""}` },
      { id: "likes", label: `likes${likesActive > 0 ? ` (${likesActive})` : ""}` },
      { id: "done", label: `done${done > 0 ? ` (${done})` : ""}` },
    ];

    return `
      <div class="tabs-bar">
        ${tabs.map((t) => `
          <button class="tab-btn${activeTab === t.id ? " active" : ""}" data-tab="${t.id}">
            ${escapeHtml(t.label)}
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderPendingTab() {
    if (state.pendingQueue.length === 0) {
      return `
        <div class="empty-state">
          <span class="empty-check">✓</span>
          <span class="empty-label">all clear — nothing pending</span>
        </div>
      `;
    }
    return state.pendingQueue.map((item) => renderQueueCard(item)).join("");
  }

  function renderQueueCard(item) {
    const isEditing = editingPending[item.id] === true;
    const floorGbp = item.floorPrice ? `£${item.floorPrice.toFixed(0)}` : "";
    const banner = item.isBelowFloor ? `
      <div class="below-floor-banner">
        <span>⚠</span>
        <span>agent wants to go below floor${floorGbp ? ` (${floorGbp})` : ""}</span>
      </div>
    ` : item.isFollowup ? `
      <div class="followup-banner">
        <span>↺</span>
        <span>follow-up — buyer already messaged</span>
      </div>
    ` : "";

    const messageBlock = isEditing
      ? `<textarea class="message-textarea" data-item-id="${escapeHtml(item.id)}">${escapeHtml(item.proposedMessage)}</textarea>`
      : `<div class="message-text" data-action="edit-message" data-item-id="${escapeHtml(item.id)}">${escapeHtml(item.proposedMessage)}</div>`;

    const sendLabel = isEditing ? "✓ send edited" : "✓ send";

    return `
      <div class="queue-card${item.isBelowFloor ? " below-floor" : ""}">
        ${banner}
        <div class="card-body">
          <div class="card-top">
            <span class="item-title">${escapeHtml(item.itemTitle)}</span>
            <span class="card-meta">@${escapeHtml(item.buyerHandle)} · £${(item.itemPrice || 0).toFixed(2).replace(/\.00$/, "")}</span>
          </div>
          ${item.reasoning ? `
            <div class="reasoning-chip">
              <span class="reasoning-prefix">agent: </span>${escapeHtml(item.reasoning)}
            </div>
          ` : ""}
          <div class="proposed-label">PROPOSED</div>
          ${messageBlock}
          <div class="card-actions">
            <button class="btn-send" data-action="approve" data-item-id="${escapeHtml(item.id)}">${sendLabel}</button>
            <button class="btn-edit" data-action="toggle-edit" data-item-id="${escapeHtml(item.id)}">edit</button>
            <button class="btn-skip" data-action="skip" data-item-id="${escapeHtml(item.id)}">skip</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderLikesTab() {
    const likes = [...state.likesLog]
      .filter((e) => ["queued", "pending", "sent", "negotiating"].includes(e.agentStatus))
      .sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));

    if (likes.length === 0) {
      return `
        <div class="info-chip">
          <span class="info-prefix">auto: </span>monitoring for new likes every 10 min. Replies go after a 5–30 min delay.
        </div>
        <div class="empty-state">
          <span class="empty-label">no likes yet</span>
        </div>
      `;
    }

    return `
      <div class="info-chip">
        <span class="info-prefix">auto: </span>monitoring for new likes every 10 min. Replies go after a 5–30 min delay.
      </div>
      ${likes.map((e) => renderLikeRow(e)).join("")}
    `;
  }

  function renderLikeRow(event) {
    const handle = event.buyerHandle || "?";
    const initial = handle[0].toUpperCase();
    const color = avatarColor(handle);
    const statusColors = {
      queued: "#60a5fa", pending: "#60a5fa", sent: "#60a5fa",
      negotiating: "#f59e0b", sold: "#22c55e", skipped: "#525252",
    };
    const statusColor = statusColors[event.agentStatus] || "#525252";
    const price = event.itemPrice ? `£${event.itemPrice.toFixed(0)}` : "—";

    return `
      <div class="like-block">
        <div class="like-row">
          <div class="avatar" style="background:${color};">${escapeHtml(initial)}</div>
          <div class="like-info">
            <span class="like-item">${escapeHtml(event.itemTitle || "—")}</span>
            <span class="like-meta">@${escapeHtml(handle)} · ${timeAgo(event.likedAt)}</span>
          </div>
          <div class="like-right">
            <span class="like-price">${price}</span>
            ${statusPillHtml(event.agentStatus)}
          </div>
        </div>
        ${event.agentReasoning ? `
          <div class="reasoning-chip like-reasoning" style="border-left-color:${statusColor};">
            <span class="reasoning-prefix" style="color:${statusColor};">agent: </span>${escapeHtml(event.agentReasoning)}
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderDoneTab() {
    const done = [...state.likesLog]
      .filter((e) => e.agentStatus === "sold" || e.agentStatus === "skipped")
      .sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));

    if (done.length === 0) {
      return `
        <div class="empty-state">
          <span class="empty-label">nothing done yet</span>
        </div>
      `;
    }

    return done.map((e) => `
      <div class="done-card">
        <div class="done-top">
          <span class="item-title">${escapeHtml(e.itemTitle || "—")}</span>
          ${statusPillHtml(e.agentStatus)}
        </div>
        <div class="done-meta">@${escapeHtml(e.buyerHandle || "?")} · ${timeAgo(e.likedAt)}</div>
        <div class="done-price">${e.itemPrice ? `£${e.itemPrice.toFixed(0)}` : "—"}</div>
        ${e.agentReasoning ? `
          <div class="reasoning-chip" style="margin-top:6px;">
            <span class="reasoning-prefix">agent: </span>${escapeHtml(e.agentReasoning)}
          </div>
        ` : ""}
      </div>
    `).join("");
  }

  // ── Render: settings ────────────────────────────────────────────────────────

  function renderSettings() {
    const tabs = [
      { id: "floors", label: "item floors" },
      { id: "mode", label: "agent mode" },
      { id: "limits", label: "limits" },
    ];
    return `
      <div class="settings-tabs-bar">
        ${tabs.map((t) => `
          <button class="settings-tab-btn${settingsTab === t.id ? " active" : ""}" data-settings-tab="${t.id}">
            ${escapeHtml(t.label)}
          </button>
        `).join("")}
      </div>
      <div class="settings-content">
        ${settingsTab === "floors" ? renderFloorSettings() : ""}
        ${settingsTab === "mode" ? renderModeSettings() : ""}
        ${settingsTab === "limits" ? renderLimitsSettings() : ""}
      </div>
    `;
  }

  function renderFloorSettings() {
    const discount = floorToDiscount(state.globalFloorPct);
    const minAccept = (EXAMPLE_PRICE * (100 - discount)) / 100;
    const minStr = Number.isInteger(minAccept) ? `£${minAccept}` : `£${minAccept.toFixed(2)}`;
    return `
      <div class="settings-section">
        <div class="settings-row">
          <div class="settings-label-row">
            <span class="settings-label">Max discount</span>
            <span class="floor-display" id="settings-floor-display">${discount}% off</span>
          </div>
          <input type="range" class="settings-range" id="settings-floor-range"
                 min="0" max="50" step="5" value="${discount}" />
          <div class="range-sub-labels">
            <span>0% strict</span>
            <span>50% flexible</span>
          </div>
        </div>
        <div class="floor-example" id="settings-floor-example">
          On a £${EXAMPLE_PRICE} listing, accept down to ${minStr}
        </div>
        <div class="settings-hint">The agent never accepts an offer below your floor. Per-item overrides coming soon.</div>
        <button class="save-settings-btn" data-action="save-floor">Save</button>
      </div>
    `;
  }

  function renderModeSettings() {
    const modes = [
      { id: "auto", label: "Auto", desc: "Agent acts within your floor. No interruptions." },
      { id: "threshold", label: "Approve below floor", desc: "Auto above floor. Asks you before going lower." },
      { id: "manual", label: "Manual", desc: "Every message needs your approval first." },
    ];
    return `
      <div class="settings-section">
        ${modes.map((m) => `
          <div class="mode-option-card${state.mode === m.id ? " active" : ""}" data-action="set-mode" data-mode="${m.id}">
            <div class="mode-radio-dot${state.mode === m.id ? " checked" : ""}"></div>
            <div class="mode-text">
              <span class="mode-label">${escapeHtml(m.label)}</span>
              <span class="mode-desc">${escapeHtml(m.desc)}</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderLimitsSettings() {
    return `
      <div class="settings-section">
        <div class="settings-row">
          <span class="settings-label">API key</span>
          <input type="password" class="settings-input" id="settings-api-key"
                 placeholder="hgl_live_..." value="${escapeHtml(state.apiKey)}" />
        </div>
        <div class="settings-row">
          <div class="settings-label-row">
            <span class="settings-label">Max messages / day</span>
            <span class="settings-val-display" id="limit-display">${state.dailyLimit}</span>
          </div>
          <input type="range" class="settings-range" id="limit-range"
                 min="1" max="50" value="${state.dailyLimit}" />
        </div>
        <div class="settings-row">
          <div class="settings-label-row">
            <span class="settings-label">Min delay (min)</span>
            <span class="settings-val-display" id="mindelay-display">${state.minDelayMin}</span>
          </div>
          <input type="range" class="settings-range" id="mindelay-range"
                 min="1" max="60" value="${state.minDelayMin}" />
        </div>
        <div class="settings-row">
          <div class="settings-label-row">
            <span class="settings-label">Max delay (min)</span>
            <span class="settings-val-display" id="maxdelay-display">${state.maxDelayMin}</span>
          </div>
          <input type="range" class="settings-range" id="maxdelay-range"
                 min="5" max="180" value="${state.maxDelayMin}" />
        </div>
        <button class="save-settings-btn" data-action="save-limits">Save limits</button>
      </div>
    `;
  }

  function renderFooter() {
    if (showSettings) return "";
    const discount = floorToDiscount(state.globalFloorPct);
    return `
      <footer class="sidebar-footer">
        <span class="footer-info">${discount}% off max · ${state.sentToday}/${state.dailyLimit} msgs</span>
        <button class="footer-settings-btn" data-action="open-settings">⚙ settings</button>
      </footer>
    `;
  }

  function render() {
    const body = showSettings
      ? renderSettings()
      : activeTab === "pending" ? renderPendingTab()
      : activeTab === "likes" ? renderLikesTab()
      : renderDoneTab();

    root.innerHTML = `
      ${renderHeader()}
      ${renderSummary()}
      ${renderTabsBar()}
      <div class="tab-content">${body}</div>
      ${renderFooter()}
    `;
    attachEvents();
  }

  // ── Event wiring ────────────────────────────────────────────────────────────

  function attachEvents() {
    shadow.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        render();
      });
    });

    const openSettingsBtn = shadow.querySelector('[data-action="open-settings"]');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener("click", () => {
        showSettings = true;
        settingsTab = "floors";
        render();
      });
    }

    const closeSettingsBtn = shadow.querySelector('[data-action="close-settings"]');
    if (closeSettingsBtn) {
      closeSettingsBtn.addEventListener("click", () => {
        showSettings = false;
        render();
      });
    }

    shadow.querySelectorAll("[data-settings-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        settingsTab = btn.dataset.settingsTab;
        render();
      });
    });

    // Discount range live display + example
    const floorRange = shadow.querySelector("#settings-floor-range");
    if (floorRange) {
      floorRange.addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        const display = shadow.querySelector("#settings-floor-display");
        if (display) display.textContent = `${v}% off`;
        const example = shadow.querySelector("#settings-floor-example");
        if (example) {
          const minAccept = (EXAMPLE_PRICE * (100 - v)) / 100;
          const minStr = Number.isInteger(minAccept) ? `£${minAccept}` : `£${minAccept.toFixed(2)}`;
          example.textContent = `On a £${EXAMPLE_PRICE} listing, accept down to ${minStr}`;
        }
      });
    }

    // Limits ranges live display
    [
      { range: "#limit-range", display: "#limit-display" },
      { range: "#mindelay-range", display: "#mindelay-display" },
      { range: "#maxdelay-range", display: "#maxdelay-display" },
    ].forEach(({ range, display }) => {
      const r = shadow.querySelector(range);
      const d = shadow.querySelector(display);
      if (r && d) r.addEventListener("input", (e) => (d.textContent = e.target.value));
    });

    // Save floor (UI is max-discount; storage is floorPct = 100 - discount)
    const saveFloorBtn = shadow.querySelector('[data-action="save-floor"]');
    if (saveFloorBtn) {
      saveFloorBtn.addEventListener("click", () => {
        const range = shadow.querySelector("#settings-floor-range");
        const discount = parseInt(range.value, 10);
        const floorPct = discountToFloor(discount);
        chrome.runtime.sendMessage(
          { type: "save_settings", settings: { globalFloorPct: floorPct } },
          () => {
            state.globalFloorPct = floorPct;
            flashSavedButton(saveFloorBtn, "Save");
          }
        );
      });
    }

    // Save limits (incl. API key)
    const saveLimitsBtn = shadow.querySelector('[data-action="save-limits"]');
    if (saveLimitsBtn) {
      saveLimitsBtn.addEventListener("click", () => {
        const apiKey = shadow.querySelector("#settings-api-key").value.trim();
        const dailyLimit = parseInt(shadow.querySelector("#limit-range").value, 10);
        const minDelayMin = parseInt(shadow.querySelector("#mindelay-range").value, 10);
        const maxDelayMin = parseInt(shadow.querySelector("#maxdelay-range").value, 10);
        chrome.runtime.sendMessage(
          {
            type: "save_settings",
            settings: { apiKey, dailyLimit, minDelayMin, maxDelayMin },
          },
          () => {
            state.apiKey = apiKey;
            state.dailyLimit = dailyLimit;
            state.minDelayMin = minDelayMin;
            state.maxDelayMin = maxDelayMin;
            flashSavedButton(saveLimitsBtn, "Save limits");
          }
        );
      });
    }

    // Mode selection (in settings panel)
    shadow.querySelectorAll('[data-action="set-mode"]').forEach((el) => {
      el.addEventListener("click", () => {
        const mode = el.dataset.mode;
        state.mode = mode;
        chrome.runtime.sendMessage({ type: "save_settings", settings: { mode } }, () => {
          render();
        });
      });
    });

    // Header mode picker — toggle on badge click
    const modeBadgeBtn = shadow.querySelector('[data-action="toggle-mode-picker"]');
    if (modeBadgeBtn) {
      modeBadgeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showModePicker = !showModePicker;
        render();
      });
    }

    // Backdrop click closes the picker
    const modeBackdrop = shadow.querySelector('[data-action="close-mode-picker"]');
    if (modeBackdrop) {
      modeBackdrop.addEventListener("click", () => {
        showModePicker = false;
        render();
      });
    }

    // Mode picker option click → save and close
    shadow.querySelectorAll('[data-action="pick-mode"]').forEach((el) => {
      el.addEventListener("click", () => {
        const mode = el.dataset.mode;
        state.mode = mode;
        showModePicker = false;
        chrome.runtime.sendMessage({ type: "save_settings", settings: { mode } }, () => {
          render();
        });
      });
    });

    // Queue card actions
    shadow.querySelectorAll('[data-action="approve"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.itemId;
        const textarea = shadow.querySelector(`textarea[data-item-id="${CSS.escape(id)}"]`);
        const item = state.pendingQueue.find((i) => i.id === id);
        if (!item) return;
        const message = textarea ? textarea.value : item.proposedMessage;
        const original = btn.textContent;
        btn.textContent = "sending...";
        btn.disabled = true;
        chrome.runtime.sendMessage(
          { type: "approve_pending", id, message },
          (result) => {
            if (result?.ok) {
              state.pendingQueue = state.pendingQueue.filter((i) => i.id !== id);
              delete editingPending[id];
              render();
            } else {
              btn.textContent = `error: ${result?.error || "unknown"}`;
              setTimeout(() => {
                btn.textContent = original;
                btn.disabled = false;
              }, 2500);
            }
          }
        );
      });
    });

    shadow.querySelectorAll('[data-action="toggle-edit"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.itemId;
        editingPending[id] = !editingPending[id];
        render();
      });
    });

    shadow.querySelectorAll('[data-action="skip"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.itemId;
        chrome.runtime.sendMessage({ type: "skip_pending", id }, (result) => {
          if (result?.ok) {
            state.pendingQueue = state.pendingQueue.filter((i) => i.id !== id);
            delete editingPending[id];
            render();
          }
        });
      });
    });

    shadow.querySelectorAll('[data-action="edit-message"]').forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.itemId;
        editingPending[id] = true;
        render();
      });
    });
  }

  function flashSavedButton(btn, originalLabel) {
    btn.textContent = "saved ✓";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = originalLabel;
      btn.disabled = false;
    }, 1500);
  }

  // ── Initialize ──────────────────────────────────────────────────────────────

  function loadState() {
    chrome.runtime.sendMessage({ type: "get_sidebar_state" }, (data) => {
      if (data) Object.assign(state, data);
      render();
    });
  }

  loadState();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "sidebar_state_update") {
      Object.assign(state, message.data || {});
      render();
    }
    if (message?.type === "sidebar_navigate") {
      showSettings = false;
      activeTab = message.tab || "pending";
      render();
    }
    return false;
  });

  // ── Embedded CSS ────────────────────────────────────────────────────────────

  function SIDEBAR_CSS() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      :host {
        --bg: #0b0b0b;
        --surface: #141414;
        --surface-2: #1e1e1e;
        --surface-3: #282828;
        --border: rgba(255,255,255,0.07);
        --border-2: rgba(255,255,255,0.13);
        --text: #f0f0f0;
        --text-2: #a3a3a3;
        --text-3: #525252;
        --accent: #22c55e;
      }

      #sidebar {
        width: 300px;
        height: 100vh;
        background: var(--bg);
        color: var(--text);
        display: flex;
        flex-direction: column;
        font-family: 'IBM Plex Sans', -apple-system, sans-serif;
        font-size: 13px;
        border-left: 1px solid var(--border);
        position: relative;
      }

      button, input, textarea, select {
        font-family: inherit;
        font-size: inherit;
      }

      /* Header */
      .sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 13px 14px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
        background: var(--bg);
      }
      .header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .h-icon {
        position: relative;
        background: var(--surface-2);
        border: 1px solid var(--border-2);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        flex-shrink: 0;
      }
      .h-char {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 600;
        color: #f0f0f0;
        line-height: 1;
      }
      .h-bar {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: var(--accent);
      }
      .wordmark {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 600;
        font-size: 14px;
        color: var(--text);
      }
      .mode-badge {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        font-weight: 500;
        padding: 2px 6px;
        border-radius: 3px;
        letter-spacing: 0.04em;
      }
      .mode-badge-button {
        border: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 3px;
      }
      .mode-badge-button:hover { filter: brightness(1.1); }
      .mode-caret {
        font-size: 8px;
        opacity: 0.7;
      }

      /* Mode picker (anchored under header) */
      .mode-picker-backdrop {
        position: absolute;
        inset: 0;
        background: transparent;
        z-index: 5;
      }
      .mode-picker {
        position: absolute;
        top: 47px;
        left: 14px;
        right: 14px;
        background: var(--surface-2);
        border: 1px solid var(--border-2);
        border-radius: 9px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        z-index: 10;
        padding: 4px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .mode-picker-option {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        padding: 8px 10px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 7px;
        cursor: pointer;
        text-align: left;
      }
      .mode-picker-option:hover { background: var(--surface-3); }
      .mode-picker-option.active {
        background: var(--bg);
        border-color: var(--border-2);
      }
      .agent-active-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        border: 1px solid;
        border-radius: 3px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
      }
      .active-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      /* Summary strip */
      .summary-strip {
        display: flex;
        margin: 10px 14px;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 8px;
        flex-shrink: 0;
      }
      .summary-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 9px 0;
        gap: 4px;
        border-right: 1px solid var(--border);
      }
      .summary-col:last-child { border-right: none; }
      .summary-val {
        font-size: 19px;
        font-weight: 600;
        line-height: 1;
        color: var(--text);
      }
      .summary-lbl {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        color: var(--text-3);
        letter-spacing: 0.07em;
      }

      /* Tabs */
      .tabs-bar {
        display: flex;
        border-bottom: 1px solid var(--border);
        padding: 0 14px;
        gap: 6px;
        flex-shrink: 0;
        align-items: center;
      }
      .tabs-bar.settings-bar { gap: 8px; }
      .tab-btn {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 8px 4px 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        color: var(--text-3);
        cursor: pointer;
        margin-bottom: -1px;
      }
      .tab-btn.active {
        color: var(--text);
        border-bottom-color: var(--accent);
      }
      .back-btn {
        background: none;
        border: none;
        padding: 8px 4px 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
        cursor: pointer;
      }
      .back-btn:hover { color: var(--text-2); }
      .settings-title {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        color: var(--text-2);
        padding: 8px 4px 7px;
      }

      /* Tab content */
      .tab-content {
        flex: 1;
        overflow-y: auto;
        padding: 10px 14px;
        scrollbar-width: thin;
        scrollbar-color: var(--surface-3) transparent;
      }
      .tab-content::-webkit-scrollbar { width: 5px; }
      .tab-content::-webkit-scrollbar-track { background: transparent; }
      .tab-content::-webkit-scrollbar-thumb {
        background: var(--surface-3);
        border-radius: 2px;
      }

      /* Empty state */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 140px;
        gap: 8px;
      }
      .empty-check {
        font-size: 22px;
        color: var(--text-3);
      }
      .empty-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px;
        color: var(--text-3);
      }

      /* Queue cards */
      .queue-card {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        margin-bottom: 7px;
        overflow: hidden;
      }
      .queue-card.below-floor { border-color: rgba(245,158,11,0.20); }
      .below-floor-banner {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: rgba(245,158,11,0.07);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: #f59e0b;
      }
      .followup-banner {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: rgba(96,165,250,0.07);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: #60a5fa;
      }
      .card-body {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .card-top {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .item-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--text);
        line-height: 1.3;
      }
      .card-meta {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
      }
      .reasoning-chip {
        background: var(--surface-2);
        border-left: 2px solid rgba(34,197,94,0.28);
        padding: 6px 9px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        font-style: italic;
        color: var(--text-2);
        border-radius: 0 3px 3px 0;
        line-height: 1.45;
      }
      .reasoning-prefix {
        color: var(--accent);
        font-style: normal;
        font-weight: 500;
      }
      .proposed-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        color: var(--text-3);
        letter-spacing: 0.08em;
      }
      .message-text {
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 5px;
        padding: 8px 10px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text);
        cursor: text;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .message-text:hover { border-color: var(--border-2); }
      .message-textarea {
        width: 100%;
        background: var(--surface-2);
        border: 1px solid rgba(34,197,94,0.28);
        border-radius: 5px;
        padding: 8px 10px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text);
        resize: vertical;
        min-height: 80px;
        outline: none;
      }
      .card-actions {
        display: flex;
        gap: 5px;
      }
      .btn-send {
        flex: 1;
        padding: 8px;
        background: var(--accent);
        color: var(--bg);
        border: none;
        border-radius: 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn-send:hover:not(:disabled) { background: #16a34a; }
      .btn-send:disabled { opacity: 0.6; cursor: default; }
      .btn-edit {
        padding: 8px 12px;
        background: var(--surface-2);
        color: var(--text-2);
        border: 1px solid var(--border);
        border-radius: 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        cursor: pointer;
      }
      .btn-edit:hover { border-color: var(--border-2); }
      .btn-skip {
        padding: 8px 12px;
        background: transparent;
        color: var(--text-3);
        border: 1px solid transparent;
        border-radius: 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        cursor: pointer;
      }
      .btn-skip:hover { color: var(--text-2); }

      /* Likes tab */
      .info-chip {
        background: var(--surface-2);
        border-radius: 5px;
        padding: 7px 10px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
        margin-bottom: 10px;
        line-height: 1.4;
      }
      .info-prefix {
        color: var(--accent);
        font-weight: 500;
      }
      .like-block {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 8px 0;
        border-bottom: 1px solid var(--border);
      }
      .like-block:last-of-type { border-bottom: none; }
      .like-row {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 600;
        color: white;
        flex-shrink: 0;
      }
      .like-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .like-item {
        font-size: 12px;
        font-weight: 500;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .like-meta {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
      }
      .like-right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 3px;
        flex-shrink: 0;
      }
      .like-price {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        color: var(--text-2);
      }
      .like-reasoning { margin-left: 41px; }

      /* Status pill */
      .status-pill {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        font-weight: 500;
        padding: 2px 6px;
        border-radius: 3px;
        letter-spacing: 0.04em;
        text-transform: lowercase;
      }

      /* Done cards */
      .done-card {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 7px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .done-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .done-meta {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
      }
      .done-price {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px;
        font-weight: 600;
        color: var(--text);
      }

      /* Footer */
      .sidebar-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--bg);
        border-top: 1px solid var(--border);
        flex-shrink: 0;
      }
      .footer-info {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
      }
      .footer-settings-btn {
        background: none;
        border: none;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--accent);
        cursor: pointer;
        padding: 0;
      }

      /* Settings */
      .settings-tabs-bar {
        display: flex;
        gap: 6px;
        border-bottom: 1px solid var(--border);
        margin: -10px -14px 14px;
        padding: 0 14px;
      }
      .settings-tab-btn {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 8px 4px 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        color: var(--text-3);
        cursor: pointer;
        margin-bottom: -1px;
      }
      .settings-tab-btn.active {
        color: var(--text);
        border-bottom-color: var(--accent);
      }
      .settings-section {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .settings-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .settings-label {
        font-size: 12px;
        font-weight: 500;
        color: var(--text);
      }
      .settings-label-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .settings-val-display {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px;
        font-weight: 600;
        color: var(--accent);
      }
      .floor-display {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 22px;
        font-weight: 600;
        color: var(--accent);
        line-height: 1;
      }
      .floor-example {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
        padding: 7px 10px;
        background: var(--surface-2);
        border-radius: 5px;
        line-height: 1.4;
      }
      .settings-range {
        width: 100%;
        accent-color: var(--accent);
      }
      .range-sub-labels {
        display: flex;
        justify-content: space-between;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        color: var(--text-3);
      }
      .settings-input {
        width: 100%;
        padding: 8px 10px;
        background: var(--surface-2);
        border: 1px solid var(--border-2);
        border-radius: 6px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px;
        color: var(--text);
        outline: none;
      }
      .settings-input:focus { border-color: rgba(34,197,94,0.40); }
      .settings-hint {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
        line-height: 1.45;
      }

      /* Mode option (full card) */
      .mode-option-card {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 9px;
        cursor: pointer;
        transition: background 0.1s, border-color 0.1s;
      }
      .mode-option-card.active {
        background: var(--surface-2);
        border-color: var(--border-2);
      }
      .mode-radio-dot {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 1.5px solid var(--text-3);
        flex-shrink: 0;
        margin-top: 1px;
      }
      .mode-radio-dot.checked {
        border-color: var(--accent);
        background: var(--accent);
      }
      .mode-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .mode-label {
        font-size: 12px;
        font-weight: 500;
        color: var(--text);
      }
      .mode-desc {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        color: var(--text-3);
        line-height: 1.3;
      }
      .save-settings-btn {
        padding: 9px;
        background: var(--accent);
        color: var(--bg);
        border: none;
        border-radius: 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        width: 100%;
      }
      .save-settings-btn:hover:not(:disabled) { background: #16a34a; }
      .save-settings-btn:disabled { opacity: 0.7; cursor: default; }
    `;
  }
})();
