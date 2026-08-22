/**
 * GuardAI — entitlement state machine.
 * ---------------------------------------------------------------------------
 * The one place that decides whether GuardAI is allowed to run. Everything
 * else — the worker, the popup, the content script — reads that decision; none
 * of them re-derives it.
 *
 * This file is deliberately pure: no chrome.*, no fetch, no Date.now() except
 * as a default argument. It takes the previous record and one outcome, and
 * returns the next record. That makes every rule below directly testable, and
 * it means the rules cannot be quietly bent by whatever the network happened
 * to do.
 *
 * ═══ THE DESIGN ═══════════════════════════════════════════════════════════
 *
 * LOCKED IS THE ABSENCE OF A RECORD, NOT A VALUE. There is no `status:
 * "locked"`. A device is locked because it has never held an entitlement, or
 * because its record was swept away after hardStopAt passed. This is the whole
 * safety argument: no error path can produce "locked", because no error path
 * writes a record at all. Fail-open is structural rather than maintained.
 *
 * The corollary is that enforcement still works. Granting a record requires a
 * successful, authenticated round-trip to the server. You cannot fail-open
 * into a state you were never granted — going offline before you have ever
 * activated leaves you locked, because there is nothing to fall back to.
 *
 * ONLY AN ANSWER CHANGES THE ANSWER. A network error, a timeout, a 5xx, an
 * unparseable body — these are not the server saying no, they are the server
 * saying nothing. They may record that they happened (lastError) and nothing
 * else. The only thing that downgrades an entitlement is a 200 response whose
 * body explicitly says the licence is not valid.
 *
 * hardStopAt IS THE ONLY FIELD THE GATE READS. `status` exists for the UI.
 * The content script's entire check is one comparison against hardStopAt, so
 * there is no second copy of this state machine to drift out of step, and a
 * service worker that never wakes cannot keep an expired licence alive.
 * null means "never expires" and is reserved for review builds.
 * ---------------------------------------------------------------------------
 */

export const DAY_MS = 86400000;

/** How long a licence keeps working past its paid-through date. Covers a
 *  failed card, a billing outage, and a fortnight on a plane. */
export const GRACE_MS = 14 * DAY_MS;

/** Installs that predate the gate keep working this long, warned, so that an
 *  update never reads as a broken extension. */
export const GRANDFATHER_MS = 14 * DAY_MS;

/** A company connection is trusted for this long before it is re-checked. */
export const COMPANY_INITIAL_MS = 30 * DAY_MS;

/** Re-verify no more often than this. */
export const REFRESH_AFTER_MS = DAY_MS;

const COMPANY_PREFIX = "GA-";
const LICENCE_PREFIX = "GK-";

/**
 * Work out which kind of code this is from its prefix, so the user only ever
 * sees one field and never has to know which sort of customer they are.
 * @returns {{kind: "company"|"individual", code: string}|null}
 */
export function parseCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (code.length <= 3) return null;
  if (code.startsWith(COMPANY_PREFIX)) return { kind: "company", code };
  if (code.startsWith(LICENCE_PREFIX)) return { kind: "individual", code };
  return null;
}

/**
 * The gate. One comparison, mirrored verbatim in content.js — keep them
 * identical, and keep them this short.
 */
export function isUnlocked(rec, now = Date.now()) {
  if (!rec) return false;
  if (rec.hardStopAt === null || rec.hardStopAt === undefined) return true;
  return now < rec.hardStopAt;
}

/** Drop a record that has run out. Returns null for "locked". */
export function sweep(rec, now = Date.now()) {
  return isUnlocked(rec, now) ? rec : null;
}

/**
 * Should we phone home? Only for records that can actually expire and that
 * have something to ask about. Review builds (hardStopAt null) and
 * grandfathered installs (no token) never contact the server at all.
 */
export function needsRefresh(rec, now = Date.now()) {
  if (!rec || !rec.token) return false;
  if (rec.hardStopAt === null || rec.hardStopAt === undefined) return false;
  return now - (rec.lastVerifiedAt || 0) >= REFRESH_AFTER_MS;
}

/**
 * The four-state view, for UI only. `grace` is derived rather than stored
 * because it is a fact about elapsed time, and a stored copy would be wrong
 * the moment it was written.
 */
export function describe(rec, now = Date.now()) {
  if (!isUnlocked(rec, now)) return "locked";
  if (rec.status === "warned") return "warned";
  if (rec.hardStopAt === null || rec.hardStopAt === undefined) return "active";
  if (now - (rec.lastVerifiedAt || 0) >= REFRESH_AFTER_MS) return "grace";
  return "active";
}

/**
 * Fold one outcome into the record. The three branches below are the whole
 * policy; see the invariants in the header.
 *
 * @param {object|null} prev    current record, or null if locked
 * @param {{result: "valid"|"invalid"|"error", ...}} outcome
 */
export function decide(prev, outcome, now = Date.now()) {
  const o = outcome && typeof outcome === "object" ? outcome : { result: "error", reason: "malformed" };

  // ── 1. Silence is not a no. ──────────────────────────────────────────────
  // Never grants, never revokes, never moves a deadline. A locked device
  // stays locked (an error cannot activate anything); an active device stays
  // exactly as active as it was, which is the point of the whole design.
  if (o.result === "error") {
    if (!prev) return null;
    return { ...prev, lastError: String(o.reason || "network") };
  }

  // ── 2. A verified licence resets everything. ─────────────────────────────
  // Including a warning: this is what re-subscribing looks like.
  if (o.result === "valid") {
    const validUntil = Number.isFinite(o.validUntil) ? o.validUntil : null;
    return {
      status: "active",
      kind: o.kind || "individual",
      token: o.token || (prev && prev.token) || null,
      validUntil,
      hardStopAt: validUntil === null ? null : validUntil + GRACE_MS,
      lastVerifiedAt: now,
      lastError: null,
    };
  }

  // ── 3. An explicit refusal warns ONCE. ───────────────────────────────────
  // Warning starts a 14-day countdown rather than cutting someone off
  // mid-message. The `already warned` branch matters: without it, a server
  // repeating "invalid" every 24 hours would reset the countdown every 24
  // hours, and the licence would never actually end.
  if (o.result === "invalid") {
    if (!prev) return null;
    if (prev.status === "warned") {
      return { ...prev, lastVerifiedAt: now, lastError: null };
    }
    return {
      ...prev,
      status: "warned",
      hardStopAt: now + GRACE_MS,
      lastVerifiedAt: now,
      lastError: null,
    };
  }

  return prev || null;
}

/**
 * An install that predates the gate. Warned rather than active, so the popup
 * explains what changed, but fully working for a fortnight.
 */
export function grandfathered(now = Date.now()) {
  return {
    status: "warned",
    kind: "legacy",
    token: null,
    validUntil: null,
    hardStopAt: now + GRANDFATHER_MS,
    lastVerifiedAt: 0,
    lastError: null,
  };
}

/**
 * An install that was already connected to a company before the gate existed,
 * and a freshly redeemed invite code. Trusted for 30 days; the employee is not
 * the one who pays, so they must never be the one who gets locked out.
 */
export function companyGrant(now = Date.now()) {
  const validUntil = now + COMPANY_INITIAL_MS;
  return {
    status: "active",
    kind: "company",
    token: null,
    validUntil,
    hardStopAt: validUntil + GRACE_MS,
    lastVerifiedAt: now,
    lastError: null,
  };
}
