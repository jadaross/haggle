/**
 * main-world-trap.js — Runs in the page's MAIN world at document_start.
 *
 * Vinted's frontend signs every /api/v2/* request with x-csrf-token + x-anon-id
 * headers, where the CSRF token lives in JS memory we can't reach from the
 * extension's isolated world. This script wraps window.fetch and XHR before
 * Vinted's bundle loads, so when the app fires its first API call we can
 * sniff the CSRF value out of the outgoing headers and stash it on a DOM
 * attribute the isolated-world content script can read.
 */

(function () {
  if (window.__haggleCsrfTrap) return;
  window.__haggleCsrfTrap = true;

  function captureCsrf(value) {
    if (value && typeof value === "string" && value.length > 8) {
      try { document.documentElement.setAttribute("data-haggle-csrf", value); } catch (_) {}
    }
  }

  function logApi(method, url) {
    if (!url || typeof url !== "string") return;
    if (!/\/api\/v2\/|inbox-notif|\/notifications/i.test(url)) return;
    try { console.log("[haggle-trap]", method, url); } catch (_) {}
  }

  // Wrap fetch
  if (typeof window.fetch === "function") {
    const orig = window.fetch.bind(window);
    window.fetch = function (input, opts) {
      opts = opts || {};
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const h = opts.headers instanceof Headers
          ? Object.fromEntries(opts.headers)
          : (opts.headers || {});
        const csrf = h["x-csrf-token"] || h["X-Csrf-Token"] || h["X-CSRF-Token"];
        if (csrf) captureCsrf(csrf);
        logApi(opts.method || "GET", url);
      } catch (_) { /* never let the trap break the page */ }
      return orig(input, opts);
    };
  }

  // Wrap XHR (capture URL via .open and CSRF via .setRequestHeader)
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__haggleUrl = url; logApi(method, url); } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (name && String(name).toLowerCase() === "x-csrf-token") captureCsrf(value);
      } catch (_) {}
      return origSet.apply(this, arguments);
    };
  } catch (_) {}
})();
