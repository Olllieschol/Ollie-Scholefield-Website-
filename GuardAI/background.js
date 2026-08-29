/**
 * Guard4AI — background.js  (Manifest V3 service worker, ES module)
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
import {
  decide, needsRefresh, describe, parseCode,
  grandfathered, companyGrant, COMPANY_INITIAL_MS, REFRESH_AFTER_MS,
} from "./src/entitlement.js";
import {
  decide as decidePolicy, provisional as provisionalPolicy,
} from "./src/policy.js";

const STATS_KEY = "guardai_stats";
const COMPANY_KEY = "guardai_company";
const ENT_KEY = "guardai_entitlement";
const POLICY_KEY = "guardai_policy";

/** How long a company seat may go without re-reading its employer's policy.
 *  An admin switching to Enforced must not have to wait a day, and must never
 *  have to ask anyone to restart a browser. */
const POLICY_AFTER_MS = 15 * 60 * 1000;

/** Floor on network attempts, in memory only so it dies with the worker.
 *  A failed check leaves lastVerifiedAt untouched, which is what makes silence
 *  unable to change anything — but it also means needsRefresh() stays true, so
 *  without this a flat network would be retried on every single wakeup. */
const ATTEMPT_FLOOR_MS = 60 * 1000;
let lastAttemptAt = 0;
let inFlight = null;

const DEFAULT_STATS = () => ({
  detected: 0,
  masked: 0,
  sentUnmasked: 0,
  // Attachments. Counted separately from `detected` because a file catch and a
  // message catch are not the same event and averaging them hides both.
  filesChecked: 0,
  filesBlocked: 0,
  platforms: {},
  sessionStart: Date.now(),
});

const DEFAULT_SETTINGS = {
  guardai_enabled: true,
  guardai_masking_enabled: false,
  // Attachment scanning, on by default. Both are read as `!== false`
  // everywhere, so a missing key is already "on" — these are written only so
  // that a person looking at storage can see what the switches are.
  guardai_file_scanning: true,
  guardai_image_scanning: true,
};

/* ------------------------------------------------------------------ *
 * Lifecycle: set sensible defaults on first install; reset session
 * stats whenever the browser starts a fresh session.
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[k] === undefined) toSet[k] = v;
  }
  toSet[STATS_KEY] = DEFAULT_STATS();
  await chrome.storage.local.set(toSet);
  await migrateEntitlement(details && details.reason);
});

chrome.runtime.onStartup.addListener(async () => {
  // New browser session -> fresh stats (mapping table is intentionally kept).
  await chrome.storage.local.set({ [STATS_KEY]: DEFAULT_STATS() });
  refreshIfStale().catch(() => {});
});

/* ------------------------------------------------------------------ *
 * Message handling from content scripts.
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "GUARDAI_STATS") return;

  // Run async work, then respond. Return true to keep the channel open.
  refreshIfStale().catch(() => {});
  recordStats(msg).then((stats) => sendResponse({ ok: true, stats }));
  return true;
});

async function recordStats(msg) {
  const data = await chrome.storage.local.get(STATS_KEY);
  const stats = data[STATS_KEY] || DEFAULT_STATS();

  if (typeof msg.detected === "number") stats.detected += msg.detected;
  if (typeof msg.masked === "number") stats.masked += msg.masked;
  if (typeof msg.sentUnmasked === "number") stats.sentUnmasked += msg.sentUnmasked;
  // A record written before this feature shipped has neither key, so start
  // from zero rather than NaN.
  if (typeof msg.filesChecked === "number") stats.filesChecked = (stats.filesChecked || 0) + msg.filesChecked;
  if (typeof msg.filesBlocked === "number") stats.filesBlocked = (stats.filesBlocked || 0) + msg.filesBlocked;

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
  return "Could not reach Guard4AI. Check your connection and try again.";
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
  // An invite code is the whole of the employee's activation. They are not the
  // one who pays, so redeeming it must unlock the product outright rather than
  // leave them hunting for a second code.
  await writeEntitlement(companyGrant(conn.employeeId));
  // The policy arrives on the same response, so a freshly connected browser is
  // never in the "company seat with no policy" state at all. An older backend
  // that does not send one leaves this null, and the first poll fills it in.
  await applyPolicyOutcome(
    payload.policy
      ? { result: "policy", policy: { ...payload.policy, company_name: conn.companyName } }
      : { result: "error", reason: "no-policy-in-response" }
  );
  return conn;
}

/**
 * Hand the seat back before letting go of it.
 *
 * Deactivating used to be purely local, so a seat stayed occupied on the
 * dashboard forever and a company slowly filled up with people who had left.
 * Nothing else can notice: there is no name, no device, no identity of any
 * kind stored against a seat, so the server cannot work out on its own that
 * this one is finished. Saying so is the only mechanism there is.
 *
 * Deliberately best-effort, and deliberately BEFORE the local wipe. A server
 * that is down, slow, or unreachable must not be able to stop someone
 * deactivating on their own machine, so every failure here is swallowed and
 * the caller carries on. The cost of a dropped release is one leaked seat that
 * an admin can remove by hand; the cost of blocking would be a user who cannot
 * turn the thing off.
 */
async function releaseSeat() {
  if (!isConfigured()) return;
  const conn = await getConnection();
  if (!conn) return;
  try {
    await fetch(rpcUrl("release_seat"), {
      method: "POST",
      headers: rpcHeaders(),
      body: JSON.stringify({ p_employee_id: conn.employeeId }),
    });
  } catch (_) {
    // Offline. The seat stays until an admin clears it.
  }
}

async function disconnectCompany() {
  await releaseSeat();
  // The policy goes with the connection, and it goes FIRST. readPolicy() seeds
  // a record for any install holding a company key, so clearing them the other
  // way round would re-seed the thing we just removed.
  //
  // This is not a bypass. The seat IS the licence: leaving your employer's
  // company takes the entitlement with it, so what is on the other side of
  // this is no product at all rather than an unenforced one.
  await chrome.storage.local.remove(POLICY_KEY);
  await chrome.storage.local.remove(COMPANY_KEY);
  // Leaving your employer's dashboard also ends the entitlement it granted.
  const rec = await readEntitlement();
  if (rec && rec.kind === "company") await writeEntitlement(null);
}


/* ------------------------------------------------------------------ *
 * Entitlement.
 *
 * Guard4AI does nothing until a code has been redeemed. The rules live in
 * src/entitlement.js and are deliberately not repeated here: this half only
 * does the I/O — talk to the server, hand the answer to decide(), store what
 * comes back. If you are looking for the policy, it is not in this file.
 *
 * Note which way the error handling runs. Every catch below produces
 * `{ result: "error" }`, which decide() is contractually unable to turn into a
 * lockout. The only path that can revoke anything is a 200 response that
 * explicitly says the licence is invalid.
 * ------------------------------------------------------------------ */

/**
 * The stored record, expired or not.
 *
 * An expired record is deliberately KEPT rather than deleted. It holds the
 * device token, which is the only thing that can heal the situation: a
 * subscription that renews after a lapse, or a machine whose clock jumped
 * forward and back, both recover on the next refresh instead of forcing the
 * user to dig out their licence key again. Deleting it would throw away the
 * one field that fixes it.
 *
 * Nothing here decides whether the record still counts — isUnlocked() does,
 * from hardStopAt alone.
 *
 * @returns {Promise<object|null>}
 */
async function readEntitlement() {
  const data = await chrome.storage.local.get(ENT_KEY);
  return data[ENT_KEY] || null;
}

async function writeEntitlement(rec) {
  if (!rec) await chrome.storage.local.remove(ENT_KEY);
  else await chrome.storage.local.set({ [ENT_KEY]: rec });
  return rec;
}

/** Fold one outcome in through the state machine and persist the result. */
async function applyOutcome(outcome) {
  const prev = await readEntitlement();
  return writeEntitlement(decide(prev, outcome, Date.now()));
}


/* ------------------------------------------------------------------ *
 * Company scanning policy.
 *
 * The rules live in src/policy.js and are deliberately not repeated here;
 * this half only does the I/O. If you are looking for the policy — for what
 * an error is allowed to change, or for why a missing record is never
 * enforced — it is not in this file.
 *
 * Note that this fails the OPPOSITE way from the entitlement code above it.
 * There, silence must never revoke. Here, silence must never relax. Both are
 * the safe direction for their own question, and they are kept in separate
 * records precisely so that one reducer is never asked to hold two
 * contradictory defaults.
 * ------------------------------------------------------------------ */

/**
 * The stored policy, seeding one if this install is a company seat that has
 * never had it.
 *
 * The seed is the whole answer to "how do we not enforce the entire existing
 * customer base on update". Every seat connected before this feature shipped
 * holds a company key and no policy, so that state has to mean something
 * harmless. It means flexible, at version -1, which every real answer from the
 * server (version 0 or more) outranks.
 *
 * Doing it here rather than in an onInstalled migration is deliberate: a
 * migration has to run before anything reads, and getting that ordering wrong
 * is exactly the mistake that flips everyone to enforced. Seeding on read has
 * no ordering to get wrong.
 */
async function readPolicy() {
  const data = await chrome.storage.local.get([POLICY_KEY, COMPANY_KEY]);
  if (data[POLICY_KEY]) return data[POLICY_KEY];
  if (!data[COMPANY_KEY]) return null;   // individual or unconnected: no policy exists
  const seed = provisionalPolicy(Date.now());
  await chrome.storage.local.set({ [POLICY_KEY]: seed });
  return seed;
}

async function writePolicy(rec) {
  if (!rec) await chrome.storage.local.remove(POLICY_KEY);
  else await chrome.storage.local.set({ [POLICY_KEY]: rec });
  return rec;
}

async function applyPolicyOutcome(outcome) {
  const prev = await readPolicy();
  return writePolicy(decidePolicy(prev, outcome, Date.now()));
}

/**
 * First run after an update. An install that predates the gate keeps working
 * — instantly bricking someone's privacy tool during a background update is
 * indistinguishable from shipping a broken build.
 */
async function migrateEntitlement(reason) {
  const data = await chrome.storage.local.get([ENT_KEY, COMPANY_KEY]);
  if (data[ENT_KEY]) return;      // already decided, leave it alone
  if (reason === "install") return; // genuinely new -> locked, as intended
  const conn = data[COMPANY_KEY];
  await writeEntitlement(
    conn && typeof conn.employeeId === "string"
      ? companyGrant(conn.employeeId)
      : grandfathered(Date.now())
  );
}

/** Turn a PostgREST error into something a person can act on. */
function licenceError(raw) {
  const text = String(raw || "");
  if (text.includes("INVALID_KEY")) return "That licence key was not recognised. Check it and try again.";
  if (text.includes("LICENCE_INACTIVE")) return "That licence is no longer active. Check your subscription.";
  if (text.includes("LICENCE_EXPIRED")) return "That licence has expired.";
  if (text.includes("DEVICE_LIMIT")) return "That licence is already in use on 3 devices. Deactivate one first.";
  return "Could not reach Guard4AI. Check your connection and try again.";
}

/** Supabase returns timestamptz as ISO text, or null for "never expires". */
function parseValidUntil(v) {
  if (v === null || v === undefined) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

async function activateLicence(code) {
  if (!isConfigured()) throw new Error("Activation is not available in this build.");

  let res;
  try {
    res = await fetch(rpcUrl("activate_licence"), {
      method: "POST",
      headers: rpcHeaders(),
      body: JSON.stringify({ p_key: code }),
    });
  } catch (_) {
    throw new Error(licenceError(""));
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(licenceError(payload && (payload.message || payload.hint)));
  if (!payload || typeof payload.token !== "string") throw new Error(licenceError(""));

  return {
    token: payload.token,
    plan: payload.plan === "review" ? "review" : "individual",
    validUntil: parseValidUntil(payload.valid_until),
  };
}

/**
 * The single activation entry point. One field in the UI, routed by prefix,
 * so nobody has to work out which kind of customer they are.
 */
async function activateCode(raw) {
  const parsed = parseCode(raw);
  if (!parsed) {
    throw new Error("That doesn\u2019t look like a Guard4AI code. Company codes start with GA-, licence keys with GK-.");
  }

  if (parsed.kind === "company") {
    const conn = await connectCompany(parsed.code); // grants the entitlement itself
    return { kind: "company", connection: conn };
  }

  const lic = await activateLicence(parsed.code);
  // An individual licence never writes COMPANY_KEY, and recordEvents() only
  // fires when COMPANY_KEY exists. That is the whole of the "individuals
  // report nothing" guarantee: there is no branch to get wrong, because the
  // key the reporting path reads is simply never written.
  await applyOutcome({
    result: "valid",
    kind: lic.plan,
    token: lic.token,
    validUntil: lic.validUntil,
  });
  return { kind: lic.plan };
}

/**
 * Opportunistic re-check. Called whenever the worker happens to be awake;
 * needsRefresh() throttles it to once a day, and returns false outright for
 * review builds and grandfathered installs, which have nothing to ask about.
 */
/**
 * Attach the seat id to a company record issued before it carried one.
 *
 * Company grants used to be written with token: null, which makes
 * needsRefresh() return false for them forever. They therefore never
 * re-checked, and ran out on day 45 with nothing able to renew them. Every
 * install connected before this change holds one of those records.
 *
 * This grants nothing and extends nothing. It only gives an existing record
 * something to ask with, which is what lets a device that has ALREADY locked
 * out heal itself: the next refresh answers "valid", and decide() resets the
 * deadline. A device with no seat id in storage has nothing to adopt and is
 * left exactly as it was.
 */
async function adoptSeatToken(rec) {
  if (!rec || rec.kind !== "company" || rec.token) return rec;
  const conn = await getConnection();
  if (!conn) return rec;
  return writeEntitlement({ ...rec, token: conn.employeeId });
}

/**
 * How long this holder may go between checks.
 *
 * A company seat carries its employer's scanning policy back on the same
 * response, and an admin switching to Enforced must not wait a day for it, so
 * it is polled in minutes. An individual key has no policy to collect, and
 * refresh_entitlement is not free the way refresh_company is: it stamps
 * last_seen_at on every call. Speeding that one up would record more and buy
 * nothing.
 */
function refreshAfterFor(rec) {
  return rec && rec.kind === "company" ? POLICY_AFTER_MS : REFRESH_AFTER_MS;
}

async function refreshIfStale() {
  // One check at a time, and never more than once a minute. A failed check
  // deliberately leaves lastVerifiedAt alone — that is what stops silence
  // changing anything — which also means needsRefresh() stays true until one
  // succeeds. Without a floor, a flat network would be retried on every
  // keystroke batch that woke this worker.
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now - lastAttemptAt < ATTEMPT_FLOOR_MS) return readEntitlement();
  inFlight = doRefresh(now).finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh(now) {
  const rec = await adoptSeatToken(await readEntitlement());
  if (!needsRefresh(rec, now, refreshAfterFor(rec)) || !isConfigured()) return rec;
  lastAttemptAt = now;

  // Two kinds of holder, two endpoints, one contract. A seat is re-checked by
  // its own id; an individual key by the activation token it was given.
  const seat = rec.kind === "company";
  let res;
  try {
    res = await fetch(rpcUrl(seat ? "refresh_company" : "refresh_entitlement"), {
      method: "POST",
      headers: rpcHeaders(),
      // Unchanged, and it must stay unchanged. This one field — an anonymous
      // seat id that already went — is the whole of what leaves the browser.
      // The policy rides back on the response; nothing about it goes out.
      body: JSON.stringify(seat ? { p_employee_id: rec.token } : { p_token: rec.token }),
    });
  } catch (_) {
    if (seat) await applyPolicyOutcome({ result: "error", reason: "network" });
    return applyOutcome({ result: "error", reason: "network" });
  }

  // A 5xx, a 401, a proxy's login page: all of these are the server failing to
  // answer, not answering "no". Fail open on the licence, and hold the last
  // known policy — which is what makes blocking our domain pointless.
  if (!res.ok) {
    if (seat) await applyPolicyOutcome({ result: "error", reason: "http-" + res.status });
    return applyOutcome({ result: "error", reason: "http-" + res.status });
  }

  const payload = await res.json().catch(() => null);
  if (!payload || typeof payload.valid !== "boolean") {
    if (seat) await applyPolicyOutcome({ result: "error", reason: "malformed" });
    return applyOutcome({ result: "error", reason: "malformed" });
  }

  // The policy is folded in before the licence verdict, and on both verdicts.
  // A seat whose subscription has lapsed is still subject to its employer's
  // policy for the fortnight of grace it keeps working through.
  if (seat) {
    await applyPolicyOutcome(
      payload.policy
        ? { result: "policy", policy: payload.policy }
        : { result: "error", reason: "no-policy-in-response" }
    );
  }

  if (!payload.valid) return applyOutcome({ result: "invalid" });

  return applyOutcome({
    result: "valid",
    kind: rec.kind,
    token: rec.token,
    // refresh_company deliberately returns no expiry: how long a seat is
    // trusted between checks is our policy, and it lives in one place.
    validUntil: seat ? Date.now() + COMPANY_INITIAL_MS : parseValidUntil(payload.valid_until),
  });
}

async function entitlementStatus() {
  const rec = await readEntitlement();
  return {
    state: describe(rec, Date.now()),
    record: rec,
    available: isConfigured(),
    // Carried on the same reply the popup and settings page already ask for,
    // so neither needs a second round trip to know what is pinned. They also
    // watch guardai_policy through storage.onChanged, which is what updates
    // them when an admin flips it while the page is open.
    policy: await readPolicy(),
  };
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

    case "GUARDAI_ENTITLEMENT_STATUS":
      // Piggyback the daily re-check on a message we were woken for anyway,
      // which is why this extension needs no "alarms" permission.
      refreshIfStale().catch(() => {});
      entitlementStatus().then((s) => sendResponse({ ok: true, ...s }));
      return true;

    case "GUARDAI_ACTIVATE":
      activateCode(msg.code)
        .then((out) => entitlementStatus().then((s) => sendResponse({ ok: true, ...out, ...s })))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "GUARDAI_OPEN_ACTIVATION":
      // The in-page locked notice cannot open the popup itself, and content
      // scripts have no chrome.tabs, so it asks the worker. Creating a tab
      // needs no "tabs" permission — only reading tab metadata does.
      try { chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") }); } catch (_) {}
      return;

    case "GUARDAI_DEACTIVATE":
      // Release first, then wipe. Unlike disconnectCompany this clears the
      // entitlement whatever kind it is, because it is the settings page's
      // "Deactivate" and an individual licence holder means it too;
      // releaseSeat simply does nothing when there is no seat.
      releaseSeat()
        .then(() => Promise.all([
          writeEntitlement(null),
          chrome.storage.local.remove([COMPANY_KEY, POLICY_KEY]),
        ]))
        .then(() => sendResponse({ ok: true }));
      return true;

    case "GUARDAI_POLICY_SYNC":
      // Sent by a content script as it boots on a supported site. This is the
      // guarantee that matters most: whatever the timer has been doing, you
      // cannot start composing a message under a policy older than this page
      // load. Fire and forget — nothing waits on it, and the result reaches
      // the page through storage.onChanged like every other setting.
      refreshIfStale().catch(() => {});
      return;

    default:
      return;
  }
});

/* ------------------------------------------------------------------ *
 * Exported for tests only.
 *
 * Chrome loads this file as a service worker and never imports it, so these
 * exports have no effect at runtime. They exist so the I/O half above can be
 * driven directly in a test instead of raced through the message channel,
 * where a fire-and-forget refresh would finish after the assertion.
 * ------------------------------------------------------------------ */
export {
  activateCode, refreshIfStale, migrateEntitlement,
  entitlementStatus, readEntitlement, writeEntitlement,
  disconnectCompany, releaseSeat,
  readPolicy, writePolicy, POLICY_AFTER_MS,
};
