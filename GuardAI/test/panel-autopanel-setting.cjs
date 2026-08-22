/**
 * "Detail panel" setting (guardai_autopanel_enabled): whether a deliberate
 * Mask & Send pops the full side panel open afterward, or just quietly
 * updates the collapsed badge (the same behaviour "Masking mode"/silent
 * send already gets). Default is OFF — most users found the panel jumping
 * open on every single send intrusive.
 *
 * Mask & Edit / Manual mask are UNAFFECTED by this setting: opening the
 * panel there is the direct result of clicking a button whose whole purpose
 * is "let me review before sending", not an unrequested side effect, so it
 * must always open regardless of the setting.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

/** See the note in test/_env.cjs: these suites test masking, not the licence
 *  gate, so they run as a licensed install. */
const LICENSED = () => ({
  guardai_entitlement: {
    status: "active", kind: "individual", token: "test-token",
    validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
  },
});

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, "..", "src", f), "utf8");

function makeEnv({ autopanelEnabled }) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: "https://chatgpt.com/c/autopanel-test",
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

  EDITOR.addEventListener("beforeinput", (e) => {
    if (e.defaultPrevented) return;
    if (e.inputType === "insertParagraph") { SUBMIT("editor-insertParagraph"); return; }
    if (e.inputType === "insertText" && e.data != null) { EDITOR.textContent += e.data; return; }
    if (e.inputType === "insertLineBreak") { EDITOR.textContent += "\n"; return; }
  });

  document.execCommand = function (cmd, ui, value) {
    cmd = String(cmd).toLowerCase();
    if (cmd === "delete") { EDITOR.textContent = ""; return true; }
    if (cmd === "inserttext") {
      if (value == null) return false;
      if (String(value).includes("\n")) {
        EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));
      } else {
        EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: String(value), bubbles: true, cancelable: true }));
      }
      return true;
    }
    if (cmd === "insertlinebreak") {
      EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true }));
      return true;
    }
    if (cmd === "inserthtml") { EDITOR.textContent += "\n"; return true; }
    return false;
  };

  window.InputEvent = class extends window.Event {
    constructor(type, init = {}) { super(type, init); this.inputType = init.inputType || ""; this.data = init.data; }
  };
  window.DataTransfer = function () { throw new Error("no DataTransfer"); };
  window.ClipboardEvent = window.Event;

  const storage = {
    ...LICENSED(),
    guardai_masking_enabled: false, // exercise the plain warning-card + Mask & Send flow
    guardai_autopanel_enabled: !!autopanelEnabled,
  };
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
const SENSITIVE_TEXT = "Client James Whitfield, phone 0412 556 781.";

async function run(autopanelEnabled) {
  const env = makeEnv({ autopanelEnabled });
  const { document, EDITOR, sentMessages } = env;
  await wait(60);
  EDITOR.textContent = SENSITIVE_TEXT;
  EDITOR.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

  let card = null;
  const d1 = Date.now() + 8000;
  while (Date.now() < d1) {
    await wait(100);
    card = document.querySelector(".guardai-prompt--warn");
    if (card) break;
  }
  document.querySelector(".guardai-prompt__btn--send").click();

  const d2 = Date.now() + 8000;
  while (Date.now() < d2) {
    await wait(100);
    if (sentMessages.length > 0) break;
  }
  await wait(150); // let the post-send panel/badge logic settle

  const panelEl = document.querySelector(".guardai-panel");
  const reopenEl = document.querySelector(".guardai-reopen");
  return {
    submitCount: sentMessages.length,
    panelVisible: !!(panelEl && panelEl.style.display !== "none"),
    badgeVisible: !!(reopenEl && reopenEl.style.display !== "none"),
  };
}

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  /* ---- Setting OFF (default): Mask & Send stays badge-only ---- */
  {
    const r = await run(false);
    check(r.submitCount === 1, "setting off: the message still sends", `got ${r.submitCount}`);
    check(!r.panelVisible, "setting off: the full panel does NOT pop open after Mask & Send");
    check(r.badgeVisible, "setting off: the collapsed badge is shown instead");
  }

  /* ---- Setting ON: Mask & Send pops the panel open, same as before this feature ---- */
  {
    const r = await run(true);
    check(r.submitCount === 1, "setting on: the message still sends", `got ${r.submitCount}`);
    check(r.panelVisible, "setting on: the full panel DOES pop open after Mask & Send");
  }

  console.log(`\nPANEL-AUTOPANEL-SETTING: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
