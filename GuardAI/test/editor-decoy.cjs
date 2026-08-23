/**
 * Finding the real composer when the page ships a decoy.
 *
 * ═══ THE BUG ═══════════════════════════════════════════════════════════════
 *
 * Reported on grok.com: clicking "Mask & Send" did not send. It popped the
 * review panel open instead, with the message sitting inside it and Grok's own
 * composer still empty.
 *
 * Measured on the live page. Grok has TWO candidates:
 *
 *   <textarea>                     726 x 14, y=0, visibility: hidden   <- decoy
 *   <div contenteditable="true">   726 x 42, visible, "Ask Grok anything"
 *
 * genericConfig lists "textarea" before "div[contenteditable='true']", and
 * findEditor() took document.querySelector(sel) — the first match of the first
 * selector that matched anything, with no check that it was usable. So the
 * masked text was typed into an invisible box, the send never fired, and the
 * flow fell back to the panel.
 *
 * Same shape as the message-selector bug fixed in 3a7f14e: TAKING THE FIRST
 * THING THAT MATCHES IS WRONG WHEN AN EARLIER SELECTOR CAN MATCH A DECOY.
 * Roughly 20 platforms share this editor list, so any of them could ship one.
 *
 * A zero-sized rect must count as UNKNOWN, not unusable: elements are commonly
 * unlaid-out at document_start and jsdom has no layout at all, so rejecting on
 * size alone would find no editor anywhere. Visibility is what settles it.
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

function loadWindow(url, bodyHTML, { layout = true } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${bodyHTML}</body>`, {
    url, runScripts: "dangerously", pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {};
  w.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk]; return o;
        }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  if (layout) {
    // Real geometry, taken from the measurements above: data-w / data-h on the
    // element. Without this jsdom reports 0x0 for everything.
    w.Element.prototype.getBoundingClientRect = function () {
      const width = Number(this.getAttribute("data-w") || 0);
      const height = Number(this.getAttribute("data-h") || 0);
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height };
    };
  }
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

const GROK = `
  <textarea data-w="726" data-h="14" style="visibility:hidden"></textarea>
  <main>
    <div contenteditable="true" role="textbox" data-w="726" data-h="42"
         aria-label="Ask Grok anything" id="real-composer"></div>
  </main>`;

(async () => {
  console.log("\n--- grok.com, as measured ---");
  {
    const w = loadWindow("https://grok.com/", GROK);
    await new Promise((r) => setTimeout(r, 120));
    const ed = w.GuardAI._decorateHooks.findEditor();
    check(!!ed, "an editor is found at all", String(ed));
    check(ed && ed.id === "real-composer",
      "THE VISIBLE COMPOSER IS CHOSEN, not the hidden textarea above it — typing into the decoy is what made Mask & Send do nothing",
      ed ? ed.tagName + "#" + ed.id : "none");
  }

  console.log("\n--- every way a decoy can be unusable ---");
  for (const [label, attrs] of [
    ["visibility:hidden", 'style="visibility:hidden"'],
    ["display:none", 'style="display:none"'],
    ["opacity:0", 'style="opacity:0"'],
    ["aria-hidden", 'aria-hidden="true"'],
    ["disabled", "disabled"],
    ["readonly", "readonly"],
    ["one pixel tall", 'data-h="1" data-w="726"'],
  ]) {
    const body = `
      <textarea data-w="726" data-h="14" ${attrs}></textarea>
      <main><div contenteditable="true" data-w="726" data-h="42" id="real-composer"></div></main>`;
    const w = loadWindow("https://grok.com/", body);
    await new Promise((r) => setTimeout(r, 120));
    const ed = w.GuardAI._decorateHooks.findEditor();
    check(ed && ed.id === "real-composer", `skipped a decoy that is ${label}`,
      ed ? ed.tagName + (ed.id ? "#" + ed.id : "") : "none");
  }

  console.log("\n--- a real textarea composer is still preferred ---");
  {
    // The ordering must still mean something: where the textarea IS the
    // composer, it wins, because it comes first in the list.
    const body = `
      <main>
        <textarea data-w="700" data-h="60" id="real-textarea"></textarea>
        <div contenteditable="true" data-w="700" data-h="40" id="other"></div>
      </main>`;
    const w = loadWindow("https://poe.com/", body);
    await new Promise((r) => setTimeout(r, 120));
    const ed = w.GuardAI._decorateHooks.findEditor();
    check(ed && ed.id === "real-textarea",
      "a usable textarea still wins over a later selector", ed ? ed.id : "none");
  }
  {
    // Several matches for one selector: the big one is the composer.
    const body = `
      <main>
        <textarea data-w="80" data-h="20" id="tiny-search"></textarea>
        <textarea data-w="700" data-h="60" id="real-textarea"></textarea>
      </main>`;
    const w = loadWindow("https://poe.com/", body);
    await new Promise((r) => setTimeout(r, 120));
    const ed = w.GuardAI._decorateHooks.findEditor();
    check(ed && ed.id === "real-textarea",
      "where one selector matches several, the largest wins", ed ? ed.id : "none");
  }

  console.log("\n--- no layout information at all ---");
  {
    // document_start, or jsdom. Everything reports 0x0. Rejecting on size here
    // would mean never finding an editor, so size must count as unknown.
    const body = `<main><div contenteditable="true" id="real-composer"></div></main>`;
    const w = loadWindow("https://grok.com/", body, { layout: false });
    await new Promise((r) => setTimeout(r, 120));
    const ed = w.GuardAI._decorateHooks.findEditor();
    check(ed && ed.id === "real-composer",
      "an unlaid-out editor is still usable — size unknown is not size zero",
      ed ? ed.id : "none");
  }
  {
    const body = `<main><div contenteditable="true" id="hidden-one" style="display:none"></div></main>`;
    const w = loadWindow("https://grok.com/", body, { layout: false });
    await new Promise((r) => setTimeout(r, 120));
    const ed = w.GuardAI._decorateHooks.findEditor();
    check(!ed, "but display:none is still rejected without layout", ed ? ed.id : "none");
  }

  console.log(`\nEDITOR-DECOY: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
