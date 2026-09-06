/**
 * Entitlement: the licence gate's state machine and the worker that drives it.
 *
 * ═══ WHAT THIS FILE IS DEFENDING ═══════════════════════════════════════════
 *
 * GuardAI is a privacy tool. The failure that matters is not someone using it
 * unpaid — it is someone who HAS paid quietly losing protection at the moment
 * they paste a tax file number into ChatGPT, because a card expired, a server
 * 500'd, or they were on a plane. A billing outage must never become a privacy
 * incident.
 *
 * So the design makes fail-open structural rather than maintained: "locked" is
 * the ABSENCE of a record, and no error path writes a record. There is no line
 * of code to accidentally delete that would turn an outage into a lockout,
 * because there is no line of code that could ever do it.
 *
 * The tests below are mostly attempts to violate that. The important ones:
 *
 *   - a simulated Supabase outage mid-session leaves masking running
 *   - a 500, a 401 and a proxy login page are all "no answer", not "no"
 *   - a server that says INVALID every day cannot re-arm the countdown and
 *     thereby keep someone alive forever (the mirror-image bug)
 *   - going offline before ever activating still leaves you locked, so
 *     fail-open costs nothing in enforcement
 *
 * Exit code 1 on any failure.
 */
const assert = require("assert");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/** Field read that survives a null record, so a broken implementation reports
 *  a list of FAILures instead of dying on the first TypeError. A crash tells
 *  you far less than "these nine things went wrong", and run-all.cjs only
 *  surfaces the last 25 lines of a failing suite. */
const F = (rec, key) => (rec ? rec[key] : undefined);

const DAY = 86400000;
const T0 = Date.parse("2026-03-01T00:00:00Z");

/* ── a chrome stub that records what the worker stored ──────────────────── */
function makeChrome(initial) {
  const storage = Object.assign({}, initial);
  const listeners = { installed: [], startup: [], message: [] };
  return {
    storage,
    listeners,
    chrome: {
      runtime: {
        onInstalled: { addListener: (f) => listeners.installed.push(f) },
        onStartup: { addListener: (f) => listeners.startup.push(f) },
        onMessage: { addListener: (f) => listeners.message.push(f) },
      },
      storage: {
        local: {
          get: async (k) => {
            const keys = Array.isArray(k) ? k : [k];
            const o = {};
            for (const kk of keys) if (kk in storage) o[kk] = storage[kk];
            return o;
          },
          set: async (o) => { Object.assign(storage, o); },
          remove: async (k) => { for (const kk of (Array.isArray(k) ? k : [k])) delete storage[kk]; },
        },
      },
    },
  };
}

/** Fresh copy of the worker, with its own chrome stub, clock and fetch. */
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

(async () => {
  /* ══ PART 1 — the pure state machine ═════════════════════════════════ */
  const E = await import("../src/entitlement.js");
  console.log("\n--- 1. silence is not a no ---");

  const active = {
    status: "active", kind: "individual", token: "tok-1",
    validUntil: T0 + 30 * DAY, hardStopAt: T0 + 44 * DAY,
    lastVerifiedAt: T0, lastError: null,
  };

  check(E.decide(null, { result: "error", reason: "network" }, T0) === null,
    "an error on a LOCKED device cannot activate it — fail-open costs nothing in enforcement");

  {
    const after = E.decide(active, { result: "error", reason: "network" }, T0 + 5 * DAY);
    check(F(after, "hardStopAt") === active.hardStopAt && F(after, "status") === "active" &&
          F(after, "validUntil") === active.validUntil && F(after, "lastVerifiedAt") === active.lastVerifiedAt,
      "an error changes NOTHING except lastError — no downgrade, no extension",
      JSON.stringify(after));
    check(F(after, "lastError") === "network", "the error is recorded so the UI can mention it");
  }
  for (const reason of ["network", "http-500", "http-401", "malformed", "timeout"]) {
    const after = E.decide(active, { result: "error", reason }, T0 + DAY);
    check(E.isUnlocked(after, T0 + DAY), `still unlocked after ${reason}`);
  }
  check(F(E.decide(active, null, T0), "hardStopAt") === active.hardStopAt,
    "a malformed outcome (null) is treated as an error, not as a refusal");

  console.log("\n--- 2. a verified licence sets the clock ---");
  {
    const r = E.decide(null, { result: "valid", kind: "individual", token: "t", validUntil: T0 + 30 * DAY }, T0);
    check(F(r, "status") === "active" && F(r, "hardStopAt") === T0 + 44 * DAY,
      "hardStopAt is paid-through + 14 days of grace", String(F(r, "hardStopAt") - T0));
    check(E.isUnlocked(r, T0 + 43 * DAY) && !E.isUnlocked(r, T0 + 44 * DAY),
      "unlocked right up to hardStopAt, locked at it");
  }
  {
    const r = E.decide(null, { result: "valid", kind: "review", token: "t", validUntil: null }, T0);
    check(F(r, "hardStopAt") === null && E.isUnlocked(r, T0 + 3650 * DAY),
      "a review licence never expires — it must survive repeat store reviews for years");
    check(E.needsRefresh(r, T0 + 3650 * DAY) === false,
      "a review licence never phones home either, so it works on a reviewer's blocked network");
  }

  console.log("\n--- 3. an explicit refusal warns, once ---");
  {
    const warned = E.decide(active, { result: "invalid" }, T0 + DAY);
    check(F(warned, "status") === "warned" && F(warned, "hardStopAt") === T0 + DAY + 14 * DAY,
      "a cancelled licence starts a 14-day countdown, it does not cut out mid-message");
    check(E.isUnlocked(warned, T0 + 10 * DAY), "still masking during the warning window");

    // The mirror-image bug: a server repeating "invalid" every day must not
    // reset the countdown every day, or the licence never actually ends.
    let r = warned;
    for (let d = 2; d < 40; d++) r = E.decide(r, { result: "invalid" }, T0 + d * DAY);
    check(r && warned && r.hardStopAt === warned.hardStopAt,
      "38 further refusals do NOT re-arm the countdown",
      r && warned ? String((r.hardStopAt - warned.hardStopAt) / DAY) + " days of drift" : "record went null");
    check(E.sweep(r, T0 + 16 * DAY) === null, "and the countdown does run out");

    const back = E.decide(warned, { result: "valid", kind: "individual", token: "t", validUntil: T0 + 60 * DAY }, T0 + 2 * DAY);
    check(F(back, "status") === "active" && F(back, "hardStopAt") === T0 + 74 * DAY,
      "re-subscribing clears the warning completely");
  }
  check(E.decide(null, { result: "invalid" }, T0) === null,
    "a refusal aimed at a device with no licence is a no-op, not a new record");

  console.log("\n--- 4. derived views ---");
  check(E.describe(null, T0) === "locked", "no record reads as locked");
  check(E.describe(active, T0 + 60 * 60 * 1000) === "active", "recently verified reads as active");
  check(E.describe(active, T0 + 3 * DAY) === "grace", "unverified for 3 days reads as grace");
  check(E.describe({ ...active, status: "warned" }, T0 + 60000) === "warned", "warned reads as warned");
  check(E.describe(E.grandfathered(T0), T0 + 3 * DAY) === "warned",
    "a grandfathered install reads as warned for its whole window, never as grace");
  check(E.needsRefresh(E.grandfathered(T0), T0 + 30 * DAY) === false,
    "a grandfathered install has no token, so it never calls a server that would refuse it");

  console.log("\n--- 5. one field, routed by prefix ---");
  check(E.parseCode("GA-7K2M-QP4X").kind === "company", "GA- is a company invite");
  check(E.parseCode("gk-abcd-efgh-ijkl").kind === "individual", "GK- is a licence key, case-insensitively");
  check(E.parseCode("  GK-ABCD  ").code === "GK-ABCD", "surrounding whitespace is forgiven");
  for (const junk of ["", "hello", "GA-", "GK-", "XX-ABCD-EFGH", null, 42]) {
    check(E.parseCode(junk) === null, `rejected: ${JSON.stringify(junk)}`);
  }

  /* ══ PART 2 — the worker that drives it ══════════════════════════════ */
  console.log("\n--- 6. install and upgrade ---");
  {
    const env = await loadWorker();
    await env.mod.migrateEntitlement("install");
    check(env.storage.guardai_entitlement === undefined,
      "a brand-new install is LOCKED — the gate is real");
    env.restoreClock();
  }
  {
    const env = await loadWorker();
    await env.mod.migrateEntitlement("update");
    const rec = env.storage.guardai_entitlement;
    check(rec && rec.kind === "legacy" && rec.status === "warned",
      "an install that predates the gate is grandfathered, not bricked");
    check(F(rec, "hardStopAt") === T0 + 14 * DAY, "for 14 days", String((F(rec, "hardStopAt") - T0) / DAY));
    env.restoreClock();
  }
  {
    const env = await loadWorker({ storage: { guardai_company: { employeeId: "u", companyName: "Acme" } } });
    await env.mod.migrateEntitlement("update");
    const rec = env.storage.guardai_entitlement;
    check(rec && rec.kind === "company" && rec.status === "active",
      "an already-connected employee keeps working, unwarned — they are not the one who pays");
    env.restoreClock();
  }
  {
    const mine = { status: "active", kind: "individual", token: "t", validUntil: T0, hardStopAt: T0 + DAY, lastVerifiedAt: T0 };
    const env = await loadWorker({ storage: { guardai_entitlement: mine } });
    await env.mod.migrateEntitlement("update");
    check(env.storage.guardai_entitlement === mine, "an existing entitlement is never overwritten by migration");
    env.restoreClock();
  }

  console.log("\n--- 7. activation ---");
  {
    const env = await loadWorker({
      fetchImpl: (url) => url.includes("activate_licence")
        ? jsonRes(200, { token: "11111111-1111-1111-1111-111111111111", plan: "individual", valid_until: "2026-04-01T00:00:00Z" })
        : jsonRes(200, { valid: true }),
    });
    const out = await env.mod.activateCode("gk-abcd-efgh-ijkl");
    check(F(out, "kind") === "individual", "a GK- key activates an individual licence");
    check(F(env.storage.guardai_entitlement, "token") === "11111111-1111-1111-1111-111111111111", "the device token is stored");
    check(env.storage.guardai_company === undefined,
      "AN INDIVIDUAL LICENCE NEVER WRITES guardai_company — which is what makes 'individuals report nothing' structural rather than a branch that could be got wrong");
    check(env.fetchCalls.length > 0 && env.fetchCalls[0].body.p_key === "GK-ABCD-EFGH-IJKL", "the key is normalised before it is sent");
    env.restoreClock();
  }
  {
    const env = await loadWorker({
      fetchImpl: () => jsonRes(200, { employee_id: "22222222-2222-2222-2222-222222222222", company_name: "Acme" }),
    });
    await env.mod.activateCode("GA-7K2M-QP4X", "  Sarah   ", " Chen ");
    check(env.storage.guardai_company !== undefined, "a GA- code still connects to the company");
    check(F(env.storage.guardai_entitlement, "kind") === "company",
      "AND unlocks the product — an employee should never need two things");
    /* The name is the one field typed freely, so the trim is the difference
       between one Sarah Chen and two of her in the seats table. */
    check(env.fetchCalls[0].body.p_first === "Sarah" && env.fetchCalls[0].body.p_last === "Chen",
      "the name is trimmed and whitespace-collapsed before it is sent",
      JSON.stringify([env.fetchCalls[0].body.p_first, env.fetchCalls[0].body.p_last]));
    env.restoreClock();
  }
  {
    /* A seat with no name is a row the admin cannot act on. The worker refuses
       rather than leaving the UI as the only thing standing between a blank
       field and a permanent "Not named". */
    const env = await loadWorker({
      fetchImpl: () => jsonRes(200, { employee_id: "33333333-3333-3333-3333-333333333333", company_name: "Acme" }),
    });
    let threw = null;
    try { await env.mod.activateCode("GA-7K2M-QP4X", "Sarah", "   "); }
    catch (e) { threw = e.message; }
    check(threw && /first and last name/i.test(threw),
      "a workplace code with a blank name is refused by the worker, not just the page", threw);
    check(env.fetchCalls.length === 0, "and no seat is minted for it");
    env.restoreClock();
  }
  {
    /* A personal licence has no seat and no admin to show a name to. Asking
       for one would be collecting a name for nothing. */
    const env = await loadWorker({
      fetchImpl: () => jsonRes(200, { token: "44444444-4444-4444-4444-444444444444", plan: "individual", valid_until: "2026-04-01T00:00:00Z" }),
    });
    const out = await env.mod.activateCode("GK-ABCD-EFGH-IJKL");
    check(F(out, "kind") === "individual", "a personal key still activates with no name at all");
    check(!("p_first" in env.fetchCalls[0].body), "and no name is sent with it");
    env.restoreClock();
  }
  {
    const env = await loadWorker();
    let msg = "";
    await env.mod.activateCode("banana").catch((e) => { msg = e.message; });
    check(/GA-|GK-/.test(msg), "junk is refused with a message that says what a code looks like", msg);
    check(env.fetchCalls.length === 0, "and is not sent to the server at all");
    check(env.storage.guardai_entitlement === undefined, "still locked");
    env.restoreClock();
  }
  {
    const env = await loadWorker(); // fetch throws
    let msg = "";
    await env.mod.activateCode("GK-ABCD-EFGH-IJKL").catch((e) => { msg = e.message; });
    check(/connection/i.test(msg), "activating while offline reports a connection problem", msg);
    check(env.storage.guardai_entitlement === undefined,
      "and does NOT grant anything — first activation genuinely requires the server");
    env.restoreClock();
  }
  {
    const env = await loadWorker({ fetchImpl: () => jsonRes(400, { message: "DEVICE_LIMIT" }) });
    let msg = "";
    await env.mod.activateCode("GK-ABCD-EFGH-IJKL").catch((e) => { msg = e.message; });
    check(msg.includes("3 devices"), "the seat limit explains itself", msg);
    env.restoreClock();
  }

  console.log("\n--- 8. THE ONE THAT MATTERS: outages never stop masking ---");
  const staleActive = {
    status: "active", kind: "individual", token: "33333333-3333-3333-3333-333333333333",
    validUntil: T0 + 30 * DAY, hardStopAt: T0 + 44 * DAY, lastVerifiedAt: T0, lastError: null,
  };
  for (const [label, impl] of [
    ["Supabase unreachable", null],
    ["Supabase 500", () => jsonRes(500, { message: "boom" })],
    ["auth rejected (401)", () => jsonRes(401, { message: "bad key" })],
    ["captive portal returns HTML", () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })],
    ["nonsense body", () => jsonRes(200, { hello: "world" })],
  ]) {
    const env = await loadWorker({
      storage: { guardai_entitlement: { ...staleActive } },
      now: T0 + 3 * DAY,
      fetchImpl: impl,
    });
    const rec = await env.mod.refreshIfStale();
    check(rec !== null && rec.hardStopAt === staleActive.hardStopAt && rec.status === "active",
      `${label}: entitlement untouched, masking continues`,
      rec ? "hardStopAt moved by " + (rec.hardStopAt - staleActive.hardStopAt) : "LOCKED OUT");
    check(F(env.storage.guardai_entitlement, "hardStopAt") === staleActive.hardStopAt,
      `${label}: and the stored record was not damaged either`);
    env.restoreClock();
  }
  {
    // Twelve days of continuous outage, re-checking every day.
    const env = await loadWorker({ storage: { guardai_entitlement: { ...staleActive } }, now: T0 });
    for (let d = 1; d <= 12; d++) { env.setClock(T0 + d * DAY); await env.mod.refreshIfStale(); }
    const rec = await env.mod.readEntitlement();
    check(rec !== null, "twelve straight days of outage still leaves the user protected");
    check(F(rec, "hardStopAt") === staleActive.hardStopAt, "with the original deadline intact");
    env.restoreClock();
  }

  console.log("\n--- 9. only an answer changes the answer ---");
  {
    const env = await loadWorker({
      storage: { guardai_entitlement: { ...staleActive } },
      now: T0 + 3 * DAY,
      fetchImpl: () => jsonRes(200, { valid: false }),
    });
    const rec = await env.mod.refreshIfStale();
    check(F(rec, "status") === "warned", "an explicit 'not valid' is the only thing that downgrades");
    check(F(rec, "hardStopAt") === T0 + 3 * DAY + 14 * DAY, "and it still buys 14 days");
    env.restoreClock();
  }
  {
    const env = await loadWorker({
      storage: { guardai_entitlement: { ...staleActive } },
      now: T0 + 3 * DAY,
      fetchImpl: () => jsonRes(200, { valid: true, plan: "individual", valid_until: "2026-05-01T00:00:00Z" }),
    });
    const rec = await env.mod.refreshIfStale();
    check(F(rec, "status") === "active" && F(rec, "validUntil") === Date.parse("2026-05-01T00:00:00Z"),
      "a renewal pushes the date out");
    env.restoreClock();
  }
  {
    const env = await loadWorker({ storage: { guardai_entitlement: { ...staleActive } }, now: T0 + 60 * 1000 });
    await env.mod.refreshIfStale();
    check(env.fetchCalls.length === 0, "a licence verified a minute ago is not re-checked (throttled to daily)");
    env.restoreClock();
  }
  {
    // An expired record is KEPT, not deleted. It holds the token, which is the
    // only thing that can heal a lapse — deleting it would make a renewed
    // subscription, or a clock that jumped forward and back, require the user
    // to dig out their licence key again.
    const expired = { ...staleActive, hardStopAt: T0 + DAY };
    const env = await loadWorker({
      storage: { guardai_entitlement: { ...expired } },
      now: T0 + 2 * DAY,
      fetchImpl: () => jsonRes(200, { valid: true, plan: "individual", valid_until: "2026-06-01T00:00:00Z" }),
    });
    check(E.isUnlocked(await env.mod.readEntitlement(), T0 + 2 * DAY) === false,
      "an expired record does not unlock anything");
    const healed = await env.mod.refreshIfStale();
    check(E.isUnlocked(healed, T0 + 2 * DAY),
      "but its token heals it the moment the server says the licence is good again — a renewal just starts working");
    env.restoreClock();
  }
  {
    // The attack this opens up: if an expired record survives, a refusal must
    // not hand it a fresh 14-day warning window and thereby resurrect it.
    const expired = { ...staleActive, hardStopAt: T0 + DAY };
    const env = await loadWorker({
      storage: { guardai_entitlement: { ...expired } },
      now: T0 + 2 * DAY,
      fetchImpl: () => jsonRes(200, { valid: false }),
    });
    const after = await env.mod.refreshIfStale();
    check(E.isUnlocked(after, T0 + 2 * DAY) === false,
      "a refusal cannot resurrect an already-expired licence for another fortnight",
      "hardStopAt now " + F(after, "hardStopAt"));
    env.restoreClock();
  }
  {
    // A damaged record must fail OPEN. Being unable to read the deadline is us
    // failing to know, and that never removes protection.
    for (const [label, bad] of [
      ["no hardStopAt at all", {}],
      ["hardStopAt is a string", { hardStopAt: "soon" }],
      ["hardStopAt is NaN", { hardStopAt: NaN }],
      ["hardStopAt is Infinity", { hardStopAt: Infinity }],
      ["hardStopAt is explicitly null (a review build)", { hardStopAt: null }],
    ]) {
      check(E.isUnlocked(bad, T0), `fails OPEN: ${label}`);
    }
    check(E.isUnlocked(null, T0) === false && E.isUnlocked(undefined, T0) === false,
      "but NO record is still locked — corruption is not an activation route");
  }
  {
    const review = { status: "active", kind: "review", token: "44444444-4444-4444-4444-444444444444",
                     validUntil: null, hardStopAt: null, lastVerifiedAt: T0, lastError: null };
    const env = await loadWorker({ storage: { guardai_entitlement: review }, now: T0 + 400 * DAY });
    await env.mod.refreshIfStale();
    check(env.fetchCalls.length === 0 && (await env.mod.readEntitlement()) !== null,
      "a review build still works 400 days later without ever contacting anything");
    const st = await env.mod.entitlementStatus();
    check(st.state === "active", "and reports itself as active, not grace", st.state);
    env.restoreClock();
  }

  console.log(`\nENTITLEMENT: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
