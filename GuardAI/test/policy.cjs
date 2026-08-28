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
  check(P.LOCKABLE.every((n) => P.effective(false, enforced, n) === true),
    "every lockable switch can only ever be forced ON — there is no remote off switch");

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
    P.provisional(T0),
  ];
  let mismatch = 0;
  for (const pol of matrix) {
    for (const name of ["enabled", "files", "images", "nonsense"]) {
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
    await env.mod.activateCode("GA-ABCD-EFGH");
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
    await env.mod.activateCode("GA-ABCD-EFGH");
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
      check(w.document.getElementById("policy-who").textContent === "Acme Pty Ltd",
        "popup: and names the company that set it");
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
      check(badges.length === 2 && badges.every((b) => /Acme Pty Ltd/.test(b.textContent)),
        "settings: each says who set it");
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
  }

  console.log(failures ? `\nPOLICY: ${failures} FAILURE(S)` : "\nPOLICY: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error("policy.cjs threw:", err);
  process.exit(1);
});
