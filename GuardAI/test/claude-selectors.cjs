/**
 * claude.ai DOM regression.
 *
 * The per-message "Show what AI sees" toggle worked on ChatGPT but never on
 * Claude. Two separate faults, both verified against the live claude.ai DOM
 * on 2026-08-13:
 *
 *   1. The assistant bubble class was renamed font-claude-message ->
 *      font-claude-response, so responseMessage matched nothing. Only the
 *      user's own bubble ([data-testid="user-message"]) still resolved,
 *      which is exactly the "works on my message, not on the reply" symptom.
 *
 *   2. Worse, the configured responseRoot "div.flex-1.flex.flex-col" still
 *      MATCHED an element that no longer contained any part of the
 *      conversation (claude.ai has no <main> either). findResponseRoot's old
 *      `if (el) return el` treated that as success, so every scan ran against
 *      an empty subtree and silently found nothing — auto-restore included.
 *
 * The DOM fixtures below mirror the real structure that was measured, so a
 * future selector rename fails here loudly instead of degrading in silence.
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

/**
 * Body mirroring claude.ai: a decoy container that matches the OLD root
 * selector but holds nothing, and the real role="feed" conversation.
 * Deliberately has no <main>, like the real site.
 */
const CLAUDE_BODY = `
  <div class="flex-1 flex flex-col"><span>sidebar / decoy, no messages here</span></div>
  <div role="feed">
    <div data-testid="user-message">Call Liam Murphy on 0423 990 894.</div>
    <div class="font-claude-response">Here is the follow up for Liam Murphy.</div>
  </div>
`;

function loadWindow(bodyHTML) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${bodyHTML}</body>`, {
    url: "https://claude.ai/chat/abc",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {};
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
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

(async () => {
  const w = loadWindow(CLAUDE_BODY);
  await new Promise((r) => setTimeout(r, 120));

  const hooks = w.GuardAI._decorateHooks;
  const root = hooks.findResponseRoot();

  /* ---- 1. The root must be the feed, NOT the matching-but-empty decoy ---- */
  check(root && root.getAttribute("role") === "feed",
    'findResponseRoot picks role="feed", not the empty div.flex-1.flex.flex-col decoy',
    root ? `got <${root.tagName.toLowerCase()} class="${root.className}">` : "got nothing");

  /* ---- 2. Both message kinds resolve inside it ---- */
  check(!!(root && root.querySelector("div.font-claude-response")),
    "the current assistant bubble (font-claude-response) resolves inside the root");
  check(!!(root && root.querySelector('[data-testid="user-message"]')),
    "the user bubble resolves inside the root");

  /* ---- 3. Decoration reaches the ASSISTANT reply, not just the user's own
       message — the actual reported symptom. Needs a mapping entry first,
       since decorateMessages only marks messages with swappable data. ---- */
  w.GuardAI._restoreHooks.masker.registerManual("Liam Murphy", "Grace Wells", "NAME_PII");
  hooks.decorateMessages(hooks.findResponseRoot());

  // Query from the document, not the root: if the root itself is wrong these
  // checks should report a clean FAIL about the missing button rather than
  // throwing on a null and aborting the remaining cases.
  const assistant = w.document.querySelector("div.font-claude-response");
  const user = w.document.querySelector('[data-testid="user-message"]');
  check(!!(assistant && assistant.querySelector(".guardai-msgtoggle")),
    "the assistant reply gets the 'Show what AI sees' toggle");
  check(!!(user && user.querySelector(".guardai-msgtoggle")),
    "the user message still gets its toggle too");

  /* ---- 4. Fallback: if NOTHING matches a message, we must still return a
       usable root rather than throwing or returning null. ---- */
  const bare = loadWindow(`<div class="flex-1 flex flex-col"><p>empty chat</p></div>`);
  await new Promise((r) => setTimeout(r, 120));
  const bareRoot = bare.GuardAI._decorateHooks.findResponseRoot();
  check(!!bareRoot, "an empty conversation still yields a usable root (no null/throw)");

  console.log(`\nCLAUDE-SELECTORS: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
