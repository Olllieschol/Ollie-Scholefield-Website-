/**
 * Document headings are not people, and a prefixed reference is not a bank
 * account. Both found on a real supplier onboarding pack (2026-08-29).
 *
 * ═══ WHAT WENT WRONG ═══════════════════════════════════════════════════════
 *
 * "New Supplier Onboarding Pack" was masked to "New Emerson Sinclair" — the
 * line that tells the AI what the document is, rewritten into a person.
 * NON_PERSON_WORDS (the fix for "Site Coordinator" -> a person) had NOT
 * regressed: it lists job titles and org units, and heading nouns are a
 * different, open-ended vocabulary. Measured before the fix: 6 of 9 ordinary
 * document headings were read as people.
 *
 * So the rule here is STRUCTURAL — short line, title case, no sentence
 * punctuation, no digits, and the candidate is essentially the whole line —
 * with a gazetteer rescue so a signature block stays a person.
 *
 * ═══ THE COST, ASSERTED RATHER THAN HIDDEN ═════════════════════════════════
 *
 * A name ALONE on its own line that the gazetteer does not vouch for is now
 * missed (§4). Measured 4 of 13 realistic signatures. Any context at all on
 * the line — "Prepared by", "Contact", a trailing role — keeps it, 5 of 5.
 * That residual is limit #2 (the gazetteer is 927 hand-built given names and
 * misses ordinary ones: "Diane" is listed, "Dianne" is not). It is asserted
 * below so it cannot change silently in either direction: if these start
 * being detected the limit has been fixed, and if the KEPT cases start being
 * missed the rule has eaten something it should not.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const w = loadWindow();
const det = new w.GuardAI.Detector();
const gaz = w.GuardAI.NAME_GAZETTEER;

/** A document with an identifier in it, so name detection is unlocked at all. */
const doc = (line) => "Supplier pack.\n\nTFN 354 324 783.\n\n" + line + "\n\nEnd of document.";
const names = (line) => det.scan(doc(line)).filter((f) => f.type === "NAME_PII").map((f) => f.value);

(async () => {

console.log("\n--- 1. the reported heading ---");
{
  check(names("New Supplier Onboarding Pack").length === 0,
    "'New Supplier Onboarding Pack' is not a person", JSON.stringify(names("New Supplier Onboarding Pack")));

  // The REWIND is what made the first attempt at this fix useless: rejecting
  // the full run offers a shorter one from the same line, which covers less
  // of it and slipped through a per-candidate test. The heading verdict is
  // now taken once per line, so the shorter run gets the same answer.
  const got = names("New Supplier Onboarding Pack");
  check(!got.some((v) => /Onboarding|Pack|Supplier/.test(v)),
    "…and no shorter run from the same line sneaks through the rewind", JSON.stringify(got));
}

console.log("\n--- 2. ordinary document headings, none of them people ---");
{
  for (const h of [
    "Employee Handbook Extract", "Vendor Compliance Checklist", "Data Processing Agreement",
    "Risk Assessment Matrix", "Quality Assurance Manual",
    "Annual Leave Policy Summary", "Purchase Order Confirmation", "Service Level Agreement",
    "Supplier Onboarding Pack", "Master Services Agreement", "Incident Response Plan",
    "Contractor Induction Booklet", "Board Meeting Minutes", "Site Safety Briefing",
    "Payment Terms Schedule",
  ]) {
    check(names(h).length === 0, `"${h}" is a title, not a person`, JSON.stringify(names(h)));
  }
  // Numbered headings are still headings.
  check(names("4. Delivery and Acceptance").length === 0, "'4. Delivery and Acceptance' is a heading");
}

console.log("\n--- 2b. RESIDUAL: a heading opening with a form-label word ---");
{
  /**
   * 2 of 18 headings still produce a name, and both share one shape: the
   * FIRST word is a form-label word ("Client", "Customer") that isNameWord
   * rejects, so accept() bails before the line is ever judged, and the
   * surviving two-word tail covers too little of the line to look like a
   * title on its own.
   *
   * It is fixable — judge the line on the untrimmed run when accept() bails
   * — and that fix was measured and REJECTED, because it also swallows
   * "Contact Dana Whitcombe", "Attention Marcus Ellery" and "Regarding
   * Dianne Alcorn": same shape, a label word in front of a real name. A
   * mangled heading is a worse-reading document; a dropped name is a leak,
   * and the leak is the worse half. Asserted so the trade stays visible.
   */
  check(names("Client Intake Form").length > 0,
    "LIMIT: 'Client Intake Form' still yields a name — see the note above");
  check(names("Customer Complaint Register").length > 0,
    "LIMIT: so does 'Customer Complaint Register'");
  // The reason it is not closed:
  for (const keep of ["Contact Dana Whitcombe", "Attention Marcus Ellery", "Regarding Dianne Alcorn"]) {
    check(names(keep).length > 0,
      `…and this is what closing it would cost: "${keep}"`, JSON.stringify(names(keep)));
  }
}

console.log("\n--- 2c. a name run never spans a paragraph break ---");
{
  // The other half of the heading defect, and invisible to the heading rule:
  // the token separator \s+ crossed a blank line, pairing a heading's last
  // word with the next block's first, and clampToSentence then trimmed the
  // value back to ONE token — NAME_PII "Agreement", "Confirmation",
  // "Acceptance", "Culture". Pre-existing; found while fixing the heading.
  for (const [line, word] of [
    ["Service Level Agreement", "Agreement"],
    ["Purchase Order Confirmation", "Confirmation"],
    ["4. Delivery and Acceptance", "Acceptance"],
  ]) {
    check(!names(line).some((v) => v === word),
      `no one-word "person" left over from the block below "${line}"`, JSON.stringify(names(line)));
  }
  // The run is TRUNCATED at the break, not rejected: a real name at the end
  // of a block is swept up with the next block's first word by the greedy
  // match, and rejecting outright lost those names outright.
  check(names("Sarah Chen").length > 0, "a name at the end of a block survives the truncation");
  // A SINGLE newline still separates name tokens — table and CSV rows.
  const csv = det.scan("Name,Phone\nSarah Chen,0412 556 781");
  check(csv.some((f) => f.type === "NAME_PII"), "a name split by a single newline is still found",
    JSON.stringify(csv.map((f) => f.type + ":" + f.value)));
}

console.log("\n--- 3. names are still found where they actually appear ---");
{
  for (const line of [
    "Prepared by Dana Whitcombe",
    "Contact Dianne Alcorn — (07) 3388 5510",
    "Signed: Xylophia Quandrix",
    "Attention Ng Wei Ming",
    "Dana Whitcombe, People and Culture",
  ]) {
    check(names(line).length > 0, `context on the line keeps the person: "${line}"`, JSON.stringify(names(line)));
  }
  // A sentence is never a heading, however short.
  check(names("Contact Sarah Chen on 0412 556 781").length > 0, "a name inside a sentence is untouched");
  // The gazetteer rescue: vouched-for names survive even alone on a line.
  check(gaz.isFirst("sarah"), "fixture: the gazetteer vouches for 'Sarah'");
  check(names("Sarah Chen").length > 0, "a vouched-for name alone on a line is still a person");
  check(names("Ng Wei Ming").length > 0, "…and so is one vouched for by its SURNAME");
}

console.log("\n--- 4. THE COST, after the gazetteer top-up ---");
{
  /**
   * This section originally recorded four bare signature names as lost:
   * Dana Whitcombe, Dianne Alcorn, Marcus Ellery, Xylophia Quandrix. Three
   * were lost only because the gazetteer was thin in its LARGEST group —
   * capping Anglo-Celtic at ~32% of 927 names left it the worst-covered
   * group in the list. The quota was dropped and the bucket topped up
   * (927 -> 1,279 given names) on 2026-08-29, and those three now survive,
   * which is what this section's own note said should happen.
   *
   * What remains is limit #2 proper, and no list will close it: a name
   * genuinely absent from the gazetteer, standing alone on a line with no
   * context at all, is missed.
   */
  for (const n of ["Dana Whitcombe", "Dianne Alcorn", "Marcus Ellery"]) {
    check(names(n).length > 0,
      `recovered by the top-up: "${n}" alone on a line is a person again`,
      JSON.stringify(names(n)));
  }
  check(!gaz.isFirst("xylophia") && !gaz.isLast("quandrix"),
    "fixture: the gazetteer vouches for neither part of the invented name");
  check(names("Xylophia Quandrix").length === 0,
    "LIMIT: a name the list has never heard of, alone on a line, is still missed");
  check(names("Xylophia Quandrix is the contact").length > 0,
    "…and the same name in a sentence is still caught, so the loss is only the bare line");
}

console.log("\n--- 4b. the top-up did not turn sentences into people ---");
{
  // Every name added that is also an ordinary English word went into
  // AMBIGUOUS_FIRST at the same time. Without that, the lowercase path read
  // "please grant access" and "cole slaw" as names — measured, 13 of them.
  for (const s of ["please grant access", "the willow tree", "cole slaw side",
                   "a robin bird", "the holly bush", "a rowan tree"]) {
    const f = det.scan(s + " and the phone is 0412 556 781").filter((x) => x.type === "NAME_PII");
    check(f.length === 0, `ordinary words stay ordinary: "${s}"`, JSON.stringify(f.map((x) => x.value)));
  }
  // …and the same words capitalised are still people.
  for (const s of ["Grant Sullivan", "Willow Baker", "Cole Harrington"]) {
    check(det.scan(s + " called on 0412 556 781").some((x) => x.type === "NAME_PII"),
      `…but capitalised they are still names: "${s}"`);
  }
}

console.log("\n--- 5. the six over-capture incidents are untouched ---");
{
  // The heading rule only ever REJECTS a candidate, so it cannot over-capture
  // — but these are the six the limits list says every detector change must
  // clear, and the point is that the surrounding sentence survives.
  const cases = [
    ["14 Grove Street, Ryan", "Send the parcel to 14 Grove Street, Ryan. Let me know. Call 0412 556 781."],
    ["Mary-Anne Douglas", "Mary-Anne Douglas can be reached on 0412 556 781."],
    ["rwalsh_admin", "my login is username: rwalsh_admin and the phone is 0412 556 781"],
    ["rwalsh_admin", "the login for Xero is rwalsh_admin, phone 0412 556 781"],
    ["Aroha Nkemdirim", "Ask Aroha Nkemdirim about it, her number is 0412 556 781"],
    ["0412 556 781", "james is at 0412 556 781"],
  ];
  for (const [want, text] of cases) {
    const vals = det.scan(text).map((f) => f.value);
    check(vals.some((v) => v.includes(want)), `still caught: ${JSON.stringify(want)}`, JSON.stringify(vals));
    // Nothing captured may swallow an ordinary word beside it.
    check(!vals.some((v) => /\b(Let|Ask|and|the|is at)\b/.test(v)),
      `…and nothing swallowed an ordinary word`, JSON.stringify(vals));
  }
}

console.log("\n--- 6. a prefixed reference is not a bank account ---");
{
  const line = "Reference SUP-2026-0441 · Prepared 12 August 2026";
  const f = det.scan(line);
  check(!f.some((x) => x.type === "BANK_ACCOUNT"),
    "'Reference SUP-2026-0441' reports no bank account", JSON.stringify(f.map((x) => x.type + ":" + x.value)));
  check(f.some((x) => x.type === "REF_CODE" && x.value === "SUP-2026-0441"),
    "…it is a REF_CODE, captured WHOLE — a partial capture would leave '-0441' beside the stand-in",
    JSON.stringify(f.map((x) => x.type + ":" + x.value)));
  check(det.scan("Invoice INV-2026-0441").every((x) => x.type !== "BANK_ACCOUNT"),
    "the same shape after 'Invoice' is also not an account");

  /**
   * Two separate mechanisms, and this asserts BOTH — the first negative
   * control on the tail guard came back green, because REF_CODE's widened
   * capture already covered the reported case and the overlap resolver
   * dropped the bank-account reading. These prefixes are longer than
   * REF_CODE's 2-4 letters, so nothing overlaps them and only the tail guard
   * is left standing. Without it each of these reports a bank account.
   */
  for (const s of ["Reference SUPPLIER-2026-0441", "Reference PURCHASEORDER-2026-0441",
                   "Invoice CONTRACT/2026-0441"]) {
    check(det.scan(s).every((x) => x.type !== "BANK_ACCOUNT"),
      `a long-prefixed code is not an account: "${s}"`,
      JSON.stringify(det.scan(s).map((x) => x.type + ":" + x.value)));
  }

  // CONTROL, and the one that matters: a real account number must still be
  // found. The guard rejects a digit run that is the TAIL of a longer token;
  // a genuine account sits after a space and is untouched.
  const real = det.scan("Account name Harbourview BSB 064-172 Account number 3820 4471");
  check(real.some((x) => x.type === "BANK_ACCOUNT" && x.value === "3820 4471"),
    "control: a real grouped account number is still detected",
    JSON.stringify(real.map((x) => x.type + ":" + x.value)));
  check(real.some((x) => x.type === "BSB"), "control: the BSB beside it is still detected");
  for (const s of ["Account 8827 3410", "acct 044-772-19", "Reference 2026 0441 for the transfer"]) {
    check(det.scan(s).some((x) => x.type === "BANK_ACCOUNT"),
      `control: still an account — "${s}"`, JSON.stringify(det.scan(s).map((x) => x.type + ":" + x.value)));
  }
}

console.log("\n--- 7. masking leaves no half-replaced reference ---");
{
  const text = "Reference SUP-2026-0441 for the supplier account.";
  const { masked } = await maskText(w, text);
  check(!/-0441/.test(masked), "no '-0441' tail survives the substitution", masked);
  check(!/SUP-2026/.test(masked), "and the original code is gone entirely", masked);
}

console.log(`\nHEADING NAMES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
