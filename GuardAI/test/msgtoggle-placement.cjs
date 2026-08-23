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

/* A real answer, copied in shape from a live perplexity.ai reply: the body is
   a rendered-markdown container whose children are p, ul, p — and the matched
   values appear in the intro paragraph AND in every bullet. That is five
   separate seeds inside ONE message, which is what produced six buttons on the
   page when there should have been two. The question is a sibling DIV of the
   answer body, one level up, which is what keeps it a separate message. */
const PROSE_THREAD = `
  <main>
    <div class="thread">
      <div class="turn">
        <div class="q"><span>${QUESTION}</span></div>
        <div class="answerwrap">
          <div class="prose" data-renderer="lm">
            <p>I can see you want to follow up about NF-41900.</p>
            <ul>
              <li>Coastline Logistics &ndash; NF-41900</li>
              <li>Coastline Logistics &ndash; NF-41900</li>
            </ul>
            <p>Tell me what kind of follow-up and I will draft it for NF-41900.</p>
          </div>
        </div>
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

  /* ── 3b. One reply is ONE message, however many paragraphs it has ────── */
  console.log("\n--- a reply with matches in several paragraphs ---");
  {
    const w = loadWindow("https://www.perplexity.ai/search/abc", PROSE_THREAD);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    hooks.decorateMessages(hooks.findResponseRoot());

    const after = owners(w);
    check(after.length === 2,
      "EXACTLY TWO BUTTONS: one for what was sent, one for what came back — not one per paragraph",
      `${after.length}: ${after.join(", ")}`);
    check(after.includes("q"), "one is the question", after.join(", "));
    check(after.filter((c) => c === "prose").length === 1,
      "and the other is the whole reply body, once", after.join(", "));
    const inList = w.document.querySelectorAll("li .guardai-msgtoggle, ul .guardai-msgtoggle").length;
    check(inList === 0, "no button hanging off an individual bullet", String(inList));
    const inPara = w.document.querySelectorAll("p .guardai-msgtoggle").length;
    check(inPara === 0, "and none inside a paragraph", String(inPara));
  }
  {
    // Streaming: paragraphs arrive one at a time. Each arrival must not chop
    // the reply back up, which is what the re-split would otherwise do.
    const w = loadWindow("https://www.perplexity.ai/search/abc", PROSE_THREAD);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    const prose = w.document.querySelector(".prose");
    const finished = prose.innerHTML;
    prose.innerHTML = "<p>I can see you want to follow up about NF-41900.</p>";
    hooks.decorateMessages(hooks.findResponseRoot());
    prose.innerHTML = finished;
    hooks.decorateMessages(hooks.findResponseRoot());
    hooks.decorateMessages(hooks.findResponseRoot());
    const after = owners(w);
    check(after.length === 2, "still two after the rest of the reply streams in", after.join(", "));
  }

  /* ── 3c. Configured platforms: fallback selectors are FALLBACKS ──────── */
  console.log("\n--- platforms with hand-tuned selectors ---");
  {
    /* Gemini's real selector lists name the same message nested three deep:
       user-query-content > .user-query-bubble-with-background > .query-text,
       and message-content > .model-response-text. Unioning them gave one
       button per match — two stacked on the user's bubble on the live site. */
    const GEMINI = `
      <main>
        <chat-window>
          <user-query>
            <user-query-content>
              <div class="user-query-bubble-with-background">
                <div class="query-text"><p>${QUESTION}</p></div>
              </div>
            </user-query-content>
          </user-query>
          <model-response>
            <message-content>
              <div class="model-response-text"><p>${ANSWER}</p></div>
            </message-content>
          </model-response>
        </chat-window>
        <div contenteditable="true">Ask Gemini</div>
      </main>`;
    const w = loadWindow("https://gemini.google.com/app/abc", GEMINI);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    hooks.decorateMessages(hooks.findResponseRoot());

    const btns = [...w.document.querySelectorAll(".guardai-msgtoggle")];
    check(btns.length === 2, "Gemini: exactly two buttons, not one per nested fallback selector",
      `${btns.length}: ${owners(w).join(", ")}`);
    const perOwner = new Map();
    btns.forEach((b) => perOwner.set(b.parentElement, (perOwner.get(b.parentElement) || 0) + 1));
    check([...perOwner.values()].every((n) => n === 1),
      "and never two stacked on the same bubble", JSON.stringify([...perOwner.values()]));
  }
  {
    /* Claude nests on the assistant side: font-claude-response wraps
       font-claude-message, and both are in the list as renames of each other. */
    const CLAUDE = `
      <div role="feed">
        <div data-testid="user-message"><p>${QUESTION}</p></div>
        <div class="font-claude-response">
          <div class="font-claude-message"><p>${ANSWER}</p></div>
        </div>
      </div>
      <div contenteditable="true">Reply to Claude</div>`;
    const w = loadWindow("https://claude.ai/chat/abc", CLAUDE);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    hooks.decorateMessages(hooks.findResponseRoot());
    const btns = [...w.document.querySelectorAll(".guardai-msgtoggle")];
    check(btns.length === 2, "Claude: two buttons, despite two nested names for the same reply",
      `${btns.length}: ${owners(w).join(", ")}`);
  }
  {
    /* ChatGPT is the control: one selector per role, roles cannot nest. It was
       measured correct on a live thread and must stay that way. */
    const CHATGPT = `
      <main>
        <article data-message-author-role="user"><div><p>${QUESTION}</p></div></article>
        <article data-message-author-role="assistant"><div><p>${ANSWER}</p></div></article>
        <div contenteditable="true" id="prompt-textarea">Ask anything</div>
      </main>`;
    const w = loadWindow("https://chatgpt.com/c/abc", CHATGPT);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    hooks.decorateMessages(hooks.findResponseRoot());
    const btns = [...w.document.querySelectorAll(".guardai-msgtoggle")];
    check(btns.length === 2, "ChatGPT: still exactly two", `${btns.length}`);
    const roles = btns.map((b) => b.parentElement.getAttribute("data-message-author-role")).sort();
    check(roles.join(",") === "assistant,user",
      "one on the question, one on the reply", roles.join(","));
  }

  /* ── 3d. Structural battery ───────────────────────────────────────────
   *
   * The point of this section is to stop this bug class being found one
   * platform at a time by the user. Rather than visit 28 sites, it enumerates
   * the DOM SHAPES a chat UI can use and asserts the same invariant against
   * every one: two messages in, two buttons out, never stacked, never inside a
   * paragraph, list item or table cell.
   *
   * Two of these shapes were measured on live sites rather than invented —
   * they are marked. The rest are structural variants that any of the ~20
   * genericConfig platforms could present, since none of them has selectors
   * and all take the same discovery path.
   * ------------------------------------------------------------------ */
  console.log("\n--- structural battery: two messages in, two buttons out ---");
  {
    const Q = QUESTION;
    const A_PARA = `<p>Here is a summary for NF-41900 at Coastline Logistics.</p>`;
    const SHAPES = [
      ["prose body, p + ul (MEASURED on perplexity.ai)", `
        <div class="turn">
          <div class="q"><span>${Q}</span></div>
          <div class="wrap"><div class="prose" data-renderer="lm">
            ${A_PARA}<ul><li>Coastline Logistics &ndash; NF-41900</li><li>NF-41900 again</li></ul>
            <p>Anything else on NF-41900?</p>
          </div></div>
        </div>`],
      ["table wrapped in positioning divs (MEASURED on grok.com)", `
        <div class="turn">
          <div class="q"><span>${Q}</span></div>
          <div class="bubble"><div class="response-content-markdown">
            <p>Here is a clean summary for Coastline Logistics.</p>
            <div class="group-table"><div class="w-fit"><div class="rounded"><div class="table-container">
              <table><tbody>
                <tr><td>Coastline Logistics</td><td>NF-41900</td></tr>
                <tr><td>Coastline Logistics</td><td>NF-41900</td></tr>
              </tbody></table>
            </div></div></div></div>
            <p>Would you like anything else on NF-41900?</p>
            <ul><li>Draft a note for NF-41900</li></ul>
          </div></div>
        </div>`],
      ["reply rendered as a table", `
        <div class="turn">
          <div class="q"><span>${Q}</span></div>
          <div class="reply"><div class="md">
            <p>Here you go for Coastline Logistics.</p>
            <table><tbody>
              <tr><td>Coastline Logistics</td><td>NF-41900</td></tr>
              <tr><td>Coastline Logistics</td><td>NF-41900</td></tr>
            </tbody></table>
          </div></div>
        </div>`],
      ["reply with a fenced code block", `
        <div class="turn">
          <div class="q"><span>${Q}</span></div>
          <div class="reply"><div class="md">
            <p>Try this for NF-41900:</p>
            <pre><code>lookup("Coastline Logistics", "NF-41900")</code></pre>
            <p>That covers NF-41900.</p>
          </div></div>
        </div>`],
      ["headings and blockquote in one reply", `
        <div class="turn">
          <div class="q"><span>${Q}</span></div>
          <div class="reply"><div class="md">
            <h2>Coastline Logistics</h2>
            <p>Account NF-41900.</p>
            <blockquote><p>NF-41900 is current.</p></blockquote>
          </div></div>
        </div>`],
      ["bubbles as flex-column siblings", `
        <div class="turn" style="display:flex;flex-direction:column">
          <div class="q"><p>${Q}</p></div>
          <div class="reply"><p>Noted for Coastline Logistics, NF-41900.</p><p>NF-41900 confirmed.</p></div>
        </div>`],
      ["user bubble wrapped in a grid", `
        <div class="turn">
          <div class="qgrid" style="display:grid;grid-template-columns:1fr">
            <div class="q"><p>${Q}</p></div>
          </div>
          <div class="reply"><div class="md">${A_PARA}<p>NF-41900 noted.</p></div></div>
        </div>`],
    ];

    for (const [label, body] of SHAPES) {
      const w = loadWindow("https://www.perplexity.ai/search/abc",
        `<main><div class="thread">${body}</div><div contenteditable="true">Ask</div></main>`);
      await new Promise((r) => setTimeout(r, 120));
      await seed(w);
      const hooks = w.GuardAI._decorateHooks;
      hooks.decorateMessages(hooks.findResponseRoot());
      hooks.decorateMessages(hooks.findResponseRoot());

      const btns = [...w.document.querySelectorAll(".guardai-msgtoggle")];
      const perOwner = new Map();
      btns.forEach((b) => perOwner.set(b.parentElement, (perOwner.get(b.parentElement) || 0) + 1));
      const stacked = [...perOwner.values()].filter((n) => n > 1).length;
      const buried = w.document.querySelectorAll(
        "p .guardai-msgtoggle, li .guardai-msgtoggle, td .guardai-msgtoggle, pre .guardai-msgtoggle"
      ).length;

      check(btns.length === 2, `${label}: two buttons`, `${btns.length}: ${owners(w).join(", ")}`);
      check(stacked === 0, `${label}: none stacked`, String(stacked));
      check(buried === 0, `${label}: none buried inside a paragraph, bullet, cell or code block`,
        String(buried));
      // A button on a narrow scroll wrapper renders squeezed against the table
      // with its label wrapped onto two lines. It has to be on the message.
      const inWrapper = w.document.querySelectorAll(
        ".table-container .guardai-msgtoggle, .rounded .guardai-msgtoggle, .w-fit .guardai-msgtoggle"
      ).length;
      check(inWrapper === 0, `${label}: none inside a table/scroll wrapper`, String(inWrapper));
    }
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
