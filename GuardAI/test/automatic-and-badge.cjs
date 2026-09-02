/**
 * Automatic protection, the floating badge, and the one thing automatic mode
 * must still stop for.
 *
 * ═══ WHAT THIS PINS ════════════════════════════════════════════════════════
 *
 * 1. NAMING. "Masking mode" read as though masking stopped when it was off.
 *    Off still masks — it asks first. The label now describes the difference
 *    that actually exists, and the popup default moved to ON.
 *
 * 2. THE BADGE has three states, so it needs something a switch cannot give:
 *    always / when masking / off. An unrecognised stored value falls back to
 *    the DEFAULT and never to "off", because a badge that silently vanishes
 *    on a storage glitch is indistinguishable from a broken extension.
 *
 * 3. THE EXCEPTION, and the reason the whole file exists: automatic mode
 *    sends text with nothing on screen, and STILL stops for every upload.
 *    Text can be swapped word by word. A file cannot be partly masked, so the
 *    only decision available for one is whether it goes at all — and that is
 *    the user's, every time, in both modes, whatever the settings say.
 *
 *    This reverses two earlier calls: clean documents used to auto-attach
 *    with a notice, and so did an image OCR read and found nothing in. The
 *    reasoning then — a click on every clean file teaches people to click
 *    past the cards that carry news — is still true, and is now outweighed.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const SCRIPTS = require(path.join(ROOT, "manifest.json"))
  .content_scripts[0].js.map((p) => p.replace(/^src\//, ""));

const LICENSED = () => ({
  guardai_entitlement: {
    status: "active", kind: "individual", token: "t",
    validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
  },
});

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- popup ---------- */
function popupEnv(seed) {
  const dom = new JSDOM(read("popup.html"), {
    url: "https://example.com/popup.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const storage = Object.assign({ guardai_enabled: true }, seed);
  window.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk];
          return o;
        }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((kk) => delete storage[kk]); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL: (p) => "file://" + p,
      lastError: null,
      sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({ ok: true, available: false, state: "active", record: null }), 0); },
    },
    tabs: { create() {} },
  };
  window.eval(read("popup.js"));
  return { window, storage };
}


/**
 * jsdom has no DataTransfer and input.files is read-only, so releaseFiles()
 * cannot complete without these. That matters more than it sounds: with them
 * missing, a release silently fails and every "nothing was attached"
 * assertion passes whatever the code does. Mirrors test/file-attach.cjs,
 * where the same shims are checked against real browser behaviour.
 */
function installFileEnv(w) {
  class FakeDataTransfer {
    constructor() { this._files = []; this._data = {}; this.items = { add: (f) => this._files.push(f) }; }
    setData(t, v) { this._data[t] = v; }
    getData(t) { return this._data[t] || ""; }
    get files() { const l = this._files.slice(); l.item = (i) => l[i]; return l; }
  }
  w.DataTransfer = FakeDataTransfer;
  w.DragEvent = class extends w.Event {
    constructor(t, i = {}) { super(t, i); this.dataTransfer = i.dataTransfer || null; }
  };
  w.ClipboardEvent = class extends w.Event {
    constructor(t, i = {}) { super(t, i); this.clipboardData = i.clipboardData || null; }
  };
  Object.defineProperty(w.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() { return this.__files || Object.assign([], { item: () => null }); },
    set(v) { this.__files = v; },
  });
}

/* ---------- content script ---------- */
function pageEnv({ masking = true, badgeMode, extra = {} } = {}) {
  // The real composer + the real file input. A release is only observable
  // through the input the extension hands the file back to, which is the
  // wire that actually carries it to the site.
  const dom = new JSDOM(
    `<!DOCTYPE html><body><main>` +
    `<div contenteditable="true" id="prompt-textarea"></div>` +
    `<div class="hidden"><input multiple type="file" id="upload-files"></div>` +
    `</main></body>`,
    { url: "https://chatgpt.com/c/x", runScripts: "dangerously", pretendToBeVisual: true }
  );
  const { window } = dom;
  const storage = Object.assign(LICENSED(), { guardai_masking_enabled: masking }, extra);
  if (badgeMode !== undefined) storage.guardai_badge_mode = badgeMode;
  const sessionStore = {};
  window.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk];
          return o;
        }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: () => Promise.resolve(),
      },
      session: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in sessionStore) o[kk] = sessionStore[kk];
          return o;
        }, {})),
        set: (o) => { Object.assign(sessionStore, o); return Promise.resolve(); },
      },
      onChanged: { addListener(fn) { window.__onChanged = fn; } },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!window.InputEvent) window.InputEvent = window.Event;
  installFileEnv(window);
  for (const f of SCRIPTS) window.eval(read("src/" + f));
  return { window, document: window.document, storage, sessionStore };
}

(async () => {
  /* ---- 1. The renames and the new default ---- */
  console.log("\n--- what the popup says, and what it starts as ---");
  {
    const { window } = popupEnv({});
    await wait(120);
    const d = window.document;
    const titles = [...d.querySelectorAll(".gd-row__title")].map((e) => e.textContent);
    check(titles.includes("Automatic protection") && !titles.includes("Masking mode"),
      'renamed to "Automatic protection"', titles.join(" | "));
    check(titles.includes("Show details every time") && !titles.includes("Detail panel"),
      'renamed to "Show details every time"', titles.join(" | "));
    check(d.getElementById("toggle-masking").checked === true,
      "Automatic protection defaults ON");
    check(d.getElementById("toggle-autopanel").checked === false,
      "Show details every time defaults OFF");
    // The rename is only worth anything if the copy stops implying that OFF
    // means unprotected.
    const desc = [...d.querySelectorAll(".gd-row__desc")].map((e) => e.textContent).join(" ");
    check(/warning card before anything sends/.test(desc),
      "and OFF is described as asking first, not as protection being off");
  }

  /* ---- 2. An existing user's explicit choice survives the default flip ---- */
  console.log("\n--- flipping the default must not flip anybody's setting ---");
  {
    const { window } = popupEnv({ guardai_masking_enabled: false });
    await wait(120);
    check(window.document.getElementById("toggle-masking").checked === false,
      "someone who turned it OFF still has it off after the default moved to ON");
  }

  /* ---- 3. The badge control ---- */
  console.log("\n--- floating badge: three states ---");
  {
    const { window } = popupEnv({});
    await wait(120);
    const on = [...window.document.querySelectorAll(".gd-seg__btn")]
      .filter((b) => b.getAttribute("aria-checked") === "true");
    check(on.length === 1 && on[0].dataset.badge === "masking",
      'defaults to "When masking"', on.map((b) => b.dataset.badge).join(","));
    check(/Everything the badge shows is also in this panel under Recent swaps/
      .test(window.document.body.textContent), "the helper line is there");
  }
  {
    const { window, storage } = popupEnv({});
    await wait(120);
    const off = window.document.querySelector('.gd-seg__btn[data-badge="off"]');
    off.dispatchEvent(new window.Event("click", { bubbles: true }));
    await wait(120);
    check(storage.guardai_badge_mode === "off", "clicking a segment persists it",
      String(storage.guardai_badge_mode));
    const checked = [...window.document.querySelectorAll(".gd-seg__btn")]
      .filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.badge);
    check(checked.length === 1 && checked[0] === "off",
      "and exactly one segment is selected afterwards", checked.join(","));
  }
  {
    // The failure that matters: a value nobody recognises must not read as
    // "off". A badge that quietly disappears looks like a broken extension.
    const { window } = popupEnv({ guardai_badge_mode: "nonsense" });
    await wait(120);
    const on = [...window.document.querySelectorAll(".gd-seg__btn")]
      .filter((b) => b.getAttribute("aria-checked") === "true");
    check(on.length === 1 && on[0].dataset.badge === "masking",
      "an unrecognised stored value falls back to the default, not to Off",
      on.map((b) => b.dataset.badge).join(","));
  }

  /* ---- 3b. The badge card actually stacks ---- */
  console.log("\n--- floating badge: the card lays out as a card ---");
  {
    /**
     * Shipped broken and no test saw it. `.gd-row--stack { display: block }`
     * was written above `.gd-row { display: flex }`, equal specificity, so
     * the later rule won and the card rendered as three columns — title,
     * control, and the helper text crushed into a clipped strip. Every
     * assertion about titles, values and persistence passed throughout,
     * because none of them looked at layout.
     */
    const { window } = popupEnv({});
    await wait(120);
    const d = window.document;
    const stack = [...d.querySelectorAll(".gd-row")].find((r) => r.classList.contains("gd-row--stack"));
    check(!!stack, "the badge card is a row");
    check(stack && window.getComputedStyle(stack).display === "block",
      "…and stacks its label above its helper text rather than beside it",
      stack ? window.getComputedStyle(stack).display : "absent");
    const plain = [...d.querySelectorAll(".gd-row:not(.gd-row--stack)")][0];
    check(plain && window.getComputedStyle(plain).display === "flex",
      "control: the ordinary toggle rows are still side-by-side",
      plain ? window.getComputedStyle(plain).display : "absent");
  }

  /* ---- 3c. Recent swaps uses the same colours as the in-page panel ---- */
  console.log("\n--- recent swaps: one colour language across both surfaces ---");
  {
    /**
     * The convention is documented in styles.css and is NOT the obvious one:
     * colour follows the VALUE, not its position. A real value is always
     * green, a fake always red, so the same mapping reads the same in the
     * popup and on the page. The popup list is always real -> fake, so the
     * struck-out real is green and the fake beside it red — identical to a
     * MASKED row in the panel.
     *
     * Pinned by comparing the two stylesheets rather than by hard-coding
     * hexes here, because the failure worth catching is the two surfaces
     * DRIFTING, and a copy of the value in a third file would drift too.
     */
    const popupCss = read("popup.html");
    const pageCss = read("styles.css");
    const tok = (css, name, scope) => {
      const block = scope ? css.slice(css.indexOf(scope)) : css;
      const m = block.match(new RegExp(name + "\\s*:\\s*(#[0-9a-fA-F]{3,8})"));
      return m && m[1].toLowerCase();
    };
    const panelDarkReal = (pageCss.match(/\.guardai-panel__row--mask \.guardai-panel__from \{ color: (#[0-9a-f]{6})/i) || [])[1];
    const panelDarkFake = (pageCss.match(/\.guardai-panel__row--mask \.guardai-panel__to \{ color: (#[0-9a-f]{6})/i) || [])[1];
    const panelLightReal = (pageCss.match(/guardai-light \.guardai-panel__row--mask \.guardai-panel__from \{ color: (#[0-9a-f]{6})/i) || [])[1];
    const panelLightFake = (pageCss.match(/guardai-light \.guardai-panel__row--mask \.guardai-panel__to \{ color: (#[0-9a-f]{6})/i) || [])[1];
    check(!!(panelDarkReal && panelDarkFake && panelLightReal && panelLightFake),
      "the in-page panel's swap colours are readable from styles.css",
      `${panelDarkReal}/${panelDarkFake} ${panelLightReal}/${panelLightFake}`);

    const popDarkReal = tok(popupCss, "--swap-real");
    const popDarkFake = tok(popupCss, "--swap-fake");
    const popLightReal = tok(popupCss, "--swap-real", "body.gd-light");
    const popLightFake = tok(popupCss, "--swap-fake", "body.gd-light");
    check(popDarkReal === (panelDarkReal || "").toLowerCase(),
      "dark: a REAL value is the same green in the popup as on the page",
      `${popDarkReal} vs ${panelDarkReal}`);
    check(popDarkFake === (panelDarkFake || "").toLowerCase(),
      "dark: a FAKE value is the same red", `${popDarkFake} vs ${panelDarkFake}`);
    check(popLightReal === (panelLightReal || "").toLowerCase(),
      "light: the same green", `${popLightReal} vs ${panelLightReal}`);
    check(popLightFake === (panelLightFake || "").toLowerCase(),
      "light: the same red", `${popLightFake} vs ${panelLightFake}`);

    // And that the rows actually USE the tokens — matching values in :root
    // proves nothing if the rules still point at --text-dim.
    check(/\.gd-swap__real \{ color: var\(--swap-real\)/.test(popupCss) &&
          /text-decoration: line-through/.test(popupCss),
      "the real value is painted with the token and struck through");
    check(/\.gd-swap__fake \{ color: var\(--swap-fake\)/.test(popupCss),
      "and the fake with the other token");
  }

  /* ---- 4. The badge on the page ---- */
  console.log("\n--- floating badge: on the page ---");
  {
    const env = pageEnv({ badgeMode: "off" });
    await wait(150);
    const hooks = env.window.GuardAI._restoreHooks;
    // Log something, the way a mask does, then ask for the badge.
    env.window.GuardAI._badgeHooks.showReopen();
    await wait(50);
    const el = env.document.querySelector(".guardai-reopen");
    check(!el || el.style.display === "none", "Off: no badge on the page",
      el ? `display=${JSON.stringify(el.style.display)}` : "absent");
    check(!!hooks && !!hooks.masker, "control: the content script did load");
  }
  {
    const env = pageEnv({ badgeMode: "always" });
    await wait(200);
    const el = env.document.querySelector(".guardai-reopen");
    check(!!el && el.style.display !== "none",
      "Always: the badge is present from page load, before anything is masked",
      el ? `display=${JSON.stringify(el.style.display)}` : "absent");
  }
  {
    const env = pageEnv({ badgeMode: "masking" });
    await wait(200);
    const before = env.document.querySelector(".guardai-reopen");
    check(!before || before.style.display === "none",
      "When masking: nothing on screen before anything is masked",
      before ? `display=${JSON.stringify(before.style.display)}` : "absent");
    env.window.GuardAI._badgeHooks.showReopen();
    await wait(50);
    const shown = env.document.querySelector(".guardai-reopen");
    check(!!shown && shown.style.display !== "none", "appears once something is masked");
    // It must go again — that is the whole difference from "always".
    env.window.GuardAI._badgeHooks.setLinger(60);
    env.window.GuardAI._badgeHooks.showReopen();
    await wait(700);
    const after = env.document.querySelector(".guardai-reopen");
    check(after && (after.style.display === "none" ||
                    after.classList.contains("guardai-reopen--fading")),
      "and fades again on its own", after ? `display=${after.style.display}` : "gone");
  }
  {
    // Switching to Off in another tab must clear a badge already on screen,
    // not wait for the next mask.
    const env = pageEnv({ badgeMode: "always" });
    await wait(200);
    check(!!env.document.querySelector(".guardai-reopen"), "control: badge is up");
    env.window.__onChanged({ guardai_badge_mode: { newValue: "off" } }, "local");
    await wait(60);
    const el = env.document.querySelector(".guardai-reopen");
    check(el && el.style.display === "none",
      "switching to Off in another tab clears it immediately",
      el ? `display=${JSON.stringify(el.style.display)}` : "absent");
  }

  /* ---- 5. Uploads always stop, in both modes ---- */
  console.log("\n--- an upload is a decision, every time ---");
  {
    const makeFile = (w, name, type) => ({
      name, size: 2048, type, lastModified: 1700000000000,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
    });
    /** Run one batch through reviewFiles and report what the user saw. */
    async function upload(opts, verdict, files) {
      const env = pageEnv(opts);
      await wait(150);
      const H = env.window.GuardAI._fileHooks;
      H.setParser(async () => verdict);
      // COUNT THE WIRE, not a stub. The first version of this replaced
      // _fileHooks.releaseFiles and counted calls to it — but reviewFiles
      // calls the module-scope function directly, so the counter never moved
      // and every "nothing was attached" assertion passed no matter what the
      // code did. Only the negative control exposed it. A `change` on the
      // site's own file input is what actually means "the site has it".
      let released = 0;
      const input = env.document.getElementById("upload-files");
      input.addEventListener("change", () => { released++; });
      await H.reviewFiles(files(env.window), null);
      await wait(250);
      const card = env.document.querySelector(".guardai-filecard");
      return { env, card, released, text: card ? card.textContent : "" };
    }

    const CLEAN_PDF = { kind: "pdf", label: "PDF document", action: "pass", pages: 3,
      summary: { counts: {}, blocking: [], other: [], blockingCount: 0, total: 0, pageHits: {} } };

    // AUTOMATIC ON, a clean PDF. This is the reversal: it used to attach itself.
    {
      const r = await upload({ masking: true }, CLEAN_PDF,
        (w) => [makeFile(w, "report.pdf", "application/pdf")]);
      check(!!r.card, "automatic ON: a clean PDF still shows a card");
      check(/Send anyway/.test(r.text) && /Cancel/.test(r.text),
        "with Send anyway / Cancel", r.text.slice(0, 120));
      check(r.released === 0, "and nothing is attached until it is clicked",
        `released=${r.released}`);
      check(!/could not check/i.test(r.text),
        "a file that WAS read is not described as unreadable", r.text.slice(0, 160));
    }
    // AUTOMATIC OFF, same file: identical treatment. The mode must not matter.
    {
      const r = await upload({ masking: false }, CLEAN_PDF,
        (w) => [makeFile(w, "report.pdf", "application/pdf")]);
      check(!!r.card && r.released === 0,
        "automatic OFF: the same clean PDF also waits", `released=${r.released}`);
    }
    // An image OCR read and found nothing in — the other reversal.
    {
      const r = await upload({ masking: true },
        { kind: "image", label: "PNG image", action: "img-nothing", conf: 78 },
        (w) => [makeFile(w, "shot.png", "image/png")]);
      check(!!r.card && r.released === 0,
        "an image with nothing found waits too", `released=${r.released}`);
    }
    // The hard-stop setting is now irrelevant either way.
    {
      const r = await upload({ masking: true, extra: { guardai_image_hard_stop: false } },
        { kind: "image", label: "PNG image", action: "img-nothing", conf: 78 },
        (w) => [makeFile(w, "shot.png", "image/png")]);
      check(!!r.card && r.released === 0,
        "and does so with the old hard-stop setting explicitly OFF");
    }
    // Scanning switched off for the type: still a card, and it says why.
    {
      const r = await upload(
        { masking: true, extra: { guardai_file_scanning: false } },
        CLEAN_PDF, (w) => [makeFile(w, "report.pdf", "application/pdf")]);
      check(!!r.card, "scanning OFF for the type: a card still appears");
      check(/can't check inside this file/i.test(r.text),
        "and says Guard4AI didn't look inside", r.text.slice(0, 200));
      check(r.released === 0, "never a silent pass-through", `released=${r.released}`);
    }
  }

  console.log(`\nAUTOMATIC-AND-BADGE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
