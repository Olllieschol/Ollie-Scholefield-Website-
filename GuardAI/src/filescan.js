/**
 * Guard4AI — file scanning policy.
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
    IMAGE: "image",
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
   * Images tesseract's bundled decoders read: PNG, JPEG, WebP. Screenshots
   * are the case that matters — measured 2026-08-28, rendered screen text
   * OCRs digit-exact at native resolution (19/19 planted values across seven
   * realistic UIs). Every other image format stays in KNOWN_UNSUPPORTED:
   * HEIC (iPhone photos) has no decoder here, and a photo of a document is a
   * different, much harder input than a screenshot anyway.
   */
  const IMAGE_EXTS = {
    png: "PNG screenshot / image",
    jpg: "JPEG image",
    jpeg: "JPEG image",
    webp: "WebP image",
  };

  /**
   * Deliberately NOT supported in v1, listed by name so the warning can say
   * what the file is rather than "unsupported file". A user who attaches a
   * spreadsheet deserves to be told Guard4AI cannot read spreadsheets yet, not
   * that their file is unrecognisable.
   */
  const KNOWN_UNSUPPORTED = {
    xlsx: "Excel spreadsheet", xls: "Excel spreadsheet", xlsm: "Excel spreadsheet",
    pptx: "PowerPoint deck", ppt: "PowerPoint deck",
    doc: "Legacy Word document (.doc)",
    pages: "Pages document", numbers: "Numbers spreadsheet", key: "Keynote deck",
    gif: "Image", heic: "Image", heif: "Image", svg: "Image", bmp: "Image", tiff: "Image",
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
    if (IMAGE_EXTS[ext]) return { kind: KIND.IMAGE, label: IMAGE_EXTS[ext], ext };
    if (KNOWN_UNSUPPORTED[ext]) {
      return { kind: KIND.UNSUPPORTED, label: KNOWN_UNSUPPORTED[ext], ext };
    }

    if (!ext) {
      if (type === "application/pdf") return { kind: KIND.PDF, label: "PDF document", ext };
      if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        return { kind: KIND.DOCX, label: "Word document", ext };
      }
      if (type === "image/png") return { kind: KIND.IMAGE, label: IMAGE_EXTS.png, ext };
      if (type === "image/jpeg") return { kind: KIND.IMAGE, label: IMAGE_EXTS.jpg, ext };
      if (type === "image/webp") return { kind: KIND.IMAGE, label: IMAGE_EXTS.webp, ext };
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
        console.warn("[Guard4AI] file scan window failed, continuing:", err);
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
   * Three categories that look like they belong here and do not:
   *
   *   HEALTH is a topic detector, not a data detector — its pattern matches
   *   "therapy", "symptoms", "medication", "mental health". It fires on any
   *   HR policy or leave clause. Blocking on it reintroduces exactly the
   *   noise this list exists to avoid. It is counted, not blocked.
   *
   *   IMMIGRATION is the same shape, and was in this list until 2026-08-28
   *   by oversight rather than decision. Its pattern matches the WORDS
   *   "immigration", "sponsorship", "permanent residency", "visa" — and
   *   "Visa" is also a payment card, so measured on 14 payment-sense
   *   sentences it flagged 14 of them: "We accept Visa, Mastercard and Amex"
   *   blocked a document as an immigration matter. It also captures no
   *   identifier at all — on "Visa grant number EGO4821577, subclass 482" it
   *   returns "Visa" and "subclass 482" and misses the grant number, which
   *   is the only actual identifier in the sentence. A rule that cannot
   *   capture the identifier cannot be protecting one. Counted, not blocked,
   *   for exactly HEALTH's reason.
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

    // Images get their OWN three states rather than reusing the document
    // ones, because the document states carry promises OCR cannot make.
    // "pass" means "read it, nothing blocks" — and a document extractor
    // really did read every character. OCR reads what it can see, which is
    // not the same thing, so an image is NEVER auto-released and never
    // shown the document wording. All three land on the decide card.
    IMG_FOUND: "img-found",           // OCR read text and the rules fired
    IMG_NOTHING: "img-nothing",       // OCR read text; nothing it read matched
    IMG_UNREADABLE: "img-unreadable", // OCR could not read this image properly

    // A scanned PDF where only the first few pages were read. It is its own
    // action because it must never take IMG_NOTHING's path: that one
    // auto-attaches, and "nothing in the 5 pages we read of 40" is not the
    // same fact as "nothing in this file". See the note on PDF_OCR_MAX_PAGES.
    PDF_PARTIAL: "pdf-partial",
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


  /* ------------------------------------------------------------------ *
   * Image scanning policy.
   *
   * Everything here was measured 2026-08-28 against a corpus of realistic
   * rendered screenshots (banking, ATO, payroll, Medicare, dark-mode chat,
   * email; retina and 1x) with checksum-valid planted values, plus degraded
   * variants. The numbers that matter:
   *
   *   - native-resolution screenshots: 19/19 rule hits, all digit-exact
   *   - JPEG recompression to quality 15: still 4/4 exact
   *   - BELOW native resolution the cliff is sharp: at 60% of 1x the same
   *     page scored confidence 27 with destroyed digits ("sims 2811
   *     70685008" for a card number); at 40% OCR returned nothing at all
   *   - readable pages scored confidence 61–95; the gap between 27 and 61
   *     is where the unreadable line goes
   *
   * The one non-negotiable: OCR reads what it can see, so an image verdict
   * can never claim the file is clean. IMG_NOTHING means "nothing in what
   * we could read", and the card wording owns that out loud.
   * ------------------------------------------------------------------ */

  /**
   * Pixel dimensions from the file header, without decoding the image.
   * PNG, JPEG and WebP (VP8 / VP8L / VP8X) — the three formats classify()
   * admits. Returns { width, height } or null when the header cannot be
   * read, and null is NOT "small": the caller must treat it as unknown.
   */
  function imageDims(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : bytes && bytes.byteLength != null ? new Uint8Array(bytes) : null;
    if (!b || b.length < 16) return null;

    // PNG: 8-byte signature, then IHDR with big-endian width/height.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      if (b.length < 24) return null;
      const be = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
      const w = be(16), h = be(20);
      return w && h ? { width: w, height: h } : null;
    }

    // JPEG: walk the markers to the first frame header (SOF0–SOF15, minus
    // the ones that are not frames: DHT C4, JPG C8, DAC CC).
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const marker = b[o + 1];
        if (marker === 0xff) { o++; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (b[o + 5] << 8) | b[o + 6];
          const w = (b[o + 7] << 8) | b[o + 8];
          return w && h ? { width: w, height: h } : null;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { o += 2; continue; }
        const len = (b[o + 2] << 8) | b[o + 3];
        if (len < 2) return null;
        o += 2 + len;
      }
      return null;
    }

    // WebP: RIFF....WEBP, then one of three chunk layouts.
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      if (b.length < 30) return null;
      const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (tag === "VP8X") {
        // 24-bit little-endian canvas size, stored minus one.
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return { width: w, height: h };
      }
      if (tag === "VP8 ") {
        // Lossy: frame header at chunk payload + 6, 14-bit little-endian each.
        const w = (b[26] | (b[27] << 8)) & 0x3fff;
        const h = (b[28] | (b[29] << 8)) & 0x3fff;
        return w && h ? { width: w, height: h } : null;
      }
      if (tag === "VP8L") {
        if (b[20] !== 0x2f) return null; // signature byte
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        const w = 1 + (bits & 0x3fff);
        const h = 1 + ((bits >> 14) & 0x3fff);
        return { width: w, height: h };
      }
      return null;
    }

    return null;
  }

  /**
   * Never scan part of an image. Above this we refuse with a plain reason
   * rather than downscaling (measured: below native resolution digits are
   * DESTROYED, not fuzzed — a downscaled scan would read wrong, not partial)
   * or silently cropping. 24MP is about four full retina screens stacked —
   * room for any real screenshot including tall full-page captures, while a
   * 60MP scan that would take minutes gets an honest no.
   */
  const IMG_MAX_PIXELS = 24 * 1000 * 1000;

  /** The one plain line for an oversized image, or null when it fits. */
  function imageTooLarge(dims) {
    if (!dims || !dims.width || !dims.height) return null;
    const mp = dims.width * dims.height;
    if (mp <= IMG_MAX_PIXELS) return null;
    return (
      "This image is too large to read reliably (" +
      Math.round(mp / 1000000) + " megapixels; the limit is " +
      Math.round(IMG_MAX_PIXELS / 1000000) + "). It has not been read."
    );
  }

  /**
   * The unreadable line. Measured floors: every page OCR read correctly
   * scored confidence 61+; the degraded page that produced destroyed digits
   * scored 27; a page OCR could not segment at all scored 0 with no text.
   * The cut sits in the gap. Both floors exist because they fail
   * differently: low confidence is "what came out is probably wrong", and
   * too-few characters is "nothing meaningful came out" — a confident read
   * of three stray letters must not count as having read the image.
   */
  const OCR_MIN_CONF = 45;
  const OCR_MIN_CHARS = 20;

  /**
   * Three states, and FOUND wins over unreadable on purpose: if the rules
   * fired on what OCR managed to read, that warning is true regardless of
   * how badly the rest of the image read. The reverse ordering would let a
   * blurry screenshot suppress a real TFN hit.
   *
   * @param {object} input
   * @param {object} [input.summary]    from summarise(), if scanning ran
   * @param {number} input.confidence   tesseract mean confidence, 0–100
   * @param {number} input.textChars    non-whitespace chars OCR produced
   */
  function ocrVerdict(input) {
    const it = input || {};
    const summary = it.summary || summarise([]);
    const conf = Number.isFinite(it.confidence) ? it.confidence : 0;
    const chars = Number.isFinite(it.textChars) ? it.textChars : 0;

    if (summary.total > 0) {
      return { action: ACTION.IMG_FOUND, summary };
    }
    if (conf < OCR_MIN_CONF || chars < OCR_MIN_CHARS) {
      return {
        action: ACTION.IMG_UNREADABLE,
        reason: chars < OCR_MIN_CHARS
          ? "Guard4AI could not make out text in this image."
          : "The text in this image is too unclear to read reliably.",
      };
    }
    return { action: ACTION.IMG_NOTHING, summary };
  }

  /* ------------------------------------------------------------------ *
   * "Send as masked text" suitability.
   *
   * The option to extract a document's text, mask it, and send it as a
   * message exists ONLY when the extraction will genuinely read correctly.
   * A jumbled paste is worse than a block: the user will not notice it is
   * mangled, will send it, and will get a confidently wrong answer with
   * nothing on screen to explain why.
   *
   * Every threshold below was measured, not guessed, against a corpus of
   * real documents (2026-08-28: five public PDFs — two academic papers, a
   * High Court judgment summary, two IRS forms — a real 469k-char DOCX
   * handbook, and constructed geometry controls). Blind-scored result:
   * 0 false positives, 2 false negatives in 12, and both false negatives
   * are deliberate (a record card whose masked text would be all fakes,
   * and a document too long to paste). The margins that make the numbers
   * meaningful:
   *
   *   fragShare      offered docs measured <= 0.34, forms >= 0.61
   *   medLine        offered >= 47, forms <= 17
   *   braidRate      row-wise-painted columns 0.51, every real doc <= 0.13
   *   debrisShare    equation-shattered paper 0.41, offered docs <= 0.15
   *   tableShare     table-only DOCX 0.99, prose DOCX 0.00 (exact, from
   *                  the document's own structure)
   *
   * Sentence density is deliberately a WEAK backstop only: measured, an
   * IRS 1040 form scores 7.1 sentences/1k against real prose at 5.4-9.0,
   * so it cannot distinguish a form from prose. Line shape can.
   * ------------------------------------------------------------------ */

  /** Text-shape signals. Pure string work; format-agnostic. */
  function textShape(text) {
    const t = typeof text === "string" ? text : "";
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    const lineChars = lines.reduce((n, l) => n + l.length, 0);
    const frag = lines.filter((l) => l.length < 40).length;
    // Debris: lines that are not words — shattered equations, dot leaders,
    // isolated symbols. Either almost nothing, or under half letters.
    const debris = lines.filter((l) => {
      if (l.length <= 4) return true;
      const letters = (l.match(/\p{L}/gu) || []).length;
      return letters / l.length < 0.5;
    }).length;
    // A sentence ender must follow a LETTER: dot leaders in forms
    // (". . . . 13b") otherwise count as prose — measured, they inflated a
    // tax form to 93 "sentences"/1k.
    const sentences = (t.match(/\p{L}[.!?](?=[\s"')\]]|$)/gu) || []).length;
    const nonWs = (t.match(/\S/g) || []).length;
    const med = lines.length
      ? lines.map((l) => l.length).sort((a, b) => a - b)[Math.floor(lines.length / 2)]
      : 0;
    return {
      chars: t.length,
      lineCount: lines.length,
      medLine: med,
      fragShare: lines.length ? frag / lines.length : 1,
      debrisShare: lines.length ? debris / lines.length : 1,
      sentPer1k: nonWs ? (sentences / nonWs) * 1000 : 0,
      longCharShare: lineChars
        ? lines.filter((l) => l.length >= 80).reduce((n, l) => n + l.length, 0) / lineChars
        : 0,
    };
  }

  /**
   * PDF layout signals, from per-page positioned items:
   * [{ items: [{x, y, len, stream}], width }].
   *
   * The one that matters most is braidRate: consecutive items in STREAM
   * order that stay on the same row but jump a column's width sideways.
   * That is the signature of a painter drawing row-wise across columns —
   * the one document shape whose extraction is maximally garbled while
   * every TEXT signal looks like perfect prose (measured: the braided
   * control scores medLine 138, longCharShare 1.00). Geometry is the only
   * thing that sees it. Measured on merged visual lines it is invisible
   * (same-row fragments merge before the detector looks), so it is
   * computed on raw items.
   */
  function layoutShape(pages) {
    const rates = { braid: [], rewind: [], switch: [] };
    for (const pg of pages || []) {
      const items = (pg.items || []).filter((it) => it && typeof it.x === "number");
      if (items.length < 12) continue;
      const inStream = [...items].sort((a, b) => a.stream - b.stream);
      let braid = 0;
      for (let i = 1; i < inStream.length; i++) {
        const dy = Math.abs(inStream[i].y - inStream[i - 1].y);
        const dx = Math.abs(inStream[i].x - inStream[i - 1].x);
        if (dy < 3 && dx > (pg.width || 612) * 0.12) braid++;
      }
      rates.braid.push(braid / (inStream.length - 1));

      // visual lines, for rewind + column-switch measures
      const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
      const linesArr = [];
      for (const it of sorted) {
        const line = linesArr.find((L) => Math.abs(L.y - it.y) < 2.5);
        if (line) {
          line.startX = Math.min(line.startX, it.x);
          line.stream = Math.min(line.stream, it.stream);
          line.len += it.len;
        } else linesArr.push({ y: it.y, startX: it.x, stream: it.stream, len: it.len });
      }
      const body = linesArr.filter((L) => L.len >= 15);
      if (body.length < 6) continue;
      const bodyStream = [...body].sort((a, b) => a.stream - b.stream);
      let rewinds = 0;
      for (let i = 1; i < bodyStream.length; i++) {
        if (bodyStream[i].y - bodyStream[i - 1].y > 20) rewinds++;
      }
      rates.rewind.push(rewinds / bodyStream.length);

      const xs = body.map((L) => L.startX).sort((a, b) => a - b);
      let gap = 0, gapAt = -1;
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; gapAt = xs[i - 1] + gap / 2; }
      }
      const left = xs.filter((x) => x < gapAt).length;
      if (gap > (pg.width || 612) * 0.15 && left >= xs.length * 0.25 && xs.length - left >= xs.length * 0.25) {
        let switches = 0;
        for (let i = 1; i < bodyStream.length; i++) {
          if ((bodyStream[i].startX < gapAt) !== (bodyStream[i - 1].startX < gapAt)) switches++;
        }
        rates.switch.push(switches / bodyStream.length);
      }
    }
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    return { braidRate: avg(rates.braid), rewindRate: avg(rates.rewind), switchRate: avg(rates.switch) };
  }

  /**
   * How much text each site's composer takes AS TEXT, measured live
   * 2026-08-28 by pasting/inserting through the same synthetic paths the
   * extension uses and reading back what landed:
   *
   *   chatgpt.com   9,500 stays text; AT 10,000 the site converts the paste
   *                 into an attachment chip ("Large pastes are now
   *                 attachments"). Cap 9,000 for margin.
   *   gemini        the composer hard-caps at 32,000 characters and
   *                 TRUNCATES SILENTLY past it — 60,000 in, 32,000 landed,
   *                 no error. Cap 30,000; the insert path must still verify
   *                 the landing, because silent truncation is this
   *                 feature's worst failure.
   *   claude.ai     250,000 characters landed as text in ~1s; the composer
   *                 is not the constraint, so it gets the general 60,000
   *                 readability ceiling.
   *
   * Sites that were not probed get ChatGPT's cap — the most conservative
   * cliff measured — because "becomes an attachment at 10k" is the kind of
   * behaviour another site may share.
   */
  const PASTE_LIMITS = {
    "chatgpt.com": 9000,
    "chat.openai.com": 9000,
    "claude.ai": 60000,
    "gemini.google.com": 30000,
    "bard.google.com": 30000,
  };
  const PASTE_LIMIT_DEFAULT = 9000;

  function pasteLimitFor(hostname) {
    const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
    if (PASTE_LIMITS[host]) return PASTE_LIMITS[host];
    for (const known in PASTE_LIMITS) {
      if (host === known || host.endsWith("." + known)) return PASTE_LIMITS[known];
    }
    return PASTE_LIMIT_DEFAULT;
  }

  /**
   * The verdict. Returns { offer, why } — `why` is the one plain line the
   * card shows when the option is absent, because silence is worse than a
   * reason.
   *
   * @param {object} input
   * @param {string} input.kind        from classify()
   * @param {object} input.shape       from textShape()
   * @param {object} [input.layout]    from layoutShape(), PDFs only
   * @param {number} [input.tableShare] DOCX only: chars in tables / total
   * @param {number} [input.pasteLimit] per-site cap from pasteLimitFor()
   */
  function suitability(input) {
    const it = input || {};
    const s = it.shape || textShape("");
    const L = it.layout || null;
    const limit = typeof it.pasteLimit === "number" ? it.pasteLimit : PASTE_LIMIT_DEFAULT;
    const no = (why) => ({ offer: false, why });

    // A non-finite char count means the shape was never really computed. NaN
    // compares false against BOTH size gates, so without this line a parser
    // bug that produced NaN would fail OPEN — the one direction this check is
    // never allowed to fail.
    const chars = Number.isFinite(s.chars) ? s.chars : 0;
    if (chars < 200) return no("There isn't enough readable text in this file.");

    if (it.kind === KIND.PDF && L) {
      if (L.braidRate > 0.2 || L.rewindRate > 0.15 || L.switchRate > 0.25) {
        return no("The columns come out shuffled, so the text would not read in order.");
      }
    }
    if (it.kind === KIND.DOCX && typeof it.tableShare === "number" && it.tableShare > 0.3) {
      return no("This document is mostly tables, so the text would not come out readable.");
    }
    if (s.fragShare > 0.45 || s.medLine < (it.kind === KIND.DOCX ? 40 : 30)) {
      return no("This document is mostly a form or tables, so the text comes out as fragments.");
    }
    if (s.debrisShare > 0.25) {
      return no("Too much of this document (equations or symbols) comes out as unreadable debris.");
    }
    if (s.sentPer1k < 3) return no("The text does not come out as readable sentences.");
    if (chars > limit) {
      return no(
        "The text is too long to send as a message here (about " +
        chars.toLocaleString() + " characters; this site takes about " +
        limit.toLocaleString() + ")."
      );
    }
    return { offer: true, why: "" };
  }

  /* ------------------------------------------------------------------ *
   * Scanned PDFs — rasterise, then OCR.
   *
   * A PDF with no text layer used to be reported "not checked", which is
   * every emailed invoice, payslip and signed contract. The capability
   * already existed for images; this is the same path with a renderer in
   * front of it.
   *
   * Measured 2026-08-29 in a real browser, inside the extension's own parser
   * page, with the vendored pdf.js and tesseract:
   *
   *   rasterising is FREE      4-26ms a page, under 2% of the cost
   *   OCR is the whole cost    ~0.4s a sparse page, ~1.0s a dense one
   *
   * PDF_OCR_SCALE is 2 (144 dpi) because ACCURACY falls off a cliff below
   * it, and confidence does not warn you. On a dense page at scale 1.5 the
   * OCR came back at confidence 62 with plausible-looking text and NOT ONE
   * of the planted BSB, account, TFN or Medicare survived — 0 of 4. At
   * scale 2 it is 4 of 4. Above 2 costs 20-40% more for nothing. A sparse
   * page reads fine at 1.5, which is exactly the trap: measuring one
   * document would have set this too low.
   *
   * Page segmentation stays at tesseract's single-block default. The
   * multi-window desktop screenshot needed auto layout because a desktop is
   * several pages at once; a scanned page IS one uniform block. Re-checked
   * on a DENSE rasterised page: PSM 6, 3 and 4 all found 4 of 4, so the
   * union that helps screenshots buys nothing here and costs a second pass.
   * ------------------------------------------------------------------ */

  const PDF_OCR_SCALE = 2;

  /**
   * How many pages of a scanned PDF get read.
   *
   * At ~1s a dense page: 5 pages is about 5 seconds, which is less than the
   * 14s the image path already spends on a dense retina screenshot. It
   * covers what actually arrives by email — invoices and payslips are 1-2
   * pages, contracts and onboarding packs 3-8. A cap of 2 was considered and
   * is too tight: it would leave most real scanned contracts half-read, which
   * makes the partial-read message routine rather than notable, and a message
   * people see constantly is one they stop reading.
   */
  const PDF_OCR_MAX_PAGES = 5;

  /**
   * The verdict for a scanned PDF.
   *
   * ONE RULE ABOVE THE OTHERS: "nothing found" may only auto-attach when
   * EVERY page was read. A partial read is always a decision, because
   * "nothing in the first 5 pages of 40" reads as a clean bill of health if
   * it is delivered the way a clean file is, and the bank details are on
   * page 2 of the contract precisely often enough to matter.
   *
   * Findings still win: if the rules fired on the pages that were read, that
   * is news whether or not the rest was read, and it blocks.
   */
  function scannedPdfVerdict(input) {
    const it = input || {};
    const pagesRead = Number(it.pagesRead) || 0;
    const pagesTotal = Number(it.pagesTotal) || 0;
    const partial = pagesTotal > pagesRead;
    const base = ocrVerdict(it);

    if (base.action === ACTION.IMG_FOUND) {
      return Object.assign({}, base, { pagesRead, pagesTotal, partial });
    }
    // Could not read what we DID rasterise — unchanged, and already a
    // decision. Saying "and there were 35 more" adds nothing to it.
    if (base.action === ACTION.IMG_UNREADABLE) {
      return Object.assign({}, base, { pagesRead, pagesTotal, partial });
    }
    if (partial) {
      return {
        action: ACTION.PDF_PARTIAL,
        summary: base.summary,
        pagesRead, pagesTotal, partial: true,
      };
    }
    return Object.assign({}, base, { pagesRead, pagesTotal, partial: false });
  }

  const api = {
    KIND, ACTION, MAX_BYTES, MIN_TEXT_CHARS, CHUNK, OVERLAP, BLOCKING_TYPES,
    PDF_OCR_SCALE, PDF_OCR_MAX_PAGES, scannedPdfVerdict,
    TEXT_EXTS, KNOWN_UNSUPPORTED, IMAGE_EXTS,
    classify, chunk, scanLong, summarise, verdict, pageLookup, extensionOf,
    joinTextItems,
    windowSize,
    textShape, layoutShape, suitability, pasteLimitFor,
    PASTE_LIMITS, PASTE_LIMIT_DEFAULT,
    imageDims, imageTooLarge, ocrVerdict,
    IMG_MAX_PIXELS, OCR_MIN_CONF, OCR_MIN_CHARS,
  };

  if (typeof window !== "undefined") {
    window.GuardAI = window.GuardAI || {};
    window.GuardAI.FileScan = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
