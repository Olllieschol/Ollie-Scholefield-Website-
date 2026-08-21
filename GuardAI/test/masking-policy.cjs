/**
 * The masking policy, asserted as a contract.
 *
 *   ALWAYS MASK  personal names, company names, phone, email, address,
 *                Medicare, TFN, and account/reference numbers.
 *   NEVER AUTO-MASK  dollar figures, dates (including dates of birth) and
 *                quantities — masking them corrupts the totals, ages and date
 *                arithmetic people ask an AI to compute, and none of them
 *                identifies anyone once every identifier around them is fake.
 *                They must still be DETECTED, so the user is told.
 *   MANUAL OVERRIDE  a user can highlight any left-alone value and mask it by
 *                hand; that path must not consult the auto-mask list, must
 *                pick a same-shape fake, and must leave no residue of the
 *                original.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText, covered } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const SAMPLE =
  "Please chase the overdue invoice for Bellweather Logistics. " +
  "Their contact is Sarah Nguyen, 0412 556 781, sarah.nguyen@bellweather.com.au, " +
  "12 Wattle St Newcastle NSW 2300. Medicare 2296 78345 1, TFN 123 456 782, " +
  "BSB 084-123, account 0402 296 812. " +
  "The invoice is $40,000, issued 14/03/2025, and their DOB on file is 14/03/1998. " +
  "They ordered 250 units at $160 each.";

(async () => {
  const w = loadWindow();
  const { findings, masked, masker, items } = await maskText(w, SAMPLE);

  /* ---- ALWAYS MASK ---- */
  const mustMask = [
    ["Bellweather Logistics", "company name"],
    ["Sarah Nguyen", "personal name"],
    ["0412 556 781", "phone"],
    ["sarah.nguyen@bellweather.com.au", "email"],
    ["12 Wattle St Newcastle", "address"],
    ["2296 78345 1", "Medicare"],
    ["123 456 782", "TFN"],
    ["084-123", "BSB"],
    ["0402 296 812", "account number"],
  ];
  for (const [value, label] of mustMask) {
    check(!masked.includes(value), `always-mask: ${label} is gone from the sent text`,
      `still present: ${value}`);
  }

  /* ---- NEVER AUTO-MASK, but still surfaced ---- */
  const mustKeep = [
    ["$40,000", "dollar figure", true],
    ["$160", "unit price", true],
    ["14/03/2025", "date", false],
    ["14/03/1998", "date of birth", true],
    ["250", "quantity", false],
  ];
  for (const [value, label, expectDetected] of mustKeep) {
    check(masked.includes(value), `never-auto-mask: ${label} survives untouched (${value})`);
    if (expectDetected) {
      check(covered(SAMPLE, findings, value),
        `never-auto-mask: ${label} is still DETECTED so the user is told (${value})`);
    }
  }

  /* ---- The AI can still do the maths ---- */
  check(masked.includes("250 units at $160"),
    "arithmetic inputs stay intact together (250 units at $160)");

  /* ---- The company fake keeps its industry descriptor ---- */
  const orgItem = findings.find((f) => f.type === "ORG");
  check(!!orgItem, "company name is detected as ORG, not as a person");
  if (orgItem) {
    const fake = masker.previewFake("ORG", orgItem.value);
    check(/\bLogistics$/.test(fake),
      "the fake company keeps the real one's descriptor, so the AI still knows it's a logistics firm",
      `got: ${fake}`);
    check(!/Bellweather/i.test(fake), "the fake company drops the identifying word");
  }

  /* ---- MANUAL OVERRIDE: a left-alone value can still be masked by hand ---- *
   * Mirrors content.js msgAutoReplace(): infer a type by SHAPE, generate a
   * same-shape fake, register it. Deliberately does NOT consult isMaskable —
   * that list governs the AUTOMATIC pass only, and this is the escape hatch
   * for exactly the values it leaves behind. */
  check(!masker.isMaskable("MONEY") && !masker.isMaskable("DOB"),
    "money and dates are excluded from the AUTOMATIC mask list");

  const moneyFake = masker.previewFake("MONEY", "$40,000");
  check(/^\$[\d,]+$/.test(moneyFake),
    "manual override: a hand-masked dollar figure still gets a dollar-shaped fake", moneyFake);
  check(moneyFake !== "$40,000", "manual override: the money fake differs from the real value");

  const dobFake = masker.previewFake("DOB", "14/03/1998");
  check(/^\d{2}\/\d{2}\/\d{4}$/.test(dobFake),
    "manual override: a hand-masked date still gets a date-shaped fake", dobFake);
  check(dobFake !== "14/03/1998", "manual override: the date fake differs from the real value");

  /* Residue guarantee, re-homed from detect-adversarial's old maskFull check:
   * a malformed amount must not leave any digits of the original behind when
   * the user masks it by hand. */
  const messy = "$14,2100";
  const messyFake = masker.previewFake("MONEY", messy);
  const messyDigits = messy.replace(/\D/g, "");
  const residue = new RegExp(messyDigits.split("").join("\\D?")).test(messyFake);
  check(!residue, "manual override: no digits of a malformed amount survive in its fake",
    `${messy} -> ${messyFake}`);

  /* ---- Round trip: what's masked must restore exactly ----
   * _env.cjs's maskText() mirrors buildReviewModel + computeMasked, which use
   * previewFake() and deliberately do NOT commit anything to the mapping
   * table. In the real flow registerReviewItems() commits the pairs just
   * before the send; do the same here, or unmask() has an empty table and
   * would trivially return its input unchanged. Uses the items from the SAME
   * maskText call that produced `masked` — a second call builds a fresh
   * masker and would hand back different fakes. */
  for (const it of items) masker.registerManual(it.value, it.fake, it.type);
  await masker.save();
  const restored = await masker.unmask(masked);
  check(restored === SAMPLE, "everything masked restores exactly back to the original");

  console.log(`\nMASKING-POLICY: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
