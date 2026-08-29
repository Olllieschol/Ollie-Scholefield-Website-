/**
 * The two standing notices in the popup — "connected, your admin sees counts"
 * and "some settings are locked on" — say their piece ONCE and then stay out
 * of the way. Repeating a standing fact on every open turns the top of the
 * popup into furniture, which is paid for by the messages that need reading.
 *
 * The dangerous half, and the reason this suite exists: "once" is keyed to
 * WHAT WAS SAID, not to a dismissed flag. If an admin pins another setting
 * later, or the seat moves to another company, that is a NEW fact and it gets
 * one more showing. A plain boolean would mean nobody is ever told about a
 * restriction that did not exist when they last looked.
 *
 * Loads the REAL popup.html and evaluates the real popup.js into it, like
 * test/popup-clear-arm.cjs, so the markup and ids cannot drift from
 * production.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/**
 * @param {object} storage shared across opens, exactly like real local storage
 * @param {object|null} connection what the worker reports for company status
 */
function openPopup(storage, connection) {
  const dom = new JSDOM(read("popup.html"), {
    url: "https://example.com/popup.html",
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
      getURL: (p) => "file://" + p,
      lastError: null,
      sendMessage: (msg, cb) => { if (typeof cb === "function") cb({ connection }); },
    },
    tabs: { create() {} },
  };
  window.eval(read("popup.js"));
  return { window, document: window.document };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = (doc, id) => doc.getElementById(id).classList.contains("is-on");

const ENFORCED = { mode: "enforced", locks: { enabled: true, files: true } };
const CO = { companyName: "Test co Guard AI v2" };

(async () => {
  console.log("\n--- 1. said once, then quiet ---");
  {
    const storage = { guardai_enabled: true, guardai_policy: ENFORCED };
    let env = openPopup(storage, CO);
    await wait(120);
    check(shown(env.document, "company-banner"), "first open: the company notice is shown");
    check(shown(env.document, "policy-banner"), "first open: the locked-settings notice is shown");
    check(env.document.getElementById("company-name").textContent === CO.companyName,
      "…and it names the company", env.document.getElementById("company-name").textContent);

    env = openPopup(storage, CO);
    await wait(120);
    check(!shown(env.document, "company-banner"), "second open: the company notice stays away");
    check(!shown(env.document, "policy-banner"), "second open: the locked notice stays away");

    env = openPopup(storage, CO);
    await wait(120);
    check(!shown(env.document, "company-banner") && !shown(env.document, "policy-banner"),
      "third open: still quiet");
  }

  console.log("\n--- 2. a NEW restriction is news, and gets one more showing ---");
  {
    const storage = { guardai_enabled: true, guardai_policy: ENFORCED };
    let env = openPopup(storage, CO);
    await wait(120);
    check(shown(env.document, "policy-banner"), "setup: shown once");
    env = openPopup(storage, CO);
    await wait(120);
    check(!shown(env.document, "policy-banner"), "setup: quiet on reopen");

    // The admin pins a third setting.
    storage.guardai_policy = { mode: "enforced", locks: { enabled: true, files: true, images: true } };
    env = openPopup(storage, CO);
    await wait(120);
    check(shown(env.document, "policy-banner"),
      "an admin pinning ANOTHER setting says its piece again — the user is told");
    env = openPopup(storage, CO);
    await wait(120);
    check(!shown(env.document, "policy-banner"), "…and then goes quiet again at the new state");
  }

  console.log("\n--- 3. a different company is a different fact ---");
  {
    const storage = { guardai_enabled: true };
    let env = openPopup(storage, CO);
    await wait(120);
    check(shown(env.document, "company-banner"), "setup: shown for the first company");
    env = openPopup(storage, CO);
    await wait(120);
    check(!shown(env.document, "company-banner"), "setup: quiet on reopen");

    env = openPopup(storage, { companyName: "Another Pty Ltd" });
    await wait(120);
    check(shown(env.document, "company-banner"),
      "moved to a different company: said again, and it names the new one");
    check(env.document.getElementById("company-name").textContent === "Another Pty Ltd",
      "…with the new company's name", env.document.getElementById("company-name").textContent);
  }

  console.log("\n--- 4. order does not create a new fact ---");
  {
    const storage = { guardai_enabled: true, guardai_policy: { mode: "enforced", locks: { enabled: true, files: true } } };
    let env = openPopup(storage, null);
    await wait(120);
    check(shown(env.document, "policy-banner"), "setup: shown once");
    // Same two locks, written in the other order. Nothing has changed for the
    // user, so nothing should be said — a fingerprint that keyed on insertion
    // order would re-show on every policy refresh.
    storage.guardai_policy = { mode: "enforced", locks: { files: true, enabled: true } };
    env = openPopup(storage, null);
    await wait(120);
    check(!shown(env.document, "policy-banner"),
      "the same locks in a different order stay quiet");
  }

  console.log("\n--- 5. controls: nothing to say, nothing shown ---");
  {
    const storage = { guardai_enabled: true };
    const env = openPopup(storage, null);
    await wait(120);
    check(!shown(env.document, "company-banner"),
      "an individual licence never sees the company notice");
    check(!shown(env.document, "policy-banner"),
      "…nor the locked-settings notice");
    check(!storage.guardai_notices_seen || !storage.guardai_notices_seen.policy,
      "and nothing is recorded as 'seen' that was never shown",
      JSON.stringify(storage.guardai_notices_seen));
  }

  console.log("\n--- 6. the facts still live in Settings, permanently ---");
  {
    // The popup notice going quiet is only acceptable because Settings keeps
    // both facts on screen every time it is opened. If either of these
    // disappears from settings.js, the popup's silence stops being honest.
    const settings = read("settings.js");
    check(/visible to your admin/.test(settings),
      "settings.js still states that the admin can see counts and categories");
    check(/Locked by admin|Set by /.test(settings),
      "settings.js still marks pinned controls as locked");
    const popup = read("popup.js");
    check(/guardai_notices_seen/.test(popup), "the popup records what it has already said");

    // Assert the RECORD'S SHAPE, not the source text. The first version of
    // this grepped popup.js for words like "dismissed" and failed on its own
    // explanatory comment — a test that reads prose instead of behaviour.
    // What matters is that the stored value identifies the fact: a boolean
    // could not tell a new lock from an old one.
    const storage = { guardai_enabled: true, guardai_policy: ENFORCED };
    const env = openPopup(storage, CO);
    await wait(120);
    const rec = storage.guardai_notices_seen;
    check(rec && typeof rec.policy === "string" && rec.policy.includes("enabled"),
      "what is stored is the policy's own fingerprint, not a flag", JSON.stringify(rec));
    check(rec && typeof rec.company === "string" && rec.company === CO.companyName,
      "…and the company's name, so a different company reads as different",
      JSON.stringify(rec));
  }

  console.log(`\nPOPUP NOTICE ONCE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
