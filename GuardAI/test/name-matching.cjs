/**
 * Name-matching correctness: three bugs in the "full name with other PII"
 * rule, all present in shipping code before this suite existed.
 *
 * BUG A — a live leak, and the highest-severity of the three.
 *   "Contact James Whitfield on 0412 556 781" did not mask the name at all.
 *   "Contact" is correctly rejected as a name word, but rejecting it also
 *   CONSUMED it, so the scan resumed after "James" and the real pair
 *   "James Whitfield" was never tested. Every common business opener does
 *   this: Contact / Regarding / Attention / Dear / From / Subject. A name
 *   went out unmasked with a phone number beside it.
 *
 *   This is the same defect already fixed in the credential scanner:
 *   rejecting a candidate is not neutral, because the rejected span is still
 *   consumed. Both now rewind to re-examine what they rejected.
 *
 * BUG B — corruption plus a partial leak.
 *   "Mary-Anne Douglas" matched only "Anne Douglas" (the hyphen creates an
 *   ASCII word boundary), so masking produced "Mary-Oliver Wells": half the
 *   real name left in the message, the other half replaced, and the sentence
 *   rewritten.
 *
 * BUG C — coverage.
 *   `[A-Z][a-z]+` cannot match José, Zoë, Björn, Siobhán, Renée or Nguyễn.
 *   Every one was missed with other PII present, so the rule protected an
 *   arbitrary subset of people based on whether their name is spelled with
 *   unaccented English letters.
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
  const names = (text) =>
    det.scan(text).filter((f) => f.type === "NAME_PII").map((f) => f.value);

  /* ---- BUG A: a rejected lead word must not swallow the name ---- */
  console.log("\n--- bug A: lead word does not consume the name ---");
  // Every one of these leads is deliberately rejected as a name word. The
  // name after it must still be found.
  const LEADS = [
    "Contact", "Regarding", "Attention", "Attn", "Dear", "From", "Subject",
    "Sent", "Hi", "Hello", "Thanks", "Also", "However", "Today", "Please note",
    "Please contact", "Re",
  ];
  for (const lead of LEADS) {
    const text = `${lead} James Whitfield on 0412 556 781`;
    check(names(text).includes("James Whitfield"),
      `"${lead} <name>" still detects the name`, JSON.stringify(names(text)));
  }
  // ...and the lead word itself must never be masked as the name.
  for (const lead of LEADS) {
    const text = `${lead} James Whitfield on 0412 556 781`;
    check(!names(text).some((n) => n.startsWith(lead + " ")),
      `"${lead} <name>" does not capture the lead word`, JSON.stringify(names(text)));
  }
  // End to end: the real name must be gone from the sent message.
  {
    const text = "Contact James Whitfield on 0412 556 781 about the invoice.";
    const r = await maskText(w, text);
    check(!r.masked.includes("James Whitfield"), "bug A: real name is masked end to end", r.masked);
    check(r.masked.startsWith("Contact "), "bug A: the word 'Contact' is left alone", r.masked);
    check(r.masked.endsWith(" about the invoice."), "bug A: surrounding text preserved", r.masked);
    console.log("      " + r.masked);
  }

  /* ---- BUG B: hyphenated / apostrophed names are single tokens ---- */
  console.log("\n--- bug B: hyphens and apostrophes ---");
  const COMPOUND = [
    ["Mary-Anne Douglas", "Mary-Anne Douglas"],
    ["Jean-Pierre Dubois", "Jean-Pierre Dubois"],
    ["Siobhán O'Brien", "Siobhán O'Brien"],
    ["Aisha Al-Rashid", "Aisha Al-Rashid"],
    ["Anna-Lena D'Angelo", "Anna-Lena D'Angelo"],
  ];
  for (const [name, expected] of COMPOUND) {
    const text = `Contact ${name} on 0412 556 781`;
    check(names(text).includes(expected), `whole name captured: ${name}`,
      JSON.stringify(names(text)));
  }
  // The specific corruption: no fragment of the real name may survive.
  for (const [name] of COMPOUND) {
    const text = `Contact ${name} on 0412 556 781`;
    const r = await maskText(w, text);
    const firstPart = name.split(/[\s'-]/)[0];
    check(!r.masked.includes(firstPart),
      `no fragment of ${JSON.stringify(name)} left behind (was "${firstPart}-...")`, r.masked);
  }

  /* ---- BUG C: non-ASCII names ---- */
  console.log("\n--- bug C: accented and non-ASCII names ---");
  const UNICODE = [
    "José Martinez", "Zoë Chen", "Björn Andersen", "Renée Dubois",
    "Siobhán Murphy", "Łukasz Kowalski", "Nguyễn Duc", "Müller Schmidt",
    "Søren Jensen", "Chloé Bernard",
  ];
  for (const name of UNICODE) {
    const text = `Contact ${name} on 0412 556 781`;
    check(names(text).includes(name), `detected: ${name}`, JSON.stringify(names(text)));
  }
  {
    const text = "Contact José Martinez on 0412 556 781";
    const r = await maskText(w, text);
    check(!r.masked.includes("José"), "accented name masked end to end", r.masked);
    console.log("      " + r.masked);
  }

  /* ---- Names longer than two tokens ---- */
  console.log("\n--- three and four token names ---");
  // A strictly two-token rule truncated every name that isn't First+Last:
  // "Ng Wei Ming" was captured as "Ng Wei", so masking left the real "Ming"
  // beside a fake name. The same half-leak as the hyphen bug, and it falls on
  // Chinese, Vietnamese, Spanish double-surname and Arabic naming rather than
  // being spread evenly.
  const MULTI = [
    "Ng Wei Ming",
    "Nguyen Van An",
    "María García López",
    "Juan Carlos García López",
    "Abd al-Rahman Hassan",
    "Johan van der Berg",
    "María de la Cruz",
  ];
  for (const name of MULTI) {
    const text = `Contact ${name} on 0412 556 781`;
    check(names(text).includes(name), `whole name captured: ${name}`,
      JSON.stringify(names(text)));
  }
  for (const name of MULTI) {
    const text = `Contact ${name} on 0412 556 781`;
    const r = await maskText(w, text);
    for (const part of name.split(/\s+/)) {
      check(!r.masked.includes(part),
        `no token of ${JSON.stringify(name)} survives masking (checked "${part}")`, r.masked);
    }
  }
  // The run must give back trailing words that are not part of the name.
  check(names("Contact James Whitfield tomorrow on 0412 556 781").includes("James Whitfield"),
    "trailing lowercase word is not absorbed",
    JSON.stringify(names("Contact James Whitfield tomorrow on 0412 556 781")));
  check(names("Regarding James Whitfield Tomorrow, call 0412 556 781").includes("James Whitfield"),
    "trailing capitalised stopword is trimmed off the run",
    JSON.stringify(names("Regarding James Whitfield Tomorrow, call 0412 556 781")));
  // A company name must stay a company, not become a three-word person.
  {
    const found = det.scan("Contact James Whitfield Consulting on 0412 556 781");
    check(found.some((f) => f.type === "ORG" && f.value === "James Whitfield Consulting"),
      "company designator keeps the span as an ORG, not a 3-token person",
      JSON.stringify(found.map((f) => f.type + ":" + f.value)));
    check(!found.some((f) => f.type === "NAME_PII" && f.value.includes("Consulting")),
      "no person finding swallows the company designator");
  }

  /* ---- The existing gate is unchanged ---- */
  console.log("\n--- unchanged behaviour ---");
  check(names("Contact James Whitfield about the invoice").length === 0,
    "still requires other PII (or a name-intro phrase) — no bare-name detection",
    JSON.stringify(names("Contact James Whitfield about the invoice")));
  check(names("My name is James Whitfield").includes("James Whitfield"),
    "name-intro phrase still works without other PII");
  check(names("Account Balance is 8827 3410").length === 0,
    "form labels are still not names",
    JSON.stringify(names("Account Balance is 8827 3410")));
  check(names("Contact Acme Pty Ltd on 0412 556 781").length === 0,
    "company designators are still not people",
    JSON.stringify(names("Contact Acme Pty Ltd on 0412 556 781")));
  // A single stray initial must not become a name.
  check(!names("Contact J K on 0412 556 781").some((n) => n === "J K"),
    "bare initials are not a name", JSON.stringify(names("Contact J K on 0412 556 781")));

  /* ---- Text integrity ---- */
  console.log("\n--- text integrity ---");
  {
    const text = "Regarding Mary-Anne Douglas and José Martinez, both on 0412 556 781.";
    const r = await maskText(w, text);
    const ordered = [...r.items].sort((a, b) => a.start - b.start);
    let rebuilt = "";
    let cur = 0;
    for (const it of ordered) { rebuilt += text.slice(cur, it.start) + it.fake; cur = it.end; }
    rebuilt += text.slice(cur);
    check(rebuilt === r.masked, "only detected spans replaced", r.masked);
    check(r.masked.startsWith("Regarding "), "lead word preserved", r.masked);
    check(r.masked.includes(" and "), "conjunction preserved", r.masked);
    check(r.masked.endsWith(", both on " + (r.items.find((i) => i.type === "PHONE") || {}).fake + "."),
      "sentence tail preserved", r.masked);
    console.log("      " + r.masked);
  }

  /* ---- Performance: the widened pattern must stay linear ---- */
  console.log("\n--- performance ---");
  {
    const hostile = "Contact ".repeat(20000) + "0412 556 781";
    const t0 = Date.now();
    det.scan(hostile);
    const ms = Date.now() - t0;
    check(ms < 1000, `rewind on a 20k-rejection input stays fast (${ms}ms)`);

    const unicodeWall = "Ábcdé Fghíj ".repeat(20000) + "0412 556 781";
    const t1 = Date.now();
    det.scan(unicodeWall);
    const ms2 = Date.now() - t1;
    check(ms2 < 3000, `unicode-heavy input stays fast (${ms2}ms)`);
  }

  console.log(`\nNAME-MATCHING: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
