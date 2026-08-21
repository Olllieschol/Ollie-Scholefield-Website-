/**
 * Section 4a regression: messageSelectors() used to fall back to ChatGPT's
 * own `[data-message-author-role="assistant"]` attribute selector whenever a
 * platform had no hand-tuned `responseMessage` config — i.e. every
 * genericConfig() site (Perplexity, Poe, Mistral, HuggingFace, and ~14
 * others). That selector never matches on non-ChatGPT DOM, so it silently
 * disabled the per-message "Show what AI sees" toggle everywhere except
 * ChatGPT while looking like real generic support. The fix returns an empty
 * selector list instead of a fake fallback; this test proves decorateMessages
 * / syncMessageViewsToDefault / the sticky-view branch in runUnmaskPass all
 * handle that gracefully (no throw) on a genericConfig platform, and that
 * boot() completes cleanly end to end on one.
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

function loadWindow(url) {
  const dom = new JSDOM("<!DOCTYPE html><body><main></main></body>", {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {};
  w.chrome = {
    storage: {
      local: {
        get: (k) =>
          Promise.resolve(
            (Array.isArray(k) ? k : [k]).reduce((o, kk) => {
              if (kk in storage) o[kk] = storage[kk];
              return o;
            }, {})
          ),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  return w;
}

(async () => {
  // A genericConfig() platform with NO responseMessage/userMessage defined —
  // exactly the shape that used to trigger the fake ChatGPT fallback.
  const w = loadWindow("https://poe.com/chat/1");
  let unhandled = null;
  w.addEventListener("unhandledrejection", (e) => { unhandled = e.reason; });
  let threw = null;
  try {
    for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  } catch (e) {
    threw = e;
  }
  check(!threw, "content.js loads without throwing on a genericConfig() platform (poe.com)", threw && threw.message);

  // Give boot() + the fake AI response (added below) time to run a full
  // decorate/unmask pass, which is exactly where the old fallback selector
  // would have been used.
  const main = w.document.querySelector("main");
  const fakeAssistantBubble = w.document.createElement("div");
  fakeAssistantBubble.setAttribute("data-message-author-role", "assistant"); // ChatGPT-shaped, irrelevant here
  fakeAssistantBubble.textContent = "Here is the information you asked for.";
  main.appendChild(fakeAssistantBubble);

  await new Promise((r) => setTimeout(r, 200));

  check(!unhandled, "no unhandled promise rejection during boot + decorate/unmask pass on a genericConfig platform", String(unhandled));
  check(typeof w.GuardAI === "object", "GuardAI namespace initialised cleanly on a genericConfig platform");

  // The old fallback would have "decorated" the ChatGPT-shaped bubble above
  // with a toggle button even on poe.com, which is exactly the kind of
  // silently-wrong cross-platform assumption this fix removes. It must NOT
  // be decorated now, since poe.com has no responseMessage config at all.
  const toggle = fakeAssistantBubble.querySelector(".guardai-msgtoggle");
  check(!toggle, "a ChatGPT-shaped element is not wrongly decorated on a platform with no responseMessage config");

  console.log(`\nSITE-CONFIG: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
