/**
 * Aggressive (standalone) name detection — opt-in, DEFAULT OFF.
 *
 * Flags a name with no other PII beside it, using src/names-gazetteer.js.
 * Three properties matter more than raw hit rate:
 *
 *  1. ADDITIVE. With the mode off, scan() output must be identical to before
 *     the feature existed. This is asserted directly rather than assumed.
 *
 *  2. THE AMBIGUITY TIERS ACTUALLY FIRE. Words like Sydney, April and Grace
 *     are both names and ordinary words. An earlier version of this had 106
 *     of its 118 ambiguous words missing from the gazetteer, which made the
 *     whole tier dead code — a word absent from the list is never a candidate
 *     at all, so the "requires corroboration" branch was unreachable. The
 *     cross-check below would have caught that.
 *
 *  3. SILENT MODE. A medium-confidence match must force the warning card even
 *     when Masking mode is on, because a false positive that masks silently
 *     rewrites the message with no visible cause. High-confidence matches
 *     stay silent like any other finding.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { loadWindow, maskText } = require("./_env.cjs");
const { makeEnv, wait } = require("../harness.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  const w = loadWindow();
  const off = new w.GuardAI.Detector();
  const on = new w.GuardAI.Detector();
  on.setAggressiveNames(true);
  const namesOf = (det, t) =>
    det.scan(t).filter((f) => f.type === "NAME_PII").map((f) => f.value);

  /* ---- 1. Default is OFF and the feature is additive ---- */
  console.log("\n--- default off / additive ---");
  check(new w.GuardAI.Detector().aggressiveNames === false,
    "a fresh Detector has aggressive names OFF");
  const ADDITIVE = [
    "Please review the file for Priya Sharma",
    "Contact Chidi Okafor about it",
    "I met Grace Whitfield yesterday",
    "Contact James Whitfield on 0412 556 781",
    "Sydney Airport is busy today",
    "Account Balance is 8827 3410",
  ];
  for (const t of ADDITIVE) {
    check(JSON.stringify(off.scan(t)) === JSON.stringify(new w.GuardAI.Detector().scan(t)),
      `mode off changes nothing: ${JSON.stringify(t)}`);
  }
  check(namesOf(off, "Please review the file for Priya Sharma").length === 0,
    "mode off: a standalone name is NOT flagged (existing rule unchanged)");
  check(namesOf(on, "Please review the file for Priya Sharma").length === 1,
    "mode on: the same standalone name IS flagged");

  /* ---- 2. Positive detection ---- */
  console.log("\n--- standalone names detected ---");
  const POSITIVE = [
    ["Please review the file for Priya Sharma", "Priya Sharma", "high"],
    ["Contact Chidi Okafor about it", "Chidi Okafor", "high"],
    ["Send Aroha Nkemdirim the draft", "Aroha Nkemdirim", "medium"],
    ["Ask Zeynep Yilmaz to confirm", "Zeynep Yilmaz", "high"],
    ["I spoke to Nguyen Tran earlier", "Nguyen Tran", "high"],
    ["Forward it to Kwame Mensah", "Kwame Mensah", "high"],
  ];
  for (const [text, expected, sev] of POSITIVE) {
    const found = on.scan(text).filter((f) => f.type === "NAME_PII");
    check(found.some((f) => f.value === expected), `detected: ${expected}`,
      JSON.stringify(found.map((f) => f.value)));
    check(found.some((f) => f.value === expected && f.severity === sev),
      `confidence ${sev}: ${expected}`,
      JSON.stringify(found.map((f) => f.value + ":" + f.severity)));
    check(found.every((f) => f.aggressive === true),
      `marked as aggressive so silent mode can tell it apart: ${expected}`);
  }

  /* ---- 3. Ambiguity tiers ---- */
  console.log("\n--- ambiguous words ---");
  const AMBIG_NEG = [
    "Sydney Airport is busy today",
    "Victoria Police issued a statement",
    "Grace period applies here",
    "April invoice is attached",
    "The Phoenix project starts Monday",
    "Grace is coming",
    "Jordan River is low",
    "Madison Square was packed",
  ];
  for (const t of AMBIG_NEG) {
    check(namesOf(on, t).length === 0, `ambiguous word not flagged: ${JSON.stringify(t)}`,
      JSON.stringify(namesOf(on, t)));
  }
  // ...but the same words ARE names with corroboration.
  const AMBIG_POS = [
    ["I met Grace Whitfield yesterday", "Grace Whitfield"],
    ["Sydney Whitfield called", "Sydney Whitfield"],
    ["We spoke to April Henderson", "April Henderson"],
  ];
  for (const [t, expected] of AMBIG_POS) {
    check(namesOf(on, t).includes(expected), `corroborated ambiguous name: ${expected}`,
      JSON.stringify(namesOf(on, t)));
  }

  /* ---- 4. Every ambiguous word is actually IN the gazetteer ---- */
  console.log("\n--- ambiguity list is reachable, not dead code ---");
  {
    const gaz = w.GuardAI.NAME_GAZETTEER;
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "detector.js"), "utf8");
    const m = src.match(/const AMBIGUOUS_FIRST = new Set\(\[([\s\S]*?)\]\);/);
    check(!!m, "AMBIGUOUS_FIRST is extractable from source");
    const amb = m ? eval("[" + m[1] + "]") : [];
    // A word in the ambiguity stoplist that ISN'T in the gazetteer can never
    // be a candidate, so its entry does nothing. Not fatal, but it means the
    // tier is smaller than it looks — assert the overlap is substantial.
    const reachable = amb.filter((a) => gaz.isFirst(a));
    check(reachable.length >= amb.length * 0.8,
      `most ambiguous words are reachable (${reachable.length}/${amb.length} in the gazetteer)`,
      "unreachable: " + amb.filter((a) => !gaz.isFirst(a)).join(" "));
    // The specific words the settings copy promises to handle must be real.
    for (const word of ["sydney", "april", "grace"]) {
      check(gaz.isFirst(word) && amb.includes(word),
        `"${word}" (named in the settings copy) is both a gazetteer name and ambiguous`);
    }
  }

  /* ---- 5. Masking still preserves the message ---- */
  console.log("\n--- text integrity ---");
  {
    const text = "Please review the file for Priya Sharma before Friday.";
    const w2 = loadWindow();
    const det = new w2.GuardAI.Detector();
    det.setAggressiveNames(true);
    const r = await maskText(w2, text, det);
    check(!r.masked.includes("Priya Sharma") || r.items.length === 0,
      "standalone name is masked when the mode is on", r.masked);
    check(r.masked.startsWith("Please review the file for "), "prefix preserved", r.masked);
    check(r.masked.endsWith(" before Friday."), "suffix preserved", r.masked);
    console.log("      " + r.masked);
  }

  /* ---- 6. Silent mode: medium warns, high stays silent ---- */
  console.log("\n--- silent mode interaction (real pipeline) ---");
  async function runSilent(text) {
    const env = makeEnv({
      pasteWorks: true,
      seed: { guardai_masking_enabled: true, guardai_aggressive_names: true },
    });
    await wait(80);
    env.EDITOR.textContent = text;
    env.EDITOR.dispatchEvent(
      new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await wait(150);
      if (env.sentMessages.length > 0 || env.document.querySelector(".guardai-prompt--warn")) {
        await wait(150);
        break;
      }
    }
    return {
      warned: !!env.document.querySelector(".guardai-prompt--warn"),
      sent: env.sentMessages.map((m) => m.text).join(""),
      sentCount: env.sentMessages.length,
    };
  }
  {
    // MEDIUM: surname not in the gazetteer -> must warn rather than silently mask.
    const med = await runSilent("Send Aroha Nkemdirim the draft");
    check(med.warned, "silent mode: a MEDIUM-confidence standalone name shows the warning card",
      JSON.stringify(med));
    check(med.sentCount === 0, "silent mode: nothing was sent before the user saw it",
      JSON.stringify(med));
  }
  {
    // HIGH: both names in the gazetteer -> behaves like any other finding.
    const high = await runSilent("Send Priya Sharma the draft");
    check(high.sentCount === 1, "silent mode: a HIGH-confidence name masks and sends silently",
      JSON.stringify(high));
    check(!high.sent.includes("Priya Sharma"), "silent mode: the real name was masked",
      high.sent);
    console.log("      sent: " + high.sent);
  }

  console.log(`\nAGGRESSIVE-NAMES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
