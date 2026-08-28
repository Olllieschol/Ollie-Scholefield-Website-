/**
 * "Send as safe text" suitability: the measured rule, held down.
 *
 * ═══ WHERE THESE NUMBERS COME FROM ══════════════════════════════════════════
 *
 * Measured 2026-08-28 against real documents run through the SHIPPING
 * extractors (vendor/pdf.min.mjs + joinTextItems, mammoth extractRawText):
 * five public PDFs (arXiv "Attention Is All You Need"; an ACL two-column
 * paper; a High Court judgment summary; IRS 1040; IRS W-9), a real 469k-char
 * DOCX handbook, the two store test PDFs, and constructed geometry controls.
 * Blind-scored against ground-truth labels fixed before the rule ran:
 * 0 false positives, 2 deliberate false negatives in 12.
 *
 * The corpus itself is too big to ship, so its MEASURED SIGNAL VECTORS are the
 * fixtures here. If a threshold change flips any verdict, this suite names the
 * document it just broke — which is the difference between "the numbers moved"
 * and "the rule now offers text-paste on a tax form".
 *
 * Two findings these fixtures encode, both from controls catching the first
 * version of a metric lying:
 *
 *   - sentence density CANNOT tell a form from prose. With dot leaders
 *     counted, an IRS 1040 scored 93 "sentences"/1k; letter-anchored it
 *     scores 7.1 — inside the 5.4–9.0 range of genuine prose. Line SHAPE is
 *     what separates them (medLine 17 vs ≥47).
 *   - braided two-column output is INVISIBLE to every text signal (the
 *     row-wise-painted control reads as perfect prose: medLine 138,
 *     longCharShare 1.00). Only stream-order geometry sees it: braidRate
 *     0.51 vs ≤0.13 on every real document.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

const w = loadWindow();
const F = w.GuardAI.FileScan;

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const shape = (chars, medLine, fragShare, debrisShare, sentPer1k) =>
  ({ chars, lineCount: 100, medLine, fragShare, debrisShare, sentPer1k, longCharShare: 0 });
const layout = (braidRate, rewindRate = 0, switchRate = 0) => ({ braidRate, rewindRate, switchRate });

/* The corpus, as measured. truth: would the paste read correctly to a person? */
const CORPUS = [
  ["attention-arxiv.pdf (equations shatter)", "pdf",
    shape(40507, 13, 0.63, 0.41, 7.6), layout(0.12), null, "block"],
  ["acl-twocolumn.pdf (column-coherent)", "pdf",
    shape(25248, 47, 0.23, 0.10, 8.7), layout(0.07, 0.02, 0.01), null, "offer"],
  ["austlii-judgment.pdf (clean prose)", "pdf",
    shape(3416, 90, 0.14, 0.07, 5.4), layout(0.07, 0.03), null, "offer"],
  ["irs-f1040-form.pdf (dense form)", "pdf",
    shape(11321, 17, 0.61, 0.22, 7.1), layout(0.09, 0.04), null, "block"],
  ["irs-w9-mixed.pdf (form + instructions)", "pdf",
    shape(38607, 64, 0.34, 0.06, 9.0), layout(0.13, 0.02, 0.02), null, "offer"],
  ["twocol row-wise painter (braided)", "pdf",
    shape(4191, 138, 0.00, 0.00, 0.0), layout(0.51), null, "block"],
  ["twocol column-wise painter", "pdf",
    shape(4251, 71, 0.00, 0.00, 8.5), layout(0.00), null, "offer"],
  ["should-pass.pdf", "pdf",
    shape(744, 61, 0.23, 0.15, 9.7), layout(0.00), null, "offer"],
  ["should-block.pdf (record card)", "pdf",
    shape(596, 31, 0.83, 0.28, 14.3), layout(0.00), null, "block"],
  ["meridian handbook (469k chars)", "docx",
    shape(469447, 946, 0.38, 0.02, 7.3), null, 0.002, "block"],
  ["contract-prose.docx", "docx",
    shape(11471, 285, 0.00, 0.00, 8.4), null, 0.0, "offer"],
  ["payroll-tables.docx", "docx",
    shape(2653, 12, 1.00, 0.73, 1.0), null, 0.99, "block"],
];

console.log("\n--- 1. the measured corpus, verdict by verdict ---");
{
  let fp = 0;
  for (const [name, kind, sh, ly, tableShare, want] of CORPUS) {
    const v = F.suitability({ kind, shape: sh, layout: ly, tableShare, pasteLimit: 60000 });
    const got = v.offer ? "offer" : "block";
    if (got === "offer" && want === "block") fp++;
    check(got === want, `${name} -> ${want}`, `got ${got}${v.why ? " (" + v.why + ")" : ""}`);
    if (!v.offer) {
      check(typeof v.why === "string" && v.why.length > 10 && !/undefined|NaN/.test(v.why),
        `…and says why in a plain line`, JSON.stringify(v.why));
    }
  }
  check(fp === 0, "zero false positives across the corpus — the direction that matters most");
}

console.log("\n--- 2. the braid gate works on geometry, from raw item streams ---");
{
  // Construct the two painters directly: same rows, different draw order.
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ y: 740 - i * 22, L: { x: 60, len: 70 }, R: { x: 320, len: 70 } });
  const braided = { width: 612, items: [] };
  const coherent = { width: 612, items: [] };
  let s1 = 0, s2 = 0;
  for (const r of rows) {
    braided.items.push({ x: r.L.x, y: r.y, len: r.L.len, stream: s1++ });
    braided.items.push({ x: r.R.x, y: r.y, len: r.R.len, stream: s1++ });
  }
  for (const r of rows) coherent.items.push({ x: r.L.x, y: r.y, len: r.L.len, stream: s2++ });
  for (const r of rows) coherent.items.push({ x: r.R.x, y: r.y, len: r.R.len, stream: s2++ });

  const b = F.layoutShape([braided]);
  const c = F.layoutShape([coherent]);
  check(b.braidRate > 0.4, "row-wise draw order scores braided", b.braidRate.toFixed(2));
  check(c.braidRate < 0.05, "column-wise draw order does not", c.braidRate.toFixed(2));
  // and the threshold sits between them with room on both sides
  check(b.braidRate > 0.2 + 0.15 && c.braidRate < 0.2 - 0.15,
    "the 0.20 threshold has margin against both painters",
    `${c.braidRate.toFixed(2)} .. 0.20 .. ${b.braidRate.toFixed(2)}`);
}

console.log("\n--- 3. textShape: the two metric bugs stay fixed ---");
{
  // Dot leaders must not count as sentences (they inflated a tax form 13x).
  const leaders = "Add lines 12e and 13a  .  .  .  .  .  .  .  .  .  .  14\n".repeat(40);
  const s1 = F.textShape(leaders);
  check(s1.sentPer1k < 3, "dot leaders are not sentences", s1.sentPer1k.toFixed(1));

  const prose = "The committee reviewed the register and noted no change. It resolved to meet again in March. ".repeat(40);
  const s2 = F.textShape(prose);
  check(s2.sentPer1k > 5, "control: real sentences still count", s2.sentPer1k.toFixed(1));

  // Equation debris is seen as debris.
  const debris = "The scaling factor is\n1\n√\nd\nk\nwhich we apply throughout the model.\n";
  const s3 = F.textShape(debris.repeat(20));
  check(s3.debrisShare > 0.4, "shattered equations count as debris", s3.debrisShare.toFixed(2));
}

console.log("\n--- 4. the debris gate is its own gate, not fragShare wearing a hat ---");
{
  // Healthy line shape, healthy sentences — debris alone must block.
  const v = F.suitability({
    kind: "pdf",
    shape: shape(20000, 60, 0.20, 0.30, 8.0),
    layout: layout(0.0),
    pasteLimit: 60000,
  });
  check(!v.offer, "high debris blocks even when every other signal is clean");
  check(/debris|equation|symbol/i.test(v.why), "…and the reason says so", v.why);
  // Control: identical shape with debris under the line is offered.
  const ok = F.suitability({
    kind: "pdf",
    shape: shape(20000, 60, 0.20, 0.10, 8.0),
    layout: layout(0.0),
    pasteLimit: 60000,
  });
  check(ok.offer, "control: same shape with ordinary debris levels is offered", ok.why);
}

console.log("\n--- 5. per-site paste limits, from the live probes ---");
{
  // Measured 2026-08-28: chatgpt converts a 10,000-char paste into an
  // attachment (9,500 stays text); gemini's composer hard-caps at 32,000 and
  // truncates silently; claude took 250,000 as text in about a second.
  check(F.pasteLimitFor("chatgpt.com") === 9000, "chatgpt: 9,000 (cliff measured at 10,000)");
  check(F.pasteLimitFor("www.chatgpt.com") === 9000, "…www resolves the same");
  check(F.pasteLimitFor("gemini.google.com") === 30000, "gemini: 30,000 (hard cap measured at 32,000)");
  check(F.pasteLimitFor("claude.ai") === 60000, "claude: the general 60,000 ceiling (composer measured far beyond it)");
  check(F.pasteLimitFor("poe.com") === 9000, "unprobed sites get the most conservative measured cliff");

  // The same 12k-char document: offered where it fits, refused where it does not.
  const doc = { kind: "docx", shape: shape(12000, 285, 0.0, 0.0, 8.4), tableShare: 0.0 };
  const onClaude = F.suitability({ ...doc, pasteLimit: F.pasteLimitFor("claude.ai") });
  const onChatGPT = F.suitability({ ...doc, pasteLimit: F.pasteLimitFor("chatgpt.com") });
  check(onClaude.offer, "12k chars is offered on claude");
  check(!onChatGPT.offer, "…and refused on chatgpt, where 10k becomes an attachment");
  check(/9,000|9000/.test(onChatGPT.why), "…with the site's real limit in the reason", onChatGPT.why);
}

console.log("\n--- 6. no gate ever fails open on junk input ---");
{
  for (const [label, input] of [
    ["null", null],
    ["empty", {}],
    ["shape missing", { kind: "pdf", pasteLimit: 9000 }],
    ["NaN chars", { kind: "pdf", shape: shape(NaN, 60, 0.1, 0.1, 8), pasteLimit: 9000 }],
  ]) {
    const v = F.suitability(input);
    check(v && v.offer === false, `${label} -> not offered`, JSON.stringify(v));
  }
}

console.log(`\nFILE SUITABILITY: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
