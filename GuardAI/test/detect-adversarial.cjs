/**
 * Adversarial detection battery — 30 realistic messages a person might type
 * into an AI chat, across personal / medical / financial / legal / workplace
 * domains. Each case lists sensitive substrings that MUST be caught:
 *   - mask: must be covered by a MASKABLE finding (swapped for a fake)
 *   - warn: a warning-only finding (HEALTH/LEGAL/etc.) covering it is enough
 *   - limitation: known regex-unfixable gap — reported, not failed. If one of
 *     these starts passing, the test tells you to promote it.
 * Exit code 1 if any non-limitation expectation fails.
 */
const { loadWindow, maskText, covered } = require("./_env.cjs");

const CASES = [
  // ---- personal ----
  {
    name: "birthday invite (address + phone)",
    text: "Can you draft a birthday invite? Party is at 14 Kellett Street, Potts Point NSW 2011, RSVP to 0412 334 556 by Friday.",
    mask: ["14 Kellett Street, Potts Point NSW 2011", "0412 334 556"],
  },
  {
    name: "lowercase self-introduction",
    text: "my name is john smith and my email is john.smith@work.com",
    // Promoted from `limitation` once the lowercase path shipped. The old
    // note said this "needs NER, not regex" — it turned out to need the
    // gazetteer that already existed for aggressive name detection.
    mask: ["john.smith@work.com", "john smith"],
  },
  {
    name: "rental reference (name + dob + address)",
    text: "Write a rental reference for my tenant Priya Natarajan, DOB 19/11/1992, currently at 8/45 Bridge Rd, Glebe NSW 2037.",
    mask: ["Priya Natarajan", "8/45 Bridge Rd, Glebe NSW 2037"],
    // Dates are detected but deliberately not auto-masked (see MASKABLE
    // in masker.js): masking them breaks date arithmetic, and a bare DOB
    // stops identifying anyone once the name and address beside it are fake.
    warn: ["19/11/1992"],
  },
  {
    name: "three-word name fully masked",
    text: "Client: Mei Lin Tan, phone 0455 102 334. Please draft the welcome letter.",
    mask: ["Mei Lin Tan", "0455 102 334"],
  },
  {
    name: "hyphenated surname fully masked",
    text: "Hassan Al-Amin (TFN 789 456 213) needs his group certificate reissued.",
    mask: ["Hassan Al-Amin", "789 456 213"],
  },
  {
    name: "school name",
    text: "My daughter goes to Lincoln Primary and finishes at 3pm, can you plan a pickup schedule?",
    limitation: [["Lincoln Primary", "free-text place/institution names need NER"]],
  },
  {
    name: "ISO-format date of birth",
    text: "Passenger details — name: Grace Tomlinson, DOB: 1995-01-14, frequent flyer QF1234567.",
    mask: ["Grace Tomlinson"],
    warn: ["1995-01-14"], // date: detected, not auto-masked
  },
  {
    name: "written date of birth",
    text: "I was born on 14 January 1995 in Penrith, does that make me eligible?",
    warn: ["14 January 1995"], // date: detected, not auto-masked
  },
  // ---- medical ----
  {
    name: "diagnosis + medication + medicare",
    text: "I was diagnosed with type 2 diabetes and I'm on metformin 500mg twice a day. My Medicare number is 2298 11345 7.",
    warn: ["diagnosed", "500mg"],
    mask: ["2298 11345 7"],
  },
  {
    name: "checksum-valid medicare, no keyword",
    text: "The number on the green card is 2123 45670 1 — can you check the format?",
    mask: ["2123 45670 1"],
  },
  {
    name: "mental health disclosure",
    text: "I've been seeing a psychiatrist for bipolar since 2019 — does this affect my TPD insurance claim?",
    warn: ["psychiatrist", "bipolar"],
  },
  // ---- financial ----
  {
    name: "transfer details (BSB + account)",
    text: "Transfer details: BSB 062-000, account 12345678, reference RENT.",
    mask: ["062-000", "12345678"],
  },
  {
    name: "credit card with expiry",
    text: "My card is 4111 1111 1111 1111 exp 09/27 cvv 321, book the flight.",
    mask: ["4111 1111 1111 1111"],
  },
  {
    name: "deal size with M suffix",
    text: "We're closing the Henderson deal at $2.3M next week — draft the internal only announcement.",
    // Dollar figures are detected but not auto-masked — swapping them
    // corrupts the arithmetic people ask the AI to do.
    warn: ["$2.3M", "internal only"],
    limitation: [["Henderson deal", "deal/code names need NER"]],
  },
  {
    name: "salary with k suffix",
    text: "Salary negotiation help: I'm currently on $120k and want to ask for $135k.",
    warn: ["$120k", "$135k"], // dollar figures: detected, not auto-masked
  },
  {
    name: "revenue verbal million",
    text: "Our Q3 revenue was $1.85 million, up 12% — summarise for the board pack, do not share externally.",
    warn: ["$1.85 million", "revenue"], // dollar figure: detected, not auto-masked
  },
  {
    name: "malformed money is flagged (not auto-masked)",
    text: "Their account balance is $14,2100 owing as of today.",
    // Dollar figures are no longer auto-masked, so the old "no digits may
    // remain" assertion doesn't apply to this path any more. The residue
    // guarantee it protected still matters for a figure the user masks BY
    // HAND, and is asserted there instead — see test/masking-policy.cjs.
    warn: ["$14,2100"],
  },
  {
    name: "valid TFN with label",
    text: "my tax file number is 123 456 782 — is that format right?",
    mask: ["123 456 782"],
  },
  {
    name: "ABN checksum-valid, no label",
    text: "Invoice from 51 824 753 556 arrived twice, help me draft a reply.",
    mask: ["51 824 753 556"],
  },
  // ---- credentials ----
  {
    name: "api key",
    text: "Our API key is sk-proj-Ab12Cd34Ef56Gh78, use it in the code example.",
    mask: ["sk-proj-Ab12Cd34Ef56Gh78"],
  },
  {
    name: "connection string with embedded password",
    text: "Here's the staging DB string: postgres://admin:Passw0rd123@10.2.11.40:5432/main — why does it time out?",
    mask: ["postgres://admin:Passw0rd123@10.2.11.40:5432/main"],
  },
  {
    name: "seed phrase",
    text: "My recovery phrase is ottoman fringe lucky carbon velvet mango, where do I enter it?",
    mask: ["ottoman fringe lucky carbon velvet mango"],
  },
  // ---- legal ----
  {
    name: "court case number",
    text: "I'm the defendant in case no. 2024/00812345 at the District Court, summarise my options.",
    warn: ["defendant", "case no. 2024/00812345"],
  },
  {
    name: "subpoena",
    text: "Draft a response to the subpoena we received about the supplier dispute.",
    warn: ["subpoena"],
  },
  // ---- workplace ----
  {
    name: "PIP with employee name but no other identifier",
    text: "Write a performance improvement plan for Daniel Okafor, he has missed every sprint goal this quarter.",
    limitation: [["Daniel Okafor", "names without an accompanying identifier are deliberately not flagged (false-positive control); needs NER"]],
  },
  {
    name: "licence in a sentence",
    text: "My driver licence NSW65498712 expires next month, draft the renewal letter.",
    mask: ["NSW65498712"],
  },
  {
    name: "passport with keyword",
    text: "My passport PA1234567 expires in March — what's the renewal process?",
    mask: ["PA1234567"],
  },
  {
    name: "bridging visa + passport",
    text: "My bridging visa expires 12/09/2026 and my passport number is N8881234, write to my MP.",
    warn: ["bridging visa"],
    mask: ["N8881234"],
  },
  // ---- location ----
  {
    name: "GPS coordinates",
    text: "My campsite is at -33.8688, 151.2093 — if I'm not back by 6pm tell someone.",
    mask: ["-33.8688, 151.2093"],
  },
  {
    name: "informal lowercase address",
    text: "i live at 152a george st sydney, what's my closest pool?",
    mask: ["152a george st sydney"],
  },
  {
    name: "international phone with context",
    text: "You can reach me on +44 7911 123456 while I'm in London.",
    mask: ["7911 123456"],
  },
];

(async () => {
  const w = loadWindow();
  let fail = 0;
  let pass = 0;
  const limitations = [];
  for (const c of CASES) {
    const { findings, masked, masker } = await maskText(w, c.text);
    const problems = [];
    for (const s of c.mask || []) {
      if (!covered(c.text, findings, s, { maskableOnly: true, masker })) {
        problems.push(`NOT MASKED: "${s}"`);
      } else if (masked.includes(s)) {
        problems.push(`FLAGGED BUT STILL IN OUTPUT: "${s}"`);
      }
    }
    for (const s of c.warn || []) {
      if (!covered(c.text, findings, s)) problems.push(`NOT FLAGGED (warn): "${s}"`);
    }
    for (const [s] of c.maskFull || []) {
      // every digit-run of the original value must be gone from the output
      const digits = s.replace(/\D/g, "");
      if (masked.includes(s) || (digits.length >= 4 && masked.includes(digits.slice(-4) + "0")) ||
          new RegExp(digits.split("").join("\\D?")).test(masked)) {
        problems.push(`RESIDUE of "${s}" in output: ...${masked.slice(Math.max(0, masked.length - 120))}`);
      }
    }
    for (const [s, why] of c.limitation || []) {
      const hit = covered(c.text, findings, s);
      limitations.push(`  ${hit ? "NOW CAUGHT (promote to mask/warn!)" : "still missed"} — "${s}" (${why})`);
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
  console.log(`\nADVERSARIAL: ${pass}/${pass + fail} pass, ${fail} fail`);
  console.log(`Known limitations (regex/local-only — need NER):`);
  for (const l of limitations) console.log(l);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
