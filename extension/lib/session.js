/**
 * session.js — Reads the Vinted access_token_web cookie from the browser.
 *
 * The extension never stores credentials. The user's live browser session
 * is the auth layer. If they haven't visited Vinted recently the token will
 * be expired — we detect that and pause gracefully.
 */

const VINTED_URL = "https://www.vinted.co.uk";
const COOKIE_NAME = "access_token_web";

/**
 * Decode a JWT payload without verifying the signature.
 * We trust the browser's cookie store — no need to verify.
 */
function decodeJwtExpiry(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.exp ? decoded.exp * 1000 : null; // convert to ms
  } catch {
    return null;
  }
}

/**
 * Returns { token, valid: true } if session is active,
 * or { token: null, valid: false, reason } if not.
 */
export async function getSession() {
  const cookie = await chrome.cookies.get({ url: VINTED_URL, name: COOKIE_NAME });

  if (!cookie || !cookie.value) {
    return { token: null, valid: false, reason: "no_cookie" };
  }

  const expiryMs = decodeJwtExpiry(cookie.value);
  if (expiryMs !== null) {
    const msUntilExpiry = expiryMs - Date.now();
    if (msUntilExpiry < 0) {
      return { token: null, valid: false, reason: "token_expired" };
    }
    if (msUntilExpiry < 5 * 60 * 1000) {
      // Within 5 minutes of expiry — still usable but warn
      return { token: cookie.value, valid: true, expiringSoon: true };
    }
  }

  return { token: cookie.value, valid: true };
}

export async function isLoggedIn() {
  const session = await getSession();
  return session.valid;
}
