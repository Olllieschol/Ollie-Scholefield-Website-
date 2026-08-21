/**
 * GuardAI — background.js  (Manifest V3 service worker, ES module)
 * ---------------------------------------------------------------------------
 * Coordinates session statistics and storage defaults. It does NO network I/O.
 *
 * Stats live in chrome.storage.local under `guardai_stats`:
 *   {
 *     detected:      total sensitive items seen this session
 *     masked:        total items masked this session
 *     sentUnmasked:  times the user chose "send anyway"
 *     platforms:     { ChatGPT: 3, Claude: 1, ... }  usage counts
 *     sessionStart:  timestamp the current session began
 *   }
 *
 * "Session" = since the browser last started (reset in onStartup).
 * ---------------------------------------------------------------------------
 */

import { buildEventBody, normaliseSite } from "./src/company.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from "./src/company-config.js";

const STATS_KEY = "guardai_stats";
const COMPANY_KEY = "guardai_company";

const DEFAULT_STATS = () => ({
  detected: 0,
  masked: 0,
  sentUnmasked: 0,
  platforms: {},
  sessionStart: Date.now(),
});

const DEFAULT_SETTINGS = {
  guardai_enabled: true,
  guardai_masking_enabled: false,
};

/* ------------------------------------------------------------------ *
 * Lifecycle: set sensible defaults on first install; reset session
 * stats whenever the browser starts a fresh session.
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[k] === undefined) toSet[k] = v;
  }
  toSet[STATS_KEY] = DEFAULT_STATS();
  await chrome.storage.local.set(toSet);
});

chrome.runtime.onStartup.addListener(async () => {
  // New browser session -> fresh stats (mapping table is intentionally kept).
  await chrome.storage.local.set({ [STATS_KEY]: DEFAULT_STATS() });
});

/* ------------------------------------------------------------------ *
 * Message handling from content scripts.
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "GUARDAI_STATS") return;

  // Run async work, then respond. Return true to keep the channel open.
  recordStats(msg).then((stats) => sendResponse({ ok: true, stats }));
  return true;
});

async function recordStats(msg) {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || DEFAULT_STATS();

  if (typeof msg.detected === "number") stats.detected += msg.detected;
  if (typeof msg.masked === "number") stats.masked += msg.masked;
  if (typeof msg.sentUnmasked === "number") stats.sentUnmasked += msg.sentUnmasked;

  if (msg.platform) {
    stats.platforms[msg.platform] = (stats.platforms[msg.platform] || 0) + 1;
  }

  await chrome.storage.local.set({ [STATS_KEY]: stats });
  return stats;
}


/* ------------------------------------------------------------------ *
 * Company reporting.
 *
 * Off unless someone has entered an invite code. When it is on, the only
 * thing that leaves this device is a category, a platform host and a
 * timestamp, one row per masked item. The value that was masked and the
 * message around it never reach this file: content.js sends category
 * strings, and src/company.js refuses to build a body out of anything else.
 * ------------------------------------------------------------------ */

/** @returns {Promise<{employeeId: string, companyName: string}|null>} */
async function getConnection() {
  const data = await chrome.storage.local.get(COMPANY_KEY);
  const conn = data[COMPANY_KEY];
  if (!conn || typeof conn.employeeId !== "string") return null;
  return conn;
}

function rpcUrl(fn) {
  return SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/rpc/" + fn;
}

function rpcHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + SUPABASE_ANON_KEY,
  };
}

/** Turn a PostgREST error into something a person can act on. */
function connectError(raw) {
  const text = String(raw || "");
  if (text.includes("SEAT_LIMIT_REACHED")) {
    return "Your company has reached its 20-seat limit.";
  }
  if (text.includes("INVALID_CODE")) {
    return "That invite code was not recognised. Check it with your admin.";
  }
  return "Could not reach GuardAI. Check your connection and try again.";
}

/**
 * Redeem an invite code and remember the anonymous employee id it returns.
 * Rejects with a human-readable message; callers surface it verbatim.
 */
async function connectCompany(code) {
  if (!isConfigured()) throw new Error("Company accounts are not available in this build.");
  if (typeof code !== "string" || !code.trim()) throw new Error("Enter your invite code.");

  let res;
  try {
    res = await fetch(rpcUrl("connect_company"), {
      method: "POST",
      headers: rpcHeaders(),
      body: JSON.stringify({ p_code: code.trim().toUpperCase() }),
    });
  } catch (_) {
    throw new Error(connectError(""));
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(connectError(payload && (payload.message || payload.hint)));
  if (!payload || typeof payload.employee_id !== "string") throw new Error(connectError(""));

  const conn = {
    employeeId: payload.employee_id,
    companyName: String(payload.company_name || "your company"),
    connectedAt: Date.now(),
  };
  await chrome.storage.local.set({ [COMPANY_KEY]: conn });
  return conn;
}

async function disconnectCompany() {
  await chrome.storage.local.remove(COMPANY_KEY);
}

/**
 * Report one masked item per category. Each body is rebuilt from scratch by
 * src/company.js, which returns null for anything it cannot verify; a null is
 * skipped rather than sent. Failures are silent by design: a company dashboard
 * being unreachable must never interrupt masking, which is the actual product.
 */
async function recordEvents(categories, hostname) {
  if (!isConfigured()) return;
  if (!Array.isArray(categories) || !categories.length) return;

  const conn = await getConnection();
  if (!conn) return;

  const site = normaliseSite(hostname);
  if (!site) return;

  for (const category of categories) {
    const body = buildEventBody(conn.employeeId, category, site);
    if (!body) continue;
    try {
      await fetch(rpcUrl("record_event"), {
        method: "POST",
        headers: rpcHeaders(),
        body: JSON.stringify(body),
      });
    } catch (_) {
      return; // offline: drop the rest of this batch rather than spin
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "GUARDAI_COMPANY_EVENTS":
      // Only ever reads these two fields off the message. Anything else the
      // sender attached is ignored rather than forwarded.
      recordEvents(msg.categories, msg.site);
      return; // fire and forget

    case "GUARDAI_COMPANY_STATUS":
      getConnection().then((conn) => sendResponse({ ok: true, connection: conn, available: isConfigured() }));
      return true;

    case "GUARDAI_COMPANY_CONNECT":
      connectCompany(msg.code)
        .then((conn) => sendResponse({ ok: true, connection: conn }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "GUARDAI_COMPANY_DISCONNECT":
      disconnectCompany().then(() => sendResponse({ ok: true }));
      return true;

    default:
      return;
  }
});
