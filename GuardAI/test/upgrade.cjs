/**
 * Updating over an existing install: nobody is logged out, nobody re-enrols.
 *
 * ═══ WHAT THIS FILE IS DEFENDING ═══════════════════════════════════════════
 *
 * An extension update is the one moment the product can quietly destroy
 * something a person cannot get back. A renamed storage key orphans their
 * settings. A migration that writes where it should read flips a whole company
 * to enforced. A seeded policy that guesses "enforced" locks people out of
 * their own switches. None of these fail loudly at the time — the extension
 * carries on looking fine, and the damage is only visible to the person whose
 * invite code stopped working.
 *
 * Two layers, and they defend different things.
 *
 *   THE SHIPPED CONTRACT (always runs). Every storage key 1.0.0 wrote is
 *   listed below and this build must still read all of them. That list is a
 *   record of what actually shipped, so it is frozen deliberately rather than
 *   derived: a released version's storage keys are history, and history is not
 *   a thing the current source can be asked about. Rename a key and this fails
 *   on the next run with the key named.
 *
 *   THE REAL UPDATE (runs when the git objects are there). Three actual 1.0.0
 *   builds are checked out, installed, connected with an invite code, given a
 *   person's settings, and then this build is loaded over the SAME
 *   chrome.storage.local and sent Chrome's own onInstalled{reason:"update"}.
 *   The network is offline throughout, which is the worst case: nothing can be
 *   re-fetched, so anything that survives survives on its own.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SEAT = "3f9c22e1-7a44-4f0d-9b21-c1d4e5f60a77";

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/* ---------------------------------------------------------------------------
   1. The shipped contract
   --------------------------------------------------------------------------- */

/**
 * Every guardai_* key written by a 1.0.0 build, as a released version left it.
 *
 * FROZEN ON PURPOSE. Everything else in this repo derives its lists from the
 * source rather than copying them, and that is right when both ends are live.
 * Here one end is a version already installed on other people's machines: it
 * cannot be re-read, it will never change, and deriving it from today's source
 * would defeat the check entirely by agreeing with whatever today's source
 * says. Do not "fix" this by generating it.
 *
 * If a key below is genuinely being retired, the fix is a migration that reads
 * the old name and writes the new one — then move the key into RETIRED with
 * the release that migrates it, so the record of what shipped stays honest.
 */
const V1_KEYS = Object.freeze([
  "guardai_activity",
  "guardai_aggressive_names",
  "guardai_auto_restore",
  "guardai_autopanel_enabled",
  "guardai_company",
  "guardai_disabled_categories",
  "guardai_enabled",
  "guardai_entitlement",
  "guardai_file_scanning",
  "guardai_first_mask_seen",
  "guardai_image_hard_stop",
  "guardai_image_scanning",
  "guardai_lock_notice_seen",
  "guardai_mapping",
  "guardai_masking_enabled",
  "guardai_policy",
  "guardai_stats",
  "guardai_theme",
]);

/** Keys 1.0.0 wrote that a later build deliberately stopped reading, each with
 *  the migration that carried its value across. Empty, and the moment it is
 *  not, the entry has to name where the value went. */
const RETIRED = Object.freeze({});

/** Every .js the extension actually ships, which is where a key must be read. */
function shippedSources(dir, acc) {
  acc = acc || [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name === ".git" || name === "store") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) shippedSources(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

console.log("\n--- 1. every key 1.0.0 wrote is still read by this build ---");
{
  const src = shippedSources(ROOT).map((p) => fs.readFileSync(p, "utf8")).join("\n");
  const missing = V1_KEYS.filter((k) => !src.includes('"' + k + '"') && !src.includes("'" + k + "'"));
  const excused = missing.filter((k) => Object.prototype.hasOwnProperty.call(RETIRED, k));
  const orphaned = missing.filter((k) => !Object.prototype.hasOwnProperty.call(RETIRED, k));

  check(orphaned.length === 0,
    "all " + V1_KEYS.length + " keys from 1.0.0 are still referenced by name",
    orphaned.length
      ? "ORPHANED: " + orphaned.join(", ") +
        ". An installed 1.0.0 holds a value under that name and nothing reads it any " +
        "more. Either restore the name, or migrate it and record it in RETIRED."
      : "");
  if (excused.length) {
    console.log("note  migrated away, by declaration: " +
      excused.map((k) => k + " -> " + RETIRED[k]).join(", "));
  }

  // Keys this build adds are fine; keys it adds while SILENTLY needing a value
  // are not, so the new ones are listed and read defensively at their sites.
  const now = [...new Set((src.match(/"guardai_[a-zA-Z_]+"/g) || []).map((s) => s.slice(1, -1)))];
  const added = now.filter((k) => !V1_KEYS.includes(k)).sort();
  console.log("note  new since 1.0.0: " + (added.join(", ") || "none") +
    " (absent on every existing install, so each must read safely as missing)");
}

/* ---------------------------------------------------------------------------
   2. The real update
   --------------------------------------------------------------------------- */

/** The last commit at each shape of 1.0.0 worth updating from. */
const OLD_BUILDS = [
  { commit: "a0fe50f", what: "earliest build with company accounts (no entitlement record)" },
  { commit: "b6479e0", what: "company + entitlement, no policy" },
  { commit: "decd4fb", what: "the last 1.0.0 commit" },
];

function checkout(commit, into) {
  const r = spawnSync("git", ["archive", commit, "GuardAI"], {
    cwd: path.join(ROOT, ".."), encoding: "buffer", maxBuffer: 1 << 28,
  });
  if (r.status !== 0) return false;
  fs.mkdirSync(into, { recursive: true });
  const t = spawnSync("tar", ["-x", "-C", into, "--strip-components=1"], { input: r.stdout });
  if (t.status !== 0) return false;
  // Node needs to be told these are modules; the extension is told by its
  // manifest, which node does not read.
  fs.writeFileSync(path.join(into, "package.json"),
    JSON.stringify({ name: "old", private: true, type: "module" }));
  return fs.existsSync(path.join(into, "background.js"));
}

const drain = () => new Promise((r) => setTimeout(r, 12));
let seq = 0;

function makeChrome(storage) {
  const L = { installed: [], startup: [], message: [], changed: [] };
  return {
    listeners: L,
    chrome: {
      runtime: {
        onInstalled: { addListener: (f) => L.installed.push(f) },
        onStartup: { addListener: (f) => L.startup.push(f) },
        onMessage: { addListener: (f) => L.message.push(f) },
        getManifest: () => ({ version: "test" }),
      },
      storage: {
        local: {
          get: async (k) => {
            if (k == null) return { ...storage };
            const ks = Array.isArray(k) ? k : [k];
            const o = {};
            for (const kk of ks) if (kk in storage) o[kk] = storage[kk];
            return o;
          },
          set: async (o) => { Object.assign(storage, o); },
          remove: async (k) => { for (const kk of (Array.isArray(k) ? k : [k])) delete storage[kk]; },
        },
        onChanged: { addListener: (f) => L.changed.push(f) },
      },
      tabs: { create() {} },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    },
  };
}

/** Load one build's worker against a storage object. `net` answers every
 *  request, or returns "offline" to make fetch throw the way a flat network
 *  does. The SAME storage object is handed to the next build: that sharing is
 *  the whole simulation. */
async function load(dir, storage, net) {
  const env = makeChrome(storage);
  globalThis.chrome = env.chrome;
  env.calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    env.calls.push({ url: u, body });
    const r = net(u, body);
    if (r === "offline") throw new TypeError("Failed to fetch");
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      json: async () => r.body, text: async () => JSON.stringify(r.body),
    };
  };
  env.mod = await import("file://" + path.join(dir, "background.js") + "?u=" + (++seq));
  env.fire = async (kind, arg) => {
    for (const f of env.listeners[kind]) await f(arg);
    await drain();
  };
  /* The popup's own path. The oldest build exports nothing at all, so calling
     into the module is not an option — and this is the real path anyway. */
  env.ask = (m) => new Promise((res) => {
    let answered = false;
    for (const f of env.listeners.message) f(m, { id: "popup" }, (r) => { answered = true; res(r); });
    setTimeout(() => { if (!answered) res(null); }, 60);
  });
  return env;
}

const OK = (body) => ({ status: 200, body });
const CONNECT_REPLY = {
  employee_id: SEAT,
  company_name: "Acme Pty Ltd",
  policy: { mode: "flexible", locks: {}, version: 3 },
};

/* Settings moved off their defaults, so "survived" can be told apart from
   "was rewritten to the default and happens to match". */
const USER_SETTINGS = {
  guardai_masking_enabled: true,
  guardai_disabled_categories: ["MONEY", "DOB"],
  guardai_theme: "dark",
  guardai_autopanel_enabled: true,
  guardai_aggressive_names: true,
  guardai_image_hard_stop: true,
  guardai_auto_restore: false,
  guardai_first_mask_seen: true,
  guardai_mapping: { v: 1, items: [{ real: "Sarah Chen", fake: "Emma Walsh", type: "NAME_PII" }] },
  guardai_activity: [{ t: 1756000000000, type: "TFN", site: "chatgpt.com" }],
};

async function updateFrom(dir, label, P) {
  console.log("\n--- " + label + " -> this build, with the network down ---");
  const storage = {};

  const old = await load(dir, storage, () => OK(CONNECT_REPLY));
  await old.fire("installed", { reason: "install" });
  const res = await old.ask({ type: "GUARDAI_COMPANY_CONNECT", code: "GA-2NFZ-JRNM" });
  check(res && res.ok && res.connection && res.connection.employeeId === SEAT,
    "1.0.0 connected with the invite code", JSON.stringify(res));
  Object.assign(storage, USER_SETTINGS);
  const before = JSON.parse(JSON.stringify(storage));
  await drain();

  // Chrome swaps the files and fires this at the new build.
  const neu = await load(ROOT, storage, () => "offline");
  await neu.fire("installed", { reason: "update", previousVersion: "1.0.0" });
  await neu.fire("startup");
  await drain();

  check(storage.guardai_company && storage.guardai_company.employeeId === SEAT,
    "the seat is still connected, same employee id", JSON.stringify(storage.guardai_company));
  check(JSON.stringify(storage.guardai_company) === JSON.stringify(before.guardai_company),
    "the connection record is byte-identical: no re-enrolment, no new timestamp");

  const ent = storage.guardai_entitlement;
  check(Boolean(ent), "the entitlement record exists after the update", JSON.stringify(ent));
  if (before.guardai_entitlement) {
    const b = before.guardai_entitlement;
    const moved = [...new Set([...Object.keys(b), ...Object.keys(ent)])]
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(ent[k]));
    if (moved.length === 0) {
      check(true, "and is untouched by the update");
    } else {
      /* One allowed change. Company grants written before the record carried a
         seat id had token:null, which makes needsRefresh() false forever: they
         could never renew and would expire with nothing able to save them.
         adoptSeatToken fills in the id already sitting in guardai_company. It
         grants nothing and extends nothing. */
      check(moved.length === 1 && moved[0] === "token" && b.token === null && ent.token === SEAT,
        "the only field the update may move is the seat id, and only from null",
        moved.join(", "));
      check(ent.status === b.status && ent.validUntil === b.validUntil &&
            ent.hardStopAt === b.hardStopAt && ent.lastVerifiedAt === b.lastVerifiedAt,
        "status and every deadline are identical");
    }
  } else {
    check(ent.kind === "company" && ent.status !== "locked",
      "a build predating the record gets one, granted by the seat it already holds",
      JSON.stringify(ent));
  }
  const st = await neu.ask({ type: "GUARDAI_ENTITLEMENT_STATUS" });
  check(st && st.ok && st.allowed !== false, "and the holder is still allowed",
    JSON.stringify(st && { allowed: st.allowed, status: st.status }));

  const drifted = Object.keys(USER_SETTINGS).filter(
    (k) => JSON.stringify(storage[k]) !== JSON.stringify(USER_SETTINGS[k]));
  check(drifted.length === 0,
    "all " + Object.keys(USER_SETTINGS).length + " chosen settings are exactly as they were",
    drifted.join(", "));

  const lost = Object.keys(before).filter((k) => !(k in storage));
  check(lost.length === 0, "no key written by 1.0.0 was removed", lost.join(", "));

  const pol = await neu.mod.readPolicy();
  check(pol && pol.mode === "flexible", "a seat the server has never answered for reads flexible",
    JSON.stringify(pol && pol.mode));
  check(P.anyLocked(pol) === false, "with nothing locked");
  for (const name of [...P.BASE_LOCKS, P.catLock("TFN")]) {
    check(P.isLocked(pol, name) === false, "  '" + name + "' is not held on");
  }
  check(P.effective(false, pol, "enabled") === false,
    "a switch they turned off stays off — the update forces nothing on");
  check(JSON.stringify(P.effectiveDisabled(USER_SETTINGS.guardai_disabled_categories, pol)) ===
        JSON.stringify(USER_SETTINGS.guardai_disabled_categories),
    "and their disabled categories are untouched");
  check(P.setByLine(pol) === "", "the popup shows no 'locked by admin' line");

  const status = await neu.ask({ type: "GUARDAI_COMPANY_STATUS" });
  check(status && status.ok && status.connection && status.connection.employeeId === SEAT,
    "the popup still shows the seat as connected", JSON.stringify(status && status.connection));
  check(neu.calls.filter((c) => /disconnect|leave_company|release/.test(c.url)).length === 0,
    "the update made no call that could release the seat");
}

(async () => {
  const P = await import("file://" + path.join(ROOT, "src", "policy.js"));

  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guardai-upgrade-"));
    const built = [];
    for (const b of OLD_BUILDS) {
      const into = path.join(tmp, b.commit);
      if (checkout(b.commit, into)) built.push({ ...b, dir: into });
    }

    if (!built.length) {
      // A shallow clone or an exported tree has no history to update FROM.
      // Section 1 still ran and still catches a rename, which is the part that
      // must never be skipped.
      console.log("\nskip  no 1.0.0 builds in this checkout (shallow clone?); " +
        "the frozen key contract above still ran");
    } else {
      for (const b of built) await updateFrom(b.dir, b.commit + "  " + b.what, P);
    }

    console.log("\n--- an enforced company keeps its locks, and only those ---");
    {
      const storage = {};
      const dir = built.length ? built[built.length - 1].dir : ROOT;
      const old = await load(dir, storage, () => OK(CONNECT_REPLY));
      await old.fire("installed", { reason: "install" });
      await old.ask({ type: "GUARDAI_COMPANY_CONNECT", code: "GA-2NFZ-JRNM" });
      storage.guardai_policy = {
        mode: "enforced", locks: { files: true, "cat:TFN": true }, version: 7,
        companyName: "Acme Pty Ltd", fetchedAt: Date.now(), lastError: null,
      };
      storage.guardai_disabled_categories = ["TFN", "MONEY"];
      const beforePolicy = JSON.stringify(storage.guardai_policy);

      const neu = await load(ROOT, storage, () => "offline");
      await neu.fire("installed", { reason: "update", previousVersion: "1.0.0" });
      await neu.fire("startup");
      await drain();

      const pol = storage.guardai_policy;
      check(JSON.stringify(pol) === beforePolicy, "an offline update leaves the stored policy alone");
      check(P.isLocked(pol, "files") && P.isLocked(pol, P.catLock("TFN")),
        "the locks the admin set are still in force");
      check(!P.isLocked(pol, "enabled") && !P.isLocked(pol, "images") && !P.isLocked(pol, "masking"),
        "and were not widened to anything else");
      check(P.effective(false, pol, "images") === false,
        "an unlocked switch is still the person's own");
      check(JSON.stringify(P.effectiveDisabled(["TFN", "MONEY"], pol)) === JSON.stringify(["MONEY"]),
        "the locked category comes off the off-list; the other stays");
      check(JSON.stringify(storage.guardai_disabled_categories) === JSON.stringify(["TFN", "MONEY"]),
        "their own list is not rewritten, so lifting a lock restores it");
    }

    console.log("\n--- nobody without an employer gains a policy ---");
    {
      const storage = {
        guardai_entitlement: {
          status: "active", kind: "individual", token: "GK-XXXX",
          validUntil: Date.now() + 9e8, hardStopAt: Date.now() + 1e9,
          lastVerifiedAt: Date.now(), lastError: null,
        },
        guardai_enabled: true, guardai_masking_enabled: true,
      };
      const before = JSON.stringify(storage.guardai_entitlement);
      const neu = await load(ROOT, storage, () => "offline");
      await neu.fire("installed", { reason: "update", previousVersion: "1.0.0" });
      await neu.fire("startup");
      await drain();
      check(!("guardai_policy" in storage), "an individual licence gets no policy record");
      check((await neu.mod.readPolicy()) === null, "and readPolicy() answers null rather than seeding");
      check(JSON.stringify(storage.guardai_entitlement) === before, "their licence is untouched");
    }

    console.log("\n--- an install with no licence and no company ---");
    {
      const storage = { guardai_enabled: true, guardai_masking_enabled: true, guardai_theme: "dark" };
      const neu = await load(ROOT, storage, () => "offline");
      await neu.fire("installed", { reason: "update", previousVersion: "1.0.0" });
      await neu.fire("startup");
      await drain();
      check(!("guardai_policy" in storage), "no policy record");
      check(!("guardai_company" in storage), "no company appears from nowhere");
      check(storage.guardai_theme === "dark" && storage.guardai_masking_enabled === true,
        "settings intact");
      check(storage.guardai_entitlement && storage.guardai_entitlement.status !== "locked",
        "and an existing install is grandfathered rather than locked out by the update",
        JSON.stringify(storage.guardai_entitlement));
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? `\nUPGRADE: ${failures} FAILURE(S)` : "\nUPGRADE: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("upgrade.cjs threw:", e); process.exit(1); });
