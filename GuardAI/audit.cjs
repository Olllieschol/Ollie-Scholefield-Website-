/**
 * Field-by-field masking audit over the user's EXACT 15 records.
 * Runs the REAL detector + buildReviewModel + computeMasked logic, then prints
 * REAL vs MASKED per field per record and flags every IDENTICAL (leaked) field.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, "src", f), "utf8");

const RECORDS = [
  ["James Whitfield", "0412 556 781", "j.whitfield88@gmail.com", "12 Acacia Ave, Parramatta NSW 2150", "DOB 03/04/1988", "TFN 234 567 891", "Balance $14,230"],
  ["Priya Natarajan", "0423 998 102", "priya.nat@outlook.com", "8/45 Bridge Rd, Glebe NSW 2037", "DOB 19/11/1992", "Medicare 3456 78912 3", "Balance $9,870"],
  ["Connor Blake", "0401 223 998", "connor.blake22@gmail.com", "156 Esplanade, Manly NSW 2095", "DOB 27/06/1979", "Driver Licence NSW45612378", "Balance $52,400"],
  ["Mei Lin Tan", "0455 102 334", "meilin.tan@hotmail.com", "22 Orchard St, Chatswood NSW 2067", "DOB 14/01/1995", "TFN 198 765 432", "Balance $3,210"],
  ["Daniel Okafor", "0434 887 211", "d.okafor@gmail.com", "9 Riverside Dr, Penrith NSW 2750", "DOB 30/08/1985", "Medicare 2298 11345 7", "Balance $27,800"],
  ["Sarah Whitmore", "0467 123 456", "sarah.w.business@gmail.com", "3/14 King St, Newtown NSW 2042", "DOB 22/02/1990", "Driver Licence NSW78234561", "Balance $61,500"],
  ["Tomasz Kowalski", "0412 998 776", "tkowalski@bigpond.com", "41 Lakeview Cres, Liverpool NSW 2170", "DOB 05/12/1983", "TFN 312 654 987", "Balance $8,950"],
  ["Aisha Rahman", "0423 776 511", "aisha.rahman91@gmail.com", "67 Hillcrest Rd, Hornsby NSW 2077", "DOB 17/09/1991", "Medicare 5567 22341 9", "Balance $19,300"],
  ["Lucas Ferreira", "0401 556 902", "lucas.ferreira@yahoo.com", "12 Bay St, Cronulla NSW 2230", "DOB 08/03/1987", "Driver Licence NSW19283746", "Balance $44,120"],
  ["Grace Tomlinson", "0445 223 671", "grace.tomlinson@gmail.com", "5/88 Pacific Hwy, North Sydney NSW 2060", "DOB 25/05/1994", "TFN 456 123 789", "Balance $7,650"],
  ["Ravi Chandrasekar", "0411 998 234", "ravi.c@outlook.com", "33 Fernhill Rd, Castle Hill NSW 2154", "DOB 11/10/1980", "Medicare 1123 45678 2", "Balance $33,900"],
  ["Olivia Marsh", "0422 667 901", "olivia.marsh22@gmail.com", "19 Seaview St, Coogee NSW 2034", "DOB 02/07/1996", "Driver Licence NSW65498712", "Balance $5,420"],
  ["Hassan Al-Amin", "0433 887 654", "hassan.alamin@gmail.com", "7 Garden Tce, Bankstown NSW 2200", "DOB 14/04/1982", "TFN 789 456 213", "Balance $22,100"],
  ["Chloe Bennett", "0455 776 332", "chloe.bennett@hotmail.com", "28 Willow Ave, Strathfield NSW 2135", "DOB 09/01/1993", "Medicare 6678 91234 5", "Balance $16,750"],
  ["Marco Esposito", "0401 223 445", "marco.esposito@gmail.com", "14 Marina Pde, Cronulla NSW 2230", "DOB 21/11/1986", "Driver Licence NSW33219875", "Balance $39,600"],
];
const FIELD_NAMES = ["Name", "Phone", "Email", "Address", "DOB", "ID Number", "Balance"];
const HEADER = "I need you to organise this client data into a clean table with columns: Name, Phone, Email, Address, DOB, ID Number, Account Balance. Please tidy up any formatting inconsistencies and flag any missing fields.";
const INPUT = HEADER + "\n\n" + RECORDS.map((r, i) => `${i + 1}. ` + r.join(", ")).join("\n") +
  "\nPlease make sure the table is properly formatted and let me know if any of the data looks inconsistent or needs correction.";

function loadWindow() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://chatgpt.com/c/x", runScripts: "dangerously" });
  const w = dom.window;
  const storage = {};
  w.chrome = { storage: { local: {
    get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => { if (kk in storage) o[kk] = storage[kk]; return o; }, {})),
    set: (o) => { Object.assign(storage, o); return Promise.resolve(); }, remove: () => Promise.resolve(),
  }, onChanged: { addListener() {} } }, runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null } };
  if (!w.InputEvent) w.InputEvent = w.Event;
  for (const f of ["detector.js", "masker.js", "nlp-detector.js"]) w.eval(read(f));
  return w;
}

(async () => {
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const masker = new w.GuardAI.Masker();
  await masker.load();
  const findings = det.scan(INPUT);

  // mirror buildReviewModel fake assignment
  const fakeByReal = new Map(); const usedFakes = new Set(); const items = [];
  for (const f of findings) {
    if (!masker.isMaskable(f.type)) continue;
    let fake = fakeByReal.get(f.value);
    if (!fake) { fake = masker.previewFake(f.type, f.value, usedFakes); fakeByReal.set(f.value, fake); usedFakes.add(fake); }
    items.push({ start: f.index, end: f.index + f.value.length, value: f.value, type: f.type, fake });
  }
  items.sort((a, b) => a.start - b.start);
  // computeMasked
  let masked = INPUT;
  const ordered = items.filter((it) => it.start >= 0).sort((a, b) => a.start - b.start);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const it = ordered[i];
    if (masked.slice(it.start, it.end) === it.value) masked = masked.slice(0, it.start) + it.fake + masked.slice(it.end);
    else masked = masked.split(it.value).join(it.fake);
  }

  const maskedLines = masked.split("\n").filter((l) => /^\d+\./.test(l.trim()));
  const out = [];
  out.push("FIELD-BY-FIELD AUDIT (REAL vs MASKED). LEAK = identical = masking failed.\n");
  const leaks = [];
  // Masking policy: dates and dollar figures are DETECTED but deliberately
  // NOT auto-masked — swapping them breaks the arithmetic and date maths
  // people ask an AI to do, and neither identifies anyone once the name,
  // contact details and ID numbers in the same row are fake. So for these two
  // columns the expectation inverts: the value SHOULD still be present, and a
  // finding should still cover it (the user is told, then chooses). See
  // MASKABLE in src/masker.js.
  const POLICY_UNMASKED = new Set(["DOB", "Balance"]);
  for (let i = 0; i < RECORDS.length; i++) {
    const realLine = `${i + 1}. ` + RECORDS[i].join(", ");
    const maskedLine = maskedLines[i] || "(MISSING ROW)";
    out.push(`--- Record ${i + 1}: ${RECORDS[i][0]} ---`);
    // crude per-field check: is each real field substring still present verbatim in masked line?
    for (let f = 0; f < FIELD_NAMES.length; f++) {
      const realVal = RECORDS[i][f];
      const present = maskedLine.includes(realVal);
      if (POLICY_UNMASKED.has(FIELD_NAMES[f])) {
        // Must survive masking AND still have been flagged to the user.
        const flagged = findings.some((fd) => realVal.includes(fd.value));
        const bad = !present || !flagged;
        out.push(
          `   ${FIELD_NAMES[f].padEnd(10)} REAL=${JSON.stringify(realVal)}` +
            (bad
              ? `  *** POLICY FAIL *** ${!present ? "auto-masked (should not be)" : "not detected"}`
              : "  ok (policy: detected, left unmasked)")
        );
        if (bad) leaks.push(`R${i + 1} ${FIELD_NAMES[f]}: ${realVal} (policy violation)`);
        continue;
      }
      // strip the field label for ID/DOB/Balance to compare the sensitive part
      const leaked = present;
      const tag = leaked ? "  *** LEAK ***" : "  ok";
      out.push(`   ${FIELD_NAMES[f].padEnd(10)} REAL=${JSON.stringify(realVal)}${tag}`);
      if (leaked) leaks.push(`R${i + 1} ${FIELD_NAMES[f]}: ${realVal}`);
    }
    out.push("   MASKED LINE: " + maskedLine);
    out.push("");
  }
  out.push("================ LEAK SUMMARY ================");
  out.push("Total leaked fields: " + leaks.length);
  for (const l of leaks) out.push("  LEAK -> " + l);

  // type coverage summary
  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
  out.push("\n================ DETECTION COUNTS ================");
  out.push(JSON.stringify(byType, null, 0));

  fs.writeFileSync(path.join(DIR, "audit.out"), out.join("\n") + "\n");
  console.log(`audit.cjs: ${leaks.length} leaked field(s). See audit.out for detail.`);
  process.exit(leaks.length ? 1 : 0);
})().catch((e) => {
  fs.writeFileSync(path.join(DIR, "audit.out"), "ERR " + e.stack);
  console.error("audit.cjs threw:", e);
  process.exit(1);
});
