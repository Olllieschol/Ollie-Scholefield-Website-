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
 * SCOPE. Originally NAME_PII only. It is now every generator that picks from
 * a word list — six of the twenty — because scoping it to one type is exactly
 * what let the identical bug resurface twice more (§6, §7).
 *
 * What must NOT be blanket-rejected is a shared STRUCTURE word. "Bellweather
 * Logistics" -> "Coastline Logistics" keeps the sentence readable, and
 * "Logistics" is a designator rather than an identity; so is "Street" in an
 * address. The tests assert both directions: the identifying word never
 * survives, the classifying word always may.
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

  /* ---- 6. EVERY type built from the name pools, not just NAME_PII ---- */
  console.log("\n--- the same collision, everywhere the name pools are used ---");
  {
    /**
     * The guard above was added for NAME_PII in 4f23af5. EMAIL and USERNAME
     * build their fakes from the SAME pools and were never covered, so the
     * identical collision stayed live for two more years' worth of the thing
     * masking exists to prevent:
     *
     *     real    Marcus Ellery / marcus.ellery@meridianfacilities.com.au
     *     masked  Rupert Wells  / blake.ellery63@example.com.au
     *
     * Measured before the fix: EMAIL 2.4%, USERNAME 2.25%. Both are a real
     * name fragment leaving a document whose name was masked.
     *
     * 4,000 draws each, because a ~2% fault presents as an intermittent and
     * one sample proves nothing — the lesson from the previewFake bug this
     * suite already covers.
     */
    const masker = new w.GuardAI.Masker();
    await masker.load();
    const DRAWS = 4000;

    let emailReuse = 0;
    for (let i = 0; i < DRAWS; i++) {
      const local = masker.previewFake("EMAIL", "marcus.ellery@meridianfacilities.com.au", new Set())
        .split("@")[0].toLowerCase();
      if (local.includes("ellery") || local.includes("marcus")) emailReuse++;
    }
    check(emailReuse === 0,
      "a fake EMAIL never reuses a name token from the real address", `${emailReuse}/${DRAWS}`);

    let userReuse = 0;
    for (let i = 0; i < DRAWS; i++) {
      if (masker.previewFake("USERNAME", "mellery", new Set()).includes("ellery")) userReuse++;
    }
    check(userReuse === 0,
      "a fake USERNAME never carries the real handle's surname", `${userReuse}/${DRAWS}`);

    // CONTROL, and the one that makes the two above meaningful: a guard that
    // fires on every draw would "pass" them by exhausting the retry budget
    // and handing back whatever it had. These prove the pool is still alive.
    const e = new Set(), u = new Set();
    for (let i = 0; i < 300; i++) {
      e.add(masker.previewFake("EMAIL", "a.b@corp.com.au", new Set()));
      u.add(masker.previewFake("USERNAME", "zzzz", new Set()));
    }
    check(e.size > 250, "control: EMAIL fakes are still varied — the guard is not always tripping",
      `${e.size}/300 distinct`);
    check(u.size > 250, "control: USERNAME fakes are still varied", `${u.size}/300 distinct`);

    // A real address whose domain MATCHES the fake pool's, which is the case
    // that makes whole-address comparison trip on "com"/"au". Asserted
    // because it is the shape most likely to break a future change to this
    // guard — not because whole-address comparison leaks: measured, it does
    // not (0/4000 either way). The local-part cut is a cost decision, and
    // this assertion is here so the SAFETY property is pinned regardless of
    // which way that decision goes.
    let sameDomain = 0;
    for (let i = 0; i < DRAWS; i++) {
      const local = masker.previewFake("EMAIL", "marcus.ellery@example.com.au", new Set())
        .split("@")[0].toLowerCase();
      if (local.includes("ellery") || local.includes("marcus")) sameDomain++;
    }
    check(sameDomain === 0,
      "an address sharing the fake pool's own domain still never leaks its name",
      `${sameDomain}/${DRAWS}`);

    // Types that do NOT draw from the name pools must be unaffected.
    let phoneVaried = new Set();
    for (let i = 0; i < 100; i++) phoneVaried.add(masker.previewFake("PHONE", "0427 336 901", new Set()));
    check(phoneVaried.size > 80, "control: PHONE is untouched by the name-token guard",
      `${phoneVaried.size}/100 distinct`);
  }

  /* ---- 7. ORG and ADDRESS — the same bug, third and fourth instance ---- */
  console.log("\n--- the identifying word never survives, the classifying word may ---");
  {
    /**
     * Reported from a live offer letter, 2026-08-29:
     *
     *     real    MERIDIAN FACILITIES GROUP PTY LTD
     *     masked  MERIDIAN PTY LTD
     *
     * "Meridian" is in the ORG stem pool, so the stand-in drew the very word
     * it was replacing. Measured before the fix: ORG 6.2%, and ADDRESS — which
     * nobody had looked at — 17.8%, the worst of the four instances.
     *
     * The fix is NOT "add ORG to the guard": a blanket word check would strip
     * "Logistics" and "Street" too, and an address that reads "60 Cedar
     * Brisbane" tells the AI less than the real one did. Structure words are
     * excluded from the COMPARISON instead, so the designator still carries.
     */
    const masker = new w.GuardAI.Masker();
    await masker.load();
    const DRAWS = 4000;
    const STRUCT = new Set(["ave", "st", "rd", "cres", "pde", "ct", "dr", "street",
      "crescent", "road", "parade", "court", "drive", "avenue", "pty", "ltd",
      "group", "holdings", "partners", "enterprises", "logistics", "industries",
      "consulting"]);

    // -- ORG: the reported case, and the pool at large.
    for (const real of ["MERIDIAN FACILITIES GROUP PTY LTD", "Coastline Logistics",
                        "Kestrel Industries Pty Ltd", "Pinnacle Consulting Group"]) {
      const realWords = new Set(words(real));
      let leak = 0;
      const ex = new Set();
      for (let i = 0; i < DRAWS; i++) {
        const f = masker.previewFake("ORG", real, new Set());
        // Only the STEM identifies; the designator is carried on purpose.
        if (realWords.has(f.split(/\s+/)[0].toLowerCase())) { leak++; if (ex.size < 2) ex.add(f); }
      }
      check(leak === 0, `an ORG stand-in never reuses the real stem — ${JSON.stringify(real)}`,
        `${leak}/${DRAWS}: ${[...ex].join(" | ")}`);
    }

    // -- ADDRESS: street name and suburb are both identifying.
    for (const real of ["22 Oak Crescent Melbourne", "7 Jacaranda Ave Perth",
                        "14 Wattle Street Brunswick"]) {
      const realWords = new Set(words(real).filter((t) => !STRUCT.has(t)));
      let leak = 0;
      const ex = new Set();
      for (let i = 0; i < DRAWS; i++) {
        const f = masker.previewFake("ADDRESS", real, new Set());
        const hit = words(f).filter((t) => !STRUCT.has(t) && realWords.has(t));
        if (hit.length) { leak++; if (ex.size < 2) ex.add(`${f} [${hit}]`); }
      }
      check(leak === 0, `an ADDRESS stand-in never reuses the real street or suburb — ${JSON.stringify(real)}`,
        `${leak}/${DRAWS}: ${[...ex].join(" | ")}`);
    }

    // -- The other direction, and the reason a blanket rule was wrong. These
    //    are the assertions that fail if someone "simplifies" the guard by
    //    dropping STRUCTURE_WORDS.
    let keptDesignator = 0, keptPtyLtd = 0, keptStreetType = 0;
    for (let i = 0; i < 400; i++) {
      if (/logistics/i.test(masker.previewFake("ORG", "Bellweather Logistics", new Set()))) keptDesignator++;
      if (/pty ltd/i.test(masker.previewFake("ORG", "Tanner & Roe Pty Ltd", new Set()))) keptPtyLtd++;
      if (/\b(Ave|St|Rd|Cres|Pde|Ct|Dr)\b/.test(
        masker.previewFake("ADDRESS", "22 Oak Crescent Melbourne", new Set()))) keptStreetType++;
    }
    check(keptDesignator === 400, "an ORG stand-in still reads as a logistics company", `${keptDesignator}/400`);
    check(keptPtyLtd === 400, "an ORG stand-in still reads as a Pty Ltd entity", `${keptPtyLtd}/400`);
    check(keptStreetType === 400, "an ADDRESS stand-in still reads as a street address", `${keptStreetType}/400`);

    // -- CONTROL: the pool must not be exhausted by the guard. With the
    //    designator fixed, the ORG stem pool IS the capacity — at 16 stems a
    //    20-company document handed the SAME stand-in to two companies, which
    //    makes unmasking ambiguous. 40 stems moves that limit to 39.
    for (const [n, expect] of [[20, 0], [30, 0], [38, 0]]) {
      const avoid = new Set();
      let dupes = 0;
      for (let i = 0; i < n; i++) {
        const f = masker.previewFake("ORG", `Distinct${i} Logistics`, avoid);
        if (avoid.has(f)) dupes++;
        avoid.add(f);
      }
      check(dupes === expect, `control: ${n} companies in one document still get ${n} distinct stand-ins`,
        `${dupes} duplicates`);
    }
    const addrAvoid = new Set();
    let addrDupes = 0;
    for (let i = 0; i < 300; i++) {
      const f = masker.previewFake("ADDRESS", `${i + 1} Oak Crescent Melbourne`, addrAvoid);
      if (addrAvoid.has(f)) addrDupes++;
      addrAvoid.add(f);
    }
    check(addrDupes === 0, "control: 300 addresses still get 300 distinct stand-ins", `${addrDupes} duplicates`);
  }

  /* ---- 8. The retry must not corrupt the value's shape ---- */
  console.log("\n--- a rejected draw is retried without mangling the shape ---");
  {
    /**
     * The collision retry used to re-call the generator as
     * `generateFake(type, real + ":" + guard)`. The seed was ALREADY random
     * per call, so the suffix added no randomness — but `real` is what the
     * shape-preserving generators read their structure from, so the retry
     * silently produced malformed values:
     *
     *     BANK_ACCOUNT  "8827 3410" -> "7753 1402:5"   the counter, emitted
     *     LICENCE    "NSW45612378"  -> "428432530"     state prefix dropped
     *     REF_CODE      "SUP-2026"  -> "CPK-05809"     wrong digit count
     *
     * Latent while the guard almost never fired. §7 widened it to ORG (6% of
     * draws) and ADDRESS (18%), which would have made this common — so it is
     * pinned here rather than left to be discovered in a masked document.
     *
     * HOW THE RETRY IS FORCED, and why the obvious way does not work. The
     * first version of this test filled `avoid` with 300 real draws and
     * asserted on the result. It passed — and it passed against the BUG,
     * because BANK_ACCOUNT draws from a 10^8 space, so 300 pre-drawn values
     * never collide and the retry was never entered. Four of the five cases
     * were asserting on a first draw that had never been rejected.
     *
     * `previewFake` only ever calls `avoid.has(f)`, so a counting stub in its
     * place rejects the first N draws deterministically and puts every case
     * genuinely inside the loop.
     */
    const masker = new w.GuardAI.Masker();
    await masker.load();
    /** Rejects the first `n` candidates, then accepts. */
    const rejectFirst = (n) => { let left = n; return { has: () => left-- > 0 }; };

    // The stub must actually be driving the loop: with n=0 and n=6 the code
    // path differs, and a stub that never fired would make the rest vacuous.
    {
      let entered = 0;
      const counting = { has: () => (entered++, entered <= 4) };
      masker.previewFake("BANK_ACCOUNT", "8827 3410", counting);
      check(entered >= 5, "control: the stub really does push the draw into the retry loop",
        `avoid.has() called ${entered}x`);
    }

    const CASES = [
      ["BANK_ACCOUNT", "8827 3410", /^\d{4} \d{4}$/, "two groups of four"],
      ["BANK_ACCOUNT", "044-772-19", /^\d{3}-\d{3}-\d{2}$/, "hyphenated 3-3-2"],
      ["LICENCE", "NSW45612378", /^NSW\d{8}$/, "state prefix kept"],
      ["REF_CODE", "SUP-2026", /^[A-Z]{3}-\d{4}$/, "same letter and digit count"],
      ["ORG", "Coastline Logistics", /^\S+ Logistics$/, "designator kept"],
      ["ADDRESS", "22 Oak Crescent Melbourne", /^\d+ \S+ (Ave|St|Rd|Cres|Pde|Ct|Dr) \S+$/, "still an address"],
      ["DOB", "14 March 1991", /^\d{1,2} [A-Z][a-z]+ \d{4}$/, "prose date stays prose"],
    ];
    for (const [type, real, shape, label] of CASES) {
      let bad = 0;
      const ex = new Set();
      for (let i = 0; i < 500; i++) {
        // 1-8 forced rejections, so both a single retry and a long run of
        // them are covered.
        const f = masker.previewFake(type, real, rejectFirst((i % 8) + 1));
        if (!shape.test(f)) { bad++; if (ex.size < 2) ex.add(f); }
      }
      check(bad === 0, `${type} keeps its shape under retry pressure (${label})`,
        `${bad}/500 malformed: ${[...ex].join(" | ")}`);
    }

    // The OTHER retry site. previewFake is the PREVIEW path; _getOrCreate is
    // the one that actually commits a mapping, and it carried the same bug.
    // The test helper masks via previewFake, so this calls the committing
    // path directly — 38 companies sharing one designator against a 40-stem
    // pool forces genuine rejections, since each registration shrinks what is
    // left.
    /**
     * 34, not 38, and the number is measured rather than chosen.
     *
     * Written at 38 first, this assertion failed about 1 run in 30 — a real
     * intermittent, not noise. Random-draw-with-retry degrades as a pool
     * fills: with 40 ORG stems and 37 taken, each retry has a 3/40 chance of
     * landing on a free one, so a finite budget sometimes runs out and hands
     * back a duplicate. Measured, P(a document gets a duplicate stand-in):
     *
     *          n=30   n=34   n=36   n=38   n=39   n=40
     *   b=50    0%     0%    0.25%  2.75%  9.00%  33.0%
     *   b=100   0%     0%     0%     0%    0.50%  9.25%
     *
     * _getOrCreate's budget was 50 while previewFake's was 100, and this is
     * the path that COMMITS the mapping, so it is the one where a duplicate
     * actually matters. Raised to 100. The curve's shape is unchanged — only
     * where it starts to bite — so the residual is a logged limit, and this
     * assertion sits at 34 where there is real margin rather than at the edge
     * where it would flake again.
     */
    {
      const m2 = new w.GuardAI.Masker();
      await m2.load();
      const N = 34;
      const fakes = [];
      for (let i = 0; i < N; i++) fakes.push(m2._getOrCreate("ORG", `Aldermere${i} Logistics`));
      const malformed = fakes.filter((f) => !/^\S+ Logistics$/.test(f));
      check(malformed.length === 0,
        `_getOrCreate's retry keeps the designator too (${N} companies committed)`,
        `${malformed.length} malformed: ${malformed.slice(0, 3).join(" | ")}`);
      check(new Set(fakes).size === N,
        `control: and all ${N} committed stand-ins are distinct, so the retry really ran`,
        `${new Set(fakes).size}/${N} distinct`);
    }
  }

  console.log(`\nFAKE-NAME-OVERLAP: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
