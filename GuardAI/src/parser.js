/**
 * GuardAI — the file reader.
 * ---------------------------------------------------------------------------
 * Runs inside parser.html, which is a hidden chrome-extension: iframe on the
 * chat page. Takes file bytes in over a private MessagePort, and sends back
 * category counts. That asymmetry is the whole point of the module:
 *
 *     in    ArrayBuffer, filename, mime type
 *     out   { CATEGORY: count }, page numbers, and a verdict
 *
 * The extracted text never leaves this frame, is never stored, and is dropped
 * as soon as the scan finishes. Nothing here has network access of any kind —
 * there is no fetch, no XHR, and pdf.js is configured so it cannot reach for a
 * remote font or a remote cmap either.
 * ---------------------------------------------------------------------------
 */
import * as pdfjs from "../vendor/pdf.min.mjs";

const FileScan = window.GuardAI.FileScan;
const detector = new window.GuardAI.Detector();

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

/* ------------------------------------------------------------------ *
 * Extraction.
 * ------------------------------------------------------------------ */

/**
 * Turn a PDF into text, remembering where each page starts so a finding can
 * be reported as "page 7" without reporting what is on page 7.
 *
 * Joining is not simply items.join(" "). pdf.js hands back positioned runs,
 * and a word split across two runs ("Whit" + "field") joined with a space
 * stops being a name — which would quietly cost detections on exactly the
 * real-world PDFs this feature is for. So runs are joined with a space only
 * where the geometry says there is a gap.
 */
async function extractPdf(bytes, onProgress) {
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,   // no eval inside the parser, ever
    disableFontFace: true,    // we want text, not rendering
    useSystemFonts: false,
    useWorkerFetch: false,    // no network for cmaps/fonts
    stopAtErrors: false,      // a damaged page should not lose the other 200
  });
  const doc = await task.promise;
  const total = doc.numPages;
  // Released through the LOADING TASK, not the document. pdf.js 6 moved
  // destroy() off PDFDocumentProxy, and calling doc.destroy() throws — which
  // would have left the worker holding the whole file after every scan.

  const pageStarts = [];
  let text = "";

  for (let n = 1; n <= total; n++) {
    pageStarts.push(text.length);
    let page;
    try {
      page = await doc.getPage(n);
      const content = await page.getTextContent();
      text += FileScan.joinTextItems(content.items);
    } catch (err) {
      // A single unreadable page is not an unreadable document. Note the gap
      // and keep going — but the caller still sees the page count, so a file
      // where EVERY page fails ends up with no text and is reported as
      // unreadable rather than clean.
      console.warn("[GuardAI] page " + n + " could not be read:", err);
    } finally {
      if (page && typeof page.cleanup === "function") page.cleanup();
    }
    text += "\n\n";
    if (onProgress && (n % 5 === 0 || n === total)) onProgress(n, total);
  }

  try { await task.destroy(); } catch (_) { /* nothing to recover */ }
  return { text, pageStarts, pages: total };
}

/** DOCX via mammoth's raw-text extractor — headers, tables and footnotes included. */
async function extractDocx(bytes) {
  const res = await window.mammoth.extractRawText({ arrayBuffer: bytes });
  return { text: (res && res.value) || "", pageStarts: [], pages: 0 };
}

/** Plain text, CSV, Markdown. UTF-8 with a BOM is common out of Excel. */
function extractText(bytes) {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, pageStarts: [], pages: 0 };
}

/* ------------------------------------------------------------------ *
 * The one reply shape.
 *
 * Built one field at a time, exactly like src/company.js and for the same
 * reason: handing this function the extraction result must not be able to
 * leak the text through it. Nothing is spread in; six values are read by name.
 * ------------------------------------------------------------------ */
function buildReply(id, cls, verdict, pages) {
  const out = {
    id: String(id),
    kind: String(cls.kind),
    label: String(cls.label),
    action: String(verdict.action),
    pages: typeof pages === "number" && pages > 0 ? pages : 0,
  };
  if (verdict.reason) out.reason = String(verdict.reason);
  if (typeof verdict.limitMB === "number") out.limitMB = verdict.limitMB;
  if (verdict.summary) {
    const s = verdict.summary;
    out.summary = {
      counts: {},                       // CATEGORY -> integer, nothing else
      blocking: s.blocking.map(String),
      other: s.other.map(String),
      blockingCount: Number(s.blockingCount) || 0,
      total: Number(s.total) || 0,
      pageHits: {},                     // CATEGORY -> [page numbers]
    };
    for (const [type, n] of Object.entries(s.counts)) {
      out.summary.counts[String(type)] = Number(n) || 0;
    }
    for (const [type, list] of Object.entries(s.pages || {})) {
      out.summary.pageHits[String(type)] = (list || []).map((p) => Number(p) || 0);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Handling one file.
 * ------------------------------------------------------------------ */
async function handle(req, port) {
  const cls = FileScan.classify(req.name, req.type);
  const bytes = req.bytes;
  const size = bytes && bytes.byteLength ? bytes.byteLength : 0;

  // Refused before reading: size and unsupported types never get opened.
  const early = FileScan.verdict({ kind: cls.kind, bytes: size });
  if (early.action === FileScan.ACTION.TOO_LARGE || early.action === FileScan.ACTION.UNSUPPORTED) {
    port.postMessage(buildReply(req.id, cls, early, 0));
    return;
  }

  let extracted = null;
  let error = null;
  try {
    if (cls.kind === FileScan.KIND.PDF) {
      extracted = await extractPdf(bytes, (page, total) => {
        port.postMessage({ id: String(req.id), progress: { page, total } });
      });
    } else if (cls.kind === FileScan.KIND.DOCX) {
      extracted = await extractDocx(bytes);
    } else {
      extracted = extractText(bytes);
    }
  } catch (err) {
    error = (err && err.message) || String(err);
  }

  let verdict;
  let pages = 0;
  if (error || !extracted) {
    verdict = FileScan.verdict({ kind: cls.kind, bytes: size, error: error || "No text extracted" });
  } else {
    pages = extracted.pages || 0;
    const pre = FileScan.verdict({ kind: cls.kind, bytes: size, text: extracted.text });
    if (pre.action === FileScan.ACTION.UNREADABLE) {
      verdict = pre; // nothing worth scanning came out
    } else {
      const findings = FileScan.scanLong(detector, extracted.text);
      const summary = FileScan.summarise(findings, FileScan.pageLookup(extracted.pageStarts));
      verdict = FileScan.verdict({ kind: cls.kind, bytes: size, text: extracted.text, summary });
    }
  }

  // Drop the text before replying rather than after. There is nothing to hold
  // on to here — no cache, no history, no "last file" — and this is the line
  // that keeps it that way.
  extracted = null;

  port.postMessage(buildReply(req.id, cls, verdict, pages));
}

/* ------------------------------------------------------------------ *
 * Handshake.
 *
 * The frame announces itself to its parent once. The content script replies
 * with one end of a MessageChannel, and from then on every file crosses that
 * port. The host page can post to this window all it likes; nothing here is
 * listening for it after the port arrives.
 * ------------------------------------------------------------------ */
let bound = false;

window.addEventListener("message", (e) => {
  if (bound) return;                                    // one port, once
  if (e.source !== window.parent) return;               // only from our injector
  if (!e.data || e.data.guardai !== "parser-port") return;
  const port = e.ports && e.ports[0];
  if (!port) return;

  bound = true;
  port.onmessage = (ev) => {
    const req = ev.data;
    if (!req || typeof req.id === "undefined" || !(req.bytes instanceof ArrayBuffer)) return;
    handle(req, port).catch((err) => {
      // Never leave a request unanswered: a card stuck on "Checking…" is worse
      // than one that says it failed, because the user cannot tell which.
      port.postMessage({
        id: String(req.id),
        kind: "unknown",
        label: "File",
        action: FileScan.ACTION.UNREADABLE,
        reason: (err && err.message) || "The file reader failed.",
        pages: 0,
      });
    });
  };
  port.start();
  port.postMessage({ ready: true });
});

// Announce readiness. Carries no data, so the wildcard target is safe — and
// the parent verifies the source is this frame before it replies with a port.
window.parent.postMessage({ guardai: "parser-ready" }, "*");
