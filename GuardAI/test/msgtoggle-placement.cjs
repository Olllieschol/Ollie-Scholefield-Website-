/**
 * "Show what AI sees": one toggle per message, always on the right.
 *
 * ═══ THE TWO BUGS THIS PINS ════════════════════════════════════════════════
 *
 * Reported 2026-08-22 against perplexity.ai, with chatgpt.com as the
 * counter-example that behaved correctly.
 *
 * 1. THE BUTTON WAS ON THE LEFT. It was `display: inline-flex` with
 *    `justify-self: start`, so it inherited whatever text-align the host site
 *    happened to use: right under a ChatGPT bubble, left under a Perplexity
 *    answer. It had no alignment of its own. Now it is block-level with
 *    width:fit-content plus margin-left/justify-self/align-self, one of which
 *    applies in each parent layout and the rest inert.
 *
 * 2. THE USER'S OWN MESSAGE HAD NO BUTTON AT ALL, and the one button on the
 *    page hung off the bottom of the ENTIRE conversation. This is the
 *    interesting one, and it needed two passes to reproduce:
 *
 *      pass 1  the question is on screen, the answer has not streamed in.
 *              One match on the page means no second seed to stop the climb,
 *              and the height test compares a container against the one short
 *              message inside it, which does not clear 1.6x + 80px. So
 *              discovery climbs past the bubble, past the turn, and marks the
 *              whole conversation container.
 *      pass 2  the answer arrives INSIDE that marked element, and discovery
 *              skips anything already marked. It never gets a button.
 *
 *    Every genericConfig() site had this — about 20 of the 28 supported hosts.
 *    ChatGPT and Claude never did, because they have hand-tuned selectors and
 *    discovery never runs there. That is exactly the difference the report
 *    described.
 *
 *    The fix is that marks are PROVISIONAL: a bubble that turns out to contain
 *    two bubbles was never a bubble. Re-derived on each pass, guarded by a
 *    cheap length check so a settled message costs nothing.
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

function loadWindow(url, bodyHTML) {
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
  // jsdom has no layout; stand in a text-proportional height so the climb
  // heuristic is really exercised rather than short-circuiting on 0x0.
  w.Element.prototype.getBoundingClientRect = function () {
    const len = (this.textContent || "").length;
    const height = 24 + Math.ceil(len / 60) * 22;
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height };
  };
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

async function seed(w) {
  const masker = w.GuardAI._restoreHooks.masker;
  await masker.load();
  masker.registerManual("Bellweather Logistics", "Coastline Logistics", "ORG");
  masker.registerManual("BW-77213", "NF-41900", "REF_CODE");
}

const QUESTION = "What should I send about NF-41900 at Coastline Logistics?";
const ANSWER = "Here is a summary for account NF-41900 at Coastline Logistics.";

/** Perplexity's shape: question and answer inside one turn, inside a thread. */
const THREAD = (answer) => `
  <main>
    <div class="thread">
      <div class="turn">
        <div class="q"><span>${QUESTION}</span></div>
        <div class="a">${answer ? `<span>${ANSWER}</span>` : ""}</div>
      </div>
    </div>
    <div contenteditable="true">Ask anything</div>
  </main>`;

const owners = (w) =>
  Array.from(w.document.querySelectorAll(".guardai-msgtoggle"))
    .map((b) => b.parentElement.className || b.parentElement.tagName);

(async () => {
  /* ── 1. The reported sequence: the answer arrives after the first pass ── */
  console.log("\n--- a reply that arrives after the first pass ---");
  {
    const w = loadWindow("https://www.perplexity.ai/search/abc", THREAD(false));
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;

    hooks.decorateMessages(hooks.findResponseRoot());
    const first = owners(w);
    check(first.length === 1, "set-up: only the question exists, so there is one button", first.join(","));

    // The answer streams in.
    w.document.querySelector(".a").innerHTML = `<span>${ANSWER}</span>`;
    hooks.decorateMessages(hooks.findResponseRoot());

    const after = owners(w);
    check(after.length === 2,
      "ONCE THE REPLY LANDS THERE ARE TWO BUTTONS — before the fix the reply arrived inside an already-marked container and never got one",
      `${after.length}: ${after.join(", ")}`);
    check(after.includes("q"), "THE USER'S OWN SENT MESSAGE HAS ONE", after.join(", "));
    check(after.includes("a"), "and so does the reply", after.join(", "));
    check(!after.includes("thread") && !after.includes("turn"),
      "and neither hangs off the whole conversation", after.join(", "));
  }

  /* ── 2. It settles: more passes must not multiply or move anything ────── */
  console.log("\n--- stable across further passes ---");
  {
    const w = loadWindow("https://www.perplexity.ai/search/abc", THREAD(true));
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    for (let i = 0; i < 5; i++) hooks.decorateMessages(hooks.findResponseRoot());
    const after = owners(w);
    check(after.length === 2, "five passes still leave exactly two buttons", after.join(", "));
    check(after.filter((c) => c === "q").length === 1, "one on the question, not a stack of them");
  }

  /* ── 3. A second turn arriving later ─────────────────────────────────── */
  console.log("\n--- a second turn ---");
  {
    const w = loadWindow("https://www.perplexity.ai/search/abc", THREAD(true));
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());

    const turn2 = w.document.createElement("div");
    turn2.className = "turn2";
    turn2.innerHTML =
      `<div class="q2"><span>And the balance on NF-41900?</span></div>` +
      `<div class="a2"><span>Coastline Logistics shows nothing outstanding.</span></div>`;
    w.document.querySelector(".thread").appendChild(turn2);
    hooks.decorateMessages(hooks.findResponseRoot());

    const after = owners(w);
    check(after.length === 4, "all four messages carry a toggle", `${after.length}: ${after.join(", ")}`);
  }

  /* ── 4. Alignment is the button's own, not the host page's ───────────── */
  console.log("\n--- always on the right, whatever the parent is ---");
  {
    // Strip comments FIRST. The rule documents these very property names in a
    // comment above them, so matching the raw text finds the explanation
    // rather than the declaration — a negative control caught this test
    // passing against its own documentation with the properties deleted.
    const rule = css.slice(css.indexOf(".guardai-msgtoggle {"));
    const body = rule.slice(0, rule.indexOf("}")).replace(/\/\*[\s\S]*?\*\//g, "");
    check(/display:\s*flex/.test(body),
      "block-level, so it no longer inherits the host page's text-align (this was the left/right difference)",
      (body.match(/display:[^;]*/) || [""])[0]);
    check(!/justify-self:\s*start/.test(body), "the old justify-self:start is gone");
    check(/margin-left:\s*auto/.test(body), "margin-left:auto  — block and flex-row parents");
    check(/justify-self:\s*end/.test(body), "justify-self:end   — grid parents");
    check(/align-self:\s*flex-end/.test(body), "align-self:flex-end — flex-column parents");
    check(/width:\s*fit-content/.test(body), "width:fit-content, so it is not stretched to the column");
  }

  /* ── 5. Never on the composer or GuardAI's own UI ─────────────────────── */
  console.log("\n--- still never on the wrong thing ---");
  {
    const w = loadWindow("https://www.perplexity.ai/search/abc", THREAD(true));
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    hooks.decorateMessages(hooks.findResponseRoot());
    const inEditor = w.document.querySelectorAll('[contenteditable="true"] .guardai-msgtoggle').length;
    check(inEditor === 0, "no toggle inside the composer", String(inEditor));
    const nested = w.document.querySelectorAll(".guardai-msgtoggle .guardai-msgtoggle").length;
    check(nested === 0, "and none nested inside another", String(nested));
  }

  console.log(`\nMSGTOGGLE-PLACEMENT: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
