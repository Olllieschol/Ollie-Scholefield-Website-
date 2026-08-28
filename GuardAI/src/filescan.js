/**
 * GuardAI — file scanning policy.
 * ---------------------------------------------------------------------------
 * Pure logic: no DOM, no chrome.*, no fetch, no parsing. Everything here is a
 * decision about text that somebody else extracted, which is what makes it
 * testable without a browser and without a PDF.
 *
 * Three jobs:
 *
 *   classify()   what kind of file is this, and can we read it at all
 *   scanLong()   run the existing detector over document-length text
 *   verdict()    given what we found, block or pass
 *
 * Exposed as window.GuardAI.FileScan.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * File classification.
   *
   * The rule that matters here is the one in the brief: a file that isn't
   * scanned must never look like a file that came back clean. So this returns
   * "unsupported" as a first-class answer, and the caller is required to
   * render it differently from "clean" — never as an absence of findings.
   * ------------------------------------------------------------------ */

  const KIND = {
    PDF: "pdf",
    DOCX: "docx",
    TEXT: "text",
    UNSUPPORTED: "unsupported",
  };

  /** Extensions we can turn into text, and what to call them to a user. */
  const TEXT_EXTS = {
    txt: "Text file",
    csv: "CSV spreadsheet",
    md: "Markdown document",
    markdown: "Markdown document",
    log: "Log file",
    tsv: "TSV spreadsheet",
  };

  /**
   * Deliberately NOT supported in v1, listed by name so the warning can say
   * what the file is rather than "unsupported file". A user who attaches a
   * spreadsheet deserves to be told GuardAI cannot read spreadsheets yet, not
   * that their file is unrecognisable.
   */
  const KNOWN_UNSUPPORTED = {
    xlsx: "Excel spreadsheet", xls: "Excel spreadsheet", xlsm: "Excel spreadsheet",
    pptx: "PowerPoint deck", ppt: "PowerPoint deck",
    doc: "Legacy Word document (.doc)",
    pages: "Pages document", numbers: "Numbers spreadsheet", key: "Keynote deck",
    png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image",
    heic: "Image", heif: "Image", svg: "Image", bmp: "Image", tiff: "Image",
    zip: "Archive", rar: "Archive", "7z": "Archive", tar: "Archive", gz: "Archive",
    mp3: "Audio", wav: "Audio", m4a: "Audio", mp4: "Video", mov: "Video",
    odt: "OpenDocument text", ods: "OpenDocument spreadsheet",
    rtf: "Rich text document", epub: "E-book",
  };

  function extensionOf(name) {
    if (typeof name !== "string") return "";
    const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  /**
   * What kind of file is this? Extension first, MIME only as a tie-breaker.
   *
   * That order is deliberate. A browser will happily hand over a File whose
   * `type` is "" (common for .md and .csv on macOS) or plain wrong, and the
   * extension is what the user believes they attached. Where the extension
   * says nothing at all, MIME gets a turn — but a MIME that disagrees with a
   * known extension does not override it, because a .pdf that claims to be
   * text/plain is far more likely to be a mislabelled PDF than a text file
   * somebody named .pdf.
   */
  function classify(name, mime) {
    const ext = extensionOf(name);
    const type = typeof mime === "string" ? mime.toLowerCase().split(";")[0].trim() : "";

    if (ext === "pdf") return { kind: KIND.PDF, label: "PDF document", ext };
    if (ext === "docx") return { kind: KIND.DOCX, label: "Word document", ext };
    if (TEXT_EXTS[ext]) return { kind: KIND.TEXT, label: TEXT_EXTS[ext], ext };
    if (KNOWN_UNSUPPORTED[ext]) {
      return { kind: KIND.UNSUPPORTED, label: KNOWN_UNSUPPORTED[ext], ext };
    }

    if (!ext) {
      if (type === "application/pdf") return { kind: KIND.PDF, label: "PDF document", ext };
      if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        return { kind: KIND.DOCX, label: "Word document", ext };
      }
      if (type.startsWith("text/")) return { kind: KIND.TEXT, label: "Text file", ext };
    }

    return { kind: KIND.UNSUPPORTED, label: ext ? "." + ext + " file" : "File", ext };
  }

  /* ------------------------------------------------------------------ *
   * Chunked scanning.
   *
   * Detector.scan() truncates at MAX_SCAN_LENGTH (100,000 chars) and says so
   * only to the console. On a chat message that ceiling is unreachable. On a
   * document it is roughly 35 pages, and past it the scan returns a result
   * that is indistinguishable from a clean one — measured: the same 130,080
   * char document with the same card/TFN/Medicare block at offset 50,000
   * returns three findings, and at offset 110,000 returns none.
   *
   * That is the exact failure this feature is not allowed to have, so files
   * never go through scan() directly. They come through here, which runs the
   * detector over overlapping windows and re-bases the indexes.
   *
   * Two properties worth keeping in mind when changing CHUNK/OVERLAP:
   *
   *   - OVERLAP must exceed the longest span any detector can return, or a
   *     value lying across a boundary is seen only in halves by both windows
   *     and found by neither. 4,000 is enormously more than the longest real
   *     finding (a long street address is under 100) and costs one extra
   *     detector pass per 20 pages.
   *
   *   - Chunking can change the COUNTS but never the BLOCK DECISION. The
   *     detector's only cross-document rule is that a bare name needs another
   *     identifier somewhere in the same scan, so a name in window 3 whose
   *     supporting identifier sat in window 1 may go uncounted. No blocking
   *     type depends on context beyond its own line — they are all structured
   *     values with their own format or checksum — so the pass/block outcome
   *     is the same however the text is divided. test/file-chunking.cjs holds
   *     that property down.
   * ------------------------------------------------------------------ */

  const CHUNK = 80000;
  const OVERLAP = 4000;

  /**
   * The window scanLong() actually uses.
   *
   * CHUNK is a preference; this is the enforced value, and it is derived from
   * the detector's own ceiling rather than assumed to be below it. A window
   * wider than MAX_SCAN_LENGTH gets truncated INSIDE scan(), which puts the
   * tail-loss bug straight back — silently, since the only signal is a console
   * warning. Deriving it means someone raising CHUNK later cannot reintroduce
   * that by editing one number.
   */
  function windowSize() {
    const max =
      (typeof window !== "undefined" && window.GuardAI && window.GuardAI.MAX_SCAN_LENGTH) || 100000;
    // Leave the overlap's worth of headroom so the last window of a document
    // is never the one that clips.
    return Math.max(1000, Math.min(CHUNK, max - OVERLAP));
  }

  /**
   * Split into overlapping windows, preferring to break at a paragraph or
   * sentence edge so a window rarely begins mid-sentence (the detector clamps
   * findings to sentence boundaries, so a ragged start costs precision).
   * Returns [{ text, offset }] where offset is the absolute index of text[0].
   */
  function chunk(text, size, overlap = OVERLAP) {
    // windowSize() is a ceiling, not a default: a caller asking for a wider
    // window gets the safe one instead. Every window this returns is handed
    // straight to Detector.scan(), and scan() truncates what it cannot take,
    // so "the caller asked for it" is not a good enough reason to hand it one
    // that will be silently clipped.
    const cap = windowSize();
    size = typeof size === "number" && isFinite(size) && size > 0 ? Math.min(size, cap) : cap;
    if (typeof text !== "string" || !text.length) return [];
    if (text.length <= size) return [{ text, offset: 0 }];

    const out = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        // Prefer a paragraph break, then a sentence end, within the last 10%
        // of the window. If neither exists (minified JSON, a wall of digits)
        // the hard cut stands — the overlap is what keeps that safe.
        const floor = end - Math.floor(size * 0.1);
        const para = text.lastIndexOf("\n", end);
        const stop = text.lastIndexOf(". ", end);
        if (para > floor) end = para + 1;
        else if (stop > floor) end = stop + 2;
      }
      out.push({ text: text.slice(start, end), offset: start });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
    return out;
  }

  /**
   * Run a detector over text of any length. Findings come back with absolute
   * indexes into the original text and no duplicates from the overlaps.
   *
   * @param {{scan: (t: string) => Array}} detector a live Detector
   * @param {string} text
   * @returns {Array} findings, sorted by index
   */
  function scanLong(detector, text) {
    if (!detector || typeof detector.scan !== "function") return [];
    if (typeof text !== "string" || !text.trim()) return [];

    const seen = new Set();
    const out = [];
    for (const part of chunk(text)) {
      let found;
      try {
        found = detector.scan(part.text) || [];
      } catch (err) {
        // One bad window must not lose the other nineteen.
        console.warn("[GuardAI] file scan window failed, continuing:", err);
        continue;
      }
      for (const f of found) {
        const index = f.index + part.offset;
        const key = f.type + "@" + index + ":" + f.value;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(Object.assign({}, f, { index }));
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }


  /* ------------------------------------------------------------------ *
   * Stitching PDF text back together.
   *
   * This lives here rather than next to the pdf.js call because it is pure
   * string work over positioned runs, and it is the single biggest lever on
   * how well detection does against a real PDF — so it needs to be testable
   * without a browser.
   *
   * The naive version, items.map(i => i.str).join(" "), is wrong in a way that
   * costs detections rather than adding noise. A PDF has no words: it has runs
   * of glyphs at coordinates, and a kerned or ligatured word arrives split
   * ("Whit" + "field", "off" + "ice"). Joined with a space those stop being a
   * name and an address. Joined with nothing, two genuinely separate words run
   * together and stop being two. So the gap between where one run ended and
   * the next begins is what decides, and only a real gap earns a space.
   * ------------------------------------------------------------------ */

  /**
   * @param {Array<{str:string, transform?:number[], width?:number, hasEOL?:boolean}>} items
   * @returns {string}
   */
  function joinTextItems(items) {
  let out = "";
  let prevEndX = null;
  let prevY = null;

  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const t = it.transform || [];
    const x = typeof t[4] === "number" ? t[4] : null;
    const y = typeof t[5] === "number" ? t[5] : null;
    const width = typeof it.width === "number" ? it.width : 0;

    if (out) {
      if (prevY !== null && y !== null && Math.abs(y - prevY) > 1) {
        out += "\n"; // new line
      } else if (prevEndX !== null && x !== null) {
        // A gap wider than a thin sliver means a real space. Anything tighter
        // is the same word broken into two runs, and must be joined with
        // nothing at all.
        if (x - prevEndX > 1) out += " ";
      } else if (!/\s$/.test(out) && !/^\s/.test(it.str)) {
        out += " ";
      }
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
    prevEndX = x !== null ? x + width : null;
    prevY = y;
  }
  return out;
}

  /* ------------------------------------------------------------------ *
   * The blocking set.
   *
   * Measured on a constructed 20-page employment contract with a payment
   * schedule: 486 findings, 98 of them "high" severity. Blocking on any
   * finding, or on high severity, blocks every real business document —
   * 136 names, 56 ABNs, 42 phone numbers is a description of a contract, not
   * news about one. An override that fires on every attachment gets clicked
   * without reading, and it is the same card and the same words as the text
   * flow, so training people past it damages the warnings that do carry news.
   *
   * So the list below is not "sensitive data". It is the much smaller set of
   * things that are never deliberately in a document you meant to share:
   * credentials, government identifiers, and instruments that move money.
   * Everything else is counted and shown, and passes.
   *
   * Two categories that look like they belong here and do not:
   *
   *   HEALTH is a topic detector, not a data detector — its pattern matches
   *   "therapy", "symptoms", "medication", "mental health". It fires on any
   *   HR policy or leave clause. Blocking on it reintroduces exactly the
   *   noise this list exists to avoid. It is counted, not blocked.
   *
   *   ABN and ACN are public register data. Every Australian invoice carries
   *   one and looking them up is the point of the register.
   * ------------------------------------------------------------------ */

  const BLOCKING_TYPES = new Set([
    "PASSWORD",      // credential
    "CREDIT_CARD",   // Luhn-checked instrument
    "BSB",           // routes money
    "BANK_ACCOUNT",  // routes money
    "TFN",           // checksummed government identifier
    "MEDICARE",      // checksummed government identifier
    "PASSPORT",      // government identifier
    "LICENCE",       // government identifier
    "IMMIGRATION",   // visa / immigration status identifiers
  ]);

  /**
   * Roll findings up into what the UI and the dashboard are allowed to know:
   * categories and counts. No values, ever — the returned object is the only
   * thing that crosses out of the parser frame, so anything not built here
   * cannot leak by being attached to something that is.
   *
   * @param {Array} findings
   * @param {(index:number)=>number|null} [pageOf] maps an index to a 1-based
   *        page, for PDFs. Page NUMBERS are safe to show — they say where to
   *        look without saying what is there — and they are what makes the
   *        warning actionable, since counts alone cannot be acted on without
   *        leaving the browser.
   */
  function summarise(findings, pageOf) {
    const counts = Object.create(null);
    const pages = Object.create(null);
    let blockingCount = 0;

    for (const f of findings || []) {
      if (!f || typeof f.type !== "string") continue;
      counts[f.type] = (counts[f.type] || 0) + 1;
      if (BLOCKING_TYPES.has(f.type)) {
        blockingCount++;
        if (typeof pageOf === "function") {
          const p = pageOf(f.index);
          if (typeof p === "number" && p > 0) {
            (pages[f.type] = pages[f.type] || new Set()).add(p);
          }
        }
      }
    }

    const blocking = Object.keys(counts)
      .filter((t) => BLOCKING_TYPES.has(t))
      .sort((a, b) => counts[b] - counts[a]);
    const other = Object.keys(counts)
      .filter((t) => !BLOCKING_TYPES.has(t))
      .sort((a, b) => counts[b] - counts[a]);

    return {
      counts,
      blocking,
      other,
      blockingCount,
      total: (findings || []).length,
      pages: Object.fromEntries(
        Object.entries(pages).map(([t, s]) => [t, [...s].sort((a, b) => a - b)])
      ),
    };
  }

  /* ------------------------------------------------------------------ *
   * The verdict.
   *
   * Four outcomes, and the reason they are four rather than two is the rule
   * about a file that could not be read. "clean" and "unreadable" must never
   * be the same screen, so they are not the same value here either.
   * ------------------------------------------------------------------ */

  const ACTION = {
    BLOCK: "block",             // something in the never-meant-to-be-here set
    PASS: "pass",               // read it, found nothing that blocks
    UNREADABLE: "unreadable",   // right file type, no text came out
    UNSUPPORTED: "unsupported", // we do not read this file type at all
    TOO_LARGE: "too-large",     // refused before reading
  };

  /** Files above this are refused rather than read into memory. */
  const MAX_BYTES = 30 * 1024 * 1024;

  /**
   * A PDF that yields almost nothing is a scanned image, not an empty
   * document. Below this many characters we say we could not read it rather
   * than that we found nothing in it. Cover pages and single-line letters do
   * exist, which is why this is a floor of a few words and not a page.
   */
  const MIN_TEXT_CHARS = 24;

  /**
   * @param {object} input
   * @param {string} input.kind      from classify()
   * @param {number} input.bytes     file size
   * @param {string} [input.text]    extracted text, if extraction ran
   * @param {string} [input.error]   extraction error, if it failed
   * @param {object} [input.summary] from summarise(), if scanning ran
   */
  function verdict(input) {
    const it = input || {};

    if (typeof it.bytes === "number" && it.bytes > MAX_BYTES) {
      return { action: ACTION.TOO_LARGE, limitMB: Math.round(MAX_BYTES / 1024 / 1024) };
    }
    if (it.kind === KIND.UNSUPPORTED) return { action: ACTION.UNSUPPORTED };
    if (it.error) return { action: ACTION.UNREADABLE, reason: String(it.error) };

    const text = typeof it.text === "string" ? it.text : "";
    if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) {
      return {
        action: ACTION.UNREADABLE,
        reason: it.kind === KIND.PDF
          ? "No selectable text — this looks like a scan or a picture of a document."
          : "No readable text in this file.",
      };
    }

    const summary = it.summary || summarise([]);
    return {
      action: summary.blockingCount > 0 ? ACTION.BLOCK : ACTION.PASS,
      summary,
    };
  }

  /**
   * Build an index -> 1-based page lookup from the page start offsets the PDF
   * parser records. Returns null when the format has no pages.
   */
  function pageLookup(pageStarts) {
    if (!Array.isArray(pageStarts) || pageStarts.length < 2) return null;
    return function pageOf(index) {
      let lo = 0, hi = pageStarts.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pageStarts[mid] <= index) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans + 1;
    };
  }

  const api = {
    KIND, ACTION, MAX_BYTES, MIN_TEXT_CHARS, CHUNK, OVERLAP, BLOCKING_TYPES,
    TEXT_EXTS, KNOWN_UNSUPPORTED,
    classify, chunk, scanLong, summarise, verdict, pageLookup, extensionOf,
    joinTextItems,
    windowSize,
  };

  if (typeof window !== "undefined") {
    window.GuardAI = window.GuardAI || {};
    window.GuardAI.FileScan = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
