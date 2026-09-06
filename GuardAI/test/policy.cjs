/**
 * Company scanning policy: the reducer, its four copies, and the worker.
 *
 * ═══ WHAT THIS FILE IS DEFENDING ═══════════════════════════════════════════
 *
 * Two failures, pointing in opposite directions, and both of them are bad.
 *
 * THE EXPENSIVE ONE — enforcing somebody nobody enforced. Every company seat
 * that connected before this feature shipped holds a company key and no policy
 * record. If that state ever reads as "enforced", a background update silently
 * takes the master switch away from the entire existing customer base. Most of
 * Part 3 is attempts to make that happen.
 *
 * THE ONE WE WERE ASKED FOR — escaping a control by cutting the wire. If
 * silence relaxed enforcement, blocking our backend in a hosts file would be a
 * complete bypass, and the feature would be theatre. Part 1 is attempts to
 * make silence mean something.
 *
 * Plus two contract checks that are cheap and would otherwise rot:
 *   - the lock rule exists in four files (a module and three classic scripts
 *     that cannot import it); Part 2 runs all four over the same matrix
 *   - refresh_company must stay write-free, because it is the reason a policy
 *     poll is not a per-seat heartbeat; Part 4 reads the SQL and checks
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const ROOT = path.join(__dirname, "..");
const F = (rec, key) => (rec ? rec[key] : undefined);
const MIN = 60000;
const T0 = Date.parse("2026-08-01T00:00:00Z");

/* ── a chrome stub, same shape as test/entitlement.cjs ─────────────────── */
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
      tabs: { create() {} },
    },
  };
}

/**
 * Let any fire-and-forget work started by the previous worker finish before
 * swapping the global chrome out from under it.
 *
 * onStartup deliberately calls refreshIfStale() without awaiting it — that is
 * correct in the product, where nothing should wait on a licence check. In a
 * test it means a chain from env N can still be mid-flight when env N+1
 * replaces globalThis.chrome, and then N's `set` lands in N+1's storage. That
 * is not a real failure mode (a browser has one chrome), but it is exactly the
 * kind of cross-talk that would let a genuine regression hide.
 */
const drain = () => new Promise((r) => setTimeout(r, 5));

let loadSeq = 0;
async function loadWorker({ storage = {}, now = T0, fetchImpl } = {}) {
  await drain();
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
  env.mod = await import("../background.js?pseq=" + (++loadSeq));
  return env;
}

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A company entitlement that is nowhere near expiring, so nothing in these
 *  tests is accidentally measuring the licence gate instead of the policy. */
const seatRecord = (t = T0) => ({
  status: "active", kind: "company", token: "9c1f8e40-0000-4000-8000-00000000b27a",
  validUntil: t + 30 * 86400000, hardStopAt: t + 44 * 86400000,
  lastVerifiedAt: 0, lastError: null,
});
const connection = { employeeId: "9c1f8e40-0000-4000-8000-00000000b27a", companyName: "Acme Pty Ltd", connectedAt: T0 };

const ENFORCED = { mode: "enforced", version: 7, locks: { enabled: true, files: true, images: true }, company_name: "Acme Pty Ltd" };
const FLEXIBLE = { mode: "flexible", version: 8, locks: {}, company_name: "Acme Pty Ltd" };

(async () => {
  const P = await import("../src/policy.js");

  /* ══ PART 1 — silence must never relax enforcement ═══════════════════ */
  console.log("\n--- 1. an enforced device that stops hearing from us stays enforced ---");

  const enforced = P.decide(null, { result: "policy", policy: ENFORCED }, T0);
  check(F(enforced, "mode") === "enforced" && P.isLocked(enforced, "enabled"),
    "a 200 saying enforced enforces");

  for (const reason of ["network", "http-500", "http-401", "http-403", "malformed", "timeout", "dns-blocked"]) {
    const after = P.decide(enforced, { result: "error", reason }, T0 + 400 * 86400000);
    check(P.isLocked(after, "enabled") && P.isLocked(after, "files") && P.isLocked(after, "images"),
      `still enforced after ${reason}, 400 days later — there is no TTL to run out`);
  }
  {
    const after = P.decide(enforced, { result: "error", reason: "network" }, T0);
    check(F(after, "version") === 7 && F(after, "lastError") === "network",
      "an error records that it happened and changes nothing else");
  }
  {
    // The literal attack in the brief: point our host at 127.0.0.1 and poll
    // forever. Every attempt is an error; none of them may relax anything.
    let rec = enforced;
    for (let i = 0; i < 500; i++) rec = P.decide(rec, { result: "error", reason: "network" }, T0 + i * MIN);
    check(P.isLocked(rec, "enabled"), "500 consecutive failed polls do not add up to a relaxation");
  }
  {
    const after = P.decide(enforced, { result: "policy", policy: { mode: "wide-open", version: 99 } }, T0);
    check(P.isLocked(after, "enabled"), "a 200 with a mode we do not recognise is silence, not permission");
    check(F(after, "lastError") === "malformed", "and it is recorded as malformed");
  }
  check(P.isLocked(P.decide(enforced, null, T0), "enabled"),
    "a malformed outcome (null) is treated as an error, not as a relaxation");

  console.log("\n--- 2. only an explicit answer relaxes it ---");
  {
    const after = P.decide(enforced, { result: "policy", policy: FLEXIBLE }, T0 + MIN);
    check(F(after, "mode") === "flexible" && !P.anyLocked(after),
      "a 200 saying flexible is the one thing that unlocks");
    check(F(after, "lastError") === null, "and it clears a stale error");
  }
  {
    // Two polls in flight at once — a page load and the timer. The older
    // answer must not win, or every trip OUT of Enforced would re-enforce.
    const relaxed = P.decide(enforced, { result: "policy", policy: FLEXIBLE }, T0 + MIN);
    const stale = P.decide(relaxed, { result: "policy", policy: ENFORCED }, T0 + 2 * MIN);
    check(F(stale, "mode") === "flexible" && F(stale, "version") === 8,
      "a response older than the one we hold is discarded", JSON.stringify(stale));
  }
  {
    const same = P.decide(enforced, { result: "policy", policy: { ...ENFORCED } }, T0 + 5 * MIN);
    check(F(same, "fetchedAt") === T0 + 5 * MIN,
      "an equal version still refreshes fetchedAt, so a re-poll is not a no-op");
  }

  console.log("\n--- 3. a lock is an explicit grant, never an inference ---");
  check(P.isLocked(null, "enabled") === false, "no record locks nothing");
  check(P.isLocked({}, "enabled") === false, "an empty object locks nothing");
  check(P.isLocked({ mode: "enforced" }, "enabled") === false, "enforced with no locks object locks nothing");
  check(P.isLocked({ mode: "enforced", locks: {} }, "enabled") === false, "enforced with empty locks locks nothing");
  check(P.isLocked({ mode: "flexible", locks: { enabled: true } }, "enabled") === false,
    "a lock without enforced mode locks nothing — both halves are required");
  for (const truthy of [1, "true", "yes", {}, []]) {
    check(P.isLocked({ mode: "enforced", locks: { enabled: truthy } }, "enabled") === false,
      "a truthy-but-not-true lock value is malformed, not a lock: " + JSON.stringify(truthy));
  }
  check(P.parsePolicy({ mode: "enforced", version: "7" }) === null, "a non-numeric version is unreadable");
  check(P.parsePolicy({ mode: "enforced", version: NaN }) === null, "NaN version is unreadable");
  check(P.parsePolicy({ mode: "enforced", version: 1, locks: { nonsense: true } }).locks.nonsense === undefined,
    "an unknown lock name is dropped rather than carried");

  console.log("\n--- 4. effective(): locked reads on, and never writes ---");
  check(P.effective(false, enforced, "enabled") === true, "a locked switch reads ON even when the user stored false");
  check(P.effective(false, null, "enabled") === false, "with no policy the user's own choice stands");
  check(P.effective(false, { mode: "flexible", locks: {} }, "enabled") === false,
    "under Flexible the user's own choice stands");
  check(P.effective(true, null, "files") === true, "and an unpinned true stays true");
  {
    // The user's stored value is an argument, not something this touches.
    const before = JSON.stringify(enforced);
    P.effective(false, enforced, "enabled");
    check(JSON.stringify(enforced) === before, "effective() does not mutate the policy record");
  }
  check(P.BASE_LOCKS.every((n) => P.effective(false,
      { mode: "enforced", locks: Object.fromEntries(P.BASE_LOCKS.map((x) => [x, true])), version: 1 },
      n) === true),
    "every base switch can only ever be forced ON — there is no remote off switch");

  console.log("\n--- 4b. any setting, not just the fixed three ---");
  check(P.BASE_LOCKS.join(",") === "enabled,files,images,masking",
    "the base switches are exactly these four", P.BASE_LOCKS.join(","));
  for (const noisy of ["aggressive", "aggressive_names", "imageHardStop", "image_hard_stop", "hardstop"]) {
    check(P.isLockName(noisy) === false,
      `"${noisy}" is not a lock name — noise settings are not an admin's to pin`);
  }
  for (const good of ["cat:NAME_PII", "cat:TFN", "cat:BUSINESS_CONFIDENTIAL", "cat:USERNAME", "cat:ABN"]) {
    check(P.isLockName(good) === true, `${good} is a valid lock name`);
  }
  for (const bad of ["cat:", "cat:lower", "cat:1ABC", "CAT:TFN", "cat: TFN", "", null, 7, {}]) {
    check(P.isLockName(bad) === false, `${JSON.stringify(bad)} is not a valid lock name`);
  }
  check(P.catLock("PHONE") === "cat:PHONE", "catLock() builds the name the server sends");

  {
    const pol = P.decide(null, { result: "policy", policy: {
      mode: "enforced", version: 3,
      locks: { "cat:PASSWORD": true, "cat:TFN": true, masking: true },
      company_name: "Acme Pty Ltd",
    } }, T0);
    check(P.isLocked(pol, "cat:PASSWORD") && P.isLocked(pol, "cat:TFN"),
      "a category lock survives the reducer");
    check(P.isLocked(pol, "masking"), "so does the masking lock");
    check(P.isLocked(pol, "enabled") === false,
      "and locking categories does NOT imply locking the master switch — each is its own");
    check(P.anyLocked(pol), "anyLocked sees category-only enforcement");
  }
  {
    const parsed = P.parsePolicy({ mode: "enforced", version: 1, locks: {
      "cat:TFN": true, "cat:lowercase": true, "aggressive": true,
      "nonsense": true, "cat:OK": 1, enabled: true,
    } });
    check(JSON.stringify(Object.keys(parsed.locks).sort()) === JSON.stringify(["cat:TFN", "enabled"]),
      "malformed and non-lockable names are dropped on the way in",
      JSON.stringify(parsed.locks));
  }

  check(P.setByLine({ mode: "enforced", locks: { "cat:TFN": true } }) === "Locked by admin",
    "the badge reads Locked by admin, not the company name");
  check(P.setByLine({ mode: "flexible", locks: {} }) === "",
    "and nothing at all when nothing is pinned");

  console.log("\n--- 4c. a category lock REMOVES from the off-list, never adds ---");
  {
    const pol = { mode: "enforced", version: 1, locks: { "cat:TFN": true, "cat:PASSWORD": true } };
    const user = ["TFN", "ORG", "PASSWORD", "MONEY"];
    const eff = P.effectiveDisabled(user, pol);
    check(JSON.stringify(eff) === JSON.stringify(["ORG", "MONEY"]),
      "pinned categories come OUT of the user's off-list", JSON.stringify(eff));
    check(JSON.stringify(user) === JSON.stringify(["TFN", "ORG", "PASSWORD", "MONEY"]),
      "and the user's own array is not mutated — their choice survives the lock");
    check(eff.every((t) => user.includes(t)),
      "nothing is ever ADDED to the off-list: a lock cannot switch a category off");
  }
  check(JSON.stringify(P.effectiveDisabled(["TFN"], null)) === JSON.stringify(["TFN"]),
    "with no policy the off-list is the user's own, untouched");
  check(JSON.stringify(P.effectiveDisabled(["TFN"], { mode: "flexible", locks: { "cat:TFN": true } })) === JSON.stringify(["TFN"]),
    "under Flexible a stored lock does nothing");
  check(JSON.stringify(P.effectiveDisabled(null, { mode: "enforced", locks: { "cat:TFN": true } })) === "[]",
    "a missing off-list is an empty one, not a crash");
  {
    // The whole point of keeping the two apart: lift the lock, get the choice back.
    const pol = { mode: "enforced", version: 1, locks: { "cat:TFN": true } };
    const user = ["TFN", "ORG"];
    P.effectiveDisabled(user, pol);
    const after = P.effectiveDisabled(user, { mode: "flexible", locks: {}, version: 2 });
    check(JSON.stringify(after) === JSON.stringify(["TFN", "ORG"]),
      "when the policy relaxes, the user's original off-list is exactly as they left it");
  }

  /* ══ PART 2 — the four copies of the rule must agree ═════════════════ */
  console.log("\n--- 5. the lock rule is copied into three classic scripts; all four agree ---");
  function extract(file, fnName) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = src.indexOf("function " + fnName + "(");
    if (start === -1) return null;
    // Walk braces from the first { after the signature.
    let i = src.indexOf("{", start), depth = 0, end = -1;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end === -1) return null;
    return new Function("return (" + src.slice(start, end) + ")")();
  }
  const copies = {
    "src/content.js": extract("src/content.js", "lockedBy"),
    "settings.js": extract("settings.js", "lockedBy"),
    "popup.js": extract("popup.js", "lockedBy"),
  };
  for (const [file, fn] of Object.entries(copies)) {
    check(typeof fn === "function", `found lockedBy() in ${file}`);
  }
  const matrix = [
    null, undefined, 0, "enforced", [],
    {}, { mode: "enforced" }, { mode: "enforced", locks: null },
    { mode: "enforced", locks: {} },
    { mode: "enforced", locks: { enabled: true } },
    { mode: "enforced", locks: { enabled: true, files: true, images: true } },
    { mode: "enforced", locks: { enabled: 1 } },
    { mode: "flexible", locks: { enabled: true } },
    { mode: "", locks: { enabled: true } },
    { mode: "enforced", locks: { masking: true } },
    { mode: "enforced", locks: { "cat:TFN": true } },
    { mode: "enforced", locks: { "cat:TFN": true, "cat:PASSWORD": true, masking: true } },
    { mode: "flexible", locks: { "cat:TFN": true } },
    P.provisional(T0),
  ];
  let mismatch = 0;
  for (const pol of matrix) {
    for (const name of ["enabled", "files", "images", "masking",
                        "cat:TFN", "cat:PASSWORD", "cat:NAME_PII", "nonsense"]) {
      const want = P.isLocked(pol, name);
      for (const [file, fn] of Object.entries(copies)) {
        if (!fn) continue;
        if (fn(pol, name) !== want) {
          mismatch++;
          console.log(`      ${file} disagrees on ${JSON.stringify(pol)} / ${name}`);
        }
      }
    }
  }
  check(mismatch === 0, `all four copies agree across ${matrix.length * 4} cases`, mismatch + " mismatches");

  /* ══ PART 3 — the update that must not enforce anybody ═══════════════ */
  console.log("\n--- 6. an existing seat with no policy is NOT enforced ---");
  {
    // The exact shape of every company install in the field today: a seat, an
    // entitlement, and no policy record, because the feature did not exist.
    const env = await loadWorker({
      storage: { guardai_company: connection, guardai_entitlement: seatRecord() },
    });
    const pol = await env.mod.readPolicy();
    check(F(pol, "mode") === "flexible", "seeded flexible, not enforced", JSON.stringify(pol));
    check(P.anyLocked(pol) === false, "and it locks nothing at all");
    check(F(pol, "version") === -1, "at version -1, so the first real answer outranks it");
    check(F(pol, "provisional") === true, "marked provisional so it is not mistaken for a server answer");
    check(env.storage.guardai_policy !== undefined, "and it was persisted, so this happens once");
    env.restoreClock();
  }
  {
    // Belt and braces: run the install hooks too. Nothing in the lifecycle may
    // produce enforcement either.
    const env = await loadWorker({
      storage: { guardai_company: connection, guardai_entitlement: seatRecord() },
    });
    for (const f of env.listeners.installed) await f({ reason: "update" });
    for (const f of env.listeners.startup) await f();
    await drain();   // onStartup's refresh is fire-and-forget by design
    const pol = await env.mod.readPolicy();
    check(!P.anyLocked(pol), "still nothing locked after onInstalled(update) and onStartup");
    env.restoreClock();
  }
  {
    const env = await loadWorker({ storage: {} });
    check((await env.mod.readPolicy()) === null, "an install with no company gets no policy record at all");
    check(env.storage.guardai_policy === undefined, "and nothing is written for it");
    env.restoreClock();
  }
  {
    const existing = { mode: "enforced", locks: { enabled: true }, version: 3, companyName: "Acme", fetchedAt: T0, lastError: null };
    const env = await loadWorker({ storage: { guardai_company: connection, guardai_policy: existing } });
    const pol = await env.mod.readPolicy();
    check(F(pol, "version") === 3 && P.isLocked(pol, "enabled"),
      "an existing policy is returned untouched — the seed never overwrites one");
    env.restoreClock();
  }

  console.log("\n--- 7. the wire: one field out, policy back ---");
  {
    const env = await loadWorker({
      storage: { guardai_company: connection, guardai_entitlement: seatRecord() },
      now: T0 + 86400000,
      fetchImpl: () => jsonRes(200, { valid: true, company_name: "Acme Pty Ltd", policy: ENFORCED }),
    });
    await env.mod.refreshIfStale();
    const call = env.fetchCalls.find((c) => c.url.includes("refresh_company"));
    check(Boolean(call), "the seat re-checks through refresh_company");
    check(JSON.stringify(Object.keys(call.body).sort()) === JSON.stringify(["p_employee_id"]),
      "the request body carries exactly one field and nothing else",
      JSON.stringify(call.body));
    check(call.body.p_employee_id === connection.employeeId, "and it is the anonymous seat id that already went");
    const pol = await env.mod.readPolicy();
    check(P.isLocked(pol, "enabled") && P.isLocked(pol, "files") && P.isLocked(pol, "images"),
      "the policy on the response is applied", JSON.stringify(pol));
    check(F(pol, "companyName") === "Acme Pty Ltd", "including the name shown under the disabled switch");
    env.restoreClock();
  }
  {
    // Nothing about the policy, the locks, or the user's own settings may
    // appear in any outbound body. This is the whole privacy claim.
    const env = await loadWorker({
      storage: {
        guardai_company: connection, guardai_entitlement: seatRecord(),
        guardai_enabled: false, guardai_file_scanning: false, guardai_policy: { mode: "enforced", locks: { enabled: true }, version: 2 },
      },
      now: T0 + 86400000,
      fetchImpl: () => jsonRes(200, { valid: true, policy: ENFORCED }),
    });
    await env.mod.refreshIfStale();
    const sent = JSON.stringify(env.fetchCalls.map((c) => c.body));
    check(!/policy|locks|enforced|scanning|enabled/i.test(sent),
      "no policy, lock or setting name appears anywhere in what was sent", sent);
    env.restoreClock();
  }

  console.log("\n--- 8. cutting the wire mid-session ---");
  for (const [label, impl] of [
    ["offline", null],
    ["500", () => jsonRes(500, { message: "boom" })],
    ["403", () => jsonRes(403, {})],
    ["a captive portal serving HTML", () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })],
    ["a 200 with no policy key", () => jsonRes(200, { valid: true })],
  ]) {
    const env = await loadWorker({
      storage: {
        guardai_company: connection, guardai_entitlement: seatRecord(),
        guardai_policy: { mode: "enforced", locks: { enabled: true, files: true, images: true }, version: 7, companyName: "Acme Pty Ltd", fetchedAt: T0, lastError: null },
      },
      now: T0 + 86400000,
      fetchImpl: impl,
    });
    await env.mod.refreshIfStale();
    const pol = await env.mod.readPolicy();
    check(P.isLocked(pol, "enabled") && P.isLocked(pol, "files") && P.isLocked(pol, "images"),
      `${label}: still enforced`, JSON.stringify(pol));
    check(F(pol, "version") === 7, `${label}: and the version did not move`);
    env.restoreClock();
  }

  console.log("\n--- 9. a lapsed subscription is still subject to the policy ---");
  {
    // Fourteen days of grace during which the extension still masks. The
    // employer's policy governs that fortnight too.
    const env = await loadWorker({
      storage: { guardai_company: connection, guardai_entitlement: seatRecord() },
      now: T0 + 86400000,
      fetchImpl: () => jsonRes(200, { valid: false, reason: "SUBSCRIPTION_INACTIVE", policy: ENFORCED }),
    });
    await env.mod.refreshIfStale();
    check(P.isLocked(await env.mod.readPolicy(), "enabled"),
      "the policy on a valid:false response is still applied");
    env.restoreClock();
  }

  console.log("\n--- 10. cadence ---");
  {
    const env = await loadWorker({
      storage: { guardai_company: connection, guardai_entitlement: seatRecord(T0) },
      now: T0 + 16 * MIN,
      fetchImpl: () => jsonRes(200, { valid: true, policy: FLEXIBLE }),
    });
    await env.mod.refreshIfStale();
    check(env.fetchCalls.length === 1, "a company seat re-checks after 15 minutes, not a day");
    env.restoreClock();
  }
  {
    const rec = { ...seatRecord(T0), lastVerifiedAt: T0 };
    const env = await loadWorker({
      storage: { guardai_company: connection, guardai_entitlement: rec },
      now: T0 + 5 * MIN,
      fetchImpl: () => jsonRes(200, { valid: true, policy: FLEXIBLE }),
    });
    await env.mod.refreshIfStale();
    check(env.fetchCalls.length === 0, "but not every five minutes — the floor still throttles it");
    env.restoreClock();
  }
  {
    const ind = {
      status: "active", kind: "individual", token: "tok-ind",
      validUntil: T0 + 30 * 86400000, hardStopAt: T0 + 44 * 86400000,
      lastVerifiedAt: T0, lastError: null,
    };
    const env = await loadWorker({
      storage: { guardai_entitlement: ind },
      now: T0 + 60 * MIN,
      fetchImpl: () => jsonRes(200, { valid: true }),
    });
    await env.mod.refreshIfStale();
    check(env.fetchCalls.length === 0,
      "an individual key stays on the daily clock — it has no policy to collect and its endpoint writes");
    env.restoreClock();
  }

  console.log("\n--- 11. connecting and disconnecting ---");
  {
    const env = await loadWorker({
      storage: {},
      fetchImpl: (url) => url.includes("connect_company")
        ? jsonRes(200, { employee_id: connection.employeeId, company_name: "Acme Pty Ltd", seat_limit: 20, policy: ENFORCED })
        : jsonRes(200, { valid: true }),
    });
    await env.mod.activateCode("GA-ABCD-EFGH", "Sarah", "Chen");
    const pol = await env.mod.readPolicy();
    check(P.isLocked(pol, "enabled"), "redeeming an invite code applies the policy that came back with it");
    check(F(pol, "provisional") === undefined, "a real answer, not the seed");
    env.restoreClock();
  }
  {
    const env = await loadWorker({
      storage: {},
      fetchImpl: (url) => url.includes("connect_company")
        ? jsonRes(200, { employee_id: connection.employeeId, company_name: "Acme Pty Ltd", seat_limit: 20 })
        : jsonRes(200, { valid: true }),
    });
    await env.mod.activateCode("GA-ABCD-EFGH", "Sarah", "Chen");
    const pol = await env.mod.readPolicy();
    check(pol && !P.anyLocked(pol),
      "an older backend that sends no policy leaves the seat unenforced, not enforced");
    env.restoreClock();
  }
  {
    const env = await loadWorker({
      storage: {
        guardai_company: connection, guardai_entitlement: seatRecord(),
        guardai_policy: { mode: "enforced", locks: { enabled: true }, version: 7 },
      },
      fetchImpl: () => jsonRes(200, {}),
    });
    await env.mod.disconnectCompany();
    check(env.storage.guardai_policy === undefined, "disconnecting clears the policy");
    check(env.storage.guardai_company === undefined, "and the connection");
    check((await env.mod.readPolicy()) === null, "and it does not re-seed itself afterwards");
    env.restoreClock();
  }

  /* ══ PART 4 — the SQL side of the contract ═══════════════════════════ */
  console.log("\n--- 12. the SQL keeps its two promises ---");
  // The SQL lives in the website repo, which is a sibling checkout rather than
  // a dependency. Skipped rather than failed when it is not there, so this
  // suite still runs for anyone who only has the extension.
  const SQL_PATH = path.join(ROOT, "..", "..", "..", "Documents", "guardaigo-landing 44", "supabase", "policy-delta.sql");
  if (!fs.existsSync(SQL_PATH)) {
    console.log("skip  policy-delta.sql not found beside this checkout — cannot verify the SQL contract");
  } else {
    const sql = fs.readFileSync(SQL_PATH, "utf8");

    function bodyOf(name) {
      const i = sql.indexOf("create or replace function " + name);
      if (i === -1) return "";
      const start = sql.indexOf("as $$", i);
      const end = sql.indexOf("$$;", start);
      return start === -1 || end === -1 ? "" : sql.slice(start, end);
    }

    const rc = bodyOf("refresh_company");
    check(rc.length > 0, "found refresh_company in policy-delta.sql");
    // The property the whole privacy argument rests on. record_event updates
    // last_active_at and refresh_entitlement stamps last_seen_at; this one must
    // do neither, or polling it every 15 minutes becomes a per-seat heartbeat.
    const writes = (rc.match(/\b(update|insert\s+into|delete\s+from)\b/gi) || []);
    check(writes.length === 0,
      "refresh_company performs no write of any kind", writes.join(", "));
    check(!/last_active_at|last_seen_at/i.test(rc),
      "and touches neither liveness column");
    check(/p_employee_id\s+uuid/.test(sql.slice(sql.indexOf("function refresh_company"))),
      "its signature still takes exactly the seat id");

    const ssp = bodyOf("set_scan_policy");
    check(/POLICY_NOT_AVAILABLE/.test(ssp) && /plan\s*=\s*'individual'/.test(ssp),
      "set_scan_policy refuses an individual plan in SQL, not just in the UI");
    check(/owner_id\s*=\s*auth\.uid\(\)/.test(ssp),
      "and resolves the company from the caller, so an admin cannot name someone else's");
    check(/security definer/.test(sql.slice(sql.indexOf("function set_scan_policy"), sql.indexOf("function set_scan_policy") + 400)),
      "it is security definer");
    check(/grant execute on function set_scan_policy\(text\) to authenticated/.test(sql) &&
          !/grant execute on function set_scan_policy\(text\)[^;]*anon/.test(sql),
      "granted to authenticated and never to anon — the extension holds the anon key");

    const pj = bodyOf("guardai_policy_json");
    check(/c\.plan\s*=\s*'individual'/.test(pj) && /'flexible'/.test(pj),
      "every READ clamps an individual plan to flexible, so a hand-edited column cannot enforce on a solo customer");
    check(!/'enabled',\s*false|'files',\s*false|'images',\s*false/.test(pj),
      "no lock is ever emitted as false — locks only ever turn protection on");
  }

  console.log("\n--- 12b. the per-setting lock SQL ---");
  const LOCKS_SQL = path.join(ROOT, "..", "..", "..", "Documents", "guardaigo-landing 44", "supabase", "policy-locks-delta.sql");
  if (!fs.existsSync(LOCKS_SQL)) {
    console.log("skip  policy-locks-delta.sql not found beside this checkout");
  } else {
    const sql2 = fs.readFileSync(LOCKS_SQL, "utf8");
    const body2 = (name) => {
      const i = sql2.indexOf("create or replace function " + name);
      if (i === -1) return "";
      const a = sql2.indexOf("as $$", i), b = sql2.indexOf("$$;", a);
      return a === -1 || b === -1 ? "" : sql2.slice(a, b);
    };

    // The single most important thing about this file: it must not redefine
    // refresh_company, because that function's write-free-ness is the reason a
    // policy poll leaves no trace. Changing guardai_policy_json is enough.
    check(!/create or replace function refresh_company/.test(sql2),
      "refresh_company is NOT redefined here — its write-free body is untouched");

    const lockable = body2("guardai_lockable");
    check(lockable.length > 0, "found guardai_lockable()");
    for (const base of ["'enabled'", "'files'", "'images'", "'masking'"]) {
      check(lockable.includes(base), `lockable includes ${base}`);
    }
    for (const noisy of ["aggressive", "hard_stop", "hardstop", "image_hard"]) {
      check(!lockable.includes(noisy),
        `lockable EXCLUDES ${noisy} — noise settings are not an admin's to pin`);
    }
    // Every category the settings page can toggle must be lockable, or an
    // admin is offered a control the extension cannot honour (or vice versa).
    const settingsSrc = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
    const gStart = settingsSrc.indexOf("const GROUPS = [");
    const gBlock = settingsSrc.slice(gStart, settingsSrc.indexOf("\n  ];", gStart));
    const toggleable = [...gBlock.matchAll(/\{ type: "([A-Z_]+)"/g)].map((m) => m[1]);
    const missing = toggleable.filter((t) => !lockable.includes("'cat:" + t + "'"));
    const extra = [...lockable.matchAll(/'cat:([A-Z_]+)'/g)]
      .map((m) => m[1]).filter((t) => !toggleable.includes(t));
    check(missing.length === 0,
      `every toggleable category is lockable (${toggleable.length} of them)`, missing.join(", "));
    check(extra.length === 0, "and nothing lockable is missing from the settings page", extra.join(", "));

    const setLocks = body2("set_scan_locks");
    check(/UNKNOWN_LOCK/.test(setLocks) && /guardai_lockable\(\)/.test(setLocks),
      "set_scan_locks refuses a name outside the allowlist rather than dropping it silently");
    check(/POLICY_NOT_AVAILABLE/.test(setLocks) && /plan\s*=\s*'individual'/.test(setLocks),
      "and refuses an individual plan, in SQL");
    check(/owner_id\s*=\s*auth\.uid\(\)/.test(setLocks),
      "and resolves the company from the caller");
    check(/security definer/.test(sql2.slice(sql2.indexOf("function set_scan_locks"), sql2.indexOf("function set_scan_locks") + 400)),
      "it is security definer");
    check(/grant execute on function set_scan_locks\(jsonb\) to authenticated/.test(sql2) &&
          !/grant execute on function set_scan_locks\(jsonb\)[^;]*anon/.test(sql2),
      "granted to authenticated and never to anon");

    const pj2 = body2("guardai_policy_json");
    check(/guardai_lockable\(\)/.test(pj2),
      "reads are filtered through the allowlist too, so retiring a name needs no data migration");
    check(/c\.plan\s*=\s*'individual'/.test(pj2),
      "the individual clamp survives the rewrite");
    check(/jsonb_object_agg\(name, true\)/.test(pj2),
      "and every lock is emitted as true — there is still no way to express a lock that turns something off");

    check(/default '\["enabled","files","images"\]'::jsonb/.test(sql2),
      "scan_locks defaults to the trio the previous delta hardcoded, so nobody's enforcement changes by running this");
  }

  /* ══ PART 5 — what the person actually sees ══════════════════════════ */
  console.log("\n--- 13. the two locked surfaces ---");
  {
    const { JSDOM } = require("jsdom");
    const readFile = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

    function openPage(page, storage) {
      const dom = new JSDOM(readFile(page), {
        url: "https://example.com/" + page,
        runScripts: "dangerously",
        pretendToBeVisual: true,
      });
      const { window } = dom;
      window.chrome = {
        storage: {
          local: {
            get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
              if (kk in storage) o[kk] = storage[kk];
              return o;
            }, {})),
            set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
            remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((kk) => delete storage[kk]); return Promise.resolve(); },
          },
          onChanged: { addListener() {} },
        },
        runtime: {
          getURL: (p) => "file://" + p, lastError: null,
          sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({ ok: true, state: "active", record: null, available: true }), 0); },
        },
        tabs: { create() {} },
      };
      Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: () => Promise.resolve() }, configurable: true,
      });
      window.eval(readFile(page === "popup.html" ? "popup.js" : "settings.js"));
      return window;
    }

    const enforcedRec = {
      mode: "enforced", locks: { enabled: true, files: true, images: true },
      version: 7, companyName: "Acme Pty Ltd", fetchedAt: T0, lastError: null,
    };
    const settle = () => new Promise((r) => setTimeout(r, 60));

    // The popup master switch — the first thing anyone testing enforcement
    // reaches for, and the one that would make the other two locks pointless.
    {
      // The user had deliberately turned GuardAI OFF before the policy landed.
      const store = { guardai_enabled: false, guardai_policy: enforcedRec };
      const w = openPage("popup.html", store);
      await settle();
      const sw = w.document.getElementById("toggle-enabled");
      check(sw.disabled === true, "popup: the master switch is disabled");
      check(sw.checked === true, "popup: and shows ON, because it IS on — a locked switch never misreports the state");
      const banner = w.document.getElementById("policy-banner");
      check(banner && banner.classList.contains("is-on"), "popup: the banner explains why, rather than leaving a dead control");
      check(!/switched off|files and images are always/i.test(
              w.document.getElementById("policy-banner").textContent),
        "popup: the banner no longer promises the old fixed trio, which per-setting locks made false");
      check(store.guardai_enabled === false,
        "popup: the user's own stored choice is NOT overwritten — it comes back when the policy relaxes");
      w.close();
    }
    {
      const w = openPage("popup.html", { guardai_enabled: true, guardai_policy: { mode: "flexible", locks: {}, version: 8 } });
      await settle();
      check(w.document.getElementById("toggle-enabled").disabled === false,
        "popup: under Flexible the switch works normally");
      check(!w.document.getElementById("policy-banner").classList.contains("is-on"),
        "popup: and the banner is not shown");
      w.close();
    }
    {
      const w = openPage("popup.html", { guardai_enabled: true });
      await settle();
      check(w.document.getElementById("toggle-enabled").disabled === false,
        "popup: an install with no policy at all is not locked");
      w.close();
    }

    // The two attachment switches on the settings page.
    {
      const store = { guardai_file_scanning: false, guardai_image_scanning: false, guardai_policy: enforcedRec };
      const w = openPage("settings.html", store);
      await settle();
      const boxes = [...w.document.querySelectorAll("input[data-switch]")];
      check(boxes.length === 2, "settings: both attachment switches are rendered", String(boxes.length));
      check(boxes.every((b) => b.disabled), "settings: both are disabled");
      check(boxes.every((b) => b.checked), "settings: and both show ON");
      const badges = [...w.document.querySelectorAll(".cat-row__badge--set")];
      check(badges.length === 2 && badges.every((b) => /^Locked by admin$/.test(b.textContent)),
        "settings: each pinned switch is badged Locked by admin",
        badges.map((b) => b.textContent).join(" | "));
      check(!badges.some((b) => /Acme|Pty|Ltd/.test(b.textContent)),
        "settings: and the badge does not carry the company name, which uppercases badly");
      check(store.guardai_file_scanning === false && store.guardai_image_scanning === false,
        "settings: the user's own choices are left in storage untouched");
      w.close();
    }
    {
      const store = { guardai_file_scanning: false, guardai_policy: { mode: "flexible", locks: {}, version: 8 } };
      const w = openPage("settings.html", store);
      await settle();
      const boxes = [...w.document.querySelectorAll("input[data-switch]")];
      check(boxes.every((b) => !b.disabled), "settings: under Flexible both switches work");
      check(boxes[0].checked === false, "settings: and the user's earlier OFF is shown again, exactly as they left it");
      check(w.document.querySelectorAll(".cat-row__badge--set").length === 0, "settings: no 'set by' badge");
      w.close();
    }

    // Per-category locks on the settings page.
    {
      const catPolicy = {
        mode: "enforced", locks: { "cat:TFN": true, "cat:PASSWORD": true },
        version: 9, companyName: "Acme Pty Ltd", fetchedAt: T0, lastError: null,
      };
      // The user had switched BOTH pinned categories off before the lock landed.
      const store = {
        guardai_disabled_categories: ["TFN", "PASSWORD", "ORG"],
        guardai_policy: catPolicy,
      };
      const w = openPage("settings.html", store);
      await settle();
      const box = (t) => w.document.querySelector(`input[data-type="${t}"]`);
      check(box("TFN") && box("TFN").disabled && box("TFN").checked,
        "settings: a pinned category is disabled and shows ON");
      check(box("PASSWORD") && box("PASSWORD").disabled && box("PASSWORD").checked,
        "settings: so is the second one");
      check(box("ORG") && !box("ORG").disabled && !box("ORG").checked,
        "settings: an unpinned category the user switched off is still off, and still theirs to change");
      check(box("NAME_PII") && !box("NAME_PII").disabled && box("NAME_PII").checked,
        "settings: an untouched category is unaffected");
      const badges = [...w.document.querySelectorAll(".cat-row__badge--set")];
      check(badges.length === 2 && badges.every((b) => /^Locked by admin$/.test(b.textContent)),
        "settings: each pinned category is badged Locked by admin", String(badges.length));
      check(JSON.stringify(store.guardai_disabled_categories) === JSON.stringify(["TFN", "PASSWORD", "ORG"]),
        "settings: rendering a lock does not rewrite the user's off-list");

      // "Disable all" must not try to switch off something pinned.
      w.document.getElementById("disable-all").click();
      await settle();
      const written = store.guardai_disabled_categories;
      check(!written.includes("TFN") && !written.includes("PASSWORD"),
        "settings: Disable all leaves pinned categories ON and out of the off-list",
        JSON.stringify(written));
      check(written.includes("ORG") && written.includes("NAME_PII"),
        "settings: and switches off everything it is actually allowed to");
      check(box("TFN").checked && box("TFN").disabled,
        "settings: the pinned switch is still on screen as on");
      w.close();
    }

    // Masking, which lives in the popup rather than the settings page.
    {
      const store = {
        guardai_enabled: true, guardai_masking_enabled: false,
        guardai_policy: { mode: "enforced", locks: { masking: true }, version: 4, companyName: "Acme Pty Ltd" },
      };
      const w = openPage("popup.html", store);
      await settle();
      const m = w.document.getElementById("toggle-masking");
      check(m.disabled === true, "popup: a pinned masking mode is disabled");
      check(m.checked === true, "popup: and shows ON despite the user having stored false");
      check(store.guardai_masking_enabled === false,
        "popup: their stored choice is untouched");
      check(w.document.getElementById("toggle-enabled").disabled === false,
        "popup: pinning masking does NOT pin the master switch — each lock is its own");
      check(w.document.getElementById("policy-banner").classList.contains("is-on"),
        "popup: the banner still explains the managed state");
      w.close();
    }
    {
      // Category-only enforcement: nothing in the popup is disabled, but the
      // person should still be told they are on a managed install.
      const w = openPage("popup.html", {
        guardai_enabled: true,
        guardai_policy: { mode: "enforced", locks: { "cat:TFN": true }, version: 5, companyName: "Acme Pty Ltd" },
      });
      await settle();
      check(w.document.getElementById("toggle-enabled").disabled === false &&
            w.document.getElementById("toggle-masking").disabled === false,
        "popup: category-only enforcement leaves both popup switches usable");
      check(w.document.getElementById("policy-banner").classList.contains("is-on"),
        "popup: but the banner appears, because a policy does apply to them");
      w.close();
    }
  }

  /* ══ PART 5b — one tick locks one thing ═════════════════════════════ */
  console.log("\n--- 13b. ticking one setting leaves every other one free ---");
  {
    // The generated dashboard list is the set of things an admin can tick, so
    // it is the right set to prove isolation over.
    const LOCKS_JS = path.join(ROOT, "..", "..", "..", "Documents", "guardaigo-landing 44", "locks.js");
    let names = null;
    if (fs.existsSync(LOCKS_JS)) {
      const src = fs.readFileSync(LOCKS_JS, "utf8");
      const json = src.slice(src.indexOf("["), src.lastIndexOf("]") + 1);
      names = JSON.parse(json).map((r) => r.name);
      check(names.length === 29, `locks.js lists 29 toggles`, String(names.length));
    } else {
      console.log("skip  locks.js not found beside this checkout");
    }

    if (names) {
      let leaks = 0;
      for (const one of names) {
        const pol = { mode: "enforced", version: 1, locks: { [one]: true } };
        if (!P.isLocked(pol, one)) { leaks++; console.log(`      ${one} did not lock itself`); continue; }
        for (const other of names) {
          if (other === one) continue;
          if (P.isLocked(pol, other)) {
            leaks++;
            console.log(`      locking ${one} also locked ${other}`);
          }
        }
      }
      check(leaks === 0,
        `each of the ${names.length} settings locks itself and nothing else (${names.length * names.length} pairs)`,
        leaks + " leaks");

      // And the category half of that, through the off-list rather than a flag.
      const cats = names.filter((n) => n.startsWith("cat:")).map((n) => n.slice(4));
      let catLeaks = 0;
      for (const one of cats) {
        const pol = { mode: "enforced", version: 1, locks: { ["cat:" + one]: true } };
        const eff = P.effectiveDisabled(cats, pol);
        if (eff.includes(one)) { catLeaks++; console.log(`      ${one} stayed disabled despite its lock`); }
        const freed = cats.filter((c) => !eff.includes(c));
        if (freed.length !== 1 || freed[0] !== one) {
          catLeaks++;
          console.log(`      locking ${one} freed ${JSON.stringify(freed)}`);
        }
      }
      check(catLeaks === 0,
        `locking one category frees exactly that category and no other (${cats.length} checked)`,
        catLeaks + " leaks");
    }
  }

  console.log("\n--- 13c. the dashboard list is generated, not a second copy ---");
  {
    const SITE = path.join(ROOT, "..", "..", "..", "Documents", "guardaigo-landing 44");
    const gen = path.join(SITE, "scripts", "gen-locks.mjs");
    if (!fs.existsSync(gen)) {
      console.log("skip  gen-locks.mjs not found beside this checkout");
    } else {
      const { spawnSync } = require("child_process");
      const r = spawnSync(process.execPath, [gen, "--check", ROOT], { cwd: SITE, encoding: "utf8" });
      check(r.status === 0,
        "locks.js is in step with settings.js — add a category and forget to regenerate, and this fails",
        (r.stderr || r.stdout || "").trim());

      // Order matters: the list exists so an admin can read it beside the
      // extension's own screens, which only works if it is in the same order.
      const settingsSrc = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
      const gStart = settingsSrc.indexOf("const GROUPS = [");
      const inOrder = [...settingsSrc.slice(gStart, settingsSrc.indexOf("\n  ];", gStart))
        .matchAll(/\{ type: "([A-Z_]+)"/g)].map((m) => m[1]);
      const src = fs.readFileSync(path.join(SITE, "locks.js"), "utf8");
      const rows = JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
      const listedCats = rows.filter((r) => r.name.startsWith("cat:")).map((r) => r.name.slice(4));
      check(JSON.stringify(listedCats) === JSON.stringify(inOrder),
        "and in the same order the extension shows them");
      check(rows.slice(0, 4).map((r) => r.name).join(",") === "enabled,masking,files,images",
        "with the two popup switches first, then the two attachment ones",
        rows.slice(0, 4).map((r) => r.name).join(","));
      check(rows.every((r) => r.label && r.label.length > 2),
        "every row carries the extension's own label rather than a re-worded one");
      check(!rows.some((r) => /aggressive|hard stop/i.test(r.label)),
        "and the two noise settings are not offered");

      // Sections. The dashboard renders one <details> with a heading per
      // group, so every row needs one and the groups must not interleave —
      // a row landing back under an earlier heading would split a section.
      check(rows.every((r) => r.group && r.group.length > 2),
        "every row carries a section heading");
      const order = rows.map((r) => r.group);
      const firstSeen = [...new Set(order)];
      check(JSON.stringify(order) === JSON.stringify(
              firstSeen.flatMap((g) => order.filter((x) => x === g))),
        "and the sections are contiguous — no group reappears after another starts");
      const gTitles = [...settingsSrc.slice(gStart, settingsSrc.indexOf("\n  ];", gStart))
        .matchAll(/\n    \{\n      title: "([^"]+)"/g)].map((m) => m[1]);
      const catGroups = firstSeen.filter((g) => gTitles.includes(g));
      check(JSON.stringify(catGroups) === JSON.stringify(gTitles),
        "the category sections are the extension's own group titles, in its own order",
        JSON.stringify(catGroups));
    }
  }

  /* ══ PART 6 — through the real content.js, end to end ════════════════ */
  console.log("\n--- 14. a pinned category is actually detected again ---");
  {
    const { makeEnv, wait } = require("../harness.cjs");

    // Every category the user can switch off, so the fixture can turn the whole
    // detector off and let ONE lock turn a single category back on. Isolating
    // it this way means the assertion cannot be satisfied by some other
    // detector happening to fire on the same sentence.
    const settingsSrc = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
    const gStart = settingsSrc.indexOf("const GROUPS = [");
    const ALL = [...settingsSrc.slice(gStart, settingsSrc.indexOf("\n  ];", gStart))
      .matchAll(/\{ type: "([A-Z_]+)"/g)].map((m) => m[1]);

    const SENT = "Contact Sarah Chen on 0412 345 678";
    async function send(env) {
      env.EDITOR.textContent = SENT;
      env.EDITOR.dispatchEvent(new env.window.KeyboardEvent(
        "keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await wait(140);
    }
    const policyRec = (locks) => ({
      mode: "enforced", locks, version: 11,
      companyName: "Acme Pty Ltd", fetchedAt: T0, lastError: null,
    });

    {
      // Control: everything switched off, no policy. Nothing should be caught.
      const env = makeEnv({ seed: { guardai_disabled_categories: ALL } });
      await wait(90);
      await send(env);
      check(env.sentMessages.length === 1 && env.sentMessages[0].text === SENT,
        "control: with every category off, the message goes out exactly as typed");
    }
    {
      // The same off-list, plus a lock on ONE category.
      const env = makeEnv({ seed: {
        guardai_disabled_categories: ALL,
        guardai_policy: policyRec({ "cat:PHONE": true }),
      } });
      await wait(90);
      await send(env);
      check(env.sentMessages.length === 0,
        "a pinned category is detected again and the send is held, though the user had switched it off",
        "sent: " + env.sentMessages.length);
      check(env.document.querySelectorAll(".guardai-prompt, .guardai-panel").length > 0,
        "and the user is shown why");
      check(JSON.stringify(env.storage.guardai_disabled_categories) === JSON.stringify(ALL),
        "while their off-list on disk is untouched — every other category stays off");
    }
    {
      // A lock on a category the user had NOT switched off changes nothing,
      // and a lock on one they had does not drag the others back with it.
      const env = makeEnv({ seed: {
        guardai_disabled_categories: ALL,
        guardai_policy: policyRec({ "cat:MEDICARE": true }),
      } });
      await wait(90);
      await send(env);
      check(env.sentMessages.length === 1,
        "locking an unrelated category does not resurrect the rest of the off-list");
    }
    {
      // The isolation property the brief asked for, end to end: pin the master
      // switch and NOTHING else comes back with it.
      const env = makeEnv({ seed: {
        guardai_disabled_categories: ALL,
        guardai_enabled: false,
        guardai_policy: policyRec({ enabled: true }),
      } });
      await wait(90);
      await send(env);
      check(env.sentMessages.length === 1,
        "pinning the master switch turns Guard4AI back on without un-disabling a single category");
    }
    {
      // Flexible mode with locks stored: they must do nothing at all.
      const env = makeEnv({ seed: {
        guardai_disabled_categories: ALL,
        guardai_policy: { mode: "flexible", locks: { "cat:PHONE": true }, version: 12 },
      } });
      await wait(90);
      await send(env);
      check(env.sentMessages.length === 1,
        "under Flexible a stored category lock is inert, end to end");
    }
    {
      // A policy arriving mid-session, into a tab that is already open.
      const env = makeEnv({ seed: { guardai_disabled_categories: ALL } });
      await wait(90);
      env.window.chrome.storage.local.set({ guardai_policy: policyRec({ "cat:PHONE": true }) });
      await wait(140);
      await send(env);
      check(env.sentMessages.length === 0,
        "a lock that lands while the tab is open takes effect without a reload",
        "sent: " + env.sentMessages.length);
    }
  }

  console.log(failures ? `\nPOLICY: ${failures} FAILURE(S)` : "\nPOLICY: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error("policy.cjs threw:", err);
  process.exit(1);
});
