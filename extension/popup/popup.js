import {
  getSettings,
  saveSettings,
  getDailyCount,
  getPendingQueue,
  getLikesLog,
} from "../lib/storage.js";

const $ = (id) => document.getElementById(id);

let currentMode = "auto";
let saveTimer = null;
const EXAMPLE_PRICE = 50; // shown in the floor example line

function discountToFloor(maxDiscountPct) {
  return 100 - maxDiscountPct;
}
function floorToDiscount(floorPct) {
  return 100 - floorPct;
}
function updateFloorExample(maxDiscountPct) {
  const minAccept = (EXAMPLE_PRICE * (100 - maxDiscountPct)) / 100;
  const minStr = Number.isInteger(minAccept) ? `£${minAccept}` : `£${minAccept.toFixed(2)}`;
  $("floor-example").textContent = `On a £${EXAMPLE_PRICE} listing, accept down to ${minStr}`;
}

async function init() {
  // Trigger a passive poll on popup open (debounced in the SW). This refreshes
  // notifications without waiting for the 10-min recurring alarm.
  // Callback form + explicit lastError read swallows Chrome's
  // "Unchecked runtime.lastError" warning when the SW isn't awake yet.
  chrome.runtime.sendMessage({ type: "poll_if_stale" }, () => {
    void chrome.runtime.lastError;
  });

  const settings = await getSettings();
  const pendingQueue = await getPendingQueue();
  const likesLog = await getLikesLog();
  const sentToday = await getDailyCount();

  // Toggle
  $("enabled-toggle").checked = settings.enabled;

  // Mode selector
  currentMode = settings.mode || "auto";
  setActiveMode(currentMode);

  // Discount slider (storage uses globalFloorPct; UI exposes max discount)
  const floor = settings.globalFloorPct || 75;
  const discount = floorToDiscount(floor);
  $("floor-pct").value = discount;
  $("floor-value").textContent = `${discount}% off`;
  updateFloorExample(discount);
  toggleFloorSection(currentMode);

  // Pending banner
  const queueLen = pendingQueue.length;
  const banner = $("pending-banner");
  if (queueLen > 0 && currentMode !== "auto") {
    banner.classList.remove("hidden");
    $("pending-banner-text").textContent =
      `${queueLen} ${queueLen === 1 ? "item needs" : "items need"} review`;
  } else {
    banner.classList.add("hidden");
  }

  // Stats strip
  $("stat-sent").textContent = String(sentToday);
  const negotiating = likesLog.filter((e) => e.agentStatus === "negotiating").length;
  $("stat-negotiating").textContent = String(negotiating);
}

function setActiveMode(mode) {
  document.querySelectorAll(".mode-option").forEach((el) => {
    if (el.dataset.mode === mode) {
      el.classList.add("active");
      el.querySelector("input").checked = true;
    } else {
      el.classList.remove("active");
      el.querySelector("input").checked = false;
    }
  });
}

function toggleFloorSection(mode) {
  const section = $("floor-section");
  if (mode === "manual") section.classList.add("hidden");
  else section.classList.remove("hidden");
}

function debouncedSave(patch, immediate = false) {
  if (saveTimer) clearTimeout(saveTimer);
  if (immediate) {
    saveSettings(patch).then(notifyBackground);
    return;
  }
  saveTimer = setTimeout(() => {
    saveSettings(patch).then(notifyBackground);
  }, 200);
}

function notifyBackground() {
  // Trigger sidebar refresh in any open Vinted tabs
  chrome.runtime.sendMessage({ type: "settings_changed" }, () => {
    void chrome.runtime.lastError;
  });
}

// ── Event listeners ──────────────────────────────────────────────────────────

document.querySelectorAll(".mode-option").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const mode = el.dataset.mode;
    currentMode = mode;
    setActiveMode(mode);
    toggleFloorSection(mode);
    debouncedSave({ mode }, true);
  });
});

$("floor-pct").addEventListener("input", (e) => {
  const discount = parseInt(e.target.value, 10);
  $("floor-value").textContent = `${discount}% off`;
  updateFloorExample(discount);
  debouncedSave({ globalFloorPct: discountToFloor(discount) });
});

$("enabled-toggle").addEventListener("change", (e) => {
  debouncedSave({ enabled: e.target.checked }, true);
});

$("pending-link").addEventListener("click", async (e) => {
  e.preventDefault();
  // Try to open the pending tab in the active Vinted tab; if no Vinted tab, open vinted.co.uk
  const tabs = await chrome.tabs.query({ url: "https://www.vinted.co.uk/*" });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    chrome.tabs.sendMessage(tabs[0].id, { type: "sidebar_navigate", tab: "pending" }, () => {
      void chrome.runtime.lastError;
    });
  } else {
    chrome.tabs.create({ url: "https://www.vinted.co.uk/" });
  }
  window.close();
});

init().catch((e) => console.error("[Haggle popup] init failed:", e));
