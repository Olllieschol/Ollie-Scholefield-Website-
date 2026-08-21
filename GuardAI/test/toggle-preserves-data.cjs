/**
 * The master on/off toggle must PAUSE, never wipe.
 *
 * Reported as "toggling off/on is wiping detection data". The stored data was
 * in fact never deleted — but teardownUI() hid the collapsed badge and nothing
 * re-showed it on re-enable (only startObserving() had the "saved log ->
 * showReopen()" logic, and that runs on page load). So an off/on cycle left
 * previously masked history invisible until the next reload, which from the
 * user's side is indistinguishable from having wiped it.
 *
 * Guarded here:
 *   - OFF hides all UI but touches neither the activity log nor the mapping,
 *     in memory OR in storage.
 *   - ON restores the badge, and re-opens the full panel if that's how the
 *     user left it, with the history intact.
 *   - "Clear session" remains the only path that actually deletes.
 *
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

const SEEDED_LOG = [
  { id: 1, kind: "mask", type: "PHONE", fake: "0400 000 111", real: "0412 556 781", revealed: false, at: Date.now() },
  { id: 2, kind: "mask", type: "NAME_PII", fake: "Grace Wells", real: "James Whitfield", revealed: false, at: Date.now() },
];
const SEEDED_MAPPING = [
  { real: "0412 556 781", fake: "0400 000 111", type: "PHONE", createdAt: Date.now() },
  { real: "James Whitfield", fake: "Grace Wells", type: "NAME_PII", createdAt: Date.now() },
];

function makeEnv() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><main></main></body></html>`, {
    url: "https://chatgpt.com/c/toggle-test",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const storage = {
    guardai_enabled: true,
    guardai_activity: SEEDED_LOG.map((e) => ({ ...e })),
    guardai_mapping: SEEDED_MAPPING.map((e) => ({ ...e })),
  };
  const listeners = [];
  window.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk];
          return o;
        }, {})),
        set: (o) => {
          const changes = {};
          for (const [k, v] of Object.entries(o)) { changes[k] = { oldValue: storage[k], newValue: v }; storage[k] = v; }
          listeners.forEach((fn) => fn(changes, "local"));
          return Promise.resolve();
        },
        remove: (k) => {
          const keys = Array.isArray(k) ? k : [k];
          const changes = {};
          for (const kk of keys) { changes[kk] = { oldValue: storage[kk], newValue: undefined }; delete storage[kk]; }
          listeners.forEach((fn) => fn(changes, "local"));
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!window.InputEvent) window.InputEvent = window.Event;
  // jsdom doesn't implement window.confirm (it's a no-op returning
  // undefined/falsy) — Clear session now gates on it, so stub it to actually
  // confirm, matching what a real user clicking "OK" would do.
  window.confirm = () => true;
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) window.eval(read(f));
  return { window, document: window.document, storage };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function view(env) {
  const panel = env.document.querySelector(".guardai-panel");
  const reopen = env.document.querySelector(".guardai-reopen");
  return {
    memLog: env.window.GuardAI._panelHooks.getActivityLog().length,
    storeLog: Array.isArray(env.storage.guardai_activity) ? env.storage.guardai_activity.length : -1,
    storeMap: Array.isArray(env.storage.guardai_mapping) ? env.storage.guardai_mapping.length : -1,
    badge: !!(reopen && reopen.style.display !== "none"),
    panel: !!(panel && panel.style.display !== "none"),
  };
}
const setEnabled = (env, on) => env.window.chrome.storage.local.set({ guardai_enabled: on });

(async () => {
  /* ---- 1. Badge case: panel closed when toggled off ---- */
  {
    const env = makeEnv();
    await wait(300);
    const boot = view(env);
    check(boot.memLog === 2 && boot.badge, "boot: saved history shows the collapsed badge", JSON.stringify(boot));

    await setEnabled(env, false);
    await wait(250);
    const off = view(env);
    check(!off.badge && !off.panel, "off: all GuardAI UI is hidden");
    check(off.memLog === 2, "off: the in-memory activity log is NOT cleared", `got ${off.memLog}`);
    check(off.storeLog === 2, "off: stored activity is NOT deleted", `got ${off.storeLog}`);
    check(off.storeMap === 2, "off: the fake<->real mapping is NOT deleted", `got ${off.storeMap}`);

    await setEnabled(env, true);
    await wait(350);
    const on = view(env);
    check(on.badge, "on: the badge comes back without needing a page reload");
    check(on.storeLog === 2 && on.memLog === 2, "on: the history is intact", JSON.stringify(on));
  }

  /* ---- 2. Panel case: panel left OPEN when toggled off ---- */
  {
    const env = makeEnv();
    await wait(300);
    env.document.querySelector(".guardai-reopen").click(); // user opens the panel
    await wait(150);
    check(view(env).panel, "setup: clicking the badge opens the full panel");

    await setEnabled(env, false);
    await wait(250);
    check(!view(env).panel, "off: an open panel is hidden too");

    await setEnabled(env, true);
    await wait(350);
    const on = view(env);
    check(on.panel, "on: a panel the user had OPEN is restored open, not demoted to the badge");
    check(on.storeLog === 2, "on: history still intact in the restored panel", `got ${on.storeLog}`);
  }

  /* ---- 3. Clear session is still the one thing that wipes ---- */
  {
    const env = makeEnv();
    await wait(300);
    env.document.querySelector(".guardai-reopen").click();
    await wait(150);
    env.document.querySelector(".guardai-panel__clear").click();
    await wait(250);
    const cleared = view(env);
    check(cleared.memLog === 0, "clear session: the activity log IS wiped", `got ${cleared.memLog}`);
    check(cleared.storeLog === 0, "clear session: stored activity IS wiped", `got ${cleared.storeLog}`);
  }

  console.log(`\nTOGGLE-PRESERVES-DATA: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
