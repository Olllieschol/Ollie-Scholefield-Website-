/**
 * Table/CSV layout audit — the leak class harness.cjs exposed but never
 * asserted on: when the type label lives only in a HEADER ROW, values in the
 * data rows are hundreds of characters from their context keyword.
 *
 * `cells` must end up MASKED. `keptCells` are dates and dollar figures, which
 * the masking policy deliberately leaves alone (masking them breaks the
 * arithmetic people ask an AI to do, and they identify nobody once the name,
 * contact details and ID numbers in the same ROW are fake) — those must
 * survive AND still be detected, so the user is told and can mask them by
 * hand. See MASKABLE in src/masker.js. Exit 1 on any leak or policy break.
 */
const { loadWindow, maskText } = require("./_env.cjs");

const CSV = [
  "Client Name, Account Balance, Phone Number, Email Address, Date Of Birth, Home Address, Medicare Number",
  "Jessica Taylor, $640.00, 0488 222 333, jess.t@example.com, 05/05/1992, 55 High St Hobart TAS 7000, 7890 12345 6",
  "Mark Nguyen, $9,900.00, 0411 555 666, mark.n@example.com, 27/12/1983, 12 Rose Ave Perth WA 6000, 8901 23456 7",
  "Tina Kaur, $18,300.50, 0433 777 888, tina.k@example.com, 09/02/1970, 3 Fig Ct Cairns QLD 4870, 1234 56789 0",
].join("\n");

const MARKDOWN = [
  "| Name | DOB | Balance | Licence |",
  "|------|-----|---------|---------|",
  "| Robert Hale | 11/03/1975 | $22,450 | NSW11223344 |",
  "| Fiona Aldridge | 30/07/1989 | $8,100.75 | VIC5566778 |",
].join("\n");

const LEAK_CELLS = {
  "CSV client export": {
    text: "Please clean up this export:\n" + CSV,
    cells: [
      "7890 12345 6", "8901 23456 7", "1234 56789 0",
      "Jessica Taylor", "Mark Nguyen", "Tina Kaur",
      "0488 222 333", "jess.t@example.com",
      "55 High St Hobart TAS 7000",
    ],
    keptCells: [
      "$640.00", "$9,900.00", "$18,300.50",
      "05/05/1992", "27/12/1983", "09/02/1970",
    ],
  },
  "markdown table": {
    text: "Summarise this table:\n" + MARKDOWN,
    cells: [
      "Robert Hale", "Fiona Aldridge",
      "NSW11223344", "VIC5566778",
    ],
    keptCells: ["11/03/1975", "30/07/1989", "$22,450", "$8,100.75"],
  },
};

(async () => {
  const w = loadWindow();
  let leaks = 0;
  let checked = 0;
  for (const [name, cfg] of Object.entries(LEAK_CELLS)) {
    const { masked, findings } = await maskText(w, cfg.text);
    console.log(`--- ${name} ---`);
    for (const cell of cfg.cells) {
      checked++;
      if (masked.includes(cell)) {
        leaks++;
        console.log(`  LEAK  ${JSON.stringify(cell)}`);
      } else {
        console.log(`  ok    ${JSON.stringify(cell)}`);
      }
    }
    for (const cell of cfg.keptCells || []) {
      checked++;
      const present = masked.includes(cell);
      const flagged = findings.some((f) => f.value === cell || cell.includes(f.value));
      if (!present || !flagged) {
        leaks++;
        console.log(
          `  POLICY  ${JSON.stringify(cell)} — ` +
            (!present ? "auto-masked (policy says leave it)" : "not detected (user never told)")
        );
      } else {
        console.log(`  ok    ${JSON.stringify(cell)} (policy: detected, left unmasked)`);
      }
    }
  }
  console.log(`\nTABLE-LAYOUT: ${checked - leaks}/${checked} cells masked, ${leaks} leaks`);
  process.exit(leaks ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
