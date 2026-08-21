/**
 * The activity panel must never pop open on its own — only the small
 * collapsed badge should appear passively (on page load with saved history,
 * or when auto-restore silently logs a swap in a response the user didn't
 * explicitly ask to review). The full panel should only ever open via a
 * deliberate user action: clicking the badge, Mask & Edit / Manual mask
 * (which always force it open — that's the whole point of those buttons),
 * or Mask & Send when the opt-in "Detail panel" setting is on (see
 * test/panel-autopanel-setting.cjs — Mask & Send is badge-only by default).
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

function loadWindow(seedStorage) {
  const dom = new JSDOM("<!DOCTYPE html><body><main></main></body>", {
    url: "https://chatgpt.com/c/panel-test",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = { ...seedStorage };
  w.chrome = {
    storage: {
      local: {
        get: (k) =>
          Promise.resolve(
            (Array.isArray(k) ? k : [k]).reduce((o, kk) => {
              if (kk in storage) o[kk] = storage[kk];
              return o;
            }, {})
          ),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  return w;
}

(async () => {
  /* ---- 1. Page load with saved history: badge only, never the full panel ---- */
  {
    const seededLog = [
      { id: 1, kind: "mask", type: "NAME_PII", fake: "David Clarke", real: "James Whitfield", revealed: false, at: Date.now() },
    ];
    const w = loadWindow({ guardai_enabled: true, guardai_activity: seededLog });
    for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
    await new Promise((r) => setTimeout(r, 250));

    const hooks = w.GuardAI._panelHooks;
    check(!hooks.isPanelVisible(), "full panel is NOT shown on load, despite saved history");
    check(hooks.isReopenVisible(), "collapsed badge IS shown on load, so history is still reachable");
  }

  /* ---- 2. Passive "unmask" activity (auto-restore) never pops the panel ---- */
  {
    const w = loadWindow({ guardai_enabled: true });
    for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
    await new Promise((r) => setTimeout(r, 150));

    const hooks = w.GuardAI._panelHooks;
    check(!hooks.isPanelVisible(), "panel starts closed on a fresh session with no history");

    // Simulate what runUnmaskPass() does when auto-restore silently finds a
    // fake in a response: it calls logActivity("unmask", [...]) with no
    // explicit user action around it.
    hooks.logActivity("unmask", [{ type: "PHONE", fake: "0459 922 197", real: "0412 556 781" }]);
    check(!hooks.isPanelVisible(), "panel stays closed after a passive auto-restore event");
    check(hooks.isReopenVisible(), "badge appears/updates after a passive auto-restore event");
    check(hooks.getActivityLog().length === 1, "the swap was still logged (just not shown intrusively)");
  }

  /* ---- 3. If the user HAS the panel open, new activity keeps it live ---- */
  {
    const w = loadWindow({ guardai_enabled: true });
    for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
    await new Promise((r) => setTimeout(r, 150));

    const hooks = w.GuardAI._panelHooks;
    // Log one item to create the panel element, then force it open the way a
    // deliberate user action (clicking the badge) would.
    hooks.logActivity("mask", [{ type: "EMAIL", fake: "a@b.com", real: "real@example.com" }]);
    const reopen = w.document.querySelector(".guardai-reopen");
    if (reopen) reopen.click(); // simulates the user opening it themselves
    check(hooks.isPanelVisible(), "panel is visible after the user explicitly opens it");

    hooks.logActivity("unmask", [{ type: "PHONE", fake: "0459 922 197", real: "0412 556 781" }]);
    check(hooks.isPanelVisible(), "panel STAYS visible (live-updates) once the user already has it open");
  }

  console.log(`\nPANEL-NO-AUTOOPEN: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
