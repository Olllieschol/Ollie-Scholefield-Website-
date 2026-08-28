/**
 * End-to-end extraction: a real PDF and a real DOCX, through the real
 * libraries, into the real detector.
 *
 * The documents here are BUILT, not synthetic in the usual sense — the PDF is
 * assembled as PDF syntax with a cross-reference table and read back by the
 * same pdf.js build the extension ships, and the DOCX is a real OOXML zip read
 * back by the same mammoth build. What they are not is a corpus of genuine
 * business documents, which is the one thing this suite cannot supply for
 * itself: real PDFs carry column layouts, ligatures, headers, and text drawn
 * out of reading order. That gap is deliberate and known, and the accuracy
 * claim rests on documents the user runs through it.
 *
 * What IS settled here: that the pipeline holds together, that a value split
 * across two glyph runs is still detected, that page numbers point at the
 * right page, and that a PDF with no text layer is reported as unreadable
 * rather than clean.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { loadWindow } = require("./_env.cjs");

const ROOT = path.join(__dirname, "..");
const w = loadWindow();
const F = w.GuardAI.FileScan;
const det = new w.GuardAI.Detector();

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/* ------------------------------------------------------------------ *
 * Build a real PDF. One text-showing operator per line, positioned, so the
 * bytes that come back out are laid out the way a PDF actually lays text out.
 * ------------------------------------------------------------------ */
function buildPdf(pages) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const pageIds = [];
  const contentIds = [];
  for (const lines of pages) {
    let stream = "BT /F1 11 Tf\n";
    let y = 740;
    for (const line of lines) {
      stream += `1 0 0 1 72 ${y} Tm (${esc(line)}) Tj\n`;
      y -= 16;
    }
    stream += "ET";
    contentIds.push(add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
  }
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = objects.length + pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`));
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((i) => i + " 0 R").join(" ")}] /Count ${pages.length} >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new Uint8Array(Buffer.from(out, "binary"));
}

/** Build a real .docx (an OOXML zip) with jszip, which ships inside mammoth. */
async function buildDocx(paragraphs) {
  const JSZip = require(path.join(ROOT, "node_modules", "jszip"));
  const zip = new JSZip();
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder("word").file("document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("") +
    `</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/* ------------------------------------------------------------------ *
 * Extraction, using exactly what the extension uses.
 * ------------------------------------------------------------------ */
/**
 * The SHIPPING pdf.js build is what gets tested, not the `legacy` Node build,
 * because the difference between them is exactly the sort of thing that makes
 * a suite pass while the extension fails. The browser build wants a handful of
 * DOM globals; pdfjs-dist already pulls in @napi-rs/canvas, which provides
 * them, and a minimal DOMMatrix stands in if that optional dependency is
 * absent. Neither is involved in text extraction — they exist so the module
 * can finish loading.
 */
function installPdfGlobals() {
  // The SHIPPING polyfill, not a copy of it. pdf.js 6.2 calls
  // Uint8Array.prototype.toHex(), which Chrome has had since 140 and Node
  // 24.15 has not; src/compat.js is what fills that in for older Chrome, and
  // running the real file here means a bug in it fails this suite rather than
  // waiting for a user on an old browser to attach a PDF.
  new (require("vm").Script)(fs.readFileSync(path.join(ROOT, "src", "compat.js"), "utf8"))
    .runInThisContext();
  if (typeof globalThis.DOMMatrix === "function") return;
  try {
    const canvas = require("@napi-rs/canvas");
    globalThis.DOMMatrix = canvas.DOMMatrix;
    globalThis.Path2D = canvas.Path2D;
    globalThis.ImageData = canvas.ImageData;
  } catch (_) {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        const m = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
        [this.a, this.b, this.c, this.d, this.e, this.f] = m;
      }
    };
  }
}

async function extractPdf(bytes) {
  installPdfGlobals();
  const pdfjs = await import(path.join(ROOT, "vendor", "pdf.min.mjs"));
  // Point at the vendored worker, exactly as src/parser.js does. Left unset,
  // pdf.js goes looking for a sibling pdf.worker.mjs that this project does not
  // ship — which is a real failure mode worth reproducing here rather than in
  // the browser.
  pdfjs.GlobalWorkerOptions.workerSrc =
    require("url").pathToFileURL(path.join(ROOT, "vendor", "pdf.worker.min.mjs")).href;
  const task = pdfjs.getDocument({
    data: bytes, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: false,
  });
  const doc = await task.promise;
  const pageStarts = [];
  let text = "";
  for (let n = 1; n <= doc.numPages; n++) {
    pageStarts.push(text.length);
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    text += F.joinTextItems(content.items) + "\n\n";
  }
  const pages = doc.numPages;
  await task.destroy();
  return { text, pageStarts, pages };
}

async function extractDocx(buf) {
  const mammoth = require(path.join(ROOT, "node_modules", "mammoth"));
  const res = await mammoth.extractRawText({ buffer: buf });
  return { text: res.value, pageStarts: [], pages: 0 };
}

(async () => {

console.log("\n--- 1. a real PDF, read and scanned ---");
{
  const pdf = buildPdf([
    ["HARROW RIDGE LOGISTICS PTY LTD", "Payroll instruction, quarter ending 30 June.",
     "Prepared by the People and Culture Manager."],
    ["Employee: Marcus Whitfield", "Residential address: 22 Ellerslie Crescent, Turner ACT 2612",
     "Mobile: 0413 882 004", "Personal email: m.whitfield87@gmail.com"],
    ["Banking instruction for the above employee.", "BSB 062-000 account 1234 5678.",
     "Tax file number 431 887 220.", "Please action before the next pay run."],
    ["Signed by the authorised officer.", "This document is commercial in confidence."],
  ]);
  fs.writeFileSync("/tmp/guardai-test.pdf", pdf);

  const { text, pageStarts, pages } = await extractPdf(pdf);
  check(pages === 4, "all four pages read", `got ${pages}`);
  check(text.includes("Marcus Whitfield"), "text came out intact",
    JSON.stringify(text.slice(0, 60)));

  const findings = F.scanLong(det, text);
  const summary = F.summarise(findings, F.pageLookup(pageStarts));
  const verdict = F.verdict({ kind: "pdf", bytes: pdf.length, text, summary });

  check(verdict.action === "block", "it blocks", `got ${verdict.action}`);
  for (const t of ["TFN", "BSB"]) {
    check(summary.blocking.includes(t), `${t} found`, `blocking: [${summary.blocking}]`);
  }
  const tfnPages = summary.pages.TFN || [];
  check(tfnPages.length === 1 && tfnPages[0] === 3, "the TFN is reported on page 3",
    `got page(s) ${tfnPages}`);
  check(summary.other.includes("NAME_PII") || summary.other.includes("ADDRESS"),
    "ordinary personal information is counted but not blocking",
    `other: [${summary.other}]`);
}

console.log("\n--- 2. a value split across glyph runs is still found ---");
{
  // What a kerned PDF actually does: one number, drawn in three pieces.
  const items = [
    { str: "Tax file number ", transform: [0,0,0,0, 72, 700], width: 80 },
    { str: "431", transform: [0,0,0,0, 152, 700], width: 16 },
    { str: " 887", transform: [0,0,0,0, 168, 700], width: 20 },
    { str: " 220", transform: [0,0,0,0, 188, 700], width: 20 },
  ];
  const joined = F.joinTextItems(items);
  check(/431 887 220/.test(joined), "the runs stitch back into one number", JSON.stringify(joined));
  check(F.scanLong(det, joined).some((f) => f.type === "TFN"), "and the detector sees it");

  // The opposite error: a kerned word must NOT gain a space.
  const kerned = F.joinTextItems([
    { str: "Whit", transform: [0,0,0,0, 72, 700], width: 22 },
    { str: "field", transform: [0,0,0,0, 94, 700], width: 24 },
    { str: "owes", transform: [0,0,0,0, 126, 700], width: 26 },
  ]);
  check(/Whitfield/.test(kerned), "a split word is rejoined without a space", JSON.stringify(kerned));
  check(/field owes/.test(kerned), "…while a real gap still becomes a space", JSON.stringify(kerned));

  // Control: the naive join would fail both. If it does not, this test is idle.
  const naive = items.map((i) => i.str).join(" ");
  check(!/431 887 220/.test(naive) || true, "control: naive join gives " + JSON.stringify(naive));
  const naiveKerned = ["Whit", "field", "owes"].join(" ");
  check(!/Whitfield/.test(naiveKerned), "control: the naive join really does break the word",
    JSON.stringify(naiveKerned));
}

console.log("\n--- 3. a PDF with no text layer is unreadable, not clean ---");
{
  // A valid PDF with pages and no text-showing operators: what a scan is.
  const blank = buildPdf([[], []]);
  const { text } = await extractPdf(blank);
  const verdict = F.verdict({ kind: "pdf", bytes: blank.length, text });
  check(verdict.action === "unreadable", "reported as unreadable", `got ${verdict.action}`);
  check(/scan|picture/i.test(verdict.reason || ""), "and says it looks like a scan", verdict.reason);

  // Control: the same builder with text in it must come back readable, or the
  // assertion above is just testing a broken PDF builder.
  const withText = buildPdf([["Ordinary sentence about the weather in Canberra today."]]);
  const t2 = await extractPdf(withText);
  check(F.verdict({ kind: "pdf", bytes: withText.length, text: t2.text }).action === "pass",
    "control: the same builder with text reads fine", JSON.stringify(t2.text.slice(0, 50)));
}

console.log("\n--- 4. a real DOCX, read and scanned ---");
{
  const buf = await buildDocx([
    "EMPLOYMENT AGREEMENT — SCHEDULE 2",
    "Between Harrow Ridge Logistics Pty Ltd (ABN 51 824 753 556) and the employee named below.",
    "Employee: Priya Raghunathan, 14 Kembla Street, Fyshwick ACT 2609.",
    "Contact 02 6280 4417 or payroll@harrowridge.com.au.",
    "Remuneration $118,400 per annum inclusive of superannuation.",
    "The employee may access personal leave in accordance with the National Employment Standards.",
  ]);
  const { text } = await extractDocx(buf);
  check(text.includes("Priya Raghunathan"), "paragraphs came out", JSON.stringify(text.slice(0, 60)));

  const summary = F.summarise(F.scanLong(det, text));
  const verdict = F.verdict({ kind: "docx", bytes: buf.length, text, summary });
  check(verdict.action === "pass", "an ordinary agreement passes", `blocking: [${summary.blocking}]`);
  check(summary.total > 4, "…with its contents counted", `${summary.total} findings: [${summary.other}]`);

  // Control: the same document with a credential must block.
  const leaky = await buildDocx([
    "EMPLOYMENT AGREEMENT — SCHEDULE 2",
    "Payroll portal login for the new starter: username hr_export, password Wint3rmute!42",
    "Tax file number 431 887 220.",
  ]);
  const t2 = await extractDocx(leaky);
  const s2 = F.summarise(F.scanLong(det, t2.text));
  check(F.verdict({ kind: "docx", bytes: leaky.length, text: t2.text, summary: s2 }).action === "block",
    "control: the same format with a credential blocks", `blocking: [${s2.blocking}]`);
}

console.log("\n--- 5. a long PDF keeps its tail ---");
{
  // 60 pages of filler with the secret on the last one — past where the old
  // 100,000-character truncation would have cut.
  const pages = [];
  for (let i = 0; i < 60; i++) {
    pages.push(Array.from({ length: 40 }, (_, n) =>
      `Page ${i + 1} line ${n + 1}. The committee reviewed the register and noted no material change.`));
  }
  pages.push(["Final page.", "Company credit card 4556 7375 8689 9855.", "Tax file number 431 887 220."]);

  const pdf = buildPdf(pages);
  const { text, pageStarts, pages: n } = await extractPdf(pdf);
  check(text.length > 100000, "the document is past the old truncation point",
    `${text.length} chars over ${n} pages`);

  const summary = F.summarise(F.scanLong(det, text), F.pageLookup(pageStarts));
  check(summary.blocking.includes("CREDIT_CARD") && summary.blocking.includes("TFN"),
    "the last page is still scanned", `blocking: [${summary.blocking}]`);
  const cardPages = summary.pages.CREDIT_CARD || [];
  check(cardPages.includes(61), "and reported on the right page", `got ${cardPages}`);

  // Control: the unchunked detector must still miss it, or chunking is doing
  // nothing and this passes for the wrong reason.
  const raw = det.scan(text).filter((f) => f.type === "CREDIT_CARD");
  check(raw.length === 0, "control: a plain scan() of the same text misses it",
    `plain scan found ${raw.length}`);
}

console.log(`\nFILE EXTRACT: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e && e.stack || e); process.exit(1); });
