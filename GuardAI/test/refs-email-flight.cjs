/**
 * Email coverage, account/reference-number consistency, and the flight-number
 * exclusion.
 *
 * Background for each group:
 *
 *  1. EMAIL — reported as "never masked". Literal addresses were in fact
 *     detected and masked correctly at every layer (this file pins that down
 *     across all the listed formats so the claim can be re-checked in one
 *     command). The one real gap was the SPELLED-OUT form, which contains no
 *     "@" at all and so was invisible to the anchored literal scan.
 *
 *  2. ACCOUNT / REFERENCE — masked inconsistently: every numeric detector
 *     keyed off CONTIGUOUS digits, so "account NS-6631" masked while
 *     "account 8827 3410" did not. The grouped forms are covered now, and the
 *     point of the table below is that all four listed shapes are asserted
 *     TOGETHER — the inconsistency was only visible when comparing shapes, so
 *     testing one at a time is what let it survive.
 *
 *  3. FLIGHT NUMBERS — "QF-2201" is the same shape as a customer reference but
 *     is public timetable data, so travel context must suppress it.
 *
 * Each group carries negative controls, because widening detection is how
 * over-masking gets introduced.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  const w = loadWindow();
  const det = new w.GuardAI.Detector();

  const typesIn = (text, type) =>
    det.scan(text).filter((f) => f.type === type).map((f) => f.value);

  /* ---- 1. Email formats ---- */
  console.log("\n--- email formats ---");
  const emails = [
    ["standard", "Email john.smith@company.com", "john.smith@company.com"],
    ["dots + digits in local part", "Email j.patel88@northstone.com.au", "j.patel88@northstone.com.au"],
    ["plus-addressing", "Email sarah+work@gmail.com", "sarah+work@gmail.com"],
    ["subdomain", "Email contact@mail.fieldstone.com.au", "contact@mail.fieldstone.com.au"],
    [".net", "Write to hi@example.net today", "hi@example.net"],
    [".org", "Write to a.person@charity.org today", "a.person@charity.org"],
    [".io", "Write to dev@startup.io today", "dev@startup.io"],
    ["underscore + hyphen", "Email first_last@my-company.com.au", "first_last@my-company.com.au"],
    ["obfuscated, spelled out", "Reach me at j dot patel at northstone dot com dot au", "j dot patel at northstone dot com dot au"],
    ["obfuscated, bracketed", "Reach me at john(at)company(dot)com", "john(at)company(dot)com"],
  ];
  for (const [label, text, expected] of emails) {
    const found = typesIn(text, "EMAIL");
    check(found.includes(expected), `email detected: ${label}`, `got ${JSON.stringify(found)}`);
  }

  // Every literal format must actually disappear from the masked output.
  for (const [label, text, expected] of emails) {
    const r = await maskText(w, text);
    check(!r.masked.includes(expected), `email masked out of the message: ${label}`, r.masked);
  }

  // Negative controls — must NOT be read as an email.
  const notEmails = [
    ["plain sentence with 'at'", "Let's meet at the office tomorrow"],
    ["price with 'at'", "I bought it at 15 dollars"],
    ["'at' next to a hostname-ish word", "Look at the report"],
    ["time", "Arriving at 5.30 pm"],
  ];
  for (const [label, text] of notEmails) {
    const found = typesIn(text, "EMAIL");
    check(found.length === 0, `not an email: ${label}`, `got ${JSON.stringify(found)}`);
  }

  /* ---- 2. Account / order reference consistency ---- */
  console.log("\n--- account / reference numbers ---");
  // All four shapes, asserted together. Any of these being detected while
  // another is missed is the exact inconsistency this group exists to catch.
  const refs = [
    ["spaced digits", "account 8827 3410", "8827 3410"],
    ["letters-dash-digits", "account NS-6631", "NS-6631"],
    ["digits-dash-digits", "order reference 044-772-19", "044-772-19"],
    ["letters-dash-digits, 3+4", "order reference HAQ-8760", "HAQ-8760"],
    ["contiguous digits", "account number 9928471", "9928471"],
    ["invoice, spaced", "invoice 4471 9930", "4471 9930"],
    ["reference after the number", "8827 3410 is my account number", "8827 3410"],
  ];
  const refTypes = ["BANK_ACCOUNT", "REF_CODE"];
  for (const [label, text, expected] of refs) {
    const found = det.scan(text).filter((f) => refTypes.includes(f.type)).map((f) => f.value);
    check(found.includes(expected), `reference detected: ${label}`, `got ${JSON.stringify(found)}`);
  }
  for (const [label, text, expected] of refs) {
    const r = await maskText(w, text);
    check(!r.masked.includes(expected), `reference masked out of the message: ${label}`, r.masked);
  }

  // Negative controls — widening this detector must not swallow ordinary numbers.
  const notRefs = [
    ["tracking number near 'order'", "The tracking number for my phone case order is 88291045, has it shipped?", "88291045"],
    ["a date near 'invoice'", "The invoice is dated 12-05-2024 and is overdue", "12-05-2024"],
    ["an ISO date near 'account'", "account opened 2024-05-12", "2024-05-12"],
    ["a phone number trailed by 'invoice'", "Ask the accountant 0412 556 781 about the invoice", "0412 556 781"],
    ["small quantities", "order 12 boxes and 30 units", "12"],
  ];
  for (const [label, text, value] of notRefs) {
    const found = det.scan(text).filter((f) => refTypes.includes(f.type)).map((f) => f.value);
    check(!found.includes(value), `not a reference: ${label}`, `got ${JSON.stringify(found)}`);
  }
  // The phone number above must still be recognised as a PHONE, not just dropped.
  check(typesIn("Ask the accountant 0412 556 781 about the invoice", "PHONE").includes("0412 556 781"),
    "a phone number near 'invoice' stays a PHONE");

  /* ---- 3. Flight numbers are not references ---- */
  console.log("\n--- flight numbers ---");
  const flights = [
    "I'm flying QF-2201 tomorrow",
    "Flight QF-2201 departs at 6am",
    "QF-2201 arrives at 9pm",
    "My flight is QF2201",
    "Booked on VA-0815, departing Sydney",
    "The aircraft for JQ-0512 is delayed at the gate",
  ];
  for (const text of flights) {
    const found = det.scan(text).filter((f) => refTypes.includes(f.type)).map((f) => f.value);
    check(found.length === 0, `flight context suppresses masking: ${JSON.stringify(text)}`,
      `got ${JSON.stringify(found)}`);
  }
  // ...but the SAME shape in account context must still mask, so the exclusion
  // is genuinely context-driven rather than a blanket hole in the detector.
  check(typesIn("Your account NS-6631 is overdue", "REF_CODE").includes("NS-6631"),
    "the same code shape still masks in account context");
  check(typesIn("customer reference QF-2201 on the invoice", "REF_CODE").includes("QF-2201"),
    "even an airline-looking code masks when the context is a customer reference");

  /* ---- 4. Combined message, end to end ---- */
  console.log("\n--- combined message ---");
  {
    const text =
      "Hi, please email j.patel88@northstone.com.au and sarah+work@gmail.com about account 8827 3410 " +
      "and order reference HAQ-8760. I'm flying QF-2201 on Tuesday so call me before then.";
    const r = await maskText(w, text);
    check(!r.masked.includes("j.patel88@northstone.com.au"), "combined: first email masked");
    check(!r.masked.includes("sarah+work@gmail.com"), "combined: second email masked");
    check(!r.masked.includes("8827 3410"), "combined: account number masked");
    check(!r.masked.includes("HAQ-8760"), "combined: order reference masked");
    check(r.masked.includes("QF-2201"), "combined: flight number left alone");
    check(r.masked.includes("I'm flying "), "combined: surrounding text preserved");
    check(r.masked.includes(" on Tuesday so call me before then."), "combined: sentence tail preserved");
    console.log("\n  in : " + text);
    console.log("  out: " + r.masked + "\n");
  }

  console.log(`\nREFS-EMAIL-FLIGHT: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})();
