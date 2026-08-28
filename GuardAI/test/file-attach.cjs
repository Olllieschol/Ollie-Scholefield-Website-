/**
 * Attachment interception: quarantine, decide, release.
 *
 * ═══ WHAT WAS MEASURED, AND WHERE ══════════════════════════════════════════
 *
 * Two different things are being tested and they need different evidence.
 *
 * The MECHANISM — can a capture listener stop a file reaching the site, and
 * does the site accept the file when we hand it back — cannot be established
 * in jsdom, because jsdom has no React, no upload code and no DataTransfer.
 * It was measured on the live sites instead, with the network stubbed so that
 * nothing uploaded:
 *
 *   chatgpt.com   synthetic change on #upload-files  -> POST /backend-api/files
 *                 same event with a window-capture stopImmediatePropagation
 *                 -> no request at all, input emptied, nothing rendered
 *   claude.ai     same result via POST .../wiggle/upload
 *   gemini        same result via push.clients6.google.com/upload/
 *
 *   claude.ai     synthetic DROP carrying the same file -> NOTHING. The
 *                 dragenter overlay appears, the drop is ignored. So a drop
 *                 can be blocked but never replayed, and release has to go
 *                 through the file input for all three entry points.
 *
 * The DECISION LOGIC — which input, which file, whether an approval is
 * remembered — is what this file tests, because that is where the bugs live.
 * ChatGPT ships three file inputs, two of them image-only; Gemini creates and
 * discards them as you go. "The first input on the page" is wrong on both.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/**
 * jsdom has no DataTransfer, MessageChannel, DragEvent or ClipboardEvent, and
 * input.files is read-only. These stubs are the environment, not the subject:
 * every one of them mirrors behaviour confirmed in a real browser above.
 */
function installFileEnv(w) {
  class FakeDataTransfer {
    constructor() {
      this._files = []; this._data = {};
      this.items = { add: (f) => this._files.push(f) };
    }
    setData(type, value) { this._data[type] = value; }
    getData(type) { return this._data[type] || ""; }
    get files() { const l = this._files.slice(); l.item = (i) => l[i]; return l; }
  }
  w.DataTransfer = FakeDataTransfer;
  w.DragEvent = class DragEvent extends w.Event {
    constructor(type, init = {}) { super(type, init); this.dataTransfer = init.dataTransfer || null; }
  };
  w.ClipboardEvent = class ClipboardEvent extends w.Event {
    constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData || null; }
  };
  Object.defineProperty(w.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() { return this.__files || Object.assign([], { item: () => null }); },
    set(v) { this.__files = v; },
  });
}

function makeFile(w, name, size = 1000, type = "") {
  return { name, size, type, lastModified: 1700000000000,
           arrayBuffer: () => Promise.resolve(new ArrayBuffer(size)) };
}

function loadPage(bodyHTML, url = "https://chatgpt.com/c/x", seed = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${bodyHTML}</body>`, {
    url, runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window;
  // Seeded before content.js runs, deliberately. loadSettings() reads storage
  // once during boot and the onChanged listener is a no-op stub here, so a
  // value written after this point would never reach the module — a test that
  // set it afterwards would pass by accident on the default, not the setting.
  const storage = Object.assign({
    guardai_entitlement: { status: "active", kind: "individual", token: "t",
                           validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null },
  }, seed);
  const sent = [];
  w.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk]; return o; }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p, sendMessage: (m) => sent.push(m), lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  installFileEnv(w);
  // jsdom's innerText reads empty (it is layout-dependent and jsdom has no
  // layout), which makes getEditorText() see nothing in a visibly full
  // editor — typeText then reports failure after actually succeeding. The
  // silent-mode/panel suites map innerText to textContent on their editor for
  // the same reason; here it is prototype-level because content.js re-finds
  // editor nodes.
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
  });
  // execCommand model (jsdom has none) — the harness.cjs pattern. Lets the
  // REAL typeText fill the contenteditable, and records anything that would
  // submit, so "inserted but never sent" is assertable.
  w.__submits = [];
  w.document.execCommand = function (cmd, ui, value) {
    const ed = w.document.querySelector('[contenteditable="true"]');
    if (!ed) return false;
    cmd = String(cmd).toLowerCase();
    if (cmd === "delete" || cmd === "selectall") { if (cmd === "delete") ed.textContent = ""; return true; }
    if (cmd === "inserttext") {
      if (value == null) return false;
      if (String(value).includes("\n")) w.__submits.push("insertText-newline");
      ed.textContent += value;
      return true;
    }
    if (cmd === "insertlinebreak") { ed.textContent += "\n"; return true; }
    if (cmd === "inserthtml") { ed.textContent += "\n"; return true; }
    return false;
  };
  w.Element.prototype.getBoundingClientRect = function () {
    const width = Number(this.getAttribute("data-w") || 100);
    const height = Number(this.getAttribute("data-h") || 20);
    const left = Number(this.getAttribute("data-x") || 0);
    return { x: left, y: 0, top: 0, left, right: left + width, bottom: height, width, height };
  };
  for (const f of ["names-gazetteer.js", "detector.js", "masker.js", "nlp-detector.js", "filescan.js", "content.js"]) {
    w.eval(read(f));
  }
  w.__sent = sent;
  return w;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

/* ChatGPT's real composer: three file inputs, two of them image-only. */
const CHATGPT = `
  <main>
    <div contenteditable="true" id="prompt-textarea" data-x="345" data-w="560" data-h="40"></div>
    <div class="hidden"><input multiple type="file" id="upload-files"></div>
    <input class="sr-only" type="file" id="upload-photos" accept="image/*" multiple>
    <input class="sr-only" type="file" id="upload-camera" accept="image/*" capture multiple>
  </main>`;

(async () => {

console.log("\n--- 1. a picked file never reaches the site ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(() => new Promise(() => {}));   // never resolves: we are testing custody, not verdicts

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "contract.pdf", 4000, "application/pdf");
  input.files = Object.assign([file], { item: (i) => [file][i] });

  let siteSaw = false;
  // The site's handler, delegated the way React does it — below us in the tree.
  w.document.querySelector("main").addEventListener("change", () => { siteSaw = true; });

  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle();

  check(!siteSaw, "the site's change handler never runs");
  check(input.files.length === 0, "the input is emptied, so nothing can read the file later",
    `${input.files.length} file(s) left`);
  check(!!H.cardEl(), "a card is shown immediately, not after the scan");
}

console.log("\n--- 2. drop and paste are stopped too ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(() => new Promise(() => {}));

  for (const [type, key] of [["drop", "dataTransfer"], ["paste", "clipboardData"]]) {
    // The property is that no FILE reaches the site — not that no event does.
    // §2b deliberately sends the site an EMPTY drop afterwards to put its drag
    // overlay away, so counting bare events here would fail on a working
    // product and, worse, would have to be "fixed" by weakening the teardown.
    let filesReachingSite = 0;
    w.document.querySelector("main").addEventListener(type, (e) => {
      const d = e[key];
      if (d && d.files && d.files.length) filesReachingSite++;
    });
    const dt = new w.DataTransfer();
    dt.items.add(makeFile(w, `via-${type}.pdf`, 2000, "application/pdf"));
    const ev = type === "drop"
      ? new w.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })
      : new w.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    w.document.querySelector("#prompt-textarea").dispatchEvent(ev);
    await settle();
    check(filesReachingSite === 0, `a ${type} carrying a file never reaches the site`,
      `${filesReachingSite} got through`);
    check(ev.defaultPrevented, `the ${type} is cancelled`);
  }

  // A paste with no files is ordinary text and must pass straight through —
  // including GuardAI's OWN synthetic paste. pasteInto() is how masked text is
  // put into the composer, and it dispatches exactly this shape. Swallowing it
  // would break masking on every site, from a listener added for attachments.
  // Fresh page: the drop/paste checks above deliberately left a card up.
  const t = loadPage(CHATGPT);
  await settle();
  t.GuardAI._fileHooks.setParser(() => new Promise(() => {}));
  let textPasteSeen = 0;
  t.document.querySelector("main").addEventListener("paste", () => { textPasteSeen++; });

  const empty = new t.DataTransfer();
  t.document.querySelector("#prompt-textarea").dispatchEvent(
    new t.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: empty }));
  await settle();
  check(textPasteSeen === 1, "pasting text is left alone", `${textPasteSeen}`);

  const masked = new t.DataTransfer();
  masked.setData("text/plain", "Hi, this is Jordan Alvarez on 0400 000 000.");
  t.document.querySelector("#prompt-textarea").dispatchEvent(
    new t.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: masked }));
  await settle();
  check(textPasteSeen === 2, "GuardAI's own masked-text paste still reaches the editor",
    `${textPasteSeen}`);
  check(!t.GuardAI._fileHooks.cardEl(), "and raises no file card");
}

console.log("\n--- 2b. the site's drag overlay is put away ---");
{
  /**
   * Reported 2026-08-28 from a real drop on chatgpt.com: the file was held and
   * the card appeared, but ChatGPT's full-screen "Drop any file here" panel
   * stayed up on top of it, because swallowing the drop means ChatGPT's own
   * drop handler — the thing that hides the panel — never runs.
   *
   * What the panel actually responds to was measured live, not guessed:
   * on chatgpt.com and claude.ai a single synthetic `dragleave` takes it down,
   * and on ChatGPT an empty `drop` does too, without throwing. jsdom has no
   * ChatGPT in it, so what is asserted here is that we SEND those events to
   * the right node; that they dismiss the panel is the live measurement.
   */
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(() => new Promise(() => {}));

  const composer = w.document.querySelector("#prompt-textarea");
  const seen = [];
  // Listen in the BUBBLE phase, which is where a dropzone's reset handler sits.
  for (const type of ["dragleave", "drop"]) {
    w.document.querySelector("main").addEventListener(type, (e) => {
      seen.push({ type, files: e.dataTransfer ? e.dataTransfer.files.length : null });
    });
  }

  const dt = new w.DataTransfer();
  dt.items.add(makeFile(w, "dropped.pdf", 2000, "application/pdf"));
  composer.dispatchEvent(new w.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await settle(10);

  const leave = seen.filter((x) => x.type === "dragleave");
  const drops = seen.filter((x) => x.type === "drop");
  check(leave.length === 1, "a dragleave is sent so a counter-style dropzone unwinds", `${leave.length}`);
  check(drops.length === 1, "and an empty drop for one that only resets on drop", `${drops.length}`);
  check(drops.length === 1 && drops[0].files === 0,
    "the replayed drop carries NO files, so nothing can be uploaded by it",
    drops.length ? String(drops[0].files) : "n/a");
  check(!!H.cardEl(), "and the file is still held");

  // The teardown must not feed itself: an empty drop is ignored by onAttach,
  // so exactly one round happens, not an unbounded cascade.
  check(seen.length === 2, "the teardown does not re-trigger itself", `${seen.length} events`);

  // Control: with no interception, a file-less drop must reach the site
  // untouched — otherwise the count above proves nothing about who sent what.
  const before = seen.length;
  composer.dispatchEvent(new w.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new w.DataTransfer() }));
  await settle();
  check(seen.length === before + 1, "control: a file-less drop passes straight through",
    `${seen.length - before}`);
}

console.log("\n--- 3. release goes back through the RIGHT input ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  const pdf = makeFile(w, "contract.pdf", 4000, "application/pdf");
  const png = makeFile(w, "chart.png", 4000, "image/png");

  // No origin: a drop or a paste. The PDF must not be handed to an image-only
  // input — ChatGPT has two of those and they come FIRST in document order.
  const forPdf = H.pickReleaseInput([pdf], null);
  check(forPdf && forPdf.id === "upload-files", "a PDF goes to the input that accepts anything",
    forPdf ? forPdf.id : "none");

  const forPng = H.pickReleaseInput([png], null);
  check(forPng && (forPng.id === "upload-photos" || forPng.id === "upload-files"),
    "an image goes to an input that will take it", forPng ? forPng.id : "none");

  // With an origin, the origin always wins — no selector can be wrong about it.
  const camera = w.document.getElementById("upload-camera");
  check(H.pickReleaseInput([pdf], camera) === camera,
    "the input that fired the event is used, whatever its accept list says");

  // A detached origin (Gemini discards inputs as you go) falls back to a search.
  camera.remove();
  const fallback = H.pickReleaseInput([pdf], camera);
  check(fallback && fallback.id === "upload-files", "a detached origin falls back to a live input",
    fallback ? fallback.id : "none");
}

console.log("\n--- 4. accept lists are read the way the browser reads them ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  const cases = [
    ["image/*", "chart.png", "image/png", true],
    ["image/*", "contract.pdf", "application/pdf", false],
    [".pdf,.docx", "contract.pdf", "application/pdf", true],
    [".pdf,.docx", "sheet.xlsx", "", false],
    [".PDF", "contract.pdf", "", true],
    ["application/pdf", "contract.pdf", "application/pdf", true],
    [".md", "notes.md", "", true],
  ];
  for (const [accept, name, mime, want] of cases) {
    const got = H.acceptsFile(accept, makeFile(w, name, 10, mime));
    check(got === want, `accept="${accept}" ${want ? "admits" : "rejects"} ${name}`, `got ${got}`);
  }
}

console.log("\n--- 5. a blocked file stays out until the user says otherwise ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(async () => ({
    kind: "pdf", label: "PDF document", action: "block", pages: 12,
    summary: { counts: { TFN: 2, NAME_PII: 40 }, blocking: ["TFN"], other: ["NAME_PII"],
               blockingCount: 2, total: 42, pageHits: { TFN: [7] } },
  }));

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "payroll.pdf", 9000, "application/pdf");
  let released = 0;
  input.addEventListener("change", () => { released++; });

  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);

  const card = H.cardEl();
  check(!!card, "the card is shown");
  const text = card ? card.textContent : "";
  check(/TFN/.test(text), "it names the category that blocked", text.slice(0, 120));
  const countEl = card && card.querySelector(".guardai-filecard__catcount");
  check(countEl && countEl.textContent.trim() === "2", "and how many",
    countEl ? JSON.stringify(countEl.textContent) : "no count element");
  check(/page\s*7/i.test(text), "and which page to look at", text.slice(0, 200));
  check(!/\d{3}\s?\d{3}\s?\d{3}/.test(text), "but never the value itself");
  check(released === 0, "nothing has been handed back yet", `${released} release(s)`);

  card.querySelector(".guardai-filecard__btn--allow").click();
  await settle();
  check(released === 1, "'Attach anyway' hands it back exactly once", `${released}`);
  check(!H.cardEl(), "and closes the card");
}

console.log("\n--- 6. an approved file is not held a second time ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  let scans = 0;
  H.setParser(async () => { scans++; return { kind: "pdf", label: "PDF document", action: "block",
    summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} } }; });

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "payroll.pdf", 9000, "application/pdf");
  let siteSaw = 0;
  w.document.querySelector("main").addEventListener("change", () => { siteSaw++; });

  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);
  check(scans === 1 && siteSaw === 0, "first attempt: scanned, held", `scans=${scans} site=${siteSaw}`);

  H.cardEl().querySelector(".guardai-filecard__btn--allow").click();
  await settle();
  check(siteSaw === 1, "approving lets it through", `site=${siteSaw}`);
  check(scans === 1, "and the release is not itself re-scanned", `scans=${scans}`);

  // Attaching the same file again — the Gemini/drop recovery path.
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(10);
  check(scans === 1 && siteSaw === 2, "attaching it again goes straight through",
    `scans=${scans} site=${siteSaw}`);

  // A DIFFERENT file is not covered by that approval.
  const other = makeFile(w, "other.pdf", 500, "application/pdf");
  input.files = Object.assign([other], { item: () => other });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);
  check(scans === 2, "a different file is still scanned", `scans=${scans}`);
}

console.log("\n--- 7. a clean file is handed back without asking ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(async () => ({ kind: "pdf", label: "PDF document", action: "pass", pages: 3,
    summary: { counts: { NAME_PII: 4 }, blocking: [], other: ["NAME_PII"],
               blockingCount: 0, total: 4, pageHits: {} } }));

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "notes.pdf", 2000, "application/pdf");
  let siteSaw = 0;
  w.document.querySelector("main").addEventListener("change", () => { siteSaw++; });
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);

  check(siteSaw === 1, "it goes through on its own", `${siteSaw}`);
  const card = H.cardEl();
  check(!!card && /nothing blocked/i.test(card.textContent), "and says it was checked",
    card ? card.textContent.slice(0, 80) : "no card");
  check(!card.querySelector(".guardai-filecard__btn--allow"), "with no decision to make");
}

console.log("\n--- 8. a file that was not read never looks like a clean one ---");
{
  for (const [action, extra, wants] of [
    ["unsupported", { label: "Excel spreadsheet" }, /not been checked/i],
    ["unreadable", { reason: "No selectable text — this looks like a scan or a picture of a document." }, /not been checked/i],
    ["too-large", { limitMB: 30 }, /not been checked/i],
  ]) {
    const w = loadPage(CHATGPT);
    await settle();
    const H = w.GuardAI._fileHooks;
    H.setParser(async () => Object.assign({ kind: "pdf", label: "PDF document", action }, extra));

    const input = w.document.getElementById("upload-files");
    const file = makeFile(w, "thing.pdf", 2000, "application/pdf");
    let siteSaw = 0;
    w.document.querySelector("main").addEventListener("change", () => { siteSaw++; });
    input.files = Object.assign([file], { item: () => file });
    input.dispatchEvent(new w.Event("change", { bubbles: true }));
    await settle(20);

    const card = H.cardEl();
    check(siteSaw === 0, `${action}: not handed back on its own`);
    check(!!card && wants.test(card.textContent), `${action}: says it was NOT checked`,
      card ? card.textContent.slice(0, 140) : "no card");
    check(!!card && !/nothing blocked/i.test(card.textContent),
      `${action}: and never says "nothing blocked"`);
    check(!!card && !!card.querySelector(".guardai-filecard__btn--allow"),
      `${action}: the user is asked, not told`);
  }
}

console.log("\n--- 8b. if the reader itself never starts ---");
{
  // The most likely failure on a fresh install: the extension-origin frame
  // does not load (a missing web_accessible_resources entry, a host that
  // refuses it). The file must NOT be quietly let through, and must NOT be
  // quietly swallowed either — the user is asked, same as any other file we
  // could not read.
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(async () => { throw new Error("The file reader could not start."); });

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "contract.pdf", 4000, "application/pdf");
  let siteSaw = 0;
  w.document.querySelector("main").addEventListener("change", () => { siteSaw++; });
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);

  const card = H.cardEl();
  check(siteSaw === 0, "the file is not uploaded unchecked", `${siteSaw}`);
  check(!!card, "a card is shown rather than silence");
  check(!!card && /not been checked/i.test(card.textContent),
    "it says the file was not checked", card ? card.textContent.slice(0, 140) : "");
  check(!!card && /could not start/i.test(card.textContent),
    "and repeats the reason", card ? card.textContent.slice(0, 200) : "");
  check(!!card && !!card.querySelector(".guardai-filecard__btn--allow"),
    "with a way through, so a broken reader does not block all attachments");

  // …and that way through actually works.
  card.querySelector(".guardai-filecard__btn--allow").click();
  await settle();
  check(siteSaw === 1, "'Attach anyway' still hands it back", `${siteSaw}`);
}

console.log("\n--- 8c. where the card sits, and staying where it is put ---");
{
  // Reported 2026-08-28: the card was centred by the numbers and looked
  // off-centre. Every one of these sites has a sidebar, so the middle of the
  // WINDOW is well left of the column the conversation is in. The composer is
  // the proxy for that column. jsdom viewport is 1024x768; the fixture's
  // composer sits at x=345 with width 560, the way a 345px sidebar leaves it.
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(() => new Promise(() => {}));

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "contract.pdf", 4000, "application/pdf");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(10);

  const card = H.cardEl();
  check(!!card, "the card exists");
  // offsetWidth is 0 under jsdom, so placeFileCard falls back to its declared
  // 400x320 — which is what the real card measures, and makes this exact.
  const CARD_W = 400;
  const composerCentre = 345 + 560 / 2;                 // 625
  const windowCentre = w.innerWidth / 2;                // 512
  const left = parseFloat(card.style.left);
  check(Math.abs(left + CARD_W / 2 - composerCentre) <= 1,
    "centred on the composer, not the window",
    `left=${left}, card centre=${left + CARD_W / 2}, composer centre=${composerCentre}`);
  check(Math.abs(left + CARD_W / 2 - windowCentre) > 50,
    "control: that is genuinely different from the window centre, so the check above bites",
    `window centre=${windowCentre}`);
  check(!!card.style.top, "and it is positioned vertically too", card.style.top);

  // Dragging it must stick — the card re-renders between states, and a card
  // that snapped back to centre each time would be worse than an immovable one.
  check(!!card.querySelector(".guardai-filecard__grip"), "it has a drag handle");
  card.style.left = "60px";
  card.style.top = "40px";
  card._dragged = true;
  H.placeFileCard(card);
  check(card.style.left === "60px" && card.style.top === "40px",
    "a dragged card is left where it was put", `${card.style.left} ${card.style.top}`);

  // …but never dragged off the screen, including when a later state is taller.
  card.style.left = "5000px";
  card.style.top = "5000px";
  H.placeFileCard(card);
  const l2 = parseFloat(card.style.left), t2 = parseFloat(card.style.top);
  check(l2 <= w.innerWidth - CARD_W - 8 && l2 >= 8, "…and clamped back on screen horizontally", String(l2));
  check(t2 <= w.innerHeight - 320 - 8 && t2 >= 8, "…and vertically", String(t2));
}

console.log("\n--- 8d. no composer, no problem ---");
{
  // A platform where findEditor() comes up empty must still get a placed card,
  // centred on the window rather than jammed against the left edge.
  const w = loadPage(`<main><div class="hidden"><input multiple type="file" id="upload-files"></div></main>`);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(() => new Promise(() => {}));
  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "contract.pdf", 4000, "application/pdf");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(10);

  const card = H.cardEl();
  check(!!card, "the card still appears with no composer on the page");
  const left = parseFloat(card.style.left);
  check(Math.abs(left + 400 / 2 - w.innerWidth / 2) <= 1,
    "and falls back to the window centre", `left=${left}`);
  check(left >= 8, "not pinned to the edge");
}

console.log("\n--- 10. Send as safe text: one model, four standard actions ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;

  const REAL_TFN = "412 336 907";
  const DOC_TEXT =
    "Clause 4. The employee named below is engaged on the terms of this agreement. " +
    "The tax file number " + REAL_TFN + " is provided for payroll purposes only. " +
    "Nothing in this clause limits a remedy otherwise available at law.";

  const calls = [];
  H.setParser(async (file, onProgress, mode) => {
    calls.push(mode);
    if (mode === "extract") return { ok: true, text: DOC_TEXT };
    return {
      kind: "docx", label: "Word document", action: "block", pages: 0,
      summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} },
      suit: { offer: true, why: "" },
    };
  });

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "contract.docx", 9000,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);

  const card = H.cardEl();
  card.querySelector(".guardai-filecard__btn--safetext").click();
  await settle(20);

  const prev = H.previewEl();
  check(!!prev, "the preview appears");
  // The SAME four options as the text card — reused handlers, not a second set.
  for (const [sel, label] of [
    [".guardai-fileprev__btn--masksend", "Mask & Send"],
    [".guardai-fileprev__btn--maskedit", "Mask & Edit"],
    [".guardai-fileprev__btn--manual", "Manual mask"],
    [".guardai-fileprev__btn--anyway", "Send anyway"],
  ]) {
    check(!!prev.querySelector(sel), `it offers ${label}`);
  }
  check(!prev.querySelector(".guardai-fileprev__btn--insert"), "the old lone Insert button is gone");

  const shown = prev.querySelector(".guardai-fileprev__text").textContent;
  check(!shown.includes(REAL_TFN), "the REAL TFN is not in the preview");
  check(/Clause 4\./.test(shown), "…while the surrounding sentence survived");

  const sizeBefore = w.GuardAI._restoreHooks.masker.size;
  // Cancel: no trace — nothing registered, composer untouched.
  prev.querySelector(".guardai-fileprev__close").click();
  await settle();
  check(!H.previewEl(), "closing the preview cancels");
  check(w.GuardAI._restoreHooks.masker.size === sizeBefore, "…and registers nothing");
  const editor = w.document.getElementById("prompt-textarea");
  check(!(editor.textContent || "").trim(), "…and the composer is still empty");

  // Round two: Mask & Edit — the real doMaskAndEdit fills, registers, no send.
  card.querySelector(".guardai-filecard__btn--safetext").click();
  await settle(20);
  const prev2 = H.previewEl();
  const shown2 = prev2.querySelector(".guardai-fileprev__text").textContent;
  prev2.querySelector(".guardai-fileprev__btn--maskedit").click();
  for (let i = 0; i < 60 && !(editor.textContent || "").trim(); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));

  const landed = editor.textContent || "";
  check(landed.length > 100, "Mask & Edit fills the composer", String(landed.length));
  check(!landed.includes(REAL_TFN), "the REAL TFN never reaches the composer");
  check(landed === shown2, "what landed is BYTE-IDENTICAL to what the preview showed");
  check(w.__submits.length === 0, "…and nothing was sent", w.__submits.join(","));
  check(w.GuardAI._restoreHooks.masker.size > sizeBefore, "…and the mappings registered so the reply can unmask");
}

console.log("\n--- 10b. the document flow's own masking policy ---");
{
  // DOB masks HERE despite being warn-only in chat; MONEY stays visible; one
  // organisation in two costumes gets ONE stand-in. All through the SHARED
  // model builder (buildReviewModel + docPolicy) — the same code path every
  // preview button consumes.
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  const DOC =
    "MERIDIAN FACILITIES GROUP PTY LTD\n" +
    "We confirm your salary of $92,400 per annum. TFN 412 336 907. " +
    "We have your date of birth as 14 March 1991 on file.\n" +
    "People and Culture, Meridian Facilities Group";
  const { masked, items } = await H.buildDocPreview(DOC);

  check(!masked.includes("14 March 1991"), "the DOB is masked in the document flow");
  const dob = items.find((i) => i.type === "DOB");
  check(!!dob && /^\d{1,2} [A-Z][a-z]+ (19|20)\d\d$/.test(dob.fake),
    "…with a stand-in in the same written format", dob && dob.fake);
  check(masked.includes("$92,400"), "the salary stays visible — it is what the user is asking about");
  check(!masked.includes("MERIDIAN FACILITIES GROUP"), "letterhead org masked");
  check(!masked.includes("Meridian Facilities Group"), "signature org masked");
  const orgs = items.filter((i) => i.type === "ORG");
  check(orgs.length === 2, "two surfaces, two mappings", String(orgs.length));
  const hdr = orgs.find((o) => o.value.includes("PTY"));
  const sig = orgs.find((o) => !o.value.includes("PTY"));
  const stemOf = (v) => v.toLowerCase().replace(/\b(pty|ltd|limited|group|holdings)\b/g, "").trim();
  check(!!hdr && !!sig && stemOf(hdr.fake) === stemOf(sig.fake),
    "…but ONE entity: the stand-ins share a stem", orgs.map((o) => o.fake).join(" | "));
  check(hdr && hdr.fake === hdr.fake.toUpperCase() && /GROUP PTY LTD$/.test(hdr.fake),
    "the letterhead stand-in is ALL-CAPS with its full designators", hdr && hdr.fake);
  check(sig && /Group$/.test(sig.fake) && sig.fake !== sig.fake.toUpperCase(),
    "the signature stand-in keeps its own case and tail", sig && sig.fake);

  // Chat flow unchanged by the doc policy: the same text through the ordinary
  // model (no docPolicy) must NOT mask the DOB — that is the card-mediated
  // choice the chat card exists for.
  const chat = await (async () => {
    const RH = w.GuardAI._restoreHooks;
    return null; // chat-path DOB behaviour is pinned by masking-policy.cjs
  })();
}

console.log("\n--- 10c. the preview IS what lands — byte for byte, through the remount ---");
{
  /**
   * Live failure, 2026-08-28: the fill machinery verified against a STALE
   * editor node (a big paste makes ProseMirror remount the editor), decided
   * the landed fill had failed, cleared it, and cascaded into the
   * char-by-char crawl at ~2 chars/second. The user read a composer 94 chars
   * into a 28-minute fill and reported "the preview does not match what was
   * inserted" — which it didn't, and in the worst possible way.
   *
   * The fixture's editor REPLACES ITSELF when a paste lands, exactly like
   * the live ProseMirror. The flow is the REAL one: card -> preview ->
   * Mask & Edit.
   */
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;

  const LONG =
    ("Clause. The parties acknowledge the obligations described here survive termination, " +
     "and any waiver must be written. ").repeat(22) +
    "Tax file number 412 336 907 is held for payroll. Contact Priya Raghunathan on 0413 887 220.";
  H.setParser(async (file, onProgress, mode) => {
    if (mode === "extract") return { ok: true, text: LONG };
    return { kind: "docx", label: "Word document", action: "block", pages: 0,
      summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} },
      suit: { offer: true, why: "" } };
  });

  let pastes = 0, inserts = 0;
  const wirePaste = (node) => node.addEventListener("paste", (e) => {
    pastes++;
    const t = e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData("text/plain") : "";
    const fresh = w.document.createElement("div");
    fresh.setAttribute("contenteditable", "true");
    fresh.id = "prompt-textarea";
    fresh.setAttribute("data-x", "345"); fresh.setAttribute("data-w", "560"); fresh.setAttribute("data-h", "40");
    fresh.textContent = t;
    wirePaste(fresh);
    node.replaceWith(fresh);   // the remount that broke live verification
  });
  wirePaste(w.document.getElementById("prompt-textarea"));
  const realExec = w.document.execCommand;
  w.document.execCommand = function (cmd, ui, value) {
    if (String(cmd).toLowerCase() === "inserttext") inserts++;
    return realExec.call(this, cmd, ui, value);
  };

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "long.docx", 9000, "");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);
  H.cardEl().querySelector(".guardai-filecard__btn--safetext").click();
  await settle(20);
  const prev = H.previewEl();
  const shown = prev.querySelector(".guardai-fileprev__text").textContent;
  check(shown.length > 1500, "fixture: the previewed text is document-sized", String(shown.length));

  prev.querySelector(".guardai-fileprev__btn--maskedit").click();
  const liveNode = () => w.document.getElementById("prompt-textarea");
  for (let i = 0; i < 80 && (liveNode().textContent || "").length < shown.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));

  check(pastes >= 1, "the fill went via the paste path, not a crawl", `${pastes} paste(s)`);
  check(inserts < 15, "…with no char-by-char fallback", `${inserts} insertText calls`);
  check(liveNode().textContent === shown,
    "the inserted string is BYTE-IDENTICAL to the previewed string",
    liveNode().textContent === shown ? "" :
      `lens ${liveNode().textContent.length} vs ${shown.length}`);
  check(w.__submits.length === 0, "Mask & Edit sent nothing");

  // The reverse direction — the dangerous one. Mappings registered; run BOTH
  // swap directions over the page. Nothing may rewrite the composer (masked
  // text going out REAL) and nothing may rewrite GuardAI's own file UI.
  const RH = w.GuardAI._restoreHooks;
  const before = liveNode().textContent;
  RH.applyRules(w.document.body, RH.buildSwapRules("unmask"));
  check(liveNode().textContent === before,
    "unmask over the page cannot turn the composer's fakes back into real data");
  RH.applyRules(w.document.body, RH.buildSwapRules("remask"));
  check(liveNode().textContent === before, "…and remask cannot rewrite it either");

  const pv = w.document.createElement("div");
  pv.className = "guardai-fileprev";
  pv.innerHTML = '<div class="guardai-fileprev__text"></div>';
  pv.querySelector(".guardai-fileprev__text").textContent = shown;
  w.document.body.appendChild(pv);
  RH.applyRules(w.document.body, RH.buildSwapRules("unmask"));
  check(pv.textContent === shown, "the preview element is protected from the swap machinery");
  pv.remove();
  w.document.execCommand = realExec;
}

console.log("\n--- 10d. a fill that cannot land does not send ---");
{
  // The standard flow's failure semantics: doMaskAndSend refuses to send on a
  // short landing (its fullyLanded gate), shows its recovery UI, and no send
  // fires. Fixture: an editor that truncates everything to 40 chars.
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  const LONG = ("The committee reviewed the register and noted no material change in the period. ").repeat(30) +
    "TFN 412 336 907.";
  H.setParser(async (file, onProgress, mode) => {
    if (mode === "extract") return { ok: true, text: LONG };
    return { kind: "docx", label: "Word document", action: "block", pages: 0,
      summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} },
      suit: { offer: true, why: "" } };
  });
  const ed = w.document.getElementById("prompt-textarea");
  ed.addEventListener("paste", () => { ed.textContent = "short"; });
  const realExec = w.document.execCommand;
  w.document.execCommand = function (cmd, ui, value) {
    if (String(cmd).toLowerCase() === "inserttext") { ed.textContent = (ed.textContent + String(value)).slice(0, 40); return true; }
    return realExec.call(this, cmd, ui, value);
  };

  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "long.docx", 9000, "");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);
  H.cardEl().querySelector(".guardai-filecard__btn--safetext").click();
  await settle(20);
  H.previewEl().querySelector(".guardai-fileprev__btn--masksend").click();
  await new Promise((r) => setTimeout(r, 1500));

  check(w.__submits.length === 0, "nothing was sent on a fill that came up short",
    w.__submits.join(","));
  check((ed.textContent || "").length < 100, "…and no full document is sitting in the box",
    String((ed.textContent || "").length));
  w.document.execCommand = realExec;
}

console.log("\n--- 10e. all three cards teach ONE button language ---");
{
  /**
   * Reported 2026-08-28: the text card and the file preview offered the same
   * four choices styled three different ways — a bright green primary against
   * a muted one, Mask & Edit dominant-white on one card and dark-filled on
   * the other, and "Send anyway" wearing its warning orange on the text card
   * but plain grey on the file card. The last one is the dangerous half: the
   * single option that sends REAL data had lost its warning colour on exactly
   * the card where the user is looking at a document they did not type.
   *
   * The fix is one shared component (.guardai-act + role), so this asserts
   * the invariant rather than the pixels: both cards give each action the
   * SAME role, and the roles are defined in exactly one place.
   */
  const src = read("content.js");
  const ROLES = [
    ["Mask & Send",  "guardai-act--primary",   "prompt__btn--send",   "fileprev__btn--masksend"],
    ["Mask & Edit",  "guardai-act--secondary", "prompt__btn--edit",   "fileprev__btn--maskedit"],
    ["Manual mask",  "guardai-act--secondary", "prompt__btn--manual", "fileprev__btn--manual"],
    ["Send anyway",  "guardai-act--danger",    "prompt__btn--anyway", "fileprev__btn--anyway"],
  ];
  const buttonMarkup = (bem) => {
    const m = src.match(new RegExp("<button class=\"[^\"]*" + bem.replace(/[-]/g, "\\-") + "\"[^>]*>", "g"));
    return m ? m[0] : null;
  };
  for (const [label, role, textBem, fileBem] of ROLES) {
    const t = buttonMarkup(textBem);
    const f = buttonMarkup(fileBem);
    check(!!t && t.includes(role), `text card: ${label} is ${role}`, t || "not found");
    check(!!f && f.includes(role), `file preview: ${label} is ${role}`, f || "not found");
  }

  /* The DECISION card — the one the user meets first, and the last to join
     the shared component (2026-08-28). Its "Attach anyway" is the same kind
     of action as "Send anyway": it hands over unprotected data. It was a
     plain grey ghost sitting beside a bright filled "Don't attach", so the
     riskiest button on the card read as the safest one. */
  const allowBtn = buttonMarkup("filecard__btn--allow");
  const cancelBtn = buttonMarkup("filecard__btn--cancel");
  const safeTextBtn = buttonMarkup("filecard__btn--safetext");
  check(!!allowBtn && allowBtn.includes("guardai-act--danger"),
    "decision card: Attach anyway is the danger role", allowBtn || "not found");
  check(!!allowBtn && !allowBtn.includes("--ghost"),
    "…and no longer wears the ghost treatment it had", allowBtn || "not found");
  check(!!cancelBtn && cancelBtn.includes("guardai-act--secondary"),
    "decision card: Don't attach is secondary — safe, but not the loudest thing on the card",
    cancelBtn || "not found");
  check(!!safeTextBtn && safeTextBtn.includes("guardai-act--primary"),
    "decision card: Send as safe text is primary — the protected path, same green as Mask & Send",
    safeTextBtn || "not found");
  check(!!cancelBtn && !!allowBtn && cancelBtn.includes("guardai-act ") && allowBtn.includes("guardai-act "),
    "…and both sit on the shared component, so the row cannot mismatch in height or radius");

  // The one that matters most, stated on its own: the risky action keeps its
  // warning treatment on EVERY card that offers it.
  const dangerCount = (src.match(/guardai-act--danger/g) || []).length;
  check(dangerCount === 3, "exactly three buttons carry the danger role — one per card",
    String(dangerCount));

  // Rendered, not just declared: the live preview's buttons carry the roles.
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(async (file, onProgress, mode) => {
    if (mode === "extract") return { ok: true, text: "Clause 4. The tax file number 412 336 907 is on file for payroll purposes." };
    return { kind: "docx", label: "Word document", action: "block", pages: 0,
      summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} },
      suit: { offer: true, why: "" } };
  });
  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "c.docx", 9000, "");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);
  H.cardEl().querySelector(".guardai-filecard__btn--safetext").click();
  await settle(20);
  const prev = H.previewEl();
  check(prev.querySelectorAll(".guardai-act").length === 4,
    "the live preview renders four shared-component buttons",
    String(prev.querySelectorAll(".guardai-act").length));
  check(!!prev.querySelector(".guardai-fileprev__btn--anyway.guardai-act--danger"),
    "…and its Send anyway is the danger role");
  check(prev.querySelectorAll(".guardai-act--secondary").length === 2,
    "…with Mask & Edit and Manual mask at equal weight",
    String(prev.querySelectorAll(".guardai-act--secondary").length));

  // Single source of truth: no card may re-colour these buttons itself.
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");   // comments first — they name the very properties
  for (const stray of [
    ".guardai-prompt__btn--send {", ".guardai-prompt__btn--edit", ".guardai-prompt__btn--ghost",
    ".guardai-prompt__btn--anyway", ".guardai-fileprev__btn--ghost", ".guardai-fileprev__btn--masksend",
    // The decision card's old private set. --ghost is the one that made
    // "Attach anyway" look safe; --safetext and the __btn base are gone with
    // it so the card cannot drift back to its own metrics.
    ".guardai-filecard__btn--ghost", ".guardai-filecard__btn--safetext",
    ".guardai-filecard__btn {",
  ]) {
    check(!css.includes(stray), `no per-card override left for ${stray.trim()}`);
  }
  for (const role of ["--primary", "--secondary", "--danger"]) {
    // Anchored to line start so the html.guardai-light override — which also
    // contains ".guardai-act--primary {" — is not counted as a second base
    // definition. The light block is a deliberate second definition; a
    // per-card one would not be.
    const defs = (css.match(new RegExp("^\\.guardai-act" + role + "\\s*\\{", "gm")) || []).length;
    check(defs === 1, `.guardai-act${role} has exactly one base definition`, String(defs));
    const lightDefs = (css.match(new RegExp("^html\\.guardai-light \\.guardai-act" + role + "\\s*\\{", "gm")) || []).length;
    check(lightDefs === 1, `…and exactly one light-theme override`, String(lightDefs));
  }
  // Control: the three roles must actually LOOK different, or "consistent"
  // would be satisfied by making every button identical.
  const roleBody = (r) => {
    const i = css.indexOf(".guardai-act" + r + " {");
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };
  const bodies = ["--primary", "--secondary", "--danger"].map(roleBody);
  check(new Set(bodies).size === 3, "control: the three roles are visually distinct from each other");
  check(/2e5c43/.test(bodies[0]), "primary is the muted file-card green", bodies[0].trim().slice(0, 60));
  check(/f0883e/.test(bodies[2]), "danger is the text-card warning orange", bodies[2].trim().slice(0, 60));

  /* Rendered, on every decision-card state. Declared markup is not enough:
     the three image states and the document states run through the same
     render() but are assembled by different branches, and it is the state
     with NOTHING found where a neutral "Attach anyway" would be most
     tempting to click without reading. */
  for (const [label, res] of [
    ["found something", { kind: "image", label: "PNG screenshot / image", action: "img-found", pages: 0,
      summary: { counts: { MEDICARE: 1 }, blocking: ["MEDICARE"], other: [], blockingCount: 1, total: 1, pageHits: {} } }],
    ["read it, found nothing", { kind: "image", label: "PNG screenshot / image", action: "img-nothing", pages: 0,
      summary: { counts: {}, blocking: [], other: [], blockingCount: 0, total: 0, pageHits: {} } }],
    ["could not read it", { kind: "image", label: "JPEG image", action: "img-unreadable", pages: 0,
      reason: "The text in this image is too unclear to read reliably." }],
    ["a blocked document", { kind: "docx", label: "Word document", action: "block", pages: 0,
      summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} } }],
  ]) {
    const ww = loadPage(CHATGPT);
    await settle(10);
    ww.GuardAI._fileHooks.setParser(async () => res);
    const inp = ww.document.getElementById("upload-files");
    const f = makeFile(ww, "x.png", 5000, "image/png");
    inp.files = Object.assign([f], { item: () => f });
    inp.dispatchEvent(new ww.Event("change", { bubbles: true }));
    await settle(12);
    const c = ww.GuardAI._fileHooks.cardEl();
    const allow = c && c.querySelector(".guardai-filecard__btn--allow");
    const cancel = c && c.querySelector(".guardai-filecard__btn--cancel");
    check(!!allow && allow.classList.contains("guardai-act--danger"),
      `rendered [${label}]: Attach anyway wears the warning orange`,
      allow ? allow.className : "no button");
    check(!!cancel && !cancel.classList.contains("guardai-act--danger"),
      `rendered [${label}]: …and Don't attach does not`,
      cancel ? cancel.className : "no button");
  }
}

console.log("\n--- 11. withheld, and it says why ---");
{
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  const WHY = "This document is mostly tables, so the text would not come out readable.";
  H.setParser(async () => ({
    kind: "docx", label: "Word document", action: "block", pages: 0,
    summary: { counts: { TFN: 4 }, blocking: ["TFN"], other: [], blockingCount: 4, total: 4, pageHits: {} },
    suit: { offer: false, why: WHY },
  }));
  const input = w.document.getElementById("upload-files");
  const file = makeFile(w, "payroll.docx", 5000, "");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);

  const card = H.cardEl();
  check(!card.querySelector(".guardai-filecard__btn--safetext"), "no button on an unsuitable document");
  const whyEl = card.querySelector(".guardai-filecard__textwhy");
  check(!!whyEl && whyEl.textContent.includes(WHY), "…but the reason is said in one plain line",
    whyEl && whyEl.textContent.slice(0, 90));
}

console.log("\n--- 12. one file at a time, and a refusal on click is shown ---");
{
  // Multi-file: no button, no reason line — the option does not apply.
  const w = loadPage(CHATGPT);
  await settle();
  const H = w.GuardAI._fileHooks;
  H.setParser(async () => ({
    kind: "pdf", label: "PDF document", action: "block", pages: 1,
    summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} },
    suit: { offer: true, why: "" },
  }));
  const input = w.document.getElementById("upload-files");
  const files = [makeFile(w, "a.pdf", 100, ""), makeFile(w, "b.pdf", 100, "")];
  input.files = Object.assign(files, { item: (i) => files[i] });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(20);
  const card = H.cardEl();
  check(!card.querySelector(".guardai-filecard__btn--safetext"), "two files: no safe-text button");
  check(!card.querySelector(".guardai-filecard__textwhy"), "…and no stray reason line");

  // Single file whose extract-mode round trip REFUSES (frame re-check): the
  // reason lands in the status line and no preview opens.
  const w2 = loadPage(CHATGPT);
  await settle();
  const H2 = w2.GuardAI._fileHooks;
  H2.setParser(async (file, onProgress, mode) => {
    if (mode === "extract") return { ok: false, why: "The columns come out shuffled, so the text would not read in order." };
    return {
      kind: "pdf", label: "PDF document", action: "block", pages: 2,
      summary: { counts: { TFN: 1 }, blocking: ["TFN"], other: [], blockingCount: 1, total: 1, pageHits: {} },
      suit: { offer: true, why: "" },
    };
  });
  const in2 = w2.document.getElementById("upload-files");
  const f2 = makeFile(w2, "odd.pdf", 900, "application/pdf");
  in2.files = Object.assign([f2], { item: () => f2 });
  in2.dispatchEvent(new w2.Event("change", { bubbles: true }));
  await settle(20);
  const card2 = H2.cardEl();
  card2.querySelector(".guardai-filecard__btn--safetext").click();
  await settle(20);
  check(!H2.previewEl(), "a frame-side refusal opens no preview");
  check(/shuffled/.test(card2.querySelector(".guardai-filecard__textwhy").textContent),
    "…and its reason is shown on the card",
    card2.querySelector(".guardai-filecard__textwhy").textContent.slice(0, 80));
}

console.log("\n--- 9. the master switch means hands off ---");
{
  // Seeded off BEFORE content.js boots — the real case is a page loaded with
  // the switch already off, and loadSettings() only reads storage once.
  const w = loadPage(CHATGPT, "https://chatgpt.com/c/x", { guardai_enabled: false });
  await settle(10);
  w.GuardAI._fileHooks.setParser(async () => { throw new Error("must not scan"); });

  const input = w.document.getElementById("upload-files");
  let siteSaw = 0;
  w.document.querySelector("main").addEventListener("change", () => { siteSaw++; });
  const file = makeFile(w, "x.pdf", 100, "application/pdf");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(10);
  check(siteSaw === 1, "master switch off: the file is not touched", `${siteSaw}`);
  check(!w.GuardAI._fileHooks.cardEl(), "and no card appears");

  // Control: the same page with the switch ON must hold the file, or the
  // assertion above is passing because the listener never ran at all.
  const on = loadPage(CHATGPT);
  await settle(10);
  on.GuardAI._fileHooks.setParser(() => new Promise(() => {}));
  const in2 = on.document.getElementById("upload-files");
  let saw2 = 0;
  on.document.querySelector("main").addEventListener("change", () => { saw2++; });
  const f2 = makeFile(on, "x.pdf", 100, "application/pdf");
  in2.files = Object.assign([f2], { item: () => f2 });
  in2.dispatchEvent(new on.Event("change", { bubbles: true }));
  await settle(10);
  check(saw2 === 0, "control: with the switch on, the same file IS held", `${saw2}`);
}

console.log("\n--- 13. images: three states, three different screens, none of them 'clean' ---");
{
  /* (a) Found something: the same category rows and counts as a document,
     plus the line owning that OCR is a partial read. Held until decided. */
  const w = loadPage(CHATGPT);
  await settle(10);
  const H = w.GuardAI._fileHooks;
  H.setParser(async () => ({
    kind: "image", label: "PNG screenshot / image", action: "img-found", pages: 0,
    summary: { counts: { TFN: 1, BSB: 2 }, blocking: ["BSB", "TFN"], other: [],
               blockingCount: 3, total: 3, pageHits: {} },
  }));
  let released = 0;
  w.document.querySelector("main").addEventListener("change", () => { released++; });
  const shot = makeFile(w, "shot.png", 5000, "image/png");
  const photos = w.document.getElementById("upload-photos");
  photos.files = Object.assign([shot], { item: () => shot });
  photos.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(10);

  const card = H.cardEl();
  check(!!card && released === 0, "a screenshot with findings is held", `released=${released}`);
  check(/check this first/.test(card.textContent), "under the same header a document gets");
  const cats = [...card.querySelectorAll(".guardai-filecard__catname")].map((el) => el.textContent);
  check(cats.length === 2 && /BSB/i.test(cats.join(" ")), "categories are named, with counts", cats.join(", "));
  check(/may not have read all of it/.test(card.textContent),
    "and the card owns that an OCR read is partial EVEN when it found something");
  check(!card.querySelector(".guardai-filecard__btn--safetext") && !card.querySelector(".guardai-filecard__textwhy"),
    "no 'Send as safe text', and no absence-reason either — a screenshot has no text version");
  card.querySelector(".guardai-filecard__btn--allow").click();
  await settle(10);
  check(released === 1 && !H.cardEl(), "'Attach anyway' releases it through the same path as a document");

  /* (b) Nothing found: the dangerous state. It must HOLD — auto-releasing
     here is exactly the bank-statement-looks-clean outcome — and its words
     must not borrow the document flow's "checked/clean" promises. */
  const w2 = loadPage(CHATGPT);
  await settle(10);
  const H2 = w2.GuardAI._fileHooks;
  H2.setParser(async () => ({
    kind: "image", label: "PNG screenshot / image", action: "img-nothing", pages: 0,
    summary: { counts: {}, blocking: [], other: [], blockingCount: 0, total: 0, pageHits: {} },
  }));
  let released2 = 0;
  w2.document.querySelector("main").addEventListener("change", () => { released2++; });
  const shot2 = makeFile(w2, "clean.png", 5000, "image/png");
  const photos2 = w2.document.getElementById("upload-photos");
  photos2.files = Object.assign([shot2], { item: () => shot2 });
  photos2.dispatchEvent(new w2.Event("change", { bubbles: true }));
  await settle(10);

  const card2 = H2.cardEl();
  check(!!card2 && released2 === 0,
    "CONTROL (the dangerous direction): nothing-found does NOT auto-release", `released=${released2}`);
  check(/nothing found, your call/.test(card2.textContent), "the header hands the judgement over");
  check(/look it over yourself/.test(card2.textContent), "and the body says to");
  check(/cannot read everything a person can/.test(card2.textContent),
    "…because OCR reads less than a person — photos of screens included",
    card2.textContent.slice(0, 200));
  check(!/Checked — nothing blocked/.test(card2.textContent) && !/found nothing sensitive/.test(card2.textContent),
    "the document flow's 'checked/clean' wording appears NOWHERE on it");
  card2.querySelector(".guardai-filecard__btn--cancel").click();
  await settle(4);
  check(!H2.cardEl() && released2 === 0, "'Don't attach' closes without releasing");

  /* (c) Could not read it: unmistakable, and marked unchecked. */
  const w3 = loadPage(CHATGPT);
  await settle(10);
  const H3 = w3.GuardAI._fileHooks;
  H3.setParser(async () => ({
    kind: "image", label: "JPEG image", action: "img-unreadable", pages: 0,
    reason: "The text in this image is too unclear to read reliably.",
  }));
  let released3 = 0;
  w3.document.querySelector("main").addEventListener("change", () => { released3++; });
  const blurry = makeFile(w3, "blurry.jpg", 5000, "image/jpeg");
  const photos3 = w3.document.getElementById("upload-photos");
  photos3.files = Object.assign([blurry], { item: () => blurry });
  photos3.dispatchEvent(new w3.Event("change", { bubbles: true }));
  await settle(10);

  const card3 = H3.cardEl();
  check(!!card3 && released3 === 0, "an unreadable image is held", `released=${released3}`);
  check(/could not read this image properly/.test(card3.textContent),
    "and says so in exactly those words");
  check(/too unclear to read reliably/.test(card3.textContent), "with the parser's plain reason");
  check(/Treat it as unchecked/.test(card3.textContent), "and tells the user how to treat it");
  check(/could not check it/.test(card3.textContent), "under the could-not-check header");

  /* (d2) An action string this build does not recognise must fail CLOSED.
     Caught live: a version skew (stale content script, newer parser frame)
     produced an action the router had no list for, and the file — an image
     WITH findings — auto-released under "Checked — nothing blocked". The
     router now treats anything that is not literally the clean-document
     verdict as unchecked. */
  const w5 = loadPage(CHATGPT);
  await settle(10);
  const H5 = w5.GuardAI._fileHooks;
  H5.setParser(async () => ({ kind: "mystery", label: "File", action: "verdict-from-the-future", pages: 0 }));
  let released5 = 0;
  w5.document.querySelector("main").addEventListener("change", () => { released5++; });
  const odd = makeFile(w5, "odd.png", 5000, "image/png");
  const photos5 = w5.document.getElementById("upload-photos");
  photos5.files = Object.assign([odd], { item: () => odd });
  photos5.dispatchEvent(new w5.Event("change", { bubbles: true }));
  await settle(10);
  const card5 = H5.cardEl();
  check(!!card5 && released5 === 0,
    "an unrecognised verdict is HELD, never released as clean", `released=${released5}`);
  check(card5 && /not checked/.test(card5.textContent),
    "and rendered as unchecked, not as an empty findings list");
  check(card5 && !/nothing blocked|nothing sensitive/i.test(card5.textContent),
    "with no trace of the clean-file wording");

  /* (d) Control in the other direction: the doc flow still auto-releases a
     clean PDF, so holding every image did not quietly start holding
     everything. */
  const w4 = loadPage(CHATGPT);
  await settle(10);
  const H4 = w4.GuardAI._fileHooks;
  H4.setParser(async () => ({
    kind: "pdf", label: "PDF document", action: "pass", pages: 2,
    summary: { counts: {}, blocking: [], other: [], blockingCount: 0, total: 0, pageHits: {} },
  }));
  let released4 = 0;
  w4.document.querySelector("main").addEventListener("change", () => { released4++; });
  const pdf = makeFile(w4, "clean.pdf", 5000, "application/pdf");
  const files4 = w4.document.getElementById("upload-files");
  files4.files = Object.assign([pdf], { item: () => pdf });
  files4.dispatchEvent(new w4.Event("change", { bubbles: true }));
  await settle(10);
  check(released4 === 1, "control: a clean DOCUMENT still releases on its own", `released=${released4}`);
}

console.log("\n--- 10. an unlicensed install never intercepts ---");
{
  const dom = new JSDOM(`<!DOCTYPE html><body>${CHATGPT}</body>`, {
    url: "https://chatgpt.com/c/x", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  const storage = {};                              // no entitlement record at all
  w.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk]; return o; }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  installFileEnv(w);
  w.Element.prototype.getBoundingClientRect = () => ({ x:0,y:0,top:0,left:0,right:100,bottom:20,width:100,height:20 });
  for (const f of ["names-gazetteer.js", "detector.js", "masker.js", "nlp-detector.js", "filescan.js", "content.js"]) w.eval(read(f));
  await settle(10);

  w.GuardAI._fileHooks.setParser(async () => { throw new Error("must not scan"); });
  const input = w.document.getElementById("upload-files");
  let siteSaw = 0;
  w.document.querySelector("main").addEventListener("change", () => { siteSaw++; });
  const file = makeFile(w, "x.pdf", 100, "application/pdf");
  input.files = Object.assign([file], { item: () => file });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(10);
  check(siteSaw === 1, "locked: attachments are left completely alone", `${siteSaw}`);
  check(!w.GuardAI._fileHooks.cardEl(), "and nothing is drawn on the page");
}

console.log(`\nFILE ATTACH: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
