/**
 * Per-item "forget this one" — the alternative to all-or-nothing Clear
 * session, for a user who wants to select which item(s) to delete rather
 * than wipe everything.
 *
 * Each "Masked" row in the panel now carries a small delete button. Clicking
 * it must, for exactly that one real<->fake pair:
 *   - flip it back to fake on the page (same "visible proof" principle as
 *     Clear session, just scoped to one item)
 *   - drop it from the masker (future auto-restore passes ignore it)
 *   - remove it from the activity log (and persist that)
 *   - leave every OTHER item completely untouched
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

const REAL_A = "0412 556 781", FAKE_A = "0400 000 111"; // item to delete
const REAL_B = "James Whitfield", FAKE_B = "Grace Wells"; // item that must survive

function makeEnv() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><main></main></body></html>`, {
    url: "https://chatgpt.com/c/item-delete-test",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const storage = {
    guardai_enabled: true,
    guardai_mapping: [
      { real: REAL_A, fake: FAKE_A, type: "PHONE", createdAt: Date.now() },
      { real: REAL_B, fake: FAKE_B, type: "NAME_PII", createdAt: Date.now() },
    ],
    guardai_activity: [
      { id: 1, kind: "mask", type: "PHONE", fake: FAKE_A, real: REAL_A, revealed: false, at: Date.now() },
      { id: 2, kind: "mask", type: "NAME_PII", fake: FAKE_B, real: REAL_B, revealed: false, at: Date.now() },
    ],
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
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!window.InputEvent) window.InputEvent = window.Event;
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) window.eval(read(f));

  const main = document.querySelector("main");
  const reply = document.createElement("div");
  reply.setAttribute("data-message-author-role", "assistant");
  reply.textContent = `Following up with ${REAL_B} on ${REAL_A}.`;
  main.appendChild(reply);

  return { window, document, storage, reply };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = makeEnv();
  await wait(300);
  check(env.reply.textContent.includes(REAL_A) && env.reply.textContent.includes(REAL_B),
    "setup: both real values show on the page", env.reply.textContent);

  env.document.querySelector(".guardai-reopen").click();
  await wait(150);

  const rows = env.document.querySelectorAll(".guardai-panel__row--mask");
  check(rows.length === 2, "setup: two 'Masked' rows in the panel", `got ${rows.length}`);
  const delButtons = env.document.querySelectorAll(".guardai-panel__itemdel");
  check(delButtons.length === 2, "setup: each Masked row has a delete button", `got ${delButtons.length}`);

  // Delete the row for item A (phone number) specifically, not item B.
  const rowA = [...rows].find((r) => r.textContent.includes(FAKE_A));
  check(!!rowA, "setup: found the row for the phone-number item");
  rowA.querySelector(".guardai-panel__itemdel").click();
  await wait(150);

  check(env.reply.textContent.includes(FAKE_A), "deleted item: the phone number flips back to fake on the page", env.reply.textContent);
  check(!env.reply.textContent.includes(REAL_A), "deleted item: the real phone number is gone from the page");
  check(env.reply.textContent.includes(REAL_B), "untouched item: the OTHER real value (name) is still shown as real — unaffected", env.reply.textContent);

  const hooks = env.window.GuardAI._restoreHooks;
  check(!hooks.masker.realToFake.has(REAL_A), "deleted item: dropped from the masker");
  check(hooks.masker.realToFake.has(REAL_B), "untouched item: still present in the masker");

  check(Array.isArray(env.storage.guardai_mapping) && env.storage.guardai_mapping.length === 1
    && env.storage.guardai_mapping[0].real === REAL_B,
    "deleted item: storage mapping now has exactly the surviving item", JSON.stringify(env.storage.guardai_mapping));

  const panelHooks = env.window.GuardAI._panelHooks;
  const log = panelHooks.getActivityLog();
  check(log.length === 1 && log[0].real === REAL_B,
    "deleted item: removed from the activity log, the other entry remains", JSON.stringify(log));
  check(Array.isArray(env.storage.guardai_activity) && env.storage.guardai_activity.length === 1,
    "deleted item: the persisted activity log reflects the deletion too", JSON.stringify(env.storage.guardai_activity));

  const remainingRows = env.document.querySelectorAll(".guardai-panel__row--mask");
  check(remainingRows.length === 1, "panel re-renders down to just the surviving row", `got ${remainingRows.length}`);

  console.log(`\nPANEL-ITEM-DELETE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
