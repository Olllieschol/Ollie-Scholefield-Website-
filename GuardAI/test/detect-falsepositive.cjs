/**
 * False-positive battery — benign messages that must NOT be masked.
 * Each case lists substrings that must survive masking untouched (they are
 * normal text, product names, scores, reference numbers, hypotheticals).
 * Warning-only findings are allowed unless `noFindings` is set; what we're
 * guarding against is the masker REWRITING innocent text.
 * Exit code 1 on any over-mask.
 */
const { loadWindow, maskText } = require("./_env.cjs");

const CASES = [
  {
    name: "product price, no financial context",
    text: "The new MacBook costs $3,499 at the shops — is it worth it over the Air?",
    keep: ["$3,499"],
  },
  {
    name: "hypothetical investment",
    text: "If someone invested $10,000 in an index fund in 1990, what would it be worth today?",
    keep: ["$10,000"],
  },
  {
    name: "house price in news question",
    text: "A house near us sold for $1,550,000 at auction — is the market overheating?",
    keep: ["$1,550,000"],
  },
  {
    name: "big view count",
    text: "The video has 1,234,567,890 views, how is that even possible?",
    keep: ["1,234,567,890"],
  },
  {
    name: "sports score with dash",
    text: "The final score was 123-456 in the charity cricket match, write a funny recap.",
    keep: ["123-456"],
  },
  {
    name: "order reference letters+digits (not a passport)",
    text: "Your order reference is UT2024881 and the tracking id is AU12345678 — write a complaint about the delay.",
    keep: ["UT2024881", "AU12345678"],
  },
  {
    name: "tracking number near the word phone",
    text: "The tracking number for my phone case order is 88291045, has it shipped?",
    keep: ["88291045"],
  },
  {
    name: "capitalised place names with an email present",
    text: "I visited Sydney Harbour and the Blue Mountains last weekend. Photos went to gallery@example.com.",
    keep: ["Sydney Harbour", "Blue Mountains"],
  },
  {
    name: "meeting-notes headings with an email present",
    text: "Meeting notes: Action Items and Next Steps below. Send follow-ups to team@corp.com.",
    keep: ["Action Items", "Next Steps"],
  },
  {
    name: "holiday greeting with an email present",
    text: "Draft a card: Merry Christmas and Happy Easter to all! RSVP events@corp.com.",
    keep: ["Merry Christmas", "Happy Easter"],
  },
  {
    name: "non-Luhn 16 digits, no card context",
    text: "The device serial is 4111111111111112 printed under the base plate.",
    keep: ["4111111111111112"],
  },
  {
    name: "invoice due date is not a DOB",
    text: "The invoice is due 15/08/2026 — remind me a week before.",
    keep: ["15/08/2026"],
  },
  {
    name: "lot number that looks medicare-shaped, fails checksum",
    text: "Lot number 4111 22334 5 was recalled, write the notice.",
    keep: ["4111 22334 5"],
  },
  {
    name: "recipe quantities",
    text: "Preheat the oven to 200 degrees and bake for 45 minutes. Serves 12 people.",
    keep: ["200 degrees", "45 minutes"],
  },
  {
    name: "St Johns Wort dosage is not an address",
    text: "Can I take 2 tablets of St Johns Wort daily with my multivitamin?",
    keep: ["2 tablets of St Johns Wort"],
  },
  {
    name: "version-number pair is not GPS",
    text: "Upgrading from 10.15.7 to 14.4.1 broke the build, help me debug.",
    keep: ["10.15.7", "14.4.1"],
  },
  {
    name: "year range with dash",
    text: "Compare the 2023-2024 budget to the 2022-2023 one at a high level.",
    keep: ["2023-2024", "2022-2023"],
  },
  {
    name: "book title capitalised pair with phone present",
    text: "I'm reading Pride and Prejudice — my sister (0412 000 111) recommended it. Discussion questions?",
    keep: ["Pride and Prejudice"],
  },
];

(async () => {
  const w = loadWindow();
  let fail = 0;
  let pass = 0;
  for (const c of CASES) {
    const { masked } = await maskText(w, c.text);
    const problems = [];
    for (const s of c.keep || []) {
      if (!masked.includes(s)) {
        problems.push(`OVER-MASKED: "${s}" was rewritten -> ...${masked.slice(0, 160)}`);
      }
    }
    if (problems.length) {
      fail++;
      console.log(`FAIL  ${c.name}`);
      for (const p of problems) console.log(`      ${p}`);
    } else {
      pass++;
      console.log(`pass  ${c.name}`);
    }
  }
  console.log(`\nFALSE-POSITIVES: ${pass}/${pass + fail} pass, ${fail} over-mask`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
