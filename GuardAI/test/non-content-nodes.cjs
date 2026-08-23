/**
 * Script, style and template text is not page content.
 *
 * ═══ WHAT WAS HAPPENING ════════════════════════════════════════════════════
 *
 * Measured on a live grok.com thread: FOUR toggle buttons where there should
 * have been two. Two of them had been appended inside <script> elements —
 * Grok is a Next.js app and embeds its serialised payload in
 * <script>self.__next_f.push(...)</script> blobs, which contain the message
 * text, which contains the masked values.
 *
 * The stray buttons are invisible, so on their own they are only untidy. The
 * real problem is the other half: none of GuardAI's five text walkers
 * excluded script content either, so THE RESTORE PASS WAS REWRITING FAKE
 * VALUES BACK TO REAL ONES INSIDE THAT JSON. Real client data, written by us,
 * into a script payload, where nobody would ever see it and page code might
 * read it. Nothing in the UI would have shown this.
 *
 * isProtectedNode() already guarded GuardAI's own UI and the composer. It now
 * guards non-content tags too, and the two walkers that did not use it at all
 * (discovery and hasSwappableData) check the same thing directly.
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

const REAL_NAME = "Bellweather Logistics";
const FAKE_NAME = "Coastline Logistics";
const REAL_REF = "BW-77213";
const FAKE_REF = "NF-41900";

/* The shape Next.js produces: the conversation, and a script blob repeating
   it. Both carry the fake values, because both were written after masking. */
const BODY = `
  <main>
    <div class="turn">
      <div class="q"><p>Please confirm ${FAKE_NAME}, account ${FAKE_REF}.</p></div>
      <div class="reply"><div class="md">
        <p>Confirmed for ${FAKE_NAME} on ${FAKE_REF}.</p>
      </div></div>
    </div>
    <script type="application/json" id="payload">
      {"messages":[{"text":"Please confirm ${FAKE_NAME}, account ${FAKE_REF}."}]}
    </script>
    <style id="sheet">/* ${FAKE_NAME} ${FAKE_REF} */ .x { color: red; }</style>
    <template id="tpl"><p>${FAKE_NAME} ${FAKE_REF}</p></template>
    <div contenteditable="true">Ask anything</div>
  </main>`;

function loadWindow() {
  const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, {
    url: "https://grok.com/c/abc", runScripts: "dangerously", pretendToBeVisual: true,
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
  w.Element.prototype.getBoundingClientRect = function () {
    const len = (this.textContent || "").length;
    const height = 24 + Math.ceil(len / 60) * 22;
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height };
  };
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

(async () => {
  const w = loadWindow();
  await new Promise((r) => setTimeout(r, 120));
  const hooks = w.GuardAI._decorateHooks;
  const { masker, buildSwapRules, applyRules } = w.GuardAI._restoreHooks;
  await masker.load();
  masker.registerManual(REAL_NAME, FAKE_NAME, "ORG");
  masker.registerManual(REAL_REF, FAKE_REF, "REF_CODE");

  const scriptBefore = w.document.getElementById("payload").textContent;
  const styleBefore = w.document.getElementById("sheet").textContent;

  console.log("\n--- decoration ---");
  hooks.decorateMessages(hooks.findResponseRoot());
  hooks.decorateMessages(hooks.findResponseRoot());

  const btns = [...w.document.querySelectorAll(".guardai-msgtoggle")];
  const inScript = [...w.document.querySelectorAll("script .guardai-msgtoggle")].length +
    [...w.document.querySelectorAll("script")].filter((s) => s.querySelector && s.querySelector(".guardai-msgtoggle")).length;
  check(inScript === 0, "NO TOGGLE INSIDE A <script> — Next.js payload blobs carry the masked text and were being treated as messages",
    String(inScript));
  check(btns.length === 2, "exactly two buttons, on the two real messages",
    `${btns.length}: ${btns.map((b) => b.parentElement.className || b.parentElement.tagName).join(", ")}`);
  for (const b of btns) {
    check(!b.closest("script, style, template"), "button is in page content", b.parentElement.tagName);
  }

  console.log("\n--- restore must not touch non-content ---");
  applyRules(w.document.body, buildSwapRules("unmask"));

  const scriptAfter = w.document.getElementById("payload").textContent;
  const styleAfter = w.document.getElementById("sheet").textContent;
  check(scriptAfter === scriptBefore,
    "THE SCRIPT PAYLOAD IS UNCHANGED — before this, restore wrote the real client name into the page's JSON",
    scriptAfter.includes(REAL_NAME) ? "real name was written into the script" : "changed");
  check(!scriptAfter.includes(REAL_NAME) && !scriptAfter.includes(REAL_REF),
    "and contains no real values at all", scriptAfter.trim().slice(0, 80));
  check(styleAfter === styleBefore, "the stylesheet is unchanged too");

  console.log("\n--- but the visible conversation IS restored ---");
  const reply = w.document.querySelector(".reply");
  check(reply.textContent.includes(REAL_NAME),
    "the real name is swapped back into the reply", reply.textContent.trim().slice(0, 60));
  check(reply.textContent.includes(REAL_REF), "and so is the reference");
  check(!reply.textContent.includes(FAKE_NAME),
    "with the stand-in gone", reply.textContent.trim().slice(0, 60));

  console.log(`\nNON-CONTENT-NODES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
