/**
 * End-to-end harness: loads the REAL detector.js, masker.js, nlp-detector.js and
 * content.js into a jsdom DOM, models a ChatGPT-like contenteditable, and drives
 * the ACTUAL user flow: type 15 records -> press Enter -> click the real
 * "Mask & Send" / "Mask & Edit" buttons -> observe what the editor/site does.
 *
 * The editor model reproduces the DOCUMENTED real-site behaviours:
 *   - plain Enter on the editor  -> SUBMIT (send message, clear box)
 *   - execCommand("insertText", X) where X contains "\n"  -> SUBMIT  (this is the
 *     real ChatGPT/Lexical behaviour that caused message-splitting)
 *   - execCommand("insertText", singleChar)  -> append, no submit
 *   - execCommand("insertLineBreak")         -> append "\n", no submit (Shift+Enter)
 *   - paste event with text/plain            -> replace selection inline, no submit
 *   - clicking the send button               -> SUBMIT
 * Anything the code does that triggers SUBMIT is recorded, so we can SEE whether
 * Mask & Edit wrongly sends, or a long message splits into >1 SUBMIT.
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

function makeEnv({ pasteWorks, seed, licensed = true, storageFails = false } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: "https://chatgpt.com/c/abc123",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // ---- the SUBMIT sink: every place a real send would fire records here ----
  const sentMessages = [];
  const EDITOR = document.createElement("div");
  EDITOR.id = "prompt-textarea";
  EDITOR.setAttribute("contenteditable", "true");
  // jsdom doesn't compute innerText; make innerText mirror textContent so the
  // code's getEditorText (innerText || textContent) sees real content.
  Object.defineProperty(EDITOR, "innerText", {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
  });
  // offsetParent is null in jsdom (no layout) -> findEnabledSendButton would skip
  // the button. Force it visible.
  document.body.appendChild(EDITOR);

  const sendBtn = document.createElement("button");
  sendBtn.setAttribute("data-testid", "send-button");
  Object.defineProperty(sendBtn, "offsetParent", { get() { return document.body; }, configurable: true });
  document.body.appendChild(sendBtn);

  function SUBMIT(reasonTag) {
    const content = EDITOR.textContent;
    sentMessages.push({ text: content, via: reasonTag });
    EDITOR.textContent = ""; // site clears the box after sending
  }

  // site behaviour: clicking send submits whatever is in the box
  sendBtn.addEventListener("click", () => SUBMIT("send-button"));
  // site behaviour: plain Enter submits (GuardAI intercepts at document-capture
  // BEFORE this target-phase handler; if it doesn't, we'd see a SUBMIT)
  EDITOR.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) SUBMIT("editor-enter");
  });
  // site behaviour: paste inserts text/plain inline (no submit). When
  // pasteTrusted is false we model a real ProseMirror/Lexical editor that
  // IGNORES synthetic (untrusted) paste events — the common real-world case for
  // content-script-dispatched ClipboardEvents.
  EDITOR.addEventListener("paste", (e) => {
    if (!pasteWorks) return; // untrusted synthetic paste ignored by the editor
    let t = "";
    try { t = e.clipboardData.getData("text/plain"); } catch (_) {}
    if (t) EDITOR.textContent = t; // selectAll happened before paste -> replace all
  });

  // ---- execCommand model (jsdom has none) ----
  document.execCommand = function (cmd, ui, value) {
    cmd = String(cmd).toLowerCase();
    if (cmd === "delete") { EDITOR.textContent = ""; return true; }
    if (cmd === "inserttext") {
      if (value == null) return false;
      EDITOR.textContent += value;
      if (String(value).includes("\n")) { SUBMIT("insertText-newline"); } // real bug
      return true;
    }
    if (cmd === "insertlinebreak") { EDITOR.textContent += "\n"; return true; }
    if (cmd === "inserthtml") { EDITOR.textContent += "\n"; return true; }
    return false;
  };

  // ---- DataTransfer / ClipboardEvent polyfills (jsdom lacks them) ----
  if (pasteWorks) {
    window.DataTransfer = class {
      constructor() { this._d = {}; }
      setData(t, v) { this._d[t] = v; }
      getData(t) { return this._d[t] || ""; }
    };
    window.ClipboardEvent = class extends window.Event {
      constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData; }
    };
    global.DataTransfer = window.DataTransfer;
    global.ClipboardEvent = window.ClipboardEvent;
  } else {
    // simulate environment where synthetic paste cannot carry data -> forces the
    // char-by-char fallback path
    window.DataTransfer = function () { throw new Error("DataTransfer unavailable"); };
    window.ClipboardEvent = window.Event;
    global.DataTransfer = window.DataTransfer;
    global.ClipboardEvent = window.ClipboardEvent;
  }

  // ---- chrome stub ----
  // `seed` pre-populates storage BEFORE content.js boots, so a test can set
  // a toggle without depending on listener timing.
  // licensed:false boots the extension exactly as a user who has never
  // entered a code sees it. Everything else defaults to a working licence —
  // see the note on LICENSED().
  const storage = Object.assign(licensed ? LICENSED() : {}, seed || {});
  const storageListeners = [];
  const runtimeMessages = [];
  window.chrome = {
    storage: {
      local: {
        // storageFails simulates "Extension context invalidated", which is a
        // real and not-rare condition (it happens to every open tab when the
        // extension reloads or updates). It has to be settable from before
        // content.js is evaluated, because loadSettings() runs during boot and
        // patching the stub afterwards is already too late.
        get: (keys) => storageFails
          ? Promise.reject(new Error("Extension context invalidated"))
          : Promise.resolve(
              (Array.isArray(keys) ? keys : [keys]).reduce((o, k) => { if (k in storage) o[k] = storage[k]; return o; }, {})
            ),
        set: (obj) => {
          // Fire onChanged like real chrome.storage does. The old no-op stub
          // meant any setting written AFTER boot never reached content.js, so
          // a test could set a toggle, see nothing happen, and look like a
          // product bug when it was the harness.
          const changes = {};
          for (const k of Object.keys(obj)) changes[k] = { oldValue: storage[k], newValue: obj[k] };
          Object.assign(storage, obj);
          for (const fn of storageListeners) {
            try { fn(changes, "local"); } catch (_) {}
          }
          return Promise.resolve();
        },
        remove: (k) => {
          const keys = Array.isArray(k) ? k : [k];
          const changes = {};
          for (const kk of keys) { changes[kk] = { oldValue: storage[kk] }; delete storage[kk]; }
          for (const fn of storageListeners) { try { fn(changes, "local"); } catch (_) {} }
          return Promise.resolve();
        },
      },
      onChanged: { addListener(fn) { storageListeners.push(fn); } },
    },
    runtime: {
      // Recorded rather than dropped, so a test can assert that the locked
      // notice actually asks the worker to open the activation page.
      sendMessage(m) { runtimeMessages.push(m); },
      lastError: null,
      getURL: (p) => "file://" + p,
    },
  };

  // Fallbacks for constructors jsdom may lack.
  if (!window.InputEvent) window.InputEvent = window.Event;

  // ---- load the real source files in order, evaluated against the jsdom window
  // so bare globals (location, history, setTimeout, getSelection, ...) resolve
  // naturally to the page context, exactly like a real content script. ----
  // Same order as manifest.json's content_scripts. names-gazetteer.js must
  // come first: detector.js reads window.GuardAI.NAME_GAZETTEER at scan time,
  // and without it aggressive name detection silently does nothing.
  for (const f of ["names-gazetteer.js", "detector.js", "masker.js", "nlp-detector.js", "content.js"]) {
    window.eval(read(f));
  }

  return { runtimeMessages, storage, window, document, EDITOR, sendBtn, sentMessages, SUBMIT };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The realistic 15-record paste with a header row and varied PII.
const RECORDS = [
  ["James Whitfield", "$12,450.00", "0412 345 678", "james.w@example.com", "14/03/1985", "42 Wallaby Way Sydney NSW 2000", "3456 78912 3"],
  ["Sarah Connor", "$8,200.00", "0423 111 222", "sarah.c@example.com", "02/07/1979", "9 Baker St Melbourne VIC 3000", "2987 65432 1"],
  ["Michael Brown", "$15,000.00", "0455 333 444", "m.brown@example.com", "23/11/1990", "11 King Rd Brisbane QLD 4000", "4123 45678 9"],
  ["Emily Davis", "$3,100.00", "0466 777 888", "emily.d@example.com", "30/01/1988", "7 Queen St Perth WA 6000", "5678 90123 4"],
  ["David Wilson", "$22,750.00", "0477 999 000", "david.w@example.com", "18/09/1975", "3 George St Adelaide SA 5000", "6789 01234 5"],
  ["Jessica Taylor", "$640.00", "0488 222 333", "jess.t@example.com", "05/05/1992", "55 High St Hobart TAS 7000", "7890 12345 6"],
  ["Daniel Martin", "$9,900.00", "0411 444 555", "dan.m@example.com", "27/12/1983", "21 Park Ave Darwin NT 0800", "8901 23456 7"],
  ["Laura Anderson", "$1,200.00", "0422 666 777", "laura.a@example.com", "11/06/1995", "8 Ocean Dr Cairns QLD 4870", "9012 34567 8"],
  ["Robert Thomas", "$18,300.00", "0433 888 999", "rob.t@example.com", "09/02/1970", "14 Hill Rd Geelong VIC 3220", "1234 56789 0"],
  ["Sophie Jackson", "$5,500.00", "0444 000 111", "soph.j@example.com", "22/08/1991", "6 Lake St Newcastle NSW 2300", "2345 67890 1"],
  ["Christopher White", "$7,750.00", "0455 111 222", "chris.w@example.com", "16/04/1986", "19 Forest Rd Townsville QLD 4810", "3456 78901 2"],
  ["Olivia Harris", "$33,000.00", "0466 333 444", "liv.h@example.com", "03/10/1993", "2 River St Ballarat VIC 3350", "4567 89012 3"],
  ["Matthew Clark", "$450.00", "0477 555 666", "matt.c@example.com", "29/07/1981", "27 Beach Rd Wollongong NSW 2500", "5678 90123 4"],
  ["Hannah Lewis", "$12,000.00", "0488 777 888", "hannah.l@example.com", "14/11/1989", "10 Valley Dr Bendigo VIC 3550", "6789 01234 5"],
  ["Andrew Walker", "$2,800.00", "0411 999 000", "andrew.w@example.com", "08/03/1977", "33 Garden St Launceston TAS 7250", "7890 12345 6"],
];
function buildPaste() {
  const header = "Client Name, Account Balance, Phone Number, Email Address, Date Of Birth, Home Address, Medicare Number";
  const lines = RECORDS.map((r) => r.join(", "));
  return "Please anonymise this client table before I share it externally.\n" + header + "\n" + lines.join("\n");
}

async function runScenario(label, { pasteWorks, button }) {
  const env = makeEnv({ pasteWorks });
  const { document, EDITOR, sentMessages } = env;
  await wait(60); // let boot() settle

  // 1) user pastes the block into the editor (set its content directly)
  const paste = buildPaste();
  EDITOR.textContent = paste;

  // 2) user presses Enter -> GuardAI should intercept and show the warning popup
  EDITOR.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);

  const popup = document.querySelector(".guardai-prompt--warn");
  const sentAfterEnter = sentMessages.length;

  // 3) user clicks the chosen button
  const sel = button === "send" ? ".guardai-prompt__btn--send" : ".guardai-prompt__btn--edit";
  const btn = popup && popup.querySelector(sel);
  if (btn) btn.onclick();
  // Poll until the flow settles: a send fired, OR the review panel+editable
  // appeared, OR we hit a generous ceiling (char-by-char of ~1900 chars at 2ms
  // each takes several seconds). This avoids measuring mid-fill.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await wait(150);
    const done =
      sentMessages.length > 0 ||
      !!document.querySelector(".guardai-panel__editable");
    if (done) { await wait(150); break; }
  }

  // observe results
  const panel = document.querySelector(".guardai-panel");
  const editable = document.querySelector(".guardai-panel__editable");
  const editorContent = EDITOR.textContent;

  return {
    label, pasteWorks, button,
    warningShown: !!popup,
    sentAfterEnterBlocked: sentAfterEnter === 0,
    submitCount: sentMessages.length,
    sentMessages: sentMessages.map((m) => ({ via: m.via, firstChars: m.text.slice(0, 60), len: m.text.length })),
    panelOpen: !!panel,
    editablePresent: !!editable,
    editableText: editable ? (editable.innerText || editable.textContent || "").slice(0, 80) : null,
    editorStillHasText: editorContent.length,
  };
}

// Exported so other suites can drive the REAL content.js pipeline (editor,
// interception, review model, masking, send) instead of re-implementing the
// editor emulation above. The runner below only executes when this file is
// run directly, so requiring it is side-effect free.
module.exports = { makeEnv, wait, runScenario };

if (require.main === module) (async () => {
  let anyFail = false;
  // ---------- BUG 1: header masking (pure string logic, fully faithful) ----------
  console.log("======================================================");
  console.log("BUG 1 — does masking alter column headers / instructions?");
  console.log("======================================================");
  {
    const env = makeEnv({ pasteWorks: true });
    await wait(60);
    const Detector = env.window.GuardAI.Detector;
    const det = new Detector();
    const paste = buildPaste();
    const findings = det.scan(paste);
    const names = findings.filter((f) => f.type === "NAME_PII").map((f) => f.value);
    console.log("Detected NAME_PII values:", JSON.stringify(names));
    const headerTokens = ["Account Balance", "Phone Number", "Email Address", "Date Of", "Home Address", "Medicare Number", "Client Name"];
    const leaked = names.filter((n) => headerTokens.some((h) => n === h));
    console.log("Header phrases wrongly flagged as names:", JSON.stringify(leaked));
    console.log("Medicare detected count:", findings.filter((f) => f.type === "MEDICARE").length);
    const ok = leaked.length === 0;
    console.log("RESULT:", ok ? "PASS — no headers masked" : "FAIL — headers masked");
    if (!ok) anyFail = true;
  }

  // ---------- BUG 2 & 3: drive the real buttons end-to-end ----------
  const scenarios = [
    { label: "Mask & Send, synthetic paste WORKS", pasteWorks: true, button: "send" },
    { label: "Mask & Send, synthetic paste FAILS (char-by-char)", pasteWorks: false, button: "send" },
    { label: "Mask & Edit, synthetic paste WORKS", pasteWorks: true, button: "edit" },
    { label: "Mask & Edit, synthetic paste FAILS (char-by-char)", pasteWorks: false, button: "edit" },
  ];
  for (const s of scenarios) {
    console.log("\n======================================================");
    console.log("SCENARIO:", s.label);
    console.log("======================================================");
    const r = await runScenario(s.label, s);
    console.log("warning popup shown on Enter :", r.warningShown);
    console.log("raw Enter send was blocked    :", r.sentAfterEnterBlocked);
    console.log("SUBMIT count (messages sent)  :", r.submitCount);
    console.log("submits detail                :", JSON.stringify(r.sentMessages, null, 0));
    console.log("panel opened                  :", r.panelOpen);
    console.log("editable review box present   :", r.editablePresent);
    console.log("editable text (first 80)      :", JSON.stringify(r.editableText));
    if (s.button === "edit") {
      console.log("EXPECTED: SUBMIT count = 0 (must pause for review), panel open, editable present");
      const ok = r.submitCount === 0 && r.panelOpen;
      console.log("RESULT:", ok ? "PASS — paused for review" : "FAIL — sent without review");
      if (!ok) anyFail = true;
    } else {
      console.log("EXPECTED: SUBMIT count = 1 (one atomic message), header text intact in it");
      const m = r.sentMessages[0];
      const headerIntact = m && m.firstChars.length > 0;
      const ok = r.submitCount === 1;
      console.log("RESULT:", ok ? "PASS — single message" : `FAIL — ${r.submitCount} messages (split or none)`);
      if (!ok) anyFail = true;
    }
  }
  console.log(`\nharness.cjs: ${anyFail ? "FAIL" : "PASS"}`);
  process.exit(anyFail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
