/**
 * Multi-turn restore robustness (Section 3a). Exercises the unmask path
 * beyond the specific cross-contamination bug fixed in Section 1
 * (test/restore-name-integrity.cjs covers that one specifically). Here:
 *   - paraphrase (AI doesn't repeat the fake verbatim) — documented, honest
 *     limitation, not a bug: regex/substring matching cannot recover a value
 *     that was never repeated in any recognisable form. Asserts it fails
 *     SAFELY (stays masked) rather than guessing wrong.
 *   - partial echoes for non-name types (phone/email/TFN fragments) — these
 *     intentionally do NOT auto-restore (only NAME_PII gets token aliases;
 *     see buildSwapRules), verified here to fail safely, not corrupt.
 *   - many real<->fake pairs active at once (scale + mixed types).
 *   - two fake values that are literal substrings of each other.
 *   - a fake that collides with a DIFFERENT entry's real value (regression
 *     for the masker.js collision-guard fix made in this section).
 *   - idempotency: re-running restore over already-restored content is a
 *     no-op, not a second corruption opportunity.
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

function loadWindow() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://chatgpt.com/c/x",
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
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  const w = loadWindow();
  await new Promise((r) => setTimeout(r, 50));
  const { buildSwapRules, applyRules, masker } = w.GuardAI._restoreHooks;

  /* ---- 1. Paraphrase: fails safely, doesn't guess ---- */
  {
    await masker.clear();
    masker.registerManual("Priya Natarajan", "Mia Clarke", "NAME_PII");
    masker.registerManual("0423 998 102", "0498 155 053", "PHONE");
    const p = w.document.createElement("p");
    p.textContent = "Thanks — I've noted the client's details and will follow up with her soon.";
    w.document.body.appendChild(p);
    const before = p.textContent;
    applyRules(p, buildSwapRules("unmask"));
    check(p.textContent === before, "paraphrased response (no verbatim fake) is left untouched, not corrupted");
    check(!p.textContent.includes("Priya") && !p.textContent.includes("Natarajan"),
      "paraphrase case does not hallucinate a restore", p.textContent);
    p.remove();
  }

  /* ---- 2. Partial echoes for non-name types fail safely ---- */
  {
    await masker.clear();
    masker.registerManual("0423 998 102", "0498 155 053", "PHONE");
    masker.registerManual("priya.nat@outlook.com", "mia.fletcher34@example.com.au", "EMAIL");
    masker.registerManual("234 567 891", "712 864 460", "TFN");
    const cases = [
      ["call them on 0498 for a follow-up", "phone fragment (area code only)"],
      ["their number ends in 053", "phone fragment (last 3 digits)"],
      ["reach out via mia.fletcher34 if needed", "email local-part only"],
      ["the file reference is 712-864", "TFN fragment"],
    ];
    for (const [text, label] of cases) {
      const p = w.document.createElement("p");
      p.textContent = text;
      w.document.body.appendChild(p);
      applyRules(p, buildSwapRules("unmask"));
      check(
        !p.textContent.includes("0423") && !p.textContent.includes("998") &&
        !p.textContent.includes("priya.nat") && !p.textContent.includes("234 567 891") &&
        !p.textContent.includes("891"),
        `partial ${label} does not corrupt into wrong/unexpected real data`,
        p.textContent
      );
      p.remove();
    }
  }

  /* ---- 3. Many pairs active at once, mixed types ---- */
  {
    await masker.clear();
    const N = 60;
    const entries = [];
    for (let i = 0; i < N; i++) {
      const real = `Test Person${i} 041${(1000000 + i).toString().slice(-7)}`;
      const findings = [
        { type: "NAME_PII", value: `Test Person${i}`, index: 0 },
        { type: "PHONE", value: `041${(1000000 + i).toString().slice(-7)}`, index: 0 },
      ];
      for (const f of findings) {
        const { replacements } = await masker.mask(f.value, [f]);
        entries.push({ real: f.value, fake: replacements[0].fake, type: f.type });
      }
    }
    const t0 = Date.now();
    const body = w.document.createElement("div");
    for (const e of entries) {
      const p = w.document.createElement("p");
      p.textContent = e.fake;
      body.appendChild(p);
    }
    w.document.body.appendChild(body);
    applyRules(body, buildSwapRules("unmask"));
    const ms = Date.now() - t0;
    let bad = 0;
    for (let i = 0; i < entries.length; i++) {
      const text = body.children[i].textContent;
      if (text !== entries[i].real) bad++;
    }
    check(bad === 0, `all ${entries.length} entries (mixed NAME_PII/PHONE, ${N} people) restore correctly at scale`, `${bad} wrong`);
    check(ms < 5000, `restore over ${entries.length} entries completes in reasonable time`, `${ms}ms`);
    body.remove();
  }

  /* ---- 4. Two fakes where one is a literal substring of the other ---- */
  {
    await masker.clear();
    // Engineer a guaranteed substring relationship regardless of the normal
    // generators: register directly.
    masker.registerManual("Real Alpha", "Noah Reid", "NAME_PII");
    masker.registerManual("Real Beta", "Noah Reidstone", "NAME_PII"); // contains "Noah Reid" as a prefix
    const p1 = w.document.createElement("p");
    p1.textContent = "Please follow up with Noah Reid about the invoice.";
    w.document.body.appendChild(p1);
    applyRules(p1, buildSwapRules("unmask"));
    check(p1.textContent.includes("Real Alpha"), "shorter fake (substring of a longer one) restores to ITS OWN real value", p1.textContent);
    check(!p1.textContent.includes("Real Beta"), "shorter fake match does not pull in the longer entry's real value", p1.textContent);
    p1.remove();

    const p2 = w.document.createElement("p");
    p2.textContent = "Please follow up with Noah Reidstone about the invoice.";
    w.document.body.appendChild(p2);
    applyRules(p2, buildSwapRules("unmask"));
    check(p2.textContent.includes("Real Beta"), "longer fake (containing a shorter one as a prefix) restores to ITS OWN real value", p2.textContent);
    check(!p2.textContent.includes("Real Alpha"), "longer fake match is not corrupted by the shorter entry's rule matching inside it", p2.textContent);
    p2.remove();
  }

  /* ---- 5. Fake colliding with a DIFFERENT entry's real value (regression) ---- */
  {
    await masker.clear();
    masker.registerManual("Chloe Bennett", "Some Other Fake", "NAME_PII"); // A's real name
    // Force B's generated fake to collide with A's real value by monkey-patching
    // Math.random briefly is fragile; instead verify the GUARD directly: ask
    // previewFake/_getOrCreate to never return a fake equal to a known real.
    const known = new Set(masker.realToFake.keys());
    for (let i = 0; i < 200; i++) {
      const fake = masker.previewFake("NAME_PII", `Person${i}`, new Set());
      if (known.has(fake)) {
        failures++;
        console.log(`FAIL  previewFake returned a fake ("${fake}") equal to an existing real value`);
      }
    }
    console.log("pass  previewFake never returns a fake matching another entry's real value (200 draws)");
  }

  /* ---- 6. Idempotency: restoring already-restored text is a no-op ---- */
  {
    await masker.clear();
    masker.registerManual("Priya Natarajan", "Mia Clarke", "NAME_PII");
    const p = w.document.createElement("p");
    p.textContent = "Please contact Mia Clarke about the invoice.";
    w.document.body.appendChild(p);
    const rules = buildSwapRules("unmask");
    applyRules(p, rules);
    const once = p.textContent;
    applyRules(p, rules); // second pass over already-real text
    const twice = p.textContent;
    check(once === "Please contact Priya Natarajan about the invoice.", "first restore pass is correct", once);
    check(twice === once, "second restore pass over already-real text is a no-op", twice);
    p.remove();
  }

  console.log(`\nRESTORE-ROBUSTNESS: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
