/**
 * "Masking mode" (silent auto-mask): when on, sensitive data is masked and
 * sent automatically with NO warning card — GuardAI works invisibly. On any
 * failure/uncertainty it must fall back to the normal, fully-visible warning
 * card rather than either silently giving up or inventing its own recovery
 * UI. When off (default), behaviour is unchanged from before this feature.
 *
 * Reuses the same faithful editor model as harness-submit.cjs (real
 * beforeinput-driven submit simulation) since that's what actually exercises
 * doMaskAndSend()/triggerSend() realistically.
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, "..", "src", f), "utf8");

function makeEnv({ profile, maskingEnabled }) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: "https://chatgpt.com/c/silent-test",
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
  EDITOR.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) SUBMIT("editor-enter");
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
      const it = profile === "para-only" ? "insertParagraph" : "insertLineBreak";
      EDITOR.dispatchEvent(new window.InputEvent("beforeinput", { inputType: it, bubbles: true, cancelable: true }));
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

  const storage = { guardai_masking_enabled: !!maskingEnabled };
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
// Multi-line, like a real multi-record paste — the "para-only" failure mode
// (case 3 below) only manifests when the fill actually needs a line break;
// a single-line message would complete fine under either profile and never
// exercise the fallback this test is checking.
const SENSITIVE_TEXT =
  "I need to follow up with my client.\n\n" +
  "James Whitfield, phone 0412 556 781, email j.whitfield88@gmail.com.\n" +
  "Please write a follow up email.";

async function run(profile, maskingEnabled) {
  const env = makeEnv({ profile, maskingEnabled });
  const { document, EDITOR, sentMessages } = env;
  await wait(60);
  EDITOR.textContent = SENSITIVE_TEXT;
  // Sample the editor's inline opacity throughout: silent mode must hide the
  // box while it swaps the text, so the per-line re-type is never visible.
  const opacitySamples = [];
  const sampler = setInterval(() => opacitySamples.push(EDITOR.style.opacity), 5);
  EDITOR.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await wait(150);
    if (sentMessages.length > 0 || document.querySelector(".guardai-prompt--warn")) { await wait(200); break; }
  }
  clearInterval(sampler);
  // The cloak is released once the site empties the box (polled), so give that
  // a moment before recording the final, must-be-visible state.
  await wait(400);
  return {
    env,
    submitCount: sentMessages.length,
    sentText: sentMessages[0] && sentMessages[0].text,
    warningShown: !!document.querySelector(".guardai-prompt--warn"),
    wasCloaked: opacitySamples.some((o) => o === "0"),
    finalOpacity: EDITOR.style.opacity,
  };
}

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  /* ---- 1. Silent mode ON, healthy editor: masks + sends, NO warning card ---- */
  {
    const r = await run("softbreak-ok", true);
    check(r.submitCount === 1, "silent mode: exactly 1 send happens automatically", `got ${r.submitCount}`);
    check(!r.warningShown, "silent mode: the warning card never appears on the happy path");
    check(!!r.sentText && !r.sentText.includes("James Whitfield") && !r.sentText.includes("0412 556 781"),
      "silent mode: the sent text is actually masked, not the raw sensitive text", r.sentText);
    check(r.wasCloaked, "silent mode: the chat box is hidden while the text is swapped (no visible re-type)");
    check(r.finalOpacity !== "0", "silent mode: the chat box is visible again once the send completes", `opacity=${r.finalOpacity}`);

    // Per-message "Show what AI sees" buttons: silent mode leaves no trace,
    // even on a message that DOES contain masked data (the sent text itself,
    // reused here) — proving this is the silent-mode gate at work, not just
    // "there was nothing to toggle anyway".
    const { document } = r.env;
    const main = document.createElement("main");
    for (const role of ["user", "assistant"]) {
      const msg = document.createElement("div");
      msg.setAttribute("data-message-author-role", role);
      msg.textContent = "Following up — " + r.sentText;
      main.appendChild(msg);
    }
    document.body.appendChild(main);
    const hooks = r.env.window.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    check(document.querySelectorAll(".guardai-msgtoggle").length === 0,
      "silent mode: no per-message 'Show what AI sees' buttons are added to the page, even on messages with masked data");
  }

  /* ---- 1b. Same masked-data messages, silent mode OFF: the buttons still appear ---- */
  {
    // maskingEnabled:false never completes a real send (the warning card
    // blocks it), so nothing gets registered in masker the way case 1's run
    // did. Seed the mapping directly via the exposed test hook instead —
    // this is exactly what a real masked send would have left behind.
    const r = await run("softbreak-ok", false);
    r.env.window.GuardAI._restoreHooks.masker.registerManual(
      "James Whitfield", "Grace Wells", "NAME_PII"
    );
    r.env.window.GuardAI._restoreHooks.masker.registerManual(
      "0423 990 894", "0498 111 222", "PHONE"
    );
    const { document } = r.env;
    const main = document.createElement("main");
    for (const role of ["user", "assistant"]) {
      const msg = document.createElement("div");
      msg.setAttribute("data-message-author-role", role);
      msg.textContent = "Following up with Grace Wells about the project.";
      main.appendChild(msg);
    }
    document.body.appendChild(main);
    const hooks = r.env.window.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    check(document.querySelectorAll(".guardai-msgtoggle").length === 2,
      "masking mode off: the per-message toggle buttons still appear on messages with masked data",
      `got ${document.querySelectorAll(".guardai-msgtoggle").length}`);
    check(!r.wasCloaked, "masking mode off: the chat box is never hidden (normal visible flow)");

    // A message with NOTHING masked/maskable in it must never get the button
    // — this is the actual bug being fixed: previously every message got one
    // regardless of whether it had anything to do with GuardAI at all.
    const plain = document.createElement("div");
    plain.setAttribute("data-message-author-role", "assistant");
    plain.textContent = "Sure, here's a recipe for banana bread.";
    document.body.querySelector("main").appendChild(plain);
    hooks.decorateMessages(hooks.findResponseRoot());
    check(!plain.querySelector(".guardai-msgtoggle"),
      "masking mode off: an ordinary reply with no masked/maskable data gets NO toggle button");

    // Table-shaped reply: label and value sit in adjacent cells with no space
    // between them once flattened to .textContent ("PHONE0423 990 894..."),
    // which broke the word-boundary regex when the check ran against the
    // whole message as one concatenated string. Each cell's own text node is
    // still clean on its own, so a per-node check must still catch it.
    const tableMsg = document.createElement("div");
    tableMsg.setAttribute("data-message-author-role", "assistant");
    const table = document.createElement("table");
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = "PHONE";
    const valueCell = document.createElement("td");
    valueCell.textContent = "0423 990 894"; // the real value restored back in
    row.appendChild(labelCell);
    row.appendChild(valueCell);
    table.appendChild(row);
    tableMsg.appendChild(table);
    document.body.querySelector("main").appendChild(tableMsg);
    hooks.decorateMessages(hooks.findResponseRoot());
    check(!!tableMsg.querySelector(".guardai-msgtoggle"),
      "masking mode off: a table reply with a value glued to its label (no space) still gets the toggle button");
  }

  /* ---- 2. Silent mode OFF (default): unchanged existing behaviour ---- */
  {
    const r = await run("softbreak-ok", false);
    check(r.submitCount === 0, "masking mode off: raw send is still blocked (unchanged behaviour)", `got ${r.submitCount}`);
    check(r.warningShown, "masking mode off: the warning card still appears as before");
  }

  /* ---- 3. Silent mode ON but the fill fails (para-only editor): falls back to the warning card, never sends silently ---- */
  {
    const r = await run("para-only", true);
    check(r.submitCount === 0, "silent mode + failed fill: nothing is sent silently", `got ${r.submitCount}`);
    check(r.warningShown, "silent mode + failed fill: falls back to the normal warning card instead of staying silent");
    check(r.finalOpacity !== "0", "silent mode + failed fill: the chat box is uncovered again so the user can see their text", `opacity=${r.finalOpacity}`);
  }

  console.log(`\nSILENT-MODE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
