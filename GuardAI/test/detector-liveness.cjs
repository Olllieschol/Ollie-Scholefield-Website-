/**
 * Every detector runs, and every detector finds something.
 *
 * runDetector() catches whatever a detector throws and turns it into a
 * console.warn, on purpose: one bad detector must not take the whole scan
 * down, because a partial result is far safer than "detection crashed, so
 * nothing was flagged and the message went out unmasked".
 *
 * The cost of that design is silence. detectPassword referenced an undeclared
 * `m` from 21 August 2026 and threw on EVERY scan for sixteen days. Masking
 * kept working for every other category, the console said so on every
 * keystroke, and nobody read it. Connection strings and wallet seed phrases
 * went out unmasked that entire time.
 *
 * So this test does the reading. Two failures, both fatal:
 *   - a detector THREW (runDetector warned)
 *   - a detector found NOTHING for a value it is the only one that catches
 *
 * A detector with no sample here is also a failure. A new detector added to
 * scan() without one would otherwise be exempt from the only check that it
 * runs at all.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { scanUndeclared } = require("./_undeclared.cjs");

const ROOT = path.join(__dirname, "..");
let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
};

/* One sample per detector, each containing a value that detector should
   claim. Checksummed identifiers are reused from the existing suites rather
   than invented, because an invalid ABN would fail this test for the wrong
   reason and read as a dead detector. */
const SAMPLES = [
  ["creditCard",   "CREDIT_CARD",           "card 4111 1111 1111 1111 expires 05/28"],
  ["medicare",     "MEDICARE",              "Medicare 2123 45670 1 for the referral"],
  ["tfn",          "TFN",                   "TFN 123 456 782 on the form"],
  ["abn",          "ABN",                   "ABN 51 824 753 556 on the invoice"],
  ["acn",          "ACN",                   "ACN 004 085 616 on the register"],
  ["passport",     "PASSPORT",              "passport number PA1234567 expires next year"],
  ["licence",      "LICENCE",               "driver licence 12345678 issued in NSW"],
  ["bsb",          "BSB",                   "BSB 062-000 for the transfer"],
  ["bankAccount",  "BANK_ACCOUNT",          "BSB 062-000 account 1234 5678"],
  ["refCode",      "REF_CODE",              "your reference number is ABC-99213-XY"],
  ["gps",          "GPS",                   "meet at -33.8688, 151.2093 tomorrow"],
  ["email",        "EMAIL",                 "write to jane.doe@example.com about it"],
  ["phone",        "PHONE",                 "call me on 0412 334 556 tonight"],
  ["address",      "ADDRESS",               "posted to 14 Kellett Street, Potts Point NSW 2011"],
  ["dob",          "DOB",                   "date of birth 19/11/1992 on the application"],
  ["money",        "MONEY",                 "the invoice total is $1,250,000 including GST"],
  ["org",          "ORG",                   "the contract is with Northwind Traders Pty Ltd"],
  ["confidential", "CONFIDENTIAL",          "this document is strictly confidential, do not forward"],
  ["business",     "BUSINESS_CONFIDENTIAL", "our Q4 revenue forecast is well behind plan this year"],
  ["health",       "HEALTH",                "she was diagnosed with type 2 diabetes last winter"],
  ["legal",        "LEGAL",                 "the litigation with the supplier is still open"],
  ["immigration",  "IMMIGRATION",           "he is applying for a 482 visa through his employer"],
  ["password",     "PASSWORD",              "the password is Tr0ub4dor!"],
  ["username",     "USERNAME",              "my username is rwalsh_admin on that system"],
  ["names",        "NAME_PII",              "Priya Natarajan, email priya@example.com, needs the letter"],
];

/* Blocks inside one detector that a single sample would not reach. The
   password bug lived in the FOURTH block of detectPassword: the first three
   ran, pushed findings, and the throw came after them. A one-sample-per-
   detector test would have gone green through all sixteen days. */
const BRANCHES = [
  ["password / connection string", "PASSWORD", "db is postgres://admin:s3cr3t@db.internal:5432/main"],
  ["password / wallet seed",       "PASSWORD", "seed phrase is alpha bravo charlie delta echo foxtrot"],
  ["password / strong token",      "PASSWORD", "he sent me Xq7!kLm2Zp over chat"],
  ["password / no separator",      "PASSWORD", "pwd Summer2026! for the share"],
  ["password / for-the-X form",    "PASSWORD", "the password for the billing portal is Hunter2!x"],
  ["email / obfuscated",           "EMAIL",    "reach me at jane dot doe at example dot com"],
];

/**
 * Loaded in a plain vm context, NOT through test/_env.cjs.
 *
 * This is the whole reason the bug survived 59 green suites. detector.js opens
 * with "use strict", so `m = re.exec(text)` against an undeclared `m` is a
 * ReferenceError in Chrome. Inside JSDOM's window.eval it is not: the sandbox
 * global intercepts the assignment and quietly creates a property instead of
 * throwing. Verified directly — an explicit "use strict" function eval'd in
 * that window assigns to an undeclared name without complaint.
 *
 * So every suite built on loadWindow() is blind to this class of defect by
 * construction. A plain vm context enforces strict mode properly and throws
 * exactly where the browser does, which is the only environment in which this
 * test means anything.
 */
function loadDetector() {
  const win = {};
  const ctx = { window: win, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "detector.js"), "utf8"),
                  ctx, { filename: "src/detector.js" });
  return win;
}

(async () => {
  const win = loadDetector();
  const Detector = win.GuardAI.Detector;

  /* Proves the point above before relying on it. If this ever fails, the
     loader has stopped enforcing strict mode and sections 2 and 4 below are
     no longer testing anything. */
  {
    let threw = false;
    try {
      vm.runInNewContext('(function(){ "use strict"; undeclaredXyz = 1; })()', {});
    } catch (e) { threw = e && e.name === "ReferenceError"; }
    check(threw, "the loader enforces strict mode, so an undeclared assignment throws here as it does in Chrome");
  }

  /* A throw only ever surfaces as a console.warn, so the warn IS the signal.
     Captured rather than silenced: the message is what names the detector. */
  function scanCapturingWarnings(text) {
    const warned = [];
    const real = console.warn;
    console.warn = (...a) => {
      const line = a.map((x) => (x instanceof Error ? x.stack || String(x) : String(x))).join(" ");
      if (/detector "[^"]+" failed/.test(line)) warned.push(line);
    };
    try {
      return { out: new Detector().scan(text), warned };
    } finally {
      console.warn = real;
    }
  }

  console.log("\n--- 1. every detector in scan() has a sample ---");
  const src = fs.readFileSync(path.join(ROOT, "src", "detector.js"), "utf8");
  const wired = [...src.matchAll(/runDetector\("([A-Za-z]+)"/g)].map((m) => m[1]);
  const covered = new Set(SAMPLES.map((s) => s[0]));
  const missing = wired.filter((n) => !covered.has(n));
  check(missing.length === 0,
    `all ${wired.length} detectors wired into scan() are exercised here`,
    missing.length ? "no sample for: " + missing.join(", ") : "");
  const stale = SAMPLES.map((s) => s[0]).filter((n) => n !== "names" && !wired.includes(n));
  check(stale.length === 0, "and no sample names a detector that no longer exists", stale.join(", "));

  console.log("\n--- 2. no detector throws ---");
  /* Run every sample through every scan, not just its own: a detector that
     throws on somebody else's text is just as dead in production, where one
     message meets all of them at once. */
  const all = [...SAMPLES.map((s) => s[2]), ...BRANCHES.map((b) => b[2])];
  for (const [name, , text] of SAMPLES) {
    const { warned } = scanCapturingWarnings(text);
    check(warned.length === 0, `${name}: its own sample scans clean`,
      warned[0] && warned[0].split("\n")[0]);
  }
  const joined = scanCapturingWarnings(all.join("\n"));
  check(joined.warned.length === 0,
    "and every sample in one message, which is what a real paste looks like",
    joined.warned.map((w) => w.split("\n")[0]).join(" | "));

  console.log("\n--- 3. every detector actually finds something ---");
  for (const [name, type, text] of SAMPLES) {
    const { out } = scanCapturingWarnings(text);
    check(out.some((f) => f.type === type),
      `${name}: finds ${type} in its sample`,
      "found: " + ([...new Set(out.map((f) => f.type))].join(", ") || "nothing at all"));
  }

  console.log("\n--- 4. and every branch within a detector, not just the first ---");
  for (const [label, type, text] of BRANCHES) {
    const { out, warned } = scanCapturingWarnings(text);
    check(warned.length === 0, `${label}: does not throw`, warned[0] && warned[0].split("\n")[0]);
    check(out.some((f) => f.type === type), `${label}: finds ${type}`,
      "found: " + ([...new Set(out.map((f) => f.type))].join(", ") || "nothing at all"));
  }

  console.log("\n--- 5. the regression itself ---");
  /* Narrow and deliberate. The generic checks above would catch a rethrow of
     this exact bug, but this one names it, so a future reader knows the two
     categories that were silently lost rather than just "password broke". */
  const conn = scanCapturingWarnings("db is postgres://admin:s3cr3t@db.internal:5432/main");
  check(conn.out.some((f) => f.label === "Connection string with credentials"),
    "a connection string is masked whole, credentials and host together");
  const seed = scanCapturingWarnings("seed phrase is alpha bravo charlie delta echo foxtrot");
  check(seed.out.some((f) => f.label === "Wallet seed phrase"),
    "and a wallet seed phrase is caught");
  console.log("\n--- 6. and the branches no sample reaches ---");
  /* Sections 2 and 4 only see code a sample actually runs. The password bug
     was in the FOURTH block of detectPassword, so a suite without a
     connection-string sample would have stayed green through all sixteen
     days. This reads every branch instead of running it. */
  for (const f of ["detector.js", "masker.js", "filescan.js", "nlp-detector.js",
                   "entitlement.js", "policy.js", "content.js", "company.js"]) {
    const hits = scanUndeclared(path.join(ROOT, "src", f));
    check(hits.length === 0, `${f}: no function assigns to a name declared nowhere in scope`,
      hits.join("; "));
  }

  console.log(failures ? `\nDETECTOR-LIVENESS: ${failures} FAILURE(S)` : "\nDETECTOR-LIVENESS: ALL PASS");
  process.exit(failures ? 1 : 0);
})();
