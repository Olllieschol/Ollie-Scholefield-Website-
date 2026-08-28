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
  w.Element.prototype.getBoundingClientRect = function () {
    const width = Number(this.getAttribute("data-w") || 100);
    const height = Number(this.getAttribute("data-h") || 20);
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height };
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
    <div contenteditable="true" id="prompt-textarea" data-w="700" data-h="40"></div>
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

console.log("\n--- 8c. the card sits in the middle of the screen ---");
{
  // Strip comments FIRST — the rule explains these very properties in a comment
  // directly above them, and matching the raw text would find the explanation
  // rather than the declaration. That exact mistake was caught by a negative
  // control once already, in test/msgtoggle-placement.cjs.
  const rule = css.slice(css.indexOf(".guardai-filecard {"));
  const body = rule.slice(0, rule.indexOf("}")).replace(/\/\*[\s\S]*?\*\//g, "");

  check(/position:\s*fixed/.test(body), "fixed to the viewport, not the page");
  check(/top:\s*50%/.test(body) && /left:\s*50%/.test(body), "anchored to the centre",
    (body.match(/top:[^;]*/) || [""])[0] + " " + (body.match(/left:[^;]*/) || [""])[0]);
  check(/transform:\s*translate\(-50%,\s*-50%\)/.test(body),
    "and pulled back by half its own size, so it is centred at any height",
    (body.match(/transform:[^;]*/) || [""])[0]);
  check(!/right:\s*\d/.test(body) && !/bottom:\s*\d/.test(body),
    "the old bottom-right corner anchoring is gone",
    (body.match(/(right|bottom):[^;]*/) || [""])[0]);

  // The animation must carry the centring translate through every frame, or the
  // card jumps to the corner for the length of the animation and back again.
  const kf = css.slice(css.indexOf("@keyframes guardai-filecard-pop"));
  const kfBody = kf.slice(0, kf.indexOf("}\n}") + 3).replace(/\/\*[\s\S]*?\*\//g, "");
  check(/animation:\s*guardai-filecard-pop/.test(body),
    "it uses its own keyframes, not the shared guardai-pop",
    (body.match(/animation:[^;]*/) || [""])[0]);
  const frames = kfBody.match(/transform:[^;]*/g) || [];
  check(frames.length >= 2 && frames.every((f) => /translate\(-50%,\s*-50%\)/.test(f)),
    "every frame of that animation keeps the centring translate",
    frames.join(" | "));

  // Control: guardai-pop, the SHARED animation, must NOT carry the translate —
  // otherwise the assertion above would pass against any keyframe block and
  // proves nothing about this one.
  const shared = css.slice(css.indexOf("@keyframes guardai-pop"));
  const sharedBody = shared.slice(0, shared.indexOf("}\n}") + 3);
  check(!/translate\(-50%/.test(sharedBody),
    "control: the shared pop animation does not centre, so the check above is real");
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
