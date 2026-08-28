/**
 * Document-length scanning, and the policy that decides block or pass.
 *
 * The regression this file exists for: Detector.scan() truncates at
 * MAX_SCAN_LENGTH (100,000 chars) and reports it only to the console. On a
 * chat message that ceiling is unreachable. On a 40-page contract it is
 * halfway down, and past it a scan of a document full of credentials returns
 * exactly what a scan of a clean document returns — nothing. Measured before
 * the fix, with the position of the secret as the ONLY variable:
 *
 *     130,080-char document, secret at  50,000 -> CREDIT_CARD, TFN, MEDICARE
 *     130,080-char document, secret at 110,000 -> (nothing)
 *
 * The first case is this suite's control. If a change ever makes scanLong()
 * silently stop covering the tail again, case 2 goes quiet while case 1 keeps
 * passing, so both are asserted every run.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

const w = loadWindow();
const F = w.GuardAI.FileScan;
const det = new w.GuardAI.Detector();

let failures = 0;
let controlsThatCaughtNothing = [];

function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/** A control asserts that the test could fail. If it never does, say so. */
function control(shouldBeCaught, label) {
  if (shouldBeCaught) console.log("ctrl  " + label + " (control caught it, as intended)");
  else { controlsThatCaughtNothing.push(label); console.log("CTRL? " + label + " — control caught NOTHING, this test proves less than it looks"); }
}

const SECRET = "Company credit card 4556 7375 8689 9855, TFN 431 887 220, Medicare 2298 41883 1.";
const FILLER = "The Committee reviewed the incident register and noted no material change in the period. ";
const HIGH = ["CREDIT_CARD", "TFN", "MEDICARE"];

function docWithSecretAt(pos, total) {
  const head = FILLER.repeat(Math.ceil(pos / FILLER.length)).slice(0, pos);
  const tail = FILLER.repeat(Math.ceil((total - pos) / FILLER.length)).slice(0, total - pos);
  return head + SECRET + tail;
}

console.log("\n--- 1. the truncation cliff ---");
{
  const positions = [1000, 50000, 99000, 110000, 250000, 480000];
  for (const pos of positions) {
    const doc = docWithSecretAt(pos, 500000);
    const found = F.scanLong(det, doc).filter((f) => HIGH.includes(f.type));
    const types = [...new Set(found.map((f) => f.type))].sort();
    check(HIGH.every((t) => types.includes(t)),
      `secret at ${pos} of ${doc.length} chars is found`, `got [${types}]`);
  }

  // Control: the OLD behaviour must still be demonstrable, or the fix above is
  // proving nothing. scan() directly on the same document should miss the tail.
  const doc = docWithSecretAt(110000, 130000);
  const rawMisses = det.scan(doc).filter((f) => HIGH.includes(f.type)).length === 0;
  control(rawMisses, "unchunked Detector.scan() still misses a secret at 110k");
}

console.log("\n--- 2. values lying across a window boundary ---");
{
  // Plant the secret so it straddles each internal chunk edge exactly.
  const size = 300000;
  let straddled = 0;
  for (const edge of [F.CHUNK, F.CHUNK * 2, F.CHUNK * 3]) {
    for (const nudge of [-40, -12, 0, 12, 40]) {
      const pos = edge + nudge;
      if (pos <= 0 || pos + SECRET.length >= size) continue;
      const doc = docWithSecretAt(pos, size);
      const types = [...new Set(F.scanLong(det, doc).filter((f) => HIGH.includes(f.type)).map((f) => f.type))];
      const ok = HIGH.every((t) => types.includes(t));
      if (!ok) straddled++;
      check(ok, `straddling boundary ${edge}${nudge >= 0 ? "+" : ""}${nudge}`, `got [${types}]`);
    }
  }
  check(straddled === 0, "no boundary position loses a value");
}

console.log("\n--- 3. the overlap does not double-count ---");
{
  // One secret, sitting inside the overlap region shared by two windows.
  const pos = F.CHUNK - Math.floor(F.OVERLAP / 2);
  const doc = docWithSecretAt(pos, 200000);
  const cards = F.scanLong(det, doc).filter((f) => f.type === "CREDIT_CARD");
  check(cards.length === 1, "a value inside the overlap is reported once", `got ${cards.length}`);

  // Control: without dedupe it would be two. Prove the overlap really covers it
  // by showing both windows do contain the value.
  const parts = F.chunk(doc).filter((p) => p.text.includes("4556 7375 8689 9855"));
  control(parts.length === 2, "the planted value really is inside two windows");
}

console.log("\n--- 4. chunk size changes counts, never the verdict ---");
{
  // The invariant the rest of this section rests on. A window wider than the
  // detector's own ceiling is truncated INSIDE scan(), which silently restores
  // the tail-loss bug — so no window may ever exceed it, including one a
  // caller asks for explicitly.
  check(F.windowSize() < w.GuardAI.MAX_SCAN_LENGTH,
    "the scanning window is below the detector's truncation ceiling",
    `${F.windowSize()} vs ${w.GuardAI.MAX_SCAN_LENGTH}`);
  const oversized = F.chunk("x".repeat(600000), 500000);
  check(oversized.every((p) => p.text.length <= w.GuardAI.MAX_SCAN_LENGTH),
    "asking for a 500k window still yields windows the detector can take",
    `widest ${Math.max(...oversized.map((p) => p.text.length))}`);

  const doc = docWithSecretAt(120000, 400000);
  const decisions = new Set();
  const counts = [];
  for (const size of [20000, 50000, 80000, 150000, 500000]) {
    const parts = F.chunk(doc, size, F.OVERLAP);
    const seen = new Set(), all = [];
    for (const p of parts) for (const f of det.scan(p.text)) {
      const i = f.index + p.offset, k = f.type + "@" + i + ":" + f.value;
      if (!seen.has(k)) { seen.add(k); all.push(Object.assign({}, f, { index: i })); }
    }
    const s = F.summarise(all);
    decisions.add(F.verdict({ kind: "pdf", bytes: 1000, text: doc, summary: s }).action);
    counts.push(s.total);
  }
  check(decisions.size === 1 && decisions.has("block"),
    "every chunk size reaches the same verdict", `verdicts: [${[...decisions]}]`);
  console.log("      (finding totals across those sizes: " + counts.join(", ") + ")");
}

console.log("\n--- 5. the blocking set, and what it deliberately lets through ---");
{
  const contract = `
EMPLOYMENT AGREEMENT. Between Harrow Ridge Logistics Pty Ltd (ABN 51 824 753 556)
of 14 Kembla Street, Fyshwick ACT 2609 and Marcus Whitfield of 22 Ellerslie
Crescent, Turner ACT 2612, born 14/03/1987, contactable on 0413 882 004 or
m.whitfield87@gmail.com. Total remuneration $118,400 per annum. The employee may
access personal/carer's leave where a medical certificate is provided, and the
Employer's mental health support programme is available to all staff.
Commercial in confidence. Invoice BF-40912 for $14,220.55 is due 14 July.`;

  const f1 = F.scanLong(det, contract);
  const s1 = F.summarise(f1);
  const v1 = F.verdict({ kind: "pdf", bytes: 2000, text: contract, summary: s1 });
  check(v1.action === "pass", "an ordinary contract passes", `blocking: [${s1.blocking}]`);
  check(s1.total > 10, "…while still counting what is in it", `${s1.total} findings: ${s1.other.slice(0,6)}`);

  // Control: the same document, one credential added, must flip to block.
  const leaky = contract + "\nSFTP access — username hr_export, password Wint3rmute!42";
  const s2 = F.summarise(F.scanLong(det, leaky));
  const v2 = F.verdict({ kind: "pdf", bytes: 2000, text: leaky, summary: s2 });
  check(v2.action === "block", "the same document plus a password blocks", `blocking: [${s2.blocking}]`);
  control(v1.action !== v2.action, "adding a credential is what changed the verdict");

  // The categories we consciously do NOT block on.
  for (const t of ["NAME_PII", "ADDRESS", "PHONE", "EMAIL", "ABN", "MONEY", "DOB", "HEALTH", "CONFIDENTIAL"]) {
    check(!F.BLOCKING_TYPES.has(t), `${t} is counted, not blocked`);
  }
  for (const t of ["PASSWORD", "CREDIT_CARD", "TFN", "MEDICARE", "BSB", "BANK_ACCOUNT", "PASSPORT", "LICENCE"]) {
    check(F.BLOCKING_TYPES.has(t), `${t} blocks`);
  }
}

console.log("\n--- 6. HEALTH really is too noisy to block on ---");
{
  // Every line here is ordinary HR policy prose with no health data in it.
  const policy = `Employees may access the mental health support programme at any time.
Where symptoms of illness are present, staff should not attend site.
The Employer will reimburse the cost of therapy sessions up to the annual cap.
A medical certificate is required for absences longer than two consecutive days.`;
  const hits = F.scanLong(det, policy).filter((f) => f.type === "HEALTH");
  check(hits.length >= 3, "HEALTH fires repeatedly on prose containing no health data",
    `${hits.length} hits: ${hits.map((h) => JSON.stringify(h.value)).join(" ")}`);
  const v = F.verdict({ kind: "pdf", bytes: 900, text: policy, summary: F.summarise(F.scanLong(det, policy)) });
  check(v.action === "pass", "so an HR policy is not blocked by them");
}

console.log("\n--- 7. unreadable and unsupported never look like clean ---");
{
  const clean = F.verdict({ kind: "text", bytes: 500, text: "Just some ordinary notes about the weather and the garden." });
  check(clean.action === "pass", "readable, nothing found -> pass");

  const scanned = F.verdict({ kind: "pdf", bytes: 900000, text: "  \n \n " });
  check(scanned.action === "unreadable", "a scanned PDF with no text layer -> unreadable, NOT pass");
  check(/scan|picture/i.test(scanned.reason || ""), "…and says why", scanned.reason);

  const xlsx = F.verdict({ kind: "unsupported", bytes: 40000 });
  check(xlsx.action === "unsupported", "a spreadsheet -> unsupported, NOT pass");

  const broken = F.verdict({ kind: "pdf", bytes: 1000, error: "Invalid PDF structure" });
  check(broken.action === "unreadable", "a parser error -> unreadable, NOT pass");

  const huge = F.verdict({ kind: "pdf", bytes: 80 * 1024 * 1024 });
  check(huge.action === "too-large", "an 80MB file -> too-large, NOT pass");

  // Four distinct actions, and none of them is "pass". A scanned PDF and a
  // corrupt one deliberately share the "unreadable" action — they are the same
  // thing to a user — but they must still say different words, or "we could not
  // read it" collapses into one unhelpful message.
  const actions = new Set([clean, scanned, xlsx, broken, huge].map((v) => v.action));
  check(actions.size === 4, "the outcomes are four distinct actions", [...actions].join(","));
  check([scanned, xlsx, broken, huge].every((v) => v.action !== "pass"),
    "no unread file is ever reported as pass");
  check(scanned.reason !== broken.reason,
    "a scan and a corrupt file give different explanations",
    `${scanned.reason} / ${broken.reason}`);
}

console.log("\n--- 8. page numbers point at the right page ---");
{
  const pages = ["Cover page. Nothing here.", "Page two, ordinary prose about logistics.",
                 "Payment details: BSB 062-000 account 1234 5678.", "Final page, signatures."];
  let text = "", starts = [];
  for (const p of pages) { starts.push(text.length); text += p + "\n\n"; }
  const pageOf = F.pageLookup(starts);
  const s = F.summarise(F.scanLong(det, text), pageOf);
  check(s.blockingCount > 0, "found the banking details", `blocking: [${s.blocking}]`);
  const reported = new Set([].concat(...Object.values(s.pages)));
  check(reported.has(3) && reported.size === 1, "reported as page 3 and only page 3",
    `got pages ${[...reported]}`);
  check(!JSON.stringify(s).includes("062-000"), "the summary carries no values, only counts and pages");
}

console.log(`\nFILE CHUNKING: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
if (controlsThatCaughtNothing.length) {
  console.log("controls that caught nothing (" + controlsThatCaughtNothing.length + "):");
  for (const c of controlsThatCaughtNothing) console.log("  - " + c);
}
process.exit(failures ? 1 : 0);
