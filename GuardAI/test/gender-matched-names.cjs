/**
 * Gender-matched name masking.
 *
 * A female name replaced by a male stand-in makes the AI's reply subtly wrong
 * ("name is Sophie Newman" -> "Got it, Oliver") and corrupts anything drafted
 * from it. The stand-in now takes its gender from the real name.
 *
 * ═══ THE DESIGN THIS FILE DEFENDS ═════════════════════════════════════════
 *
 * UNCERTAINTY IS ROUTED TO NEUTRAL, NEVER TO A GUESS. The gazetteer tags
 * conservatively: anything whose gender is unknown, contradictory across
 * origins, or genuinely unisex is tagged unisex and gets a neutral stand-in.
 * A neutral name cannot be WRONG, only uninformative. That matters most for
 * non-Anglo names, where confidence is lowest and a confidently wrong
 * stand-in would be worse than the random one it replaced.
 *
 * "juan" is the worked example: Spanish male AND Chinese female. It resolves
 * to unisex automatically rather than picking a side.
 *
 * POOL SIZING IS A CORRECTNESS PROPERTY, NOT COSMETICS. previewFake()
 * guarantees unique fakes by RE-GENERATING on collision, giving up after 100
 * tries and returning a duplicate — two different people silently sharing one
 * stand-in, the same indistinguishable-fakes bug that made
 * "[redacted-secret]" unusable. The pool was 16x14 = 224 against a 500-entry
 * table, already under-provisioned, and a naive gender split would have
 * halved it. Each pool now clears 1,500.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  const w = loadWindow();
  const gaz = w.GuardAI.NAME_GAZETTEER;
  const masker = new w.GuardAI.Masker();
  await masker.load();

  const fakeFor = (real) => masker.previewFake("NAME_PII", real, new Set());
  const genderOfFake = (fake) => {
    const first = fake.split(" ")[0];
    if (w.__pools.male.includes(first)) return "m";
    if (w.__pools.female.includes(first)) return "f";
    if (w.__pools.unisex.includes(first)) return "u";
    return "?";
  };

  // Read the pools straight out of the source so this test cannot drift from
  // what the masker actually uses.
  {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "masker.js"), "utf8");
    const grab = (name) => {
      const m = src.match(new RegExp("const " + name + " = \\[([\\s\\S]*?)\\];"));
      return m ? (m[1].match(/"[^"]+"/g) || []).map((x) => x.slice(1, -1)) : [];
    };
    w.__pools = { male: grab("FIRST_MALE"), female: grab("FIRST_FEMALE"),
                  unisex: grab("FIRST_UNISEX"), last: grab("LAST_NAMES") };
  }

  /* ---- 1. Gender is preserved ---- */
  console.log("\n--- gender preserved ---");
  const GENDERED = [
    ["Sophie Newman", "f"], ["Emma Clarke", "f"], ["Priya Sharma", "f"],
    ["Fatima Khan", "f"], ["Eleni Papadopoulos", "f"],
    ["James Whitfield", "m"], ["Chidi Okafor", "m"], ["Mehmet Yilmaz", "m"],
    ["Rajesh Patel", "m"], ["Giuseppe Rossi", "m"],
  ];
  for (const [real, expected] of GENDERED) {
    check(gaz.genderOf(real.split(" ")[0]) === expected,
      `gazetteer tags ${real.split(" ")[0]} as ${expected}`,
      String(gaz.genderOf(real.split(" ")[0])));
    // Repeat: the stand-in is randomly seeded, so one sample proves little.
    let wrong = 0;
    for (let i = 0; i < 40; i++) {
      if (genderOfFake(masker.previewFake("NAME_PII", real + ":" + i, new Set())) !== expected) wrong++;
    }
    check(wrong === 0, `${real} always gets a ${expected} stand-in (40 draws)`,
      `${wrong}/40 mismatched`);
  }

  /* ---- 2. Uncertainty routes to neutral, never to a guess ---- */
  console.log("\n--- uncertainty -> neutral ---");
  const NEUTRAL = [
    ["Juan Garcia", "tagged both Spanish-male and Chinese-female"],
    ["Wei Chen", "romanised Chinese carries no reliable gender"],
    ["Xylophia Quandrix", "not in the gazetteer at all"],
    ["Zzzz Yyyy", "not a name the list knows"],
  ];
  for (const [real, why] of NEUTRAL) {
    let nonNeutral = 0;
    for (let i = 0; i < 40; i++) {
      if (genderOfFake(masker.previewFake("NAME_PII", real + ":" + i, new Set())) !== "u") nonNeutral++;
    }
    check(nonNeutral === 0, `${real} gets a NEUTRAL stand-in — ${why}`,
      `${nonNeutral}/40 were gendered`);
  }
  check(gaz.genderOf("juan") === "u",
    "the cross-cultural collision 'juan' resolved to unisex rather than picking a side");
  check(gaz.genderOf("xylophia") === null,
    "a name absent from the gazetteer returns null, distinct from known-unisex");

  /* ---- 3. Detection is completely unaffected ---- */
  console.log("\n--- detection unchanged by the split ---");
  // A FLOOR, not an equality. This asserted `=== 927` — the size on the day
  // the gender split landed — which made it a change-detector for the list's
  // length rather than a check that the split lost nothing, and it failed the
  // moment the Anglo-Celtic bucket was topped up (2026-08-29, 927 -> 1,279).
  // The invariant that matters is the partition below; this one only has to
  // say the list never SHRINKS silently.
  check(gaz.first.size >= 927,
    "the union still holds every given name the list had before the split",
    String(gaz.first.size));
  check(gaz.firstMale.size + gaz.firstFemale.size + gaz.firstUnisex.size === gaz.first.size,
    "the three sets partition the union exactly — no name lost, none duplicated",
    `${gaz.firstMale.size}+${gaz.firstFemale.size}+${gaz.firstUnisex.size} vs ${gaz.first.size}`);
  const det = new w.GuardAI.Detector();
  for (const t of [
    "Contact James Whitfield on 0412 556 781",
    "contact oliver scholefield his phone number is 0414 593 204",
    "Contact José Martinez on 0412 556 781",
  ]) {
    check(det.scan(t).some((f) => f.type === "NAME_PII"),
      `detection still works: ${JSON.stringify(t.slice(0, 40))}`);
  }

  /* ---- 4. Pool sizing beats the mapping cap ---- */
  console.log("\n--- pools are large enough to stay unique ---");
  const CAP = 500;
  for (const g of ["male", "female", "unisex"]) {
    const combos = w.__pools[g].length * w.__pools.last.length;
    check(combos > CAP * 2, `${g} pool gives ${combos} combinations (> 2x the ${CAP}-entry cap)`,
      String(combos));
  }
  // The real property: masking many same-gender people yields distinct fakes.
  {
    const m2 = new w.GuardAI.Masker();
    await m2.load();
    const seen = new Set();
    const used = new Set();
    let dupes = 0;
    for (let i = 0; i < 200; i++) {
      const real = `Sophie Person${i}`;
      const fake = m2.previewFake("NAME_PII", real, used);
      if (seen.has(fake)) dupes++;
      seen.add(fake);
      used.add(fake);
      check_silent(genderOfFake(fake) === "f");
    }
    check(dupes === 0, "200 different female names all get DISTINCT stand-ins", `${dupes} duplicates`);
    check(seen.size === 200, "200 distinct stand-ins generated", String(seen.size));
  }

  /* ---- 5. Existing mappings are grandfathered ---- */
  console.log("\n--- existing mappings are not rewritten ---");
  {
    const m3 = new w.GuardAI.Masker();
    await m3.load();
    // Simulate a pre-existing, gender-mismatched pair from before this change.
    m3.registerManual("Sophie Newman", "Oliver Scholefield", "NAME_PII");
    check(m3.previewFake("NAME_PII", "Sophie Newman", new Set()) === "Oliver Scholefield",
      "a stored mapping keeps its old stand-in, so past conversations still restore correctly",
      m3.previewFake("NAME_PII", "Sophie Newman", new Set()));
  }

  console.log(`\nGENDER-MATCHED-NAMES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });

/** Silent variant used inside tight loops; only the aggregate is reported. */
function check_silent(ok) { if (!ok) failures++; }
