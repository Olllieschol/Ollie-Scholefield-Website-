/**
 * Popup "Clear all data" — click-to-arm, click-again-to-confirm.
 *
 * NOT window.confirm(): Chrome closes an extension's action popup the
 * instant a native alert/confirm/prompt would open inside it, so a real
 * confirm() call there silently eats the click instead of asking anything.
 * The popup instead arms itself on the first click (button label changes,
 * nothing is deleted yet) and only actually clears on a second click within
 * a short window; letting that window lapse disarms it back to normal.
 *
 * Loads the REAL popup.html (for the actual markup/ids) and evaluates the
 * real popup.js into it, rather than hand-building a fixture that could
 * drift from production markup.
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

function makeEnv(seedMapping) {
  // A plain https URL, not a chrome-extension:// one: jsdom throws on
  // localStorage access (which popup.js does at top level, for the theme
  // preference) under that scheme's opaque origin. The URL is otherwise
  // irrelevant to this test.
  const dom = new JSDOM(read("popup.html"), {
    url: "https://example.com/popup.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const storage = {
    guardai_enabled: true,
    guardai_mapping: seedMapping,
  };
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
    runtime: { getURL: (p) => "file://" + p },
    tabs: { create() {} },
  };
  // Real extension popups never see window.confirm/alert/prompt fire —
  // stub them to make that failure mode loud if the arm/disarm logic ever
  // regresses back to relying on one.
  window.confirm = () => { throw new Error("popup.js must not call window.confirm()"); };
  window.alert = () => { throw new Error("popup.js must not call window.alert()"); };

  window.eval(read("popup.js"));
  return { window, document: window.document, storage };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const SEED = [
    { real: "0412 556 781", fake: "0400 000 111", type: "PHONE", createdAt: Date.now() },
  ];

  /* ---- First click arms, does not delete ---- */
  {
    const env = makeEnv([...SEED]);
    await wait(100);
    const btn = env.document.getElementById("clear-map");
    check(btn.textContent.trim() === "Clear all data", "initial label is 'Clear all data'", btn.textContent);

    btn.click();
    await wait(50);
    check(btn.textContent !== "Clear all data", "first click arms: label changes (asks for a second click)", btn.textContent);
    check(Array.isArray(env.storage.guardai_mapping) && env.storage.guardai_mapping.length === 1,
      "first click arms: nothing is deleted yet", JSON.stringify(env.storage.guardai_mapping));
  }

  /* ---- Second click within the window actually clears ---- */
  {
    const env = makeEnv([...SEED]);
    await wait(100);
    const btn = env.document.getElementById("clear-map");
    btn.click();
    await wait(50);
    btn.click(); // confirm
    await wait(100);

    check(!Array.isArray(env.storage.guardai_mapping) || env.storage.guardai_mapping.length === 0,
      "second click confirms: the mapping is actually deleted", JSON.stringify(env.storage.guardai_mapping));
  }

  /* ---- Letting the arm window lapse disarms it — a stray later click doesn't clear ---- */
  {
    const env = makeEnv([...SEED]);
    await wait(100);
    const btn = env.document.getElementById("clear-map");
    btn.click(); // arm
    await wait(50);
    check(btn.textContent !== "Clear all data", "armed: label shows the confirm state");

    await new Promise((r) => setTimeout(r, 4200)); // past the 4s arm window
    check(btn.textContent.trim() === "Clear all data", "arm window lapses: label reverts on its own", btn.textContent);

    btn.click(); // this is now a FIRST click again (re-arms), not a confirm
    await wait(50);
    check(Array.isArray(env.storage.guardai_mapping) && env.storage.guardai_mapping.length === 1,
      "post-lapse click only re-arms, does not delete", JSON.stringify(env.storage.guardai_mapping));
  }

  console.log(`\nPOPUP-CLEAR-ARM: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
