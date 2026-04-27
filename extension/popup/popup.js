import { getSettings, saveSettings, getDailyCount } from "../lib/storage.js";
import { isLoggedIn } from "../lib/session.js";
import { fetchStats } from "../lib/render-client.js";

const $ = (id) => document.getElementById(id);

async function init() {
  const settings = await getSettings();

  // Populate fields
  $("enabled-toggle").checked = settings.enabled;
  $("api-key").value = settings.api_key || "";
  $("floor-pct").value = settings.floor_pct;
  $("floor-pct-display").textContent = `${settings.floor_pct}%`;
  $("daily-limit").value = settings.daily_limit;
  $("daily-limit-display").textContent = settings.daily_limit;

  // Session status
  const loggedIn = await isLoggedIn();
  const dot = $("session-dot");
  const text = $("session-text");
  if (loggedIn) {
    dot.className = "dot ok";
    text.textContent = "Vinted session active";
  } else {
    dot.className = "dot error";
    text.textContent = "Not logged in to Vinted.co.uk";
  }

  // Stats
  const sentToday = await getDailyCount();
  $("sent-today").textContent = String(sentToday);
  $("daily-limit-display").textContent = String(settings.daily_limit);

  // Try to get live stats from Render (non-blocking)
  if (settings.api_key) {
    fetchStats({ apiKey: settings.api_key, dailyLimit: settings.daily_limit })
      .then((stats) => {
        if (stats) {
          $("sent-today").textContent = String(stats.messages_sent_today);
          $("daily-limit-display").textContent = String(stats.daily_limit);
        }
      })
      .catch(() => {}); // silently fail — local count is the fallback
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

$("floor-pct").addEventListener("input", (e) => {
  $("floor-pct-display").textContent = `${e.target.value}%`;
});

$("save-btn").addEventListener("click", async () => {
  const patch = {
    enabled: $("enabled-toggle").checked,
    api_key: $("api-key").value.trim(),
    floor_pct: parseInt($("floor-pct").value, 10),
    daily_limit: Math.min(50, Math.max(1, parseInt($("daily-limit").value, 10))),
  };

  await saveSettings(patch);

  const btn = $("save-btn");
  btn.textContent = "Saved";
  btn.style.background = "#166534";
  setTimeout(() => {
    btn.textContent = "Save";
    btn.style.background = "";
  }, 1500);
});

$("poll-btn").addEventListener("click", async () => {
  const btn = $("poll-btn");
  btn.textContent = "Polling...";
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "poll_now" });
    btn.textContent = res?.ok ? "Polled ✓" : "Error";
  } catch {
    btn.textContent = "Error";
  }
  setTimeout(() => {
    btn.textContent = "Poll now";
    btn.disabled = false;
  }, 2000);
});

init();
