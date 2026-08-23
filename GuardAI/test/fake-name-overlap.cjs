/**
 * A stand-in name must not reuse any word from the real name.
 *
 * ═══ THE BUG THIS PINS ═════════════════════════════════════════════════════
 *
 * Found 2026-08-22, by test/name-matching.cjs failing about 1 run in 60:
 *
 *     real  "Aisha Al-Rashid"   ->   fake  "Aisha Halloway"
 *
 * The surname was replaced. The given name was sent to the AI verbatim. From
 * the user's side the message looked masked, and half of the name was not.
 *
 * The existing collision guard rejected a fake equal to the WHOLE real value,
 * a fake already in the mapping table, and a fake equal to some other entry's
 * real value. A part-for-part collision matched none of those. With 40 names
 * in each pool it lands roughly 1 time in 40 whenever the real given name is
 * one the pool also contains — and the pool is deliberately stocked with
 * common Anglo, Arabic, South Asian, Chinese and European given names, so
 * "the real name is one the pool contains" is the normal case, not a freak.
 *
 * It is also a bug that hid behind randomness: it did not reproduce on demand,
 * it produced an intermittent test failure that looked like flakiness, and the
 * previous flaky assertion in that same file made it easy to dismiss as more
 * of the same. Both were real.
 *
 * SCOPE MATTERS. This applies to NAME_PII only. ORG stand-ins are SUPPOSED to
 * share a word — "Bellweather Logistics" -> "Coastline Logistics" keeps the
 * sentence readable, and "Logistics" is a designator rather than an identity.
 * A blanket rule would have broken that, so the test asserts both directions.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/** Whole words of a value, lowercased, ignoring one-letter fragments. */
const words = (v) =>
  String(v || "").toLowerCase().split(/[^\p{L}\p{M}]+/u).filter((t) => t.length > 1);

/** Real names chosen so their given names ARE in the stand-in pools. */
const REALS = [
  "Aisha Al-Rashid",   // the reported case
  "Emma Clarke", "Grace Whitfield", "Sophie Newman", "Priya Sharma",
  "Oliver Hughes", "Liam Foster", "Noah Bennett", "Marcus Webb",
  "Hassan Nazari", "Elena Petrova", "Kenji Watanabe", "Maya Lindqvist",
];

(async () => {
  const w = loadWindow();

  /* ---- 1. Measured, not asserted once ---- */
  console.log("\n--- no stand-in reuses a word from the real name ---");
  {
    const masker = new w.GuardAI.Masker();
    await masker.load();
    let reused = 0, drawn = 0;
    const examples = [];
    for (const real of REALS) {
      const realWords = new Set(words(real));
      for (let i = 0; i < 200; i++) {
        // A fresh real value each draw, so this measures generation rather
        // than the mapping table handing back one cached answer 200 times.
        const probe = `${real} ${i}`;
        const fake = masker.previewFake("NAME_PII", probe, new Set());
        drawn++;
        const hit = words(fake).filter((t) => realWords.has(t));
        if (hit.length) { reused++; if (examples.length < 3) examples.push(`${real} -> ${fake}`); }
      }
    }
    check(reused === 0, `${drawn} draws across ${REALS.length} names, none reused a real word`,
      `${reused} reused: ${examples.join(" | ")}`);
  }

  /* ---- 2. The exact reported case ---- */
  console.log("\n--- the reported case ---");
  {
    const masker = new w.GuardAI.Masker();
    await masker.load();
    let leaked = 0;
    for (let i = 0; i < 300; i++) {
      const fake = masker.previewFake("NAME_PII", `Aisha Al-Rashid ${i}`, new Set());
      if (/\bAisha\b/i.test(fake)) leaked++;
    }
    check(leaked === 0, '"Aisha Al-Rashid" never keeps "Aisha" in its stand-in (300 draws)',
      `${leaked} leaked`);
  }

  /* ---- 3. End to end, through the real masking path ---- */
  console.log("\n--- end to end ---");
  for (const real of ["Aisha Al-Rashid", "Emma Clarke", "Grace Whitfield"]) {
    let leaked = null;
    for (let i = 0; i < 25 && !leaked; i++) {
      const r = await maskText(w, `Contact ${real} on 0412 556 781`);
      const realWords = new Set(words(real));
      for (const t of words(r.masked)) {
        if (realWords.has(t)) { leaked = `${r.masked} (kept "${t}")`; break; }
      }
    }
    check(!leaked, `no word of ${JSON.stringify(real)} survives a real masking pass`, leaked);
  }

  /* ---- 4. The guard is SCOPED — org designators must still be shared ---- */
  console.log("\n--- scoped to names, not applied blanket ---");
  {
    const masker = new w.GuardAI.Masker();
    await masker.load();
    let shared = 0;
    for (let i = 0; i < 60; i++) {
      const fake = masker.previewFake("ORG", `Bellweather Logistics ${i}`, new Set());
      if (/logistics|pty|ltd|group|holdings|services|solutions/i.test(fake)) shared++;
    }
    check(shared > 0,
      "an ORG stand-in may still carry a legal designator — a blanket rule would have made company names read as nonsense",
      `${shared}/60 kept one`);
  }

  /* ---- 5. Rejecting collisions must not exhaust the pool ---- */
  console.log("\n--- still unique, still gendered ---");
  {
    const masker = new w.GuardAI.Masker();
    await masker.load();
    const used = new Set();
    let dupes = 0;
    for (let i = 0; i < 200; i++) {
      const fake = masker.previewFake("NAME_PII", `Emma Person${i}`, used);
      if (used.has(fake)) dupes++;
      used.add(fake);
    }
    check(dupes === 0, "200 stand-ins for female names are still all distinct", `${dupes} duplicates`);
    const gaz = w.GuardAI.NAME_GAZETTEER;
    let wrongGender = 0;
    for (let i = 0; i < 100; i++) {
      const fake = masker.previewFake("NAME_PII", `Emma Other${i}`, new Set());
      if (gaz.genderOf(fake.split(" ")[0]) === "m") wrongGender++;
    }
    check(wrongGender === 0,
      "and rejecting a name never pushes the draw into the wrong gender pool", `${wrongGender}/100`);
  }

  console.log(`\nFAKE-NAME-OVERLAP: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
