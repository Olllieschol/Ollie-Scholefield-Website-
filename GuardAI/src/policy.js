/**
 * Guard4AI — company scanning policy.
 * ---------------------------------------------------------------------------
 * The one place that decides which of a user's own switches their employer has
 * pinned. Everything else — the worker, the popup, the settings page, the
 * content script — reads that decision; none of them re-derives it.
 *
 * Pure, for the same reason src/entitlement.js is pure: no chrome.*, no fetch,
 * no Date.now() except as a default argument. Every rule below is therefore
 * directly testable, and none of them can be quietly bent by whatever the
 * network happened to do.
 *
 * ═══ THIS FAILS THE OTHER WAY FROM entitlement.js ═════════════════════════
 *
 * Read that file first if you have not. Its governing rule is "only an answer
 * changes the answer", and it fails OPEN: silence never revokes a licence,
 * because the cost of being wrong is bricking a paying customer's privacy tool
 * during a billing outage.
 *
 * Policy needs the same rule pointed the other way. The cost of being wrong
 * here is a user escaping a control their employer set, and the attack we are
 * actually defending against — blocking our backend — is an engineered
 * silence. So:
 *
 *   SILENCE NEVER RELAXES ENFORCEMENT. A network error, a timeout, a 5xx, an
 *   unparseable body: none of them are the server saying "flexible". They may
 *   record that they happened (lastError) and nothing else. An enforced device
 *   that never hears from us again stays enforced forever. There is no TTL and
 *   no decay, which is the whole reason blocking the domain achieves nothing.
 *
 *   ONLY A 200 SAYING "flexible" RELAXES IT. One path in, one path out, both
 *   requiring an actual answer.
 *
 * ═══ WHAT DOES *NOT* FAIL CLOSED, AND WHY ═════════════════════════════════
 *
 * ENFORCEMENT IS A GRANT, NOT A DEFAULT. A missing or unreadable record is
 * never treated as enforced. That asymmetry is deliberate and it is the single
 * most important safety property in this file, because the failure it prevents
 * is the expensive one: every company seat that predates this feature has no
 * policy record, and a rule that read "no record means enforced" would flip
 * the entire existing customer base to enforced on a background update. There
 * is no ordering, no migration timing and no install-reason check that can go
 * wrong here, because there is no branch that can produce enforcement without
 * a server having said so.
 *
 * The cost is a window: someone who deletes or corrupts the stored record from
 * devtools is unenforced until the next successful poll. That window is small
 * (see POLICY_AFTER_MS in background.js, and every supported page load forces a
 * check), it is self-healing, and it is available only to someone who could
 * equally have disabled the extension outright from chrome://extensions. We
 * are not trying to win against the owner of the machine; we are trying to
 * make the safe setting the default and the unsafe one deliberate.
 *
 * LOCKS ARE COMPUTED, NEVER WRITTEN. effective() below folds the policy over
 * the user's own stored value at read time. The user's key is never
 * overwritten, so when an admin goes back to Flexible everyone's own choice is
 * still there, exactly as they left it.
 * ---------------------------------------------------------------------------
 */

/**
 * The switches that are not categories. Each pins one named setting.
 *
 * Deliberately absent, and they should stay absent: "aggressive name
 * detection" and "always stop on images". Both change how NOISY Guard4AI is,
 * not how protective — aggressive names trades false positives for reach, and
 * the image hard stop only decides whether a screenshot that read CLEAN waits
 * for you. An admin pinning either is tuning someone else's interruptions,
 * which is not what enforcement is for.
 */
export const BASE_LOCKS = Object.freeze(["enabled", "files", "images", "masking"]);

/**
 * A detection category is locked by name, `cat:NAME_PII` and so on.
 *
 * There is deliberately NO list of valid category names here. The server is
 * the only place that has to refuse a bad one, because the server is the only
 * place a lock is written; a lock naming a category this build has never heard
 * of simply never matches anything it renders, which is the same
 * forward-compatible behaviour an unknown base lock already has. Keeping the
 * list in one place instead of three is worth more than a client-side check
 * that can only ever agree with the server or be wrong.
 */
const CAT_LOCK = /^cat:[A-Z][A-Z0-9_]*$/;

/** The lock name that pins one detection category on. */
export function catLock(type) {
  return "cat:" + String(type || "");
}

/** Is this a name a lock is allowed to carry at all? */
export function isLockName(name) {
  return typeof name === "string" && (BASE_LOCKS.includes(name) || CAT_LOCK.test(name));
}

const MODES = Object.freeze(["flexible", "enforced"]);

/**
 * The record written for a company seat that connected before this feature
 * existed, or whose record went missing.
 *
 * version -1 is the point of it: every real answer from the server carries a
 * version of 0 or more, so the first successful poll always wins. It grants
 * nothing and locks nothing; it exists so that "company seat, no policy" is a
 * state the rest of the code never has to reason about.
 */
export function provisional(now = Date.now()) {
  return {
    mode: "flexible",
    locks: {},
    version: -1,
    companyName: null,
    fetchedAt: 0,
    lastError: null,
    provisional: true,
    seededAt: now,
  };
}

/**
 * Validate a `policy` object off the wire. Returns null for anything we cannot
 * fully read, and null is "the server did not answer this question" — never
 * "the server said flexible". decide() relies on that distinction.
 */
export function parsePolicy(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!MODES.includes(raw.mode)) return null;
  if (!Number.isFinite(raw.version)) return null;

  // Only well-formed lock names are carried through, and only an explicit
  // `true` counts. A truthy-but-not-true value is a malformed payload, not a
  // lock, and a name that is neither a base switch nor a `cat:TYPE` is
  // dropped rather than stored — so nothing downstream has to wonder whether
  // an arbitrary string in this object means something.
  const locks = {};
  const src = raw.locks && typeof raw.locks === "object" ? raw.locks : {};
  for (const name of Object.keys(src)) {
    if (src[name] === true && isLockName(name)) locks[name] = true;
  }

  return {
    mode: raw.mode,
    locks,
    version: raw.version,
    companyName: typeof raw.company_name === "string" ? raw.company_name : null,
  };
}

/**
 * Fold one outcome into the record. These three branches are the whole policy;
 * see the invariants in the header.
 *
 * @param {object|null} prev    current record, or null if none is held
 * @param {{result: "policy"|"error", policy?: object, reason?: string}} outcome
 */
export function decide(prev, outcome, now = Date.now()) {
  const o = outcome && typeof outcome === "object" ? outcome : { result: "error", reason: "malformed" };

  // ── 1. Silence is not "flexible". ────────────────────────────────────────
  // Never enforces, never relaxes, never moves a version. An enforced device
  // stays exactly as enforced as it was, which is the point of the whole file.
  if (o.result === "error") {
    if (!prev) return null;
    return { ...prev, lastError: String(o.reason || "network") };
  }

  if (o.result === "policy") {
    const next = parsePolicy(o.policy);

    // A 200 whose body we cannot read is the server failing to answer, not
    // answering. Same branch as a 5xx, deliberately.
    if (!next) {
      if (!prev) return null;
      return { ...prev, lastError: "malformed" };
    }

    // Out-of-order arrival. Two polls can be in flight at once — a page load
    // and the interval timer — and without this the slower one overwrites the
    // newer answer, which on the way out of Enforced silently re-enforces
    // everybody. Equal versions still pass through, so a re-poll refreshes
    // fetchedAt and clears a stale lastError.
    if (prev && Number.isFinite(prev.version) && next.version < prev.version) {
      return prev;
    }

    return {
      mode: next.mode,
      locks: next.locks,
      version: next.version,
      companyName: next.companyName || (prev && prev.companyName) || null,
      fetchedAt: now,
      lastError: null,
    };
  }

  return prev || null;
}

/**
 * Is this switch pinned by an admin?
 *
 * Requires mode === "enforced" AND an explicit lock. A record that is missing,
 * damaged, or provisional locks nothing — see "enforcement is a grant, not a
 * default" in the header.
 */
export function isLocked(pol, name) {
  if (!pol || typeof pol !== "object") return false;
  if (pol.mode !== "enforced") return false;
  if (!pol.locks || typeof pol.locks !== "object") return false;
  return pol.locks[name] === true;
}

/**
 * The value a switch actually has, given what the user chose and what their
 * admin pinned. This is the only function that should ever decide it.
 *
 * A locked switch always reads true: every lock turns protection
 * ON, and there is deliberately no way for an admin to force one OFF. An
 * "enforced" mode that could disable someone's scanning would be a remote
 * kill switch for a privacy tool, which is not a product we are willing to
 * hand anybody, however much an admin might want it.
 */
export function effective(userValue, pol, name) {
  return isLocked(pol, name) ? true : userValue;
}

/**
 * The user's category off-list, with any category their admin pinned removed.
 *
 * This is how a category lock stays inside the "never force a setting OFF"
 * rule. The stored list is an OFF-list, so a lock does not add to it — it
 * takes an entry OUT, which is the direction that turns detection back on.
 * There is no shape of policy that can put a category into someone's off-list.
 *
 * The user's own array is never rewritten; this returns a filtered copy, so
 * the moment a lock is lifted their original choice is still there.
 */
export function effectiveDisabled(userList, pol) {
  const list = Array.isArray(userList) ? userList : [];
  if (!anyLocked(pol)) return list.slice();
  return list.filter((type) => !isLocked(pol, catLock(type)));
}

/** True if anything at all is pinned, for "is this a managed install" UI. */
export function anyLocked(pol) {
  if (!pol || pol.mode !== "enforced" || !pol.locks) return false;
  return Object.keys(pol.locks).some((n) => isLocked(pol, n));
}

/**
 * The line shown under a disabled switch. Named rather than anonymous ("your
 * organisation") wherever we know the name, because a person is entitled to
 * know who set the rule they are subject to.
 */
export function setByLine(pol) {
  if (!anyLocked(pol)) return "";
  const who = pol && pol.companyName ? pol.companyName : "your organisation";
  return "Set by " + who + ".";
}
