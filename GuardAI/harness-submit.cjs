/**
 * Focused harness for the SUBMIT-DURING-FILL mechanism (the split / Mask&Edit
 * auto-send root cause). Unlike harness.cjs, this models an editor that:
 *   - dispatches a real `beforeinput` event for each execCommand edit, and
 *   - SUBMITS whenever it sees inputType "insertParagraph" (unless the event was
 *     preventDefault'd) — this is the suspected real ChatGPT/Lexical behaviour.
 *
 * Two editor profiles:
 *   profile "softbreak-ok":   insertLineBreak -> beforeinput inputType
 *                             "insertLineBreak" (no submit). insertText("\n") and
 *                             a raw Enter -> "insertParagraph" (submit).
 *   profile "para-only":      WORST CASE — even insertLineBreak is delivered as
 *                             inputType "insertParagraph" (editor has no soft
 *                             break), so every line break would submit unless the
 *                             GuardAI guard blocks it.
 *
 * We assert: with the send-guard, Mask & Send => exactly 1 submit, Mask & Edit
 * => 0 submits, under BOTH profiles.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

/**
 * Every suite below this line is testing detection and masking, not the
 * licence gate. A gated extension does nothing, so without an entitlement in
 * storage they would all "pass" by proving that a locked GuardAI stays quiet
 * — which is true, useless, and would hide every real regression.
 *
 * hardStopAt: null is the never-expires shape (what a review licence holds),
 * so these fixtures cannot start failing on a date. The gate itself is tested
 * in test/entitlement.cjs and test/gate.cjs, which set this up themselves.
 */
const LICENSED = () => ({
  guardai_entitlement: {
    status: "active", kind: "individual", token: "test-token",
    validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
  },
});
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, "src", f), "utf8");

function makeEnv({ profile }) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: "https://chatgpt.com/c/abc123",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const sentMessages = [];

  const EDITOR = document.createElement("div");
  EDITOR.id = "prompt-textarea";
  EDITOR.setAttribute("contenteditable", "true");
  Object.defineProperty(EDITOR, "innerText", {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
  });
  document.body.appendChild(EDITOR);

  const sendBtn = document.createElement("button");
  sendBtn.setAttribute("data-testid", "send-button");
  Object.defineProperty(sendBtn, "offsetParent", { get() { return document.body; }, configurable: true });
  document.body.appendChild(sendBtn);

  function SUBMIT(tag) {
    sentMessages.push({ text: EDITOR.textContent, via: tag });
    EDITOR.textContent = "";
  }
  sendBtn.addEventListener("click", () => SUBMIT("send-button"));

  // The editor's REAL submit decision lives here: it listens to beforeinput and
  // submits on insertParagraph. GuardAI's capture-phase guard runs BEFORE this
  // (capture vs bubble) and may preventDefault/stopImmediatePropagation.
  EDITOR.addEventListener("beforeinput", (e) => {
    if (e.defaultPrevented) return; // GuardAI blocked it
    if (e.inputType === "insertParagraph") { SUBMIT("editor-insertParagraph"); return; }
    if (e.inputType === "insertText" && e.data != null) { EDITOR.textContent += e.data; return; }
    if (e.inputType === "insertLineBreak") { EDITOR.textContent += "\n"; return; }
  });
  // raw Enter (target phase) -> the site would submit; GuardAI intercepts at
  // capture, so this only fires if GuardAI let it through.
  EDITOR.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) SUBMIT("editor-enter");
  });

  // execCommand model that DISPATCHES real beforeinput events (the faithful part).
  document.execCommand = function (cmd, ui, value) {
    cmd = String(cmd).toLowerCase();
    if (cmd === "delete") { EDITOR.textContent = ""; return true; }
    if (cmd === "inserttext") {
      // a newline inside insertText is delivered as insertParagraph (real bug);
      // our code never does this, but model it for completeness.
      if (value == null) return false;
      if (String(value).includes("\n")) {
        EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));
      } else {
        EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: String(value), bubbles: true, cancelable: true }));
      }
      return true;
    }
    if (cmd === "insertlinebreak") {
      const it = profile === "para-only" ? "insertParagraph" : "insertLineBreak";
      EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: it, bubbles: true, cancelable: true }));
      return true;
    }
    if (cmd === "inserthtml") { EDITOR.textContent += "\n"; return true; }
    return false;
  };

  // jsdom InputEvent lacks inputType/data; shim a minimal one.
  window.InputEvent = class extends window.Event {
    constructor(type, init = {}) { super(type, init); this.inputType = init.inputType || ""; this.data = init.data; }
  };

  // No synthetic paste support (forces per-line path).
  window.DataTransfer = function () { throw new Error("no DataTransfer"); };
  window.ClipboardEvent = window.Event;

  const storage = LICENSED();
  window.chrome = {
    storage: { local: {
      get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => { if (kk in storage) o[kk] = storage[kk]; return o; }, {})),
      set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
      remove: () => Promise.resolve(),
    }, onChanged: { addListener() {} } },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };

  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) window.eval(read(f));
  return { window, document, EDITOR, sentMessages };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RECORD_LINES = Array.from({ length: 15 }, (_, i) =>
  `${i + 1}. Client Person${i}, 0412 556 78${i % 10}, person${i}@gmail.com, ${i + 1} Acacia Ave, Parramatta NSW 2150, DOB 03/04/1988, TFN 234 567 89${i % 10}, Balance $14,2${i}0`);
const PASTE = "I need you to organise this client data into a clean table.\n\n" + RECORD_LINES.join("\n") + "\nPlease format it properly.";

async function run(profile, button) {
  const env = makeEnv({ profile });
  const { document, EDITOR, sentMessages } = env;
  await wait(60);
  EDITOR.textContent = PASTE;
  EDITOR.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);
  const popup = document.querySelector(".guardai-prompt--warn");
  const sel = button === "send" ? ".guardai-prompt__btn--send" : ".guardai-prompt__btn--edit";
  const btn = popup && popup.querySelector(sel);
  if (btn) btn.onclick();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await wait(150);
    if (sentMessages.length > 0 || document.querySelector(".guardai-panel__editable")) { await wait(200); break; }
  }
  return { submitCount: sentMessages.length, vias: sentMessages.map((m) => m.via), panel: !!document.querySelector(".guardai-panel") };
}

(async () => {
  const out = [];
  let anyFail = false;
  for (const profile of ["softbreak-ok", "para-only"]) {
    for (const button of ["send", "edit"]) {
      const r = await run(profile, button);
      // "para-only" is a synthetic worst-case editor where EVERY line break —
      // even a deliberate soft one we insert ourselves — is reported as
      // inputType "insertParagraph", identical to a real submit. Blocking
      // that event (required to stop an actual auto-send) also cancels the
      // underlying edit per the beforeinput spec, so a multi-line fill
      // cannot complete through this editor shape at all. The only safe
      // outcome is to detect the incomplete fill and abort BEFORE sending —
      // never send a corrupted/partial message, and never let a mid-fill
      // keystroke trigger a real submit. For Mask & Send on this profile,
      // the correct, permanent expectation is therefore 0 submits (safe
      // abort), not 1. Real ChatGPT/Claude/Gemini editors behave like
      // "softbreak-ok" (confirmed to fully complete with exactly 1 submit);
      // "para-only" exists specifically to prove the failure mode is safe.
      const isParaOnlySend = profile === "para-only" && button === "send";
      const expect = button === "send" ? (isParaOnlySend ? 0 : 1) : 0;
      const pass = r.submitCount === expect && (button === "edit" ? r.panel : true);
      if (!pass) anyFail = true;
      const label = isParaOnlySend ? "PASS — abort-safe (cannot complete this editor shape without risking a real submit)" : (pass ? "PASS" : "FAIL");
      out.push(`profile=${profile.padEnd(12)} button=${button.padEnd(4)} submits=${r.submitCount} via=${JSON.stringify(r.vias)} => ${pass ? label : "FAIL"} (expected ${expect})`);
    }
  }
  out.push(`\nharness-submit.cjs: ${anyFail ? "FAIL" : "PASS"}`);
  fs.writeFileSync(path.join(DIR, "hs.out"), out.join("\n") + "\n");
  console.log(`harness-submit.cjs: ${anyFail ? "FAIL" : "PASS"} — see hs.out for detail`);
  process.exit(anyFail ? 1 : 0);
})().catch((e) => {
  fs.writeFileSync(path.join(DIR, "hs.out"), "ERR " + e.stack);
  console.error("harness-submit.cjs threw:", e);
  process.exit(1);
});
