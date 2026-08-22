/**
 * Seat lifecycle: a company seat over a year of wall-clock time.
 *
 * ═══ WHY THIS FILE EXISTS ══════════════════════════════════════════════════
 *
 * companyGrant() shipped with token: null. needsRefresh() returns false for a
 * record with no token, so company seats never re-checked anything — and they
 * are not review builds, so hardStopAt was a real date. Every employee on a
 * team plan was locked out on day 45, permanently, with no path back except
 * re-entering the invite code, which mints a SECOND seat. Seat usage doubled
 * every 45 days for a company where nobody had left.
 *
 * It was invisible because no test ran the clock past 44 days. Every suite
 * asserted about a device at T0, or a few days out. The deadline sat 45 days
 * beyond anything anyone measured.
 *
 * So the rule this file exists to enforce: TIME-DEPENDENT STATE IS TESTED BY
 * RUNNING THE CLOCK PAST EVERY BOUNDARY, not by checking it looks right today.
 * Part 2 below refreshes daily for 400 days. If someone reintroduces a grant
 * that cannot renew itself, it fails on day 45 rather than in production.
 *
 * Exit code 1 on any failure.
 */
let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}
const F = (rec, key) => (rec ? rec[key] : undefined);

const DAY = 86400000;
const T0 = Date.parse("2026-03-01T00:00:00Z");
const SEAT = "4f2a9c31-7b60-4e8d-9f15-2c0a6d83be41";

/* ── chrome stub, same shape as test/entitlement.cjs ────────────────────── */
function makeChrome(initial) {
  const storage = Object.assign({}, initial);
  const listeners = { installed: [], startup: [], message: [] };
  return {
    storage, listeners,
    chrome: {
      runtime: {
        onInstalled: { addListener: (f) => listeners.installed.push(f) },
        onStartup:   { addListener: (f) => listeners.startup.push(f) },
        onMessage:   { addListener: (f) => listeners.message.push(f) },
      },
      storage: {
        local: {
          get: async (k) => {
            const o = {};
            for (const kk of (Array.isArray(k) ? k : [k])) if (kk in storage) o[kk] = storage[kk];
            return o;
          },
          set: async (o) => { Object.assign(storage, o); },
          remove: async (k) => { for (const kk of (Array.isArray(k) ? k : [k])) delete storage[kk]; },
        },
      },
    },
  };
}

let loadSeq = 0;
async function loadWorker({ storage = {}, now = T0, fetchImpl } = {}) {
  const env = makeChrome(storage);
  globalThis.chrome = env.chrome;
  const realNow = Date.now;
  env.setClock = (t) => { Date.now = () => t; };
  env.setClock(now);
  env.restoreClock = () => { Date.now = realNow; };
  env.fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    env.fetchCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    if (!fetchImpl) throw new Error("network down");
    return fetchImpl(String(url), JSON.parse(opts.body));
  };
  env.mod = await import("../background.js?seq=" + (++loadSeq));
  return env;
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const seatOk = () => jsonRes(200, { valid: true, company_name: "Northwind Pty Ltd" });

(async () => {
  const E = await import("../src/entitlement.js");

  /* ══ PART 1 — the grant itself ═══════════════════════════════════════ */
  console.log("\n--- 1. a seat carries something to re-check with ---");
  {
    const rec = E.companyGrant(SEAT, T0);
    check(F(rec, "token") === SEAT, "the seat id IS the token", String(F(rec, "token")));
    check(F(rec, "kind") === "company" && F(rec, "status") === "active", "active, kind company");
    check(E.companyGrant(null, T0) === null && E.companyGrant("", T0) === null,
      "no seat id mints no record, rather than one guaranteed to die");
  }
  {
    const rec = E.companyGrant(SEAT, T0);
    check(E.needsRefresh(rec, T0 + 0.5 * DAY) === false, "does not phone home twice in a day");
    for (const d of [1, 29, 44, 45, 100, 400]) {
      check(E.needsRefresh(rec, T0 + d * DAY) === true,
        `still asks to re-check on day ${d} — including after the deadline, which is how a locked device heals`);
    }
  }
  {
    // The deadline is real. This is the bug's mechanism, kept as an assertion
    // so nobody "fixes" the lockout by making seats immortal instead.
    const rec = E.companyGrant(SEAT, T0);
    check(E.isUnlocked(rec, T0 + 43 * DAY), "unrefreshed, still working on day 43");
    check(!E.isUnlocked(rec, T0 + 45 * DAY), "unrefreshed, stops on day 45 — a seat is not immortal");
  }

  /* ══ PART 2 — the regression test: a year of daily refreshes ═════════ */
  console.log("\n--- 2. four hundred days, refreshed daily, never locked ---");
  {
    const env = await loadWorker({
      storage: {
        guardai_company: { employeeId: SEAT, companyName: "Northwind Pty Ltd", connectedAt: T0 },
        guardai_entitlement: E.companyGrant(SEAT, T0),
      },
      fetchImpl: () => seatOk(),
    });
    let lockedOn = null, refreshes = 0;
    for (let d = 1; d <= 400 && lockedOn === null; d++) {
      const now = T0 + d * DAY;
      env.setClock(now);
      const before = env.fetchCalls.length;
      await env.mod.refreshIfStale();
      if (env.fetchCalls.length > before) refreshes++;
      if (!E.isUnlocked(env.storage.guardai_entitlement, now)) lockedOn = d;
    }
    env.restoreClock();
    check(lockedOn === null, "never locked out across 400 days", "locked on day " + lockedOn);
    check(refreshes === 400, "re-checked once per day, not more", String(refreshes));
    check(env.fetchCalls.every((c) => c.url.endsWith("/refresh_company")),
      "every one of them went to refresh_company");
    check(env.fetchCalls.every((c) => c.body.p_employee_id === SEAT),
      "carrying the seat id and nothing else",
      JSON.stringify(env.fetchCalls[0] && env.fetchCalls[0].body));
  }
  {
    // Same year, but the server is down the whole time. Must still not lock
    // before the deadline, and must not survive past it either.
    const env = await loadWorker({
      storage: {
        guardai_company: { employeeId: SEAT, companyName: "N", connectedAt: T0 },
        guardai_entitlement: E.companyGrant(SEAT, T0),
      },
      // no fetchImpl -> every call throws
    });
    for (const d of [1, 10, 43]) {
      env.setClock(T0 + d * DAY);
      await env.mod.refreshIfStale();
      check(E.isUnlocked(env.storage.guardai_entitlement, T0 + d * DAY),
        `offline on day ${d}: still protected, because an outage is not an answer`);
    }
    env.setClock(T0 + 45 * DAY);
    await env.mod.refreshIfStale();
    check(!E.isUnlocked(env.storage.guardai_entitlement, T0 + 45 * DAY),
      "offline past the deadline: 44 days of trust is the limit, not forever");
    env.restoreClock();
  }

  /* ══ PART 3 — healing the records that shipped broken ════════════════ */
  console.log("\n--- 3. installs already carrying a tokenless grant ---");
  {
    const legacy = { ...E.companyGrant(SEAT, T0), token: null }; // what shipped
    const env = await loadWorker({
      storage: {
        guardai_company: { employeeId: SEAT, companyName: "N", connectedAt: T0 },
        guardai_entitlement: legacy,
      },
      now: T0 + 2 * DAY,
      fetchImpl: () => seatOk(),
    });
    check(E.needsRefresh(legacy, T0 + 2 * DAY) === false, "the old record could never refresh");
    await env.mod.refreshIfStale();
    check(env.storage.guardai_entitlement.token === SEAT,
      "the worker adopts the seat id it already had in storage");
    check(env.fetchCalls.length === 1, "and immediately re-checks with it", String(env.fetchCalls.length));
    env.restoreClock();
  }
  {
    // The people this actually strands: already past day 45, extension dark.
    const dead = { ...E.companyGrant(SEAT, T0), token: null };
    const env = await loadWorker({
      storage: {
        guardai_company: { employeeId: SEAT, companyName: "N", connectedAt: T0 },
        guardai_entitlement: dead,
      },
      now: T0 + 60 * DAY,
      fetchImpl: () => seatOk(),
    });
    check(!E.isUnlocked(dead, T0 + 60 * DAY), "starts locked, 60 days in");
    await env.mod.refreshIfStale();
    check(E.isUnlocked(env.storage.guardai_entitlement, T0 + 60 * DAY),
      "ONE successful re-check brings a locked-out employee back, with no code to re-enter");
    env.restoreClock();
  }
  {
    // No connection stored: nothing to adopt, and adopting must not invent one.
    const env = await loadWorker({
      storage: { guardai_entitlement: { ...E.companyGrant(SEAT, T0), token: null } },
      now: T0 + 2 * DAY,
      fetchImpl: () => seatOk(),
    });
    await env.mod.refreshIfStale();
    check(env.storage.guardai_entitlement.token === null, "no seat id in storage, nothing adopted");
    check(env.fetchCalls.length === 0, "and nothing sent");
    env.restoreClock();
  }

  /* ══ PART 4 — what the server is allowed to do to a seat ═════════════ */
  console.log("\n--- 4. the only two answers that end a seat ---");
  for (const [label, body] of [
    ["a removed seat", { valid: false, reason: "SEAT_REMOVED" }],
    ["an unpaid company", { valid: false, reason: "SUBSCRIPTION_INACTIVE" }],
  ]) {
    const env = await loadWorker({
      storage: {
        guardai_company: { employeeId: SEAT, companyName: "N", connectedAt: T0 },
        guardai_entitlement: E.companyGrant(SEAT, T0),
      },
      now: T0 + 2 * DAY,
      fetchImpl: () => jsonRes(200, body),
    });
    await env.mod.refreshIfStale();
    const rec = env.storage.guardai_entitlement;
    check(F(rec, "status") === "warned", `${label}: warns rather than cutting off mid-message`);
    check(E.isUnlocked(rec, T0 + 2 * DAY), `${label}: still protected today`);
    check(!E.isUnlocked(rec, T0 + 17 * DAY), `${label}: gone after the 14-day countdown`);
    env.restoreClock();
  }
  {
    // A server repeating "no" every day must not re-arm the countdown forever.
    const env = await loadWorker({
      storage: {
        guardai_company: { employeeId: SEAT, companyName: "N", connectedAt: T0 },
        guardai_entitlement: E.companyGrant(SEAT, T0),
      },
      fetchImpl: () => jsonRes(200, { valid: false, reason: "SEAT_REMOVED" }),
    });
    for (let d = 2; d <= 30; d++) { env.setClock(T0 + d * DAY); await env.mod.refreshIfStale(); }
    check(!E.isUnlocked(env.storage.guardai_entitlement, T0 + 30 * DAY),
      "a daily refusal cannot keep resetting the grace window and thereby never end");
    env.restoreClock();
  }
  {
    // An individual key must still take the other endpoint.
    const env = await loadWorker({
      storage: {
        guardai_entitlement: {
          status: "active", kind: "individual", token: "tok-9",
          validUntil: T0 + 30 * DAY, hardStopAt: T0 + 44 * DAY,
          lastVerifiedAt: T0, lastError: null,
        },
      },
      now: T0 + 2 * DAY,
      fetchImpl: () => jsonRes(200, { valid: true, valid_until: new Date(T0 + 60 * DAY).toISOString() }),
    });
    await env.mod.refreshIfStale();
    check(env.fetchCalls[0].url.endsWith("/refresh_entitlement"),
      "an individual licence still uses refresh_entitlement");
    check(env.fetchCalls[0].body.p_token === "tok-9" && !("p_employee_id" in env.fetchCalls[0].body),
      "sent as p_token, with no seat id anywhere near it",
      JSON.stringify(env.fetchCalls[0].body));
    env.restoreClock();
  }

  console.log(`\nSEAT-LIFECYCLE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
