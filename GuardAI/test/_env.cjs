/**
 * Shared test environment: loads the REAL detector + masker + nlp-detector
 * into a jsdom window with a stubbed chrome.storage, exactly like audit.cjs.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

/**
 * Every suite below this line is testing detection and masking, not the
 * licence gate. A gated extension does nothing, so without an entitlement in
 * storage they would all "pass" by proving that a locked GuardAI stays quiet
 * — which is true, useless, and would hide every real regression.
 *
 * hardStopAt: null is the never-expires shape (what a review licence holds),
 * so these fixtures cannot start failing on a date. The gate itself is tested
 * in test/entitlement.cjs and test/gate.cjs, which set this up themselves.
 */
const LICENSED = () => ({
  guardai_entitlement: {
    status: "active", kind: "individual", token: "test-token",
    validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
  },
});

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

/**
 * Load the real src/ files into a JSDOM window.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * KNOWN BLIND SPOT, and it has already cost sixteen days of broken masking.
 *
 * EVERY SUITE BUILT ON THIS HARNESS IS BLIND TO STRICT-MODE FAILURES THAT
 * THROW IN CHROME.
 *
 * Our src files open with "use strict", so assigning to an undeclared name is
 * a ReferenceError in the browser. Inside JSDOM's window.eval it is not: the
 * sandbox global intercepts the assignment and quietly creates a property.
 * Verified directly — an explicit "use strict" function eval'd in this window
 * assigns to an undeclared name without complaint.
 *
 * What that cost: detectPassword referenced an undeclared `m` from 21 August
 * 2026 (a0fe50f). It threw on EVERY scan in Chrome for sixteen days, losing
 * connection strings, wallet seed phrases and standalone strong tokens.
 * runDetector caught it and wrote a console.warn nobody read. Fifty-nine
 * suites stayed green the entire time, because none of them could see it.
 *
 * So: GREEN TESTS HERE DO NOT MEAN THE EXTENSION RUNS. If tests pass and the
 * extension is broken in the browser, suspect this first.
 *
 * Two mitigations exist, and neither is this file:
 *   - test/detector-liveness.cjs loads the detector in a plain Node vm
 *     context, which DOES enforce strict mode, and asserts that it does
 *     before relying on it.
 *   - test/_undeclared.cjs reads every function in src/ statically for
 *     assignment to a name declared nowhere in scope, so branches no sample
 *     reaches are covered too.
 *
 * This harness is not fixed by switching to vm: the content-script suites
 * need a real DOM. Any OTHER strict-mode divergence between JSDOM and Chrome
 * is therefore still invisible here.
 * ─────────────────────────────────────────────────────────────────────────
 */
function loadWindow() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://chatgpt.com/c/x",
    runScripts: "dangerously",
  });
  const w = dom.window;
  const storage = LICENSED();
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
        set: (o) => {
          Object.assign(storage, o);
          return Promise.resolve();
        },
        remove: (k) => {
          delete storage[k];
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  for (const f of ["names-gazetteer.js", "detector.js", "masker.js", "nlp-detector.js", "filescan.js"]) w.eval(read(f));
  w.__storage = storage;
  return w;
}

/** Mirror content.js buildReviewModel + computeMasked over plain text. */
async function maskText(w, text, detOverride) {
  const det = detOverride || new w.GuardAI.Detector();
  const masker = new w.GuardAI.Masker();
  await masker.load();
  const findings = det.scan(text);
  const fakeByReal = new Map();
  const usedFakes = new Set();
  const items = [];
  for (const f of findings) {
    if (!masker.isMaskable(f.type)) continue;
    let fake = fakeByReal.get(f.value);
    if (!fake) {
      fake = masker.previewFake(f.type, f.value, usedFakes);
      fakeByReal.set(f.value, fake);
      usedFakes.add(fake);
    }
    items.push({ start: f.index, end: f.index + f.value.length, value: f.value, type: f.type, fake });
  }
  items.sort((a, b) => a.start - b.start);
  let masked = text;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (masked.slice(it.start, it.end) === it.value) {
      masked = masked.slice(0, it.start) + it.fake + masked.slice(it.end);
    } else {
      masked = masked.split(it.value).join(it.fake);
    }
  }
  return { findings, items, masked, masker, det };
}

/** Does any finding (of the given kinds) cover this substring of `text`? */
function covered(text, findings, substr, opts = {}) {
  const idx = text.indexOf(substr);
  if (idx < 0) throw new Error("test bug: substring not in text: " + substr);
  const end = idx + substr.length;
  return findings.some((f) => {
    if (opts.maskableOnly && !opts.masker.isMaskable(f.type)) return false;
    const fs = f.index;
    const fe = f.index + f.value.length;
    // finding overlaps a meaningful part of the target span
    return fs < end && fe > idx && Math.min(fe, end) - Math.max(fs, idx) >= Math.min(4, substr.length);
  });
}

module.exports = { loadWindow, maskText, covered, ROOT };
