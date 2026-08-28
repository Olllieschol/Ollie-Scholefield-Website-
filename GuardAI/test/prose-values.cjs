/**
 * Values as DOCUMENTS write them — four defects from the first live
 * "Send as safe text" run (2026-08-28, a real offer letter), each held down
 * with the control that would catch a lazy fix.
 *
 *   1. "your date of birth as 14 March 1991" reached the model VERBATIM.
 *      Detection existed; DOB was warn-only, and the doc flow has no warning
 *      card. Fixed in two places, and the second mattered as much as the
 *      first: rowCtx() searched its keyword in the WHOLE DOCUMENT, so once
 *      "birth" appeared anywhere, every date on a comma-rich line became a
 *      DOB — including the job's commencement date, which the fix would then
 *      have swapped for a fake. Masking a start date is the over-capture
 *      class from the limits file, arriving through a leak fix.
 *   2. "Site Coordinator" -> "Riley Lockhart": the name rule has no positive
 *      person-evidence — with an identifier anywhere in the text, any
 *      capitalised pair fits. The fix is the mechanism the rule already
 *      uses (subtractive word lists), fed with titles/units/geography — in
 *      its OWN set, because COMMON_WORDS also feeds detectOrg's lead
 *      trimmer, where "southern" would truncate Southern Cross Group.
 *   3. "(02) 9147 3388" -> "(0477 415 302": the context phone path starts at
 *      \d and cannot include "(", but its middle class eats ")".
 *   4. MERIDIAN FACILITIES GROUP PTY LTD kept while Meridian Facilities
 *      Group masked: ORG designator literals are Title-case, so all-caps
 *      letterheads failed at "PTY LTD".
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

const w = loadWindow();
const det = new w.GuardAI.Detector();

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}
const types = (t) => det.scan(t).map((f) => f.type + ":" + f.value);
const has = (t, type, value) =>
  det.scan(t).some((f) => f.type === type && f.value === value);

console.log("\n--- 1a. dates as documents write them, behind the birth gate ---");
{
  for (const [txt, val] of [
    ["your date of birth as 14 March 1991.", "14 March 1991"],
    ["date of birth: 14th of March 1991", "14th of March 1991"],
    ["DOB: March 14, 1991", "March 14, 1991"],
    ["born on 3 Mar 1991 in Sydney", "3 Mar 1991"],
  ]) {
    check(has(txt, "DOB", val), `DOB found: ${JSON.stringify(txt.slice(0, 40))}`, types(txt).join(" "));
  }
  // Controls: ordinary document dates must NOT be DOB — masking one rewrites
  // a contract's operative dates.
  for (const txt of [
    "Your commencement date is Monday 1 September 2026, at the depot, on site, as agreed.",
    "the lease terminates on 14 March 2026",
    "invoice dated 3 August 2025, payable in 14 days",
  ]) {
    check(!det.scan(txt).some((f) => f.type === "DOB"),
      `control: not a DOB: ${JSON.stringify(txt.slice(0, 44))}`, types(txt).join(" "));
  }
}

console.log("\n--- 1b. rowCtx searches its window, not the document ---");
{
  // A comma-rich line with a date, and the word "birth" NINE HUNDRED chars
  // away. Before the fix this was a DOB; the distance is the whole point.
  const far = "Start Monday 1 September 2026, Alexandria depot, 7am, bring ID, ask for dispatch.\n" +
    ("The committee reviewed the register and noted no material change in the period. ".repeat(12)) +
    "\nWe will also need your date of birth for superannuation.";
  check(far.length > 900, "fixture: the keyword really is far away", String(far.length));
  check(!det.scan(far).some((f) => f.type === "DOB" && f.value.includes("2026")),
    "a far-away 'birth' no longer converts the start date");

  // Control: the REAL table case — header within the window — still works.
  const table = "Name, DOB, TFN, Medicare\nPriya Raghunathan, 14/03/1991, 412 336 907, 2417 88214 3";
  check(det.scan(table).some((f) => f.type === "DOB" && f.value === "14/03/1991"),
    "control: a header row within the window still labels its column", types(table).join(" "));
}

console.log("\n--- 2. titles, units and geography are not people ---");
{
  const t = "TFN 412 336 907. Your appointment as Site Coordinator for the Southern Region, " +
    "reporting to Marcus Ellery in the Northern District office.";
  const names = det.scan(t).filter((f) => f.type === "NAME_PII").map((f) => f.value);
  check(!names.includes("Site Coordinator"), "'Site Coordinator' is not a person", names.join(", "));
  check(!names.includes("Southern Region"), "'Southern Region' is not a person");
  check(!names.includes("Northern District"), "'Northern District' is not a person");
  check(names.includes("Marcus Ellery"), "control: the actual person is still caught", names.join(", "));

  // The reason the stoplist is NOT in COMMON_WORDS: org lead-trimming.
  const org = "Southern Cross Group Pty Ltd will invoice Western Facilities Holdings monthly. TFN 412 336 907.";
  const orgs = det.scan(org).filter((f) => f.type === "ORG").map((f) => f.value);
  check(orgs.includes("Southern Cross Group Pty Ltd"),
    "control: compass words still open a COMPANY name", orgs.join(" | "));
  check(orgs.includes("Western Facilities Holdings"),
    "control: …in the descriptor tier too", orgs.join(" | "));
}

console.log("\n--- 3. bracketed phones come out balanced ---");
{
  const t = "please call me directly on (02) 9147 3388 to discuss";
  const ph = det.scan(t).filter((f) => f.type === "PHONE");
  check(ph.length === 1 && ph[0].value === "(02) 9147 3388",
    "the whole bracketed number is one span", JSON.stringify(ph.map((f) => f.value)));
  // Control: an unbracketed landline and a mobile are unchanged.
  check(has("call 02 9147 3388 today", "PHONE", "02 9147 3388"), "control: unbracketed landline");
  check(has("call 0413 887 220 today", "PHONE", "0413 887 220"), "control: mobile");

  // The generic balance pass: no finding of ANY type may capture one side of
  // a bracket pair the text closes right next to it.
  const scans = [
    "reference (INV-40912) attached",
    "our ABN (41 926 337 812) is on the letterhead",
  ];
  for (const s of scans) {
    for (const f of det.scan(s)) {
      const opens = (f.value.match(/\(/g) || []).length;
      const closes = (f.value.match(/\)/g) || []).length;
      check(opens === closes, `balanced: ${f.type} ${JSON.stringify(f.value)}`,
        `${opens} open vs ${closes} close in ${JSON.stringify(s)}`);
    }
  }
}

console.log("\n--- 4. ALL-CAPS letterheads are the same company ---");
{
  const t = "MERIDIAN FACILITIES GROUP PTY LTD\nABN 41 926 337 812\n\n" +
    "People and Culture, Meridian Facilities Group";
  const orgs = det.scan(t).filter((f) => f.type === "ORG").map((f) => f.value);
  check(orgs.includes("MERIDIAN FACILITIES GROUP PTY LTD"), "the letterhead is detected", orgs.join(" | "));
  check(orgs.includes("Meridian Facilities Group"), "…and the signature still is", orgs.join(" | "));
  // Controls: all-caps HEADINGS have no designator and stay prose.
  for (const heading of [
    "PLEASE READ THE FOLLOWING TERMS CAREFULLY. TFN 412 336 907.",
    "SCHEDULE A COMMENCEMENT AND REMUNERATION. TFN 412 336 907.",
  ]) {
    check(!det.scan(heading).some((f) => f.type === "ORG"),
      `control: not a company: ${JSON.stringify(heading.slice(0, 40))}`,
      types(heading).join(" "));
  }
}

console.log("\n--- 5. the stand-ins wear the value's own format ---");
{
  const m = new w.GuardAI.Masker();
  (async () => {})(); // masker.load is async but previewFake for these types is pure
  const battery = [
    ["DOB", "14 March 1991", /^\d{1,2} [A-Z][a-z]+ (19|20)\d\d$/],
    ["DOB", "14th of March 1991", /^\d{1,2}(st|nd|rd|th) of [A-Z][a-z]+ (19|20)\d\d$/],
    ["DOB", "March 14, 1991", /^[A-Z][a-z]+ \d{1,2}, (19|20)\d\d$/],
    ["DOB", "3 Mar 1991", /^\d{1,2} [A-Z][a-z]{2} (19|20)\d\d$/],
    ["DOB", "14/03/1991", /^\d{2}\/\d{2}\/(19|20)\d\d$/],
    ["DOB", "1991-03-14", /^(19|20)\d\d-\d{2}-\d{2}$/],
    ["DOB", "14.03.1991", /^\d{2}\.\d{2}\.(19|20)\d\d$/],
    ["PHONE", "(02) 9147 3388", /^\(0[2-9]\) \d{4} \d{4}$/],
    ["PHONE", "02 9147 3388", /^0[2-9] \d{4} \d{4}$/],
    ["PHONE", "0413 887 220", /^04\d{2} \d{3} \d{3}$/],
  ];
  // Random draws: one sample proves nothing (limits file, rule (a)) — 40 each.
  for (const [type, real, shape] of battery) {
    let bad = null;
    for (let i = 0; i < 40; i++) {
      const fake = m.previewFake(type, real + (i ? " #" + i : ""), new Set());
      const probe = m.previewFake(type, real, new Set(["__burn" + i]));
      if (!shape.test(probe)) { bad = probe; break; }
    }
    check(!bad, `${type} ${JSON.stringify(real)} keeps its shape across 40 draws`,
      bad ? `got ${JSON.stringify(bad)}` : "");
  }
  // A landline's fake must never equal the real area code layout by chance
  // being the SAME number — previewFake's own collision guard covers value
  // identity; here assert the area code itself moved.
  let sameCode = 0;
  for (let i = 0; i < 40; i++) {
    const f = m.previewFake("PHONE", "(02) 9147 3388", new Set(["__b" + i]));
    if (f.startsWith("(02)")) sameCode++;
  }
  check(sameCode === 0, "a bracketed fake never reuses the real area code", `${sameCode}/40`);
}

console.log(`\nPROSE VALUES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
