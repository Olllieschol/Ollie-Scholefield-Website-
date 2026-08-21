/**
 * Clearing the mapping must be VISIBLE, and it must be visible from BOTH
 * places that can trigger it.
 *
 * Reported bug: after clearing, the page kept showing the real (restored)
 * data — no sign anything happened. Two separate causes, both fixed here:
 *
 *   1. Neither clear path re-masked what was already on screen. The mapping
 *      disappearing doesn't retroactively un-restore text already swapped
 *      into the DOM — something has to explicitly flip it back to fake
 *      BEFORE the mapping backing that swap is gone. New remaskVisiblePage()
 *      does this, called from clearSession() (the panel button).
 *
 *   2. The popup's "Clear" button lives in a completely different script
 *      context from the page. It can only delete chrome.storage.local, not
 *      reach into a live tab's masker instance directly — and Masker.load()
 *      never re-reads storage after the first time (`_loaded` latches), so
 *      the page's in-memory table just kept working with data storage no
 *      longer has, invisible to the user. Fixed via a new
 *      chrome.storage.onChanged listener for guardai_mapping in content.js,
 *      which now remasks + calls the new Masker.forgetInMemory() whenever it
 *      sees the mapping emptied from anywhere, including the popup.
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

const REAL_PHONE = "0412 556 781";
const FAKE_PHONE = "0400 000 111";
const REAL_NAME = "James Whitfield";
const FAKE_NAME = "Grace Wells";

function makeEnv() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><main></main></body></html>`, {
    url: "https://chatgpt.com/c/clear-remask-test",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const storage = {
    guardai_enabled: true,
    guardai_mapping: [
      { real: REAL_PHONE, fake: FAKE_PHONE, type: "PHONE", createdAt: Date.now() },
      { real: REAL_NAME, fake: FAKE_NAME, type: "NAME_PII", createdAt: Date.now() },
    ],
    // Needed so startObserving() shows the collapsed badge (only reacts to
    // activityLog.length, not the mapping) — this test needs to click through
    // the real "Clear session" button, not just call the function directly.
    guardai_activity: [
      { id: 1, kind: "mask", type: "PHONE", fake: FAKE_PHONE, real: REAL_PHONE, revealed: false, at: Date.now() },
      { id: 2, kind: "mask", type: "NAME_PII", fake: FAKE_NAME, real: REAL_NAME, revealed: false, at: Date.now() },
    ],
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

  // A restored assistant reply, exactly as auto-restore would leave it: real
  // values already swapped into the DOM.
  const main = document.querySelector("main");
  const reply = document.createElement("div");
  reply.setAttribute("data-message-author-role", "assistant");
  reply.textContent = `Following up with ${REAL_NAME} on ${REAL_PHONE}.`;
  main.appendChild(reply);

  return { window, document, storage, reply };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---- 1. Panel's "Clear session" remasks the page before wiping ---- */
  {
    const env = makeEnv();
    await wait(300);
    check(env.reply.textContent.includes(REAL_NAME) && env.reply.textContent.includes(REAL_PHONE),
      "setup: the reply shows the real (restored) values", env.reply.textContent);

    env.document.querySelector(".guardai-reopen").click();
    await wait(150);
    env.document.querySelector(".guardai-panel__clear").click();
    await wait(150);

    check(env.reply.textContent.includes(FAKE_NAME) && env.reply.textContent.includes(FAKE_PHONE),
      "Clear session: the page flips back to showing the FAKE values", env.reply.textContent);
    check(!env.reply.textContent.includes(REAL_NAME) && !env.reply.textContent.includes(REAL_PHONE),
      "Clear session: the real values are gone from the screen");
    check(!Array.isArray(env.storage.guardai_mapping) || env.storage.guardai_mapping.length === 0,
      "Clear session: the mapping is actually gone from storage too", JSON.stringify(env.storage.guardai_mapping));
  }

  /* ---- 1b. Cancelling the confirm() prompt must leave everything alone ---- */
  {
    const env = makeEnv();
    await wait(300);
    env.window.confirm = () => false; // user clicks "Cancel"
    env.document.querySelector(".guardai-reopen").click();
    await wait(150);
    env.document.querySelector(".guardai-panel__clear").click();
    await wait(150);

    check(env.reply.textContent.includes(REAL_NAME) && env.reply.textContent.includes(REAL_PHONE),
      "cancelled confirm: the page is untouched, still showing real data", env.reply.textContent);
    check(Array.isArray(env.storage.guardai_mapping) && env.storage.guardai_mapping.length === 2,
      "cancelled confirm: the mapping is NOT deleted", JSON.stringify(env.storage.guardai_mapping));
  }

  /* ---- 2. The popup's Clear (storage.local.remove from OUTSIDE the page) also remasks ---- */
  {
    const env = makeEnv();
    await wait(300);
    check(env.reply.textContent.includes(REAL_NAME), "setup: reply shows real data again for the popup-clear case");

    // Exactly what popup.js does: it never touches this page's masker
    // instance, only storage.
    await env.window.chrome.storage.local.remove("guardai_mapping");
    await wait(150);

    check(env.reply.textContent.includes(FAKE_NAME) && env.reply.textContent.includes(FAKE_PHONE),
      "popup Clear: a storage-only removal from OUTSIDE this page still remasks the page", env.reply.textContent);
    check(env.window.GuardAI._restoreHooks.masker.size === 0,
      "popup Clear: this page's in-memory mapping is dropped too (forgetInMemory), not left stale");
  }

  console.log(`\nCLEAR-REMASKS-PAGE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
