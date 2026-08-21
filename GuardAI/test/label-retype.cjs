/**
 * Labelled-number re-typing.
 *
 * An Australian Medicare number, TFN or bank account written as
 * "0494 969 403" is indistinguishable BY SHAPE from an 04xx mobile, so the
 * phone detector claims it and the user sees their Medicare number
 * highlighted and legended as "Phone" — misleading, because the colour key
 * then implies every orange value in the message is a phone number.
 *
 * When the text explicitly labels the value ("Medicare number is X",
 * "TFN is X", "account X"), the nearest preceding label wins and the finding
 * is re-typed. Genuine phone numbers, and numbers whose only nearby keyword
 * is across a sentence boundary or inside a longer word ("accountant"), must
 * stay PHONE.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

const w = loadWindow();
const det = new w.GuardAI.Detector();

/** Type the detector assigned to `value` in `text`, or undefined. */
function typeOf(text, value) {
  const f = det.scan(text).find((x) => x.value === value);
  return f && f.type;
}

let failures = 0;
function check(text, value, expected, label) {
  const got = typeOf(text, value);
  if (got === expected) {
    console.log(`pass  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label} — expected ${expected}, got ${got}`);
  }
}

/* ---- The exact message that surfaced this bug ---- */
const REAL = "Can you write a follow-up email to my client Sophie Newman? Her mobile is " +
  "0410 632 922 and email is noah.walker16@sample.net. She's at 140 Wattle Cres " +
  "Melbourne. Her Medicare number is 0494 969 403 and TFN is 0417 036 311. " +
  "DOB 11/08/1978. Payment should go to BSB 468-329, account 0402 296 812. " +
  "Please include her contact details in the email. make me a table";

check(REAL, "0410 632 922", "PHONE", "an actual mobile stays PHONE");
check(REAL, "0494 969 403", "MEDICARE", "phone-shaped number labelled 'Medicare number is' becomes MEDICARE");
check(REAL, "0417 036 311", "TFN", "phone-shaped number labelled 'TFN is' becomes TFN");
// Nearest label wins: "BSB 468-329, account 0402 296 812" has BOTH keywords in
// range, and the account number must not be claimed by the earlier "BSB".
check(REAL, "0402 296 812", "BANK_ACCOUNT", "nearest label wins — 'account' beats the earlier 'BSB'");
check(REAL, "468-329", "BSB", "the real BSB is still BSB");

/* ---- Must NOT over-trigger ---- */
check("Call me on 0412 556 781 tomorrow.", "0412 556 781", "PHONE",
  "an unlabelled number stays PHONE");
check("Ask the accountant 0412 556 781 about the invoice for Sophie Newman", "0412 556 781", "PHONE",
  "'accountant' does not count as an 'account' label");
check("The licensee 0412 556 781 called about Sophie Newman", "0412 556 781", "PHONE",
  "'licensee' does not count as a 'licence' label");
check("My Medicare is fine. 0412 556 781 is my number, contact Sophie Newman", "0412 556 781", "PHONE",
  "a label across a sentence boundary does not carry over");
check("Her mobile is 0410 632 922 and her name is Sophie Newman", "0410 632 922", "PHONE",
  "'mobile is' keeps it a PHONE");

/* ---- Other labels ---- */
check("Her passport is 0412 556 781 apparently", "0412 556 781", "PASSPORT",
  "'passport' label re-types");
check("The ABN is 0412 556 781 for the business", "0412 556 781", "ABN",
  "'ABN' label re-types");

console.log(`\nLABEL-RETYPE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
