/**
 * The MESSAGE tab's two views, and what each is allowed to show.
 *
 * Reported 2026-08-28 from the panel: in "What AI sees", every mark carried
 * the REAL value as a small grey caption underneath the fake —
 *
 *     ┌──────────────────┐
 *     │  0490 919 349    │   <- the fake, what actually leaves the browser
 *     │  0141 737 373    │   <- the real number, in grey
 *     └──────────────────┘
 *
 * That is the one view whose entire job is to show only what the AI receives,
 * and it was rendering the user's real data under every single mark — while
 * the "What you see" tab an inch to the right existed to show exactly that.
 * buildReadView() had already dropped the mirror-image caption from the other
 * tab, so the two views disagreed about their own contract.
 *
 * The caption mechanism (data-sub + a ::after rule) is gone entirely rather
 * than suppressed per-view, which is what makes the property below hold for
 * BOTH views at once: with no CSS rule to render one, no attribute on any
 * mark in any view can produce a caption.
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

function loadWindow() {
  const dom = new JSDOM(`<!DOCTYPE html><body><main><div contenteditable="true" id="prompt-textarea"></div></main></body>`, {
    url: "https://chatgpt.com/c/x", runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {
    guardai_entitlement: { status: "active", kind: "individual", token: "t",
      validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null },
  };
  w.chrome = {
    storage: { local: {
      get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
        if (kk in storage) o[kk] = storage[kk]; return o; }, {})),
      set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
      remove: (k) => { delete storage[k]; return Promise.resolve(); },
    }, onChanged: { addListener() {} } },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  for (const f of ["names-gazetteer.js", "detector.js", "masker.js", "nlp-detector.js", "filescan.js", "content.js"]) {
    w.eval(read(f));
  }
  return w;
}

(async () => {
const w = loadWindow();
await new Promise((r) => setTimeout(r, 80));
const markHtml = w.GuardAI._panelHooks.markHtml;

const ITEMS = [
  { type: "PHONE", value: "0141 737 373", fake: "0490 919 349", manual: false },
  { type: "NAME_PII", value: "Priya Raghunathan", fake: "Rosa Ingram", manual: false },
  { type: "TFN", value: "412 336 907", fake: "680 418 837", manual: false },
  { type: "PASSWORD", value: "Wint3rmute!42", fake: "Xk9$vbQr2", manual: true },
];

console.log("\n--- 1. a mark in 'What AI sees' shows the fake, and only the fake ---");
{
  for (const it of ITEMS) {
    const html = markHtml(it);
    const el = w.document.createElement("div");
    el.innerHTML = html;
    const mark = el.querySelector("mark");

    check(!!mark, `${it.type}: renders a mark`);
    // The VISIBLE text is the fake.
    check(mark.textContent === it.fake, `${it.type}: visible text is the fake`,
      JSON.stringify(mark.textContent));
    // The real value appears NOWHERE in the rendered text.
    check(!mark.textContent.includes(it.value), `${it.type}: the real value is not visible`);
    // …and there is no caption attribute to render it underneath.
    check(!mark.hasAttribute("data-sub"), `${it.type}: no data-sub caption`,
      mark.getAttribute("data-sub") || "");
  }
}

console.log("\n--- 2. …but the tooltip can still act on it ---");
{
  // Control: stripping the caption must not strip the data the hover tooltip
  // (Remove mask / Change replacement) needs, or the view becomes read-only
  // by accident.
  const el = w.document.createElement("div");
  el.innerHTML = markHtml(ITEMS[0]);
  const mark = el.querySelector("mark");
  check(mark.getAttribute("data-real") === ITEMS[0].value, "data-real is still carried");
  check(mark.getAttribute("data-fake") === ITEMS[0].fake, "data-fake is still carried");
  check(mark.getAttribute("data-type") === ITEMS[0].type, "data-type is still carried");
  check(/--mk:/.test(mark.getAttribute("style") || ""), "the category colour is still set",
    mark.getAttribute("style"));
}

console.log("\n--- 3. no view can render a caption, because nothing styles one ---");
{
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ""); // comments name these very selectors
  check(!/\[data-sub\]/.test(stripped), "no [data-sub] rule survives in the stylesheet");
  check(!/content:\s*attr\(data-sub\)/.test(stripped), "…and nothing emits it via ::after");
  // Control: the mark itself is still styled, so this is not passing because
  // the whole block vanished.
  check(/\.guardai-panel__mark\s*\{/.test(stripped), "control: marks are still styled");
  check(/--mk/.test(stripped), "control: …including their per-category colour");
}

console.log("\n--- 4. the read view is the one that shows real values ---");
{
  // buildReadView() swaps each mark's text to data-real. Reproduce its
  // transform on a real mark and assert the two views are exact opposites.
  const el = w.document.createElement("div");
  el.innerHTML = markHtml(ITEMS[1]);
  const mark = el.querySelector("mark");
  check(mark.textContent === ITEMS[1].fake, "AI view: shows the fake");
  mark.textContent = mark.getAttribute("data-real");
  check(mark.textContent === ITEMS[1].value, "read view: shows the real value");
  check(!mark.hasAttribute("data-sub"), "…and still carries no caption either way");

  // The source guarantee: buildReadView keeps stripping data-sub defensively.
  const src = read("content.js");
  check(/removeAttribute\("data-sub"\)/.test(src),
    "buildReadView still strips any stray caption attribute");
}

console.log(`\nMESSAGE MARKS: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e && e.stack || e); process.exit(1); });
