/**
 * "Show what AI sees" on platforms with no hand-tuned selectors.
 *
 * Reported against copilot.microsoft.com on 2026-08-21: masking worked (the
 * sent message showed the fake company and account number), but the
 * per-message toggle never appeared. Cause: messageSelectors() returns the
 * configured responseMessage/userMessage lists and nothing else, and Copilot —
 * like every genericConfig() site, roughly 20 of the 28 supported hosts — has
 * neither. decorateMessages therefore queried an empty selector string and
 * matched nothing, on every one of those sites, silently.
 *
 * The fix is discoverMessages(): find the masked/real values in the DOM and
 * climb out of them to the bubble, using height rather than class names, so it
 * needs no per-site knowledge. This suite pins the behaviour that matters:
 * a button per message, never on the composer, never on GuardAI's own UI, and
 * a toggle that only rewrites its own message.
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

/* Copilot's structure as measured from the reported session: one scroll
   container holding both turns, an assistant turn whose Outlook draft card is
   contenteditable, and the composer at the bottom. No class or attribute here
   identifies a "message" — that is the whole problem. */
const COPILOT_BODY = `
  <main>
    <div class="scroll">
      <div class="turn">
        <div class="bubble"><p>Hi, following up on the Bellweather Logistics account. Our contact
          there is Marcus Webb, reachable on 0413 662 940. Account number is BW-77213, and payment
          should go to BSB 062-548. Can you draft a follow-up email covering all of this?</p></div>
      </div>
      <div class="turn">
        <div class="reply"><p>Your follow-up email draft is ready to review. I have used account
          BW-77213 for Bellweather Logistics as you gave it.</p></div>
        <div class="card">
          <div class="draft" contenteditable="true"><p>Hi Marcus, I am following up regarding the
            Coastline Logistics account (NF-41900).</p></div>
        </div>
      </div>
    </div>
    <div class="composer"><textarea>Message Copilot</textarea></div>
  </main>
`;

const PERPLEXITY_BODY = `
  <main>
    <div class="thread">
      <div class="q"><span>What should I send Marcus Webb about BW-77213?</span></div>
      <div class="a"><span>Here is a summary for account BW-77213.</span></div>
    </div>
    <div contenteditable="true">Ask anything</div>
  </main>
`;

function loadWindow(url, bodyHTML) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${bodyHTML}</body>`, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  // These suites are all about the per-message "Show what AI sees" buttons,
  // which are an Automatic-protection-OFF feature: with it on, the
  // extension leaves no visible trace on the page. Automatic protection
  // now defaults ON, so the mode is seeded rather than assumed — otherwise
  // these test nothing and pass by finding zero buttons for the wrong
  // reason.
  const storage = { guardai_masking_enabled: false };
  w.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk];
          return o;
        }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;

  /* jsdom has no layout: every rect is 0x0, which would make the height
     heuristic a no-op and let this suite "pass" without testing it. Stand in a
     text-proportional height so a container really is taller than one bubble,
     the way it is in a browser. */
  w.Element.prototype.getBoundingClientRect = function () {
    const len = (this.textContent || "").length;
    const height = 24 + Math.ceil(len / 60) * 22;
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height };
  };

  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

/* The pairs the user actually masked in the reported session. */
const PAIRS = [
  ["Bellweather Logistics", "Coastline Logistics", "ORG"],
  ["BW-77213", "NF-41900", "REF_CODE"],
  ["Marcus Webb", "Marcus Webb", null], // name left alone here; not part of the swap
];

async function seed(w) {
  const masker = w.GuardAI._restoreHooks.masker;
  await masker.load();
  for (const [real, fake, type] of PAIRS) {
    if (type) masker.registerManual(real, fake, type);
  }
  return masker;
}

(async () => {
  /* ------------------------------------------------ 1. Copilot ---------- */
  {
    const w = loadWindow("https://copilot.microsoft.com/chats/abc", COPILOT_BODY);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());

    const buttons = Array.from(w.document.querySelectorAll(".guardai-msgtoggle"));
    check(buttons.length >= 2,
      "Copilot: both the sent message and the reply get a toggle",
      `got ${buttons.length} button(s)`);

    check(buttons.every((b) => b.textContent === "Show what AI sees"),
      "Copilot: the button reads 'Show what AI sees' while real data is shown");

    /* One button per message, not one giant button on the whole transcript. */
    const onScroll = w.document.querySelector(".scroll > .guardai-msgtoggle");
    const onMain = w.document.querySelector("main > .guardai-msgtoggle");
    check(!onScroll && !onMain,
      "Copilot: the toggle lands on a message, not on the whole conversation");

    /* The composer and the editable draft card must be left completely alone:
       rewriting either would corrupt what the user is about to send. */
    const composer = w.document.querySelector(".composer");
    const draft = w.document.querySelector(".draft");
    check(!composer.querySelector(".guardai-msgtoggle"), "Copilot: the composer gets no toggle");
    check(!draft.querySelector(".guardai-msgtoggle"),
      "Copilot: the editable Outlook draft card gets no toggle");

    const draftBefore = draft.textContent;
    /* The exact element the button lands on is the site's business, not ours:
       Copilot's bubble and its turn wrapper are the same message. What must
       hold is that the button sits inside the turn that holds the sent text,
       and nowhere near the other turn. */
    const sent = w.document.querySelector(".bubble").closest(".turn");
    const reply = w.document.querySelector(".reply");
    const replyBefore = reply.textContent;

    const sentBtn = sent.querySelector(".guardai-msgtoggle");
    check(!!sentBtn && !reply.contains(sentBtn),
      "Copilot: the sent message's toggle is inside that message and no other");
    if (sentBtn) {
      /* Auto-restore is on by default, so the page is showing the user's real
         data and the button offers the AI's view. */
      sentBtn.click();
      check(sent.textContent.includes("Coastline Logistics") &&
            !sent.textContent.includes("Bellweather Logistics"),
        "Copilot: clicking once shows the company name the AI actually saw",
        sent.textContent.slice(0, 140));
      check(sent.textContent.includes("NF-41900") && !sent.textContent.includes("BW-77213"),
        "Copilot: and the fake account number with it");
      check(reply.textContent === replyBefore,
        "Copilot: the other message is untouched by that click");
      check(draft.textContent === draftBefore,
        "Copilot: the editable draft is untouched by that click");
      check(sentBtn.textContent === "Show real data",
        "Copilot: the label flips after toggling");

      sentBtn.click();
      check(sent.textContent.includes("Bellweather Logistics") && sent.textContent.includes("BW-77213"),
        "Copilot: clicking again brings the real data back",
        sent.textContent.slice(0, 140));
      check(sentBtn.textContent === "Show what AI sees",
        "Copilot: and the label flips back");
    }
  }

  /* ------------------------------------------------ 2. another generic -- */
  {
    const w = loadWindow("https://www.perplexity.ai/search/x", PERPLEXITY_BODY);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    const n = w.document.querySelectorAll(".guardai-msgtoggle").length;
    check(n >= 2, "Perplexity: the same fix covers the other selector-less sites", `got ${n}`);
  }

  /* ------------------------------------------------ 3. our own UI -------- */
  {
    const w = loadWindow("https://copilot.microsoft.com/chats/abc", COPILOT_BODY);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    /* The panel lists every real value NEXT TO its fake, so it matches both
       directions' rules better than any real message does. If discovery did
       not exclude GuardAI's own UI it would decorate the panel and, worse,
       rewrite it on click. */
    const panel = w.document.createElement("div");
    panel.className = "guardai-panel";
    panel.innerHTML = "<div>Bellweather Logistics</div><div>Coastline Logistics</div>";
    w.document.body.appendChild(panel);

    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(w.document.body); // worst case: root falls back to body
    check(!panel.querySelector(".guardai-msgtoggle"),
      "GuardAI's own panel is never mistaken for a message");
  }

  /* ------------------------------------------------ 4. repeat passes ----- */
  {
    /* Discovery must run on EVERY pass, not once: a reply that arrives after
       the first pass has to get its own button. */
    const w = loadWindow("https://copilot.microsoft.com/chats/abc", COPILOT_BODY);
    await new Promise((r) => setTimeout(r, 120));
    await seed(w);
    const hooks = w.GuardAI._decorateHooks;
    hooks.decorateMessages(hooks.findResponseRoot());
    const before = w.document.querySelectorAll(".guardai-msgtoggle").length;

    const later = w.document.createElement("div");
    later.className = "turn";
    later.innerHTML = "<div class='reply2'><p>One more note on NF-41900 for you.</p></div>";
    w.document.querySelector(".scroll").appendChild(later);

    hooks.decorateMessages(hooks.findResponseRoot());
    const after = w.document.querySelectorAll(".guardai-msgtoggle").length;
    check(after === before + 1,
      "a message that arrives later still gets its own toggle",
      `${before} -> ${after}`);
  }

  console.log(`\nGENERIC-TOGGLE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
