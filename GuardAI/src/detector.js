/**
 * GuardAI — detector.js
 * ---------------------------------------------------------------------------
 * Local-only sensitive-data detection engine. NO network calls, ever.
 *
 * Design principles (per the strict spec):
 *   - A number is only flagged as a SPECIFIC type if it matches that type's
 *     strict format (and, where relevant, passes a checksum).
 *   - Ambiguous patterns require CONTEXT words nearby before they are flagged,
 *     to keep false positives low.
 *   - High-confidence patterns (email, AU phone, Luhn-valid card, valid
 *     Medicare/TFN/ABN checksums, GPS) are flagged without context.
 *   - Overlapping matches are resolved (longest span wins) so the masker can
 *     splice cleanly.
 *
 * Region focus: Australia.
 *
 * A "finding" is:
 *   { type, label, value, index, severity: high|medium|low, reason }
 *
 * Exposed as window.GuardAI.Detector.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  /* ================================================================== *
   * Checksums & helpers
   * ================================================================== */

  /** Luhn — credit/debit cards. */
  function luhnValid(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /** Australian Tax File Number checksum (8 or 9 digits, weighted, mod 11). */
  function tfnValid(digits) {
    const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
    if (digits.length !== 8 && digits.length !== 9) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) sum += parseInt(digits[i], 10) * weights[i];
    return sum % 11 === 0;
  }

  /** Australian Medicare check digit (10 digits, first 2-6, 9th is checksum). */
  function medicareValid(digits) {
    if (digits.length < 10) return false;
    const first8 = digits.slice(0, 8);
    if (!/^[2-6]/.test(first8)) return false;
    const weights = [1, 3, 7, 9, 1, 3, 7, 9];
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += parseInt(first8[i], 10) * weights[i];
    return sum % 10 === parseInt(digits[8], 10);
  }

  /** Australian Business Number checksum (11 digits, mod 89). */
  function abnValid(digits) {
    if (digits.length !== 11) return false;
    const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      let n = parseInt(digits[i], 10);
      if (i === 0) n -= 1;
      sum += n * weights[i];
    }
    return sum % 89 === 0;
  }

  /** Word-start match: `w` must begin at a word boundary in lc text, so a
   * keyword like "ring" can never match inside "string". The END is left open
   * on purpose so stems still work ("earn" matches "earning"). */
  function hasWord(lc, w) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![a-z0-9])" + esc).test(lc);
  }

  /** True if any of `words` appears within `win` chars around [start,end). */
  function near(text, start, end, words, win) {
    win = win || 30;
    const a = Math.max(0, start - win);
    const b = Math.min(text.length, end + win);
    const ctx = text.slice(a, b).toLowerCase();
    return words.some((w) => hasWord(ctx, w));
  }

  /**
   * Explicit "this number is a <thing>" labels, used to re-type a value whose
   * SHAPE alone is ambiguous. Ordered longest-keyword-first only for
   * readability; the actual winner is whichever label sits CLOSEST before the
   * value (see retypeLabelledNumbers).
   */
  const NUMBER_LABELS = [
    { words: ["medicare"], type: "MEDICARE", label: "Medicare number" },
    { words: ["tax file", "tfn"], type: "TFN", label: "Tax File Number" },
    { words: ["passport"], type: "PASSPORT", label: "Passport number" },
    { words: ["licence", "license"], type: "LICENCE", label: "Licence number" },
    { words: ["abn"], type: "ABN", label: "ABN" },
    { words: ["acn"], type: "ACN", label: "ACN" },
    { words: ["bsb"], type: "BSB", label: "BSB" },
    { words: ["account", "acct"], type: "BANK_ACCOUNT", label: "Bank account" },
  ];

  /**
   * Re-type phone-SHAPED numbers that are explicitly labelled as something
   * else. An Australian Medicare number, TFN or bank account written as
   * "0494 969 403" is indistinguishable BY SHAPE from an 04xx mobile, so the
   * phone detector claims it and the user sees their Medicare number
   * highlighted (and legended) as "Phone" — actively misleading, since the
   * colour key then implies every orange value is a phone number.
   *
   * The dedicated MEDICARE/TFN/etc. detectors can't catch these themselves:
   * they gate on the real formats (Medicare is 4-5-1 starting 1-9; TFN is
   * 3-3-3), which these deliberately-fake-looking values don't satisfy.
   *
   * Only the label IMMEDIATELY BEFORE the value counts, and only the nearest
   * one wins — in "BSB 468-329, account 0402 296 812" the account number must
   * become BANK_ACCOUNT, not BSB, even though both keywords are in range.
   * Looking backwards only also stops "0410 632 922 and email is ..." from
   * stealing the label of whatever follows it.
   *
   * Masking quality improves as a side effect: the fake is now generated from
   * the CORRECT type, so a Medicare number is replaced by a Medicare-shaped
   * fake instead of a mobile-shaped one.
   */
  const RETYPE_WINDOW = 30;
  /** Whole-word check (boundaries on both sides) for `w` sitting at `at`. */
  function isWholeWordAt(lc, w, at) {
    const beforeCh = at > 0 ? lc[at - 1] : "";
    const afterCh = lc[at + w.length] || "";
    return !/[a-z0-9]/.test(beforeCh) && !/[a-z0-9]/.test(afterCh);
  }

  function retypeLabelledNumbers(text, findings) {
    for (const f of findings) {
      if (f.type !== "PHONE") continue;
      const from = Math.max(0, f.index - RETYPE_WINDOW);
      const before = text.slice(from, f.index).toLowerCase();
      let best = null;
      let bestAt = -1;
      for (const cand of NUMBER_LABELS) {
        for (const w of cand.words) {
          // Nearest label to the value wins, so scan from the right.
          const at = before.lastIndexOf(w);
          if (at === -1) continue;
          // Require boundaries on BOTH sides. hasWord() deliberately leaves
          // the end open so stems match ("earn" -> "earning"), but that is
          // exactly wrong here: "the accountant 0412 556 781" must stay a
          // phone number, not become a bank account.
          if (!isWholeWordAt(before, w, at)) continue;
          if (at > bestAt) {
            bestAt = at;
            best = cand;
          }
        }
      }
      if (!best) continue;
      // Nothing but connective filler ("number is", ":", "-") may sit between
      // the label and the value; a sentence break means the label belongs to
      // something else entirely.
      const between = before.slice(bestAt);
      if (/[.;!?\n]/.test(between)) continue;
      f.type = best.type;
      f.label = best.label;
      f.reason = REASONS[best.type] || f.reason;
    }
    return findings;
  }

  // rowCtx() searches the WHOLE text for a header keyword, and scan() calls
  // it once per CANDIDATE match across several detectors — on ordinary input
  // that's a handful of calls, but on a match-heavy adversarial paste it can
  // be thousands. Recomputing text.toLowerCase() (and, before this cache, an
  // unbounded per-call line scan) from scratch every single call turned that
  // into thousands of full-text passes — measured multi-second hangs on a
  // 100K-char pathological input. Cache the lowercase text per scan() call
  // (single-slot: valid as long as the same `text` reference is reused,
  // which is exactly how scan() calls every detector) so it's computed once.
  let _lcCache = null;
  let _lcCacheText = null;
  function lowerCached(text) {
    if (_lcCacheText !== text) {
      _lcCacheText = text;
      _lcCache = text.toLowerCase();
    }
    return _lcCache;
  }
  // Cap how far a "row" can extend when hunting for delimiters, so a single
  // pathological line with no newlines (unlike any real CSV/table row) can't
  // force an O(text length) scan on every call either.
  const ROW_SCAN_WINDOW = 500;

  /**
   * Tabular fallback context. In a CSV / markdown-table paste the type label
   * lives only in the HEADER row, hundreds of characters from the values, so
   * near() can never see it. If the value sits on a delimited record row
   * (>= 3 commas/pipes/tabs on its line) and the keyword appears anywhere in
   * the whole text (i.e. the header), that is context enough.
   */
  function rowCtx(text, start, words) {
    const winStart = Math.max(0, start - ROW_SCAN_WINDOW);
    const winEnd = Math.min(text.length, start + ROW_SCAN_WINDOW);
    const lsRel = text.lastIndexOf("\n", start - 1);
    const ls = lsRel >= winStart ? lsRel + 1 : winStart;
    const leRel = text.indexOf("\n", start);
    const le = leRel >= 0 && leRel <= winEnd ? leRel : winEnd;
    const line = text.slice(ls, le);
    const delims = (line.match(/,|\||\t/g) || []).length;
    if (delims < 3) return false;
    const lc = lowerCached(text);
    return words.some((w) => hasWord(lc, w));
  }

  function dedupe(findings) {
    const seen = new Set();
    return findings.filter((f) => {
      const key = `${f.type}@${f.index}:${f.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Greedily keep the best spans; drop anything overlapping an accepted one.
   * A MASKABLE finding (one the masker will actually swap for a fake) always
   * wins over a warning-only one (CONFIDENTIAL, HEALTH, LEGAL, IMMIGRATION,
   * BUSINESS_CONFIDENTIAL) on overlap, regardless of length. Those warning
   * detectors use loose "keyword + up to 40 trailing chars" patterns
   * (detectBusiness, detectLegal, etc.) that can accidentally run a few
   * characters past the keyword and swallow an adjacent structured value —
   * e.g. "revenue was $1" (BUSINESS_CONFIDENTIAL) vs "$1.85 million" (MONEY)
   * for the SAME dollar figure. Picking by raw span length would let the
   * warning steal the span and the money would never get masked. Ties within
   * the same priority tier still fall back to longest-span-wins.
   */
  function resolveOverlaps(findings) {
    const maskable = (window.GuardAI && window.GuardAI.MASKABLE_TYPES) || null;
    const priority = (f) => (maskable && maskable.has(f.type) ? 0 : 1);
    const sorted = [...findings].sort((a, b) => {
      const p = priority(a) - priority(b);
      if (p !== 0) return p;
      if (b.value.length !== a.value.length) return b.value.length - a.value.length;
      return a.index - b.index;
    });
    const accepted = [];
    for (const f of sorted) {
      const s = f.index;
      const e = f.index + f.value.length;
      const clash = accepted.some((g) => s < g.index + g.value.length && e > g.index);
      if (!clash) accepted.push(f);
    }
    return accepted.sort((a, b) => a.index - b.index);
  }

  /* ================================================================== *
   * Plain-English risk explanations
   * ================================================================== */
  const REASONS = {
    NAME_PII:
      "A full name combined with another personal detail makes you directly identifiable.",
    ORG:
      "A company name identifies a real client, employer or supplier and links this conversation to a specific business relationship.",
    DOB: "Your date of birth is a key identifier used to verify identity and is valuable for fraud.",
    PASSPORT:
      "Passport numbers are government identity documents and are extremely valuable to identity thieves.",
    LICENCE:
      "A driver licence number can be used to impersonate you and open accounts in your name.",
    MEDICARE:
      "Your Medicare number is sensitive government health ID and a prime target for identity theft.",
    TFN: "A Tax File Number is highly sensitive Australian government ID enabling serious identity fraud.",
    CREDIT_CARD:
      "Card numbers are financial credentials and should never appear in a chat log.",
    BSB: "A bank BSB identifies your branch and, with an account number, enables fraudulent transfers.",
    BANK_ACCOUNT:
      "Bank account details can be used to set up fraudulent debits or impersonate your bank.",
    REF_CODE:
      "An account or reference code ties this conversation to a specific customer, contract or invoice in a real system.",
    MONEY:
      "A specific financial figure with business/personal context can be commercially or personally sensitive.",
    PHONE:
      "A phone number is tied to your identity and can be used for spam, SIM-swap or social engineering.",
    EMAIL:
      "An email address identifies you and links to your accounts; chats may be retained or used for training.",
    ADDRESS:
      "A home address reveals where you live — a physical-safety and stalking risk if it leaks.",
    GPS: "Precise GPS coordinates reveal an exact physical location and are a serious safety risk.",
    ABN: "An ABN identifies a specific business entity and links to commercial and tax records.",
    ACN: "An ACN identifies a registered company and links to official corporate records.",
    CONFIDENTIAL:
      "This content is marked confidential/restricted — sharing it may breach an NDA or policy.",
    BUSINESS_CONFIDENTIAL:
      "This looks like confidential business data (revenue, clients, internal figures) that could leak commercial secrets.",
    HEALTH:
      "Health and medical information is highly sensitive personal data and protected under privacy law.",
    LEGAL:
      "Legal or court information is confidential and could prejudice a matter or breach privilege.",
    IMMIGRATION:
      "Immigration/visa details are sensitive government records valuable for identity fraud.",
    PASSWORD:
      "This looks like a password or credential. Secrets must never be typed into an AI chat.",
    USERNAME:
      "A username identifies a specific account, and paired with anything else in the message it is half of a working login.",
  };

  const IDENTIFIER_TYPES = new Set([
    "USERNAME",
    "ORG",
    "PHONE",
    "EMAIL",
    "ADDRESS",
    "DOB",
    "MEDICARE",
    "TFN",
    "PASSPORT",
    "LICENCE",
    "CREDIT_CARD",
    "BANK_ACCOUNT",
    "REF_CODE",
    "BSB",
    "GPS",
    "ABN",
    "ACN",
  ]);

  function finding(type, label, value, index, severity) {
    return { type, label, value, index, severity, reason: REASONS[type] || "" };
  }

  /* ================================================================== *
   * Detectors
   * ================================================================== */

  // ---- Contact & location -------------------------------------------------
  function detectEmail(text, out) {
    // Anchor on literal "@" occurrences first instead of letting the regex
    // engine scan open-ended forward from every position. The classic
    // `[localpart]+@[domain]+\.[tld]` shape catastrophically backtracks when
    // a long run of local-part-eligible characters (digits/dots/dashes) has
    // no "@" after it — the engine greedily consumes the whole run, fails,
    // and un-consumes one character at a time from every starting position.
    // Measured 5+ seconds on a 100K-char adversarial input with no "@" at
    // all. Finding "@" via indexOf is O(n) total, and bounding the local/
    // domain-part windows around each "@" (well past any real email's
    // length) keeps every subsequent regex O(1) relative to document size.
    let at = text.indexOf("@");
    while (at !== -1) {
      const beforeSlice = text.slice(Math.max(0, at - 64), at);
      const localMatch = beforeSlice.match(/[A-Za-z0-9._%+-]+$/);
      const domainSlice = text.slice(at + 1, at + 1 + 254);
      const domainMatch = domainSlice.match(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (localMatch && domainMatch) {
        const value = localMatch[0] + "@" + domainMatch[0];
        const start = at - localMatch[0].length;
        // \b-equivalent: the character just outside the match must not be a
        // word character, so this doesn't match inside a longer token.
        const before = text[start - 1];
        const after = text[start + value.length];
        const okBefore = !before || !/[A-Za-z0-9_]/.test(before);
        const okAfter = !after || !/[A-Za-z0-9_]/.test(after);
        if (okBefore && okAfter) {
          out.push(finding("EMAIL", "Email address", value, start, "medium"));
        }
      }
      at = text.indexOf("@", at + 1);
    }

    detectObfuscatedEmail(text, out);
  }

  /**
   * Spelled-out / obfuscated addresses: "j dot patel at northstone dot com
   * dot au", "john (at) company (dot) com". People write these deliberately
   * to dodge scrapers, and pasting one into an AI chat leaks the address just
   * as completely as the literal form — but it contains no "@" at all, so the
   * anchored scan above can never see it.
   *
   * Guarded by a TLD whitelist on the final segment. Without it, ordinary
   * prose ("meet me at the pub dot point road") matches the same shape; with
   * it, the pattern only fires on something that genuinely ends in a real
   * top-level domain.
   */
  const OBFUSCATED_TLDS =
    "com|net|org|io|co|au|uk|nz|us|edu|gov|info|biz|dev|app|me|ai";
  function detectObfuscatedEmail(text, out) {
    // Anchored on the "at" pivot rather than scanned from every offset, for
    // exactly the reason the literal scan above anchors on "@": the local and
    // domain parts are repeating groups, so on a long separator-rich run that
    // never completes a match ("a1.b2-c3_" x15000) the engine retries the
    // whole structure at every position — measured 10 seconds before this was
    // anchored. Every real match must contain a pivot, so enumerating pivots
    // and checking a bounded window around each is equivalent and linear.
    //
    // The pivot and separators require surrounding whitespace or brackets and
    // never match glued inside a word. Besides being correct ("format" must
    // not read as "form"+at), it keeps each window parse unambiguous, since
    // every alternative then starts on a character the word class cannot
    // match.
    const DOT = "(?:\\s+[\\(\\[]?dot[\\)\\]]?\\s+|\\s*[\\(\\[]dot[\\)\\]]\\s*|\\s*\\.\\s*)";
    const WORD = "[A-Za-z0-9_%+-]{1,64}";
    // Bounded repetition ({0,8}) — no real address has more segments, and an
    // unbounded * would reintroduce the quadratic retry inside the window.
    const LOCAL = new RegExp(`(${WORD}(?:${DOT}${WORD}){0,8})$`, "i");
    const DOMAIN = new RegExp(
      `^(${WORD}(?:${DOT}${WORD}){0,8}${DOT}(?:${OBFUSCATED_TLDS}))(?![A-Za-z0-9])`,
      "i"
    );
    const pivot = /(?:\s+[([]?at[)\]]?\s+|\s*[([]at[)\]]\s*)/gi;
    let p;
    while ((p = pivot.exec(text))) {
      const before = text.slice(Math.max(0, p.index - 128), p.index);
      const after = text.slice(pivot.lastIndex, pivot.lastIndex + 254);
      const localMatch = before.match(LOCAL);
      const domainMatch = after.match(DOMAIN);
      if (!localMatch || !domainMatch) continue;
      const start = p.index - localMatch[1].length;
      const value = text.slice(start, pivot.lastIndex + domainMatch[1].length);
      // The literal scan owns anything already containing "@".
      if (value.includes("@")) continue;
      const prev = text[start - 1];
      if (prev && /[A-Za-z0-9_@]/.test(prev)) continue;
      out.push(finding("EMAIL", "Email address", value.trim(), start, "medium"));
    }
  }

  function detectPhone(text, out) {
    // 1) Standard AU: +61 / 61 / 0 prefix + 9 more digits in any separator layout.
    const re = /(?:\+?61|\b0)(?:[\s.-]?\d){9}\b/g;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[0];
      const digits = raw.replace(/\D/g, "");
      let national;
      if (digits.startsWith("61")) {
        national = "0" + digits.slice(2);
      } else if (digits.startsWith("0")) {
        national = digits;
      } else {
        continue;
      }
      // Valid AU national number: exactly 10 digits, leading 0 then 2-9.
      if (national.length === 10 && /^0[2-9]\d{8}$/.test(national)) {
        out.push(finding("PHONE", "Phone number", raw.trim(), m.index, "medium"));
      }
    }

    // 2) AU service numbers: 1300 / 1800 / 1900 XXXXXX (10 digits).
    const serviceRe = /\b(1[389]00[\s.-]?\d{3}[\s.-]?\d{3})\b/g;
    while ((m = serviceRe.exec(text))) {
      out.push(finding("PHONE", "Phone number", m[1].trim(), m.index, "medium"));
    }

    // 3) Context-triggered: any 7–12 digit number near phone keywords — catches
    //    unusual formats (e.g. "1414 376 274"), international numbers, or numbers
    //    the user explicitly labels as a phone/mobile/contact number.
    const PHONE_CTX = [
      "phone", "mobile", "cell", "call me", "contact", "number is",
      "reach me", "ring", "text me", "sms", "fax",
    ];
    // If the number is labelled as one of these, it is NOT a phone number even
    // when a phone word also appears nearby ("tracking number for my phone case").
    const NOT_PHONE = [
      "tracking", "order", "serial", "invoice", "receipt", "reference",
      "ticket", "imei", "model", "part number", "case number",
    ];
    const ctxRe = /\b(\d[\d\s.\-()\[\]]{5,18}\d)\b/g;
    while ((m = ctxRe.exec(text))) {
      const digits = m[1].replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 12) continue;
      // Skip anything already captured as a phone.
      const start = m.index;
      const end = start + m[1].length;
      if (out.some((f) => f.type === "PHONE" && f.index <= start && end <= f.index + f.value.length))
        continue;
      if (near(text, start, end, NOT_PHONE, 45)) continue;
      if (near(text, start, end, PHONE_CTX, 45)) {
        out.push(finding("PHONE", "Phone number", m[1].trim(), start, "medium"));
      }
    }
  }

  function detectGPS(text, out) {
    const re = /[-+]?\d{1,2}\.\d{4,}\s*,\s*[-+]?\d{2,3}\.\d{4,}/g;
    let m;
    while ((m = re.exec(text))) {
      out.push(finding("GPS", "GPS coordinates", m[0].trim(), m.index, "high"));
    }
  }

  function detectAddress(text, out) {
    const streetTypes =
      "St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Cres|Crescent|" +
      "Blvd|Boulevard|Hwy|Highway|Pde|Parade|Tce|Terrace|Way|Cl|Close|" +
      // Standalone thoroughfares — these are commonly used as the WHOLE street
      // name with no preceding word (e.g. "156 Esplanade"), which the old pattern
      // missed because it required >=1 name word before the type.
      "Esplanade|Esp|Pkwy|Parkway|Cct|Circuit|Cir|Circle|Mews|Walk|Row|Grove|Grv|" +
      "Quay|Cove|Glade|Gardens|Gdns|Loop|Rise|Vista|Mall|Promenade|Concourse|Arcade";
    const states = "NSW|VIC|QLD|WA|SA|TAS|ACT|NT";
    // number + 0-3 capitalised words + street type, optional ", suburb", state,
    // postcode. The street-name words are now OPTIONAL ({0,3}) so a number
    // followed directly by a standalone thoroughfare ("156 Esplanade") matches.
    //
    // Captured in THREE parts rather than one, because the suburb tail is the
    // piece that can run away into the next clause and it has to be validated
    // after the match rather than trusted:
    //   m[1] core   — house number + street name + street type
    //   m[2] tail   — up to two capitalised words that MIGHT be a suburb
    //   m[3] region — state and/or 4-digit postcode
    //
    // Note there is deliberately no `\.?` after the street type any more. A
    // full stop is sentence punctuation, never part of the address: including
    // it meant masking replaced the "." too, and — worse — let the tail keep
    // matching across the sentence boundary into the next sentence's first
    // word ("88 Kellett Parade. Let" was captured as one address, so masking
    // deleted both the full stop and the word "Let").
    const re = new RegExp(
      `\\b(\\d{1,5}[A-Za-z]?(?:[-/]\\d{1,4})?\\s+(?:[A-Z][a-zA-Z]+\\s+){0,3}(?:${streetTypes}))\\b` +
        `((?:,?\\s+[A-Z][a-zA-Z]+){0,2})` +
        `((?:\\s+(?:${states}))?(?:\\s+\\d{4})?)`,
      "g"
    );
    let m;
    while ((m = re.exec(text))) {
      const core = m[1];
      const tail = m[2] || "";
      const region = m[3] || "";
      // The tail is only trusted when something corroborates it as a suburb:
      // an explicit state/postcode after it, or a hard clause terminator right
      // after it (end of string, comma, full stop, newline...). Left greedy, a
      // capitalised word that simply follows the street type gets swallowed —
      // "14 Grove Street, Ryan is at ..." captured "14 Grove Street, Ryan",
      // and masking that span DELETED the second person's name from the
      // message. Under-capturing a suburb only leaves a suburb unmasked;
      // over-capturing rewrites the user's sentence, which is far worse.
      let keepTail = false;
      if (tail) {
        const after = text.slice(m.index + m[0].length);
        keepTail = !!region || /^(?:[.,;:!?)\]}"'\n]|$)/.test(after);
      }
      // Always a contiguous prefix of the overall match, so `index` stays valid:
      // when the tail is rejected the region is empty too (a state/postcode
      // would have corroborated the tail and kept it).
      const value = (core + (keepTail ? tail + region : "")).trim();
      out.push(finding("ADDRESS", "Physical address", value, m.index, "high"));
    }

    // Informal lowercase addresses ("i live at 152a george st sydney"). The
    // capitalised pattern above can't see these. To stay precise we require a
    // location preposition/verb right before the number (at/to/in/near/from/
    // address is), 1-3 lowercase words, and a core street type; the optional
    // trailing words pick up the suburb.
    const loRe = new RegExp(
      "\\b(?:at|to|in|near|from|address\\s+is)\\s+" +
        "((\\d{1,5}[a-z]?(?:[-/]\\d{1,4})?)\\s+(?:[a-z]{3,}\\s+){1,3}" +
        "(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|pl|place|cres|crescent|" +
        "pde|parade|tce|terrace|hwy|highway|blvd|boulevard|esplanade|cl|close|way)\\b" +
        "(?:\\s+[a-z]+){0,2}(?:\\s+\\d{4})?)",
      "gi"
    );
    while ((m = loRe.exec(text))) {
      // The loose suburb tail can swallow ordinary following words
      // ("...george st and work nearby") — trim trailing function words.
      let value = m[1].trim();
      value = value.replace(
        /(?:\s+(?:and|or|but|the|a|an|is|was|are|it|so|then|what|where|who|which|my|your|his|her|our|their|this|that|for|with|on))+$/i,
        ""
      );
      // Only take the lowercase branch when the capitalised pattern missed it.
      const start = m.index + m[0].indexOf(m[1]);
      const end = start + value.length;
      const already = out.some(
        (f) => f.type === "ADDRESS" && f.index < end && f.index + f.value.length > start
      );
      if (!already) out.push(finding("ADDRESS", "Physical address", value, start, "high"));
    }
  }

  /**
   * Trim any finding whose captured value runs past a sentence boundary.
   *
   * Only ever shortens a value, and only from the END, so the finding's
   * `index` stays correct (the kept text is still a prefix of what was
   * matched at that position). A value is cut at the first terminator that is
   * followed by whitespace, which is what separates real sentence punctuation
   * from punctuation inside a value ("$1.5m", "j.smith@x.com" — no space, so
   * never cut). If the cut would leave nothing, the value is left alone and
   * the finding is dropped instead.
   */
  function clampToSentence(out) {
    for (let i = out.length - 1; i >= 0; i--) {
      const f = out[i];
      if (typeof f.value !== "string") continue;
      const cut = f.value.search(/[.!?;\n]\s/);
      if (cut === -1) continue;
      const trimmed = f.value.slice(0, cut).replace(/\s+$/, "");
      if (trimmed) f.value = trimmed;
      else out.splice(i, 1);
    }
  }

  // ---- Financial ----------------------------------------------------------
  function detectCreditCard(text, out) {
    // A flat character class, not `(?:\d[ -]?){13,19}`. That older pattern's
    // per-repetition OPTIONAL separator is ambiguous — the engine can consume
    // or skip it at every position — and on adversarial input (long runs of
    // digit/dash text that ultimately fail the match) that ambiguity causes
    // catastrophic backtracking: measured 73+ seconds on a 380KB pathological
    // string in testing, effectively hanging the page. A character class has
    // no such ambiguity (each character is consumed exactly one way), so this
    // match is linear-time regardless of input; digit-count/shape validation
    // now happens in JS below instead of inside the regex.
    const re = /\d[\d \-]{11,40}\d/g;
    const ctx = ["card", "credit", "debit", "visa", "mastercard", "amex", "ccv", "cvv", "cvc", "expiry"];
    let m;
    while ((m = re.exec(text))) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      // Luhn-valid is high-confidence on its own. Otherwise flag 15-16 digit
      // sequences that sit near card keywords (catches test/placeholder cards
      // that won't satisfy Luhn but are clearly labelled as a card).
      const hasCtx = near(text, m.index, m.index + m[0].length, ctx, 25);
      if (luhnValid(digits) || (hasCtx && digits.length >= 15 && digits.length <= 16)) {
        out.push(
          finding("CREDIT_CARD", "Credit/debit card number", m[0].trim(), m.index, "high")
        );
      }
    }
  }

  function detectBSB(text, out) {
    // Strictly XXX-XXX with a dash, and ONLY with banking context — the bare
    // pattern matches far too much normal text (scores, vote tallies, ranges).
    const re = /\b\d{3}-\d{3}\b/g;
    const words = ["bsb", "bank", "branch", "account", "acct", "transfer", "deposit", "pay"];
    let m;
    while ((m = re.exec(text))) {
      if (near(text, m.index, re.lastIndex, words, 30) || rowCtx(text, m.index, ["bsb"])) {
        out.push(finding("BSB", "Bank BSB", m[0], m.index, "high"));
      }
    }
  }

  /**
   * Context words that mark a nearby number as an account / order / customer
   * reference. Shared by the contiguous and the GROUPED digit patterns below
   * so the two can never drift apart — inconsistent coverage between them is
   * exactly what made this field type unreliable ("account 8827 3410" missed
   * while "account NS-6631" masked).
   */
  // Deliberately NOT the bare words "order" or "ref". "order" is far too
  // common in ordinary prose to mark the digits beside it as sensitive — "the
  // tracking number for my phone case order is 88291045" is a shipment
  // enquiry, not an account. The multi-word forms below carry the meaning.
  const REF_CONTEXT = [
    "account", "acct", "a/c", "bsb", "bank", "savings", "transfer",
    "reference", "invoice", "membership", "booking", "receipt",
    "transaction", "statement",
    "order number", "order no", "order id", "customer number",
    "member number", "policy number", "claim number", "contract number",
  ];

  /**
   * Like near(), but every keyword must match as a WHOLE word.
   *
   * hasWord() leaves the end of the keyword open so stems match ("earn" ->
   * "earning"), which is right for topic keywords and wrong for these: it
   * makes "the accountant is on 0412 556 781" look like account context and
   * turns a phone number into a bank account.
   */
  function nearWord(text, start, end, words, win) {
    win = win || 30;
    const a = Math.max(0, start - win);
    const b = Math.min(text.length, end + win);
    const ctx = text.slice(a, b).toLowerCase();
    return words.some((w) => {
      let at = ctx.indexOf(w);
      while (at !== -1) {
        if (isWholeWordAt(ctx, w, at)) return true;
        at = ctx.indexOf(w, at + 1);
      }
      return false;
    });
  }

  function detectBankAccount(text, out) {
    // 6-10 CONTIGUOUS digits near account context.
    const re = /\b\d{6,10}\b/g;
    let m;
    while ((m = re.exec(text))) {
      if (nearWord(text, m.index, re.lastIndex, REF_CONTEXT, 25) && !isFlightContext(text, m.index, re.lastIndex)) {
        out.push(finding("BANK_ACCOUNT", "Bank account number", m[0], m.index, "high"));
      }
    }

    // GROUPED digits: "8827 3410", "044-772-19", "12 3456 7890". Real account
    // and order references are written in readable blocks at least as often as
    // they are written as one run, but every numeric detector here keyed off
    // CONTIGUOUS digits, so the spaced/dashed forms fell through the gap
    // entirely while their unspaced equivalents masked — the inconsistency
    // reported for this field.
    //
    // Anchored on the CONTEXT WORD, not scanned across the whole document, for
    // the same reason detectEmail anchors on "@": `\d{2,6}(?:[ -]\d{2,6}){1,3}`
    // is ambiguous about where each group starts, so on a long digit/dash run
    // that never matches ("4111-1111-1111-111" x20000) the engine retries
    // every split at every offset — measured 8.5 seconds before this was
    // anchored. A context word is required for a match anyway, so searching
    // outward from those few positions is both equivalent and linear.
    for (const at of contextAnchors(text, REF_CONTEXT)) {
      const from = Math.max(0, at - 40);
      const window = text.slice(from, at + 80);
      const grouped = /\b\d{2,6}(?:[ -]\d{2,6}){1,3}\b/g;
      let g;
      while ((g = grouped.exec(window))) {
        const value = g[0];
        const digits = value.replace(/\D/g, "").length;
        // 6-14 digits: below 6 it's a quantity or a date fragment, above 14
        // it's a card number (detectCreditCard owns those) or a digit wall.
        if (digits < 6 || digits > 14) continue;
        if (isDateLike(value)) continue;
        // Leave anything phone-shaped to detectPhone. A valid AU number sitting
        // near a reference keyword ("the accountant 0412 556 781 about the
        // invoice") is a phone number, and the codebase already has the right
        // mechanism for the genuinely-relabelled case: retypeLabelledNumbers,
        // which only honours a label IMMEDIATELY BEFORE the value. This branch
        // looks both directions, so without this guard it would out-vote that
        // deliberately stricter rule using a keyword that merely trails the
        // number.
        if (isAuPhoneShaped(value)) continue;
        const start = from + g.index;
        // Re-check distance against the real text: the window is generous, the
        // actual proximity rule is the same 25 chars the contiguous branch uses.
        if (!nearWord(text, start, start + value.length, REF_CONTEXT, 25)) continue;
        if (isFlightContext(text, start, start + value.length)) continue;
        out.push(finding("BANK_ACCOUNT", "Account / reference number", value, start, "high"));
      }
    }
  }

  /** Same validity rule detectPhone applies: 10 digits, leading 0 then 2-9. */
  function isAuPhoneShaped(value) {
    let d = value.replace(/\D/g, "");
    if (d.startsWith("61")) d = "0" + d.slice(2);
    return /^0[2-9]\d{8}$/.test(d);
  }

  /** Start offsets of every whole-word occurrence of any of `words`. */
  function contextAnchors(text, words) {
    const lc = lowerCached(text);
    const hits = [];
    for (const w of words) {
      let at = lc.indexOf(w);
      while (at !== -1) {
        if (isWholeWordAt(lc, w, at)) hits.push(at);
        at = lc.indexOf(w, at + 1);
      }
    }
    return hits.sort((a, b) => a - b);
  }

  /**
   * Dates written with the same separators as a grouped reference number
   * ("12-05-2024", "2024-05-12", "05 12 2024"). Excluded so an invoice line
   * like "invoice dated 12-05-2024" doesn't mask the date as an account
   * number — dates are explicitly a never-auto-mask category.
   */
  function isDateLike(value) {
    const parts = value.split(/[ -]/);
    if (parts.length !== 3) return false;
    const nums = parts.map((p) => parseInt(p, 10));
    const ymd = parts[0].length === 4 && nums[0] >= 1900 && nums[0] <= 2100 &&
      nums[1] >= 1 && nums[1] <= 12 && nums[2] >= 1 && nums[2] <= 31;
    const dmy = parts[2].length === 4 && nums[2] >= 1900 && nums[2] <= 2100 &&
      nums[0] >= 1 && nums[0] <= 31 && nums[1] >= 1 && nums[1] <= 12;
    return ymd || dmy;
  }

  /**
   * Travel context around a code. A flight number is the same shape as an
   * account reference ("QF-2201" / "QF2201") but is not personal data — it's
   * public timetable information, no more identifying than the phone number
   * of the ATO, which this detector already leaves alone. Masking it corrupts
   * a perfectly ordinary travel question.
   *
   * The window is wider than the usual context check because the giveaway word
   * is often at the start of the sentence ("I'm flying out on QF-2201 next
   * Tuesday" — 20+ chars before the code).
   */
  const FLIGHT_WORDS = [
    "flight", "flights", "flying", "fly", "flew", "depart", "departs",
    "departing", "departure", "arrive", "arrives", "arriving", "arrival",
    "boarding", "board", "gate", "terminal", "airline", "airport", "layover",
    "stopover", "connecting", "aircraft", "airfare", "check-in", "qantas",
    "jetstar", "virgin",
  ];
  function isFlightContext(text, start, end) {
    // Bounded to the value's OWN sentence, following the same rule
    // retypeLabelledNumbers uses for labels. Without this the 45-char window
    // reaches into the neighbouring sentence and one travel mention
    // suppresses unrelated references around it: in "...order reference
    // HAQ-8760. I'm flying QF-2201 on Tuesday..." the word "flying" is 12
    // chars past HAQ-8760, so a plain proximity check silently stopped a
    // genuine order reference from being masked.
    let a = Math.max(0, start - 45);
    const before = text.slice(a, start);
    const bBreak = lastIndexOfAny(before, ".;!?\n");
    if (bBreak !== -1) a += bBreak + 1;

    let b = Math.min(text.length, end + 45);
    const after = text.slice(end, b);
    const aBreak = firstIndexOfAny(after, ".;!?\n");
    if (aBreak !== -1) b = end + aBreak;

    const ctx = text.slice(a, b).toLowerCase();
    return FLIGHT_WORDS.some((word) => hasWord(ctx, word));
  }
  function lastIndexOfAny(s, chars) {
    for (let i = s.length - 1; i >= 0; i--) if (chars.includes(s[i])) return i;
    return -1;
  }
  function firstIndexOfAny(s, chars) {
    for (let i = 0; i < s.length; i++) if (chars.includes(s[i])) return i;
    return -1;
  }

  /**
   * Free-form account / reference codes: 2-4 letters, a dash, 4-6 digits
   * ("BW-44192", "ACC-2291", "INV-8823").
   *
   * Every other account detector here keys off a KNOWN numeric format (BSB
   * 3-3, Medicare 4-5-1, TFN 3-3-3, plain 6-10 digit account runs), so a
   * customer/invoice/contract reference in the extremely common
   * LETTERS-DIGITS shape matched nothing at all and went out in the clear —
   * even sitting directly after the word "Account:".
   *
   * Flagged WITHOUT requiring a nearby keyword, unlike the digits-only
   * account detector above. A bare run of digits needs banking context to be
   * distinguishable from any other number, but this shape is already specific
   * enough on its own, and in practice these codes appear in bare lists
   * ("Account: BW-44192") where the label may be a table header rows away.
   *
   * Bounded deliberately: `\b` at both ends means "ABCDE-1234" (5 letters) and
   * "BW-4419256" (7 digits) do NOT match, so this only ever claims the exact
   * shape it advertises rather than creeping across longer tokens.
   */
  function detectRefCode(text, out) {
    // Also matches the unspaced form ("QF2201"), so the flight-context check
    // below can exclude it — otherwise only the dashed variant was considered
    // at all. The unspaced form additionally requires an explicit reference
    // context word, because 2-4 letters followed by digits with no separator
    // is a very common shape for ordinary tokens.
    const re = /\b([A-Za-z]{2,4})(-)?(\d{4,6})\b/g;
    let m;
    while ((m = re.exec(text))) {
      const value = m[0];
      const dashed = !!m[2];
      // A flight number is the same shape as a customer reference but is
      // public timetable data, not personal data. See isFlightContext.
      if (isFlightContext(text, m.index, re.lastIndex)) continue;
      if (!dashed && !near(text, m.index, re.lastIndex, REF_CONTEXT, 25)) continue;
      out.push(finding("REF_CODE", "Account / reference number", value, m.index, "high"));
    }
  }

  function detectMoney(text, out) {
    // Broad digits+commas match so malformed groupings ("$14,2100") are
    // consumed WHOLE — a partial match here leaves real digits behind after
    // masking. Which matches get flagged is decided below, not by the regex.
    const re = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
    const ctx = [
      "salary", "revenue", "profit", "invoice", "payment", "income", "wage",
      "turnover", "earn", "paid", "bonus", "valuation", "fee",
      // account/ledger context so client "Balance $X" amounts are masked.
      "balance", "account", "owing", "outstanding", "savings", "deposit",
      "withdrawal", "owed", "due", "credit", "debit", "loan", "mortgage",
    ];
    let m;
    while ((m = re.exec(text))) {
      const val = parseFloat(m[0].replace(/[^0-9.]/g, ""));
      // Prose: over $1,000 with a money keyword nearby. Tables: any amount in
      // a record row when the keyword (e.g. "Balance") is in the header.
      const flag =
        (val > 1000 && near(text, m.index, re.lastIndex, ctx, 40)) ||
        (val > 0 && rowCtx(text, m.index, ctx));
      if (flag) {
        out.push(finding("MONEY", "Financial amount", m[0].trim(), m.index, "medium"));
      }
    }
    // Verbal/abbreviated multipliers: $2.4 million, $1.2 billion, $2.3M, $900B.
    // These are inherently large, significant figures — no context needed.
    const reVerbal = /\$\s?\d+(?:\.\d+)?\s*(?:million|billion|trillion|[mb](?![a-z0-9]))/gi;
    while ((m = reVerbal.exec(text))) {
      out.push(finding("MONEY", "Financial amount", m[0].trim(), m.index, "medium"));
    }
    // $120k-style figures (salary, budget) — like million/billion, the "k"
    // multiplier on a dollar amount is inherently financial; no context needed.
    const reK = /\$\s?\d+(?:\.\d+)?k(?![A-Za-z0-9])/gi;
    while ((m = reK.exec(text))) {
      out.push(finding("MONEY", "Financial amount", m[0].trim(), m.index, "medium"));
    }
  }

  // ---- Personal identity --------------------------------------------------
  function detectMedicare(text, out) {
    // AU Medicare: 10 digits as 4-5-1, optionally an 11th issue/IRN digit (4-5-1-1).
    // First digit is 2-6. We flag when EITHER the official check digit validates
    // (high-confidence, no context needed) OR the format matches near a
    // "medicare" keyword — many real-world / test numbers won't satisfy the
    // checksum, and for a privacy tool it's far safer to mask a labelled
    // Medicare number than to leak it.
    // First digit is officially 2-6; we accept 1-9 so a clearly-LABELLED Medicare
    // number that uses an out-of-range first digit (common in test/placeholder
    // data, e.g. "Medicare 1123 45678 2") is still masked. Without a "medicare"
    // keyword nearby, the checksum gate still applies, so this doesn't add noise.
    const re = /\b([1-9]\d{3})[\s-]?(\d{5})[\s-]?(\d)(?:[\s/-]?(\d))?\b/g;
    let m;
    while ((m = re.exec(text))) {
      const digits = (m[1] + m[2] + m[3]).replace(/\D/g, "");
      const hasCtx =
        near(text, m.index, m.index + m[0].length, ["medicare"], 25) ||
        rowCtx(text, m.index, ["medicare"]);
      if (medicareValid(digits) || hasCtx) {
        out.push(finding("MEDICARE", "Medicare number", m[0].trim(), m.index, "high"));
      }
    }
  }

  function detectTFN(text, out) {
    const re = /\b(\d{3})[\s-]?(\d{3})[\s-]?(\d{2,3})\b/g;
    let m;
    while ((m = re.exec(text))) {
      const digits = (m[1] + m[2] + m[3]).replace(/\D/g, "");
      if (digits.length !== 8 && digits.length !== 9) continue;
      const hasCtx =
        near(text, m.index, re.lastIndex, ["tfn", "tax file"], 20) ||
        rowCtx(text, m.index, ["tfn", "tax file"]);
      const hasSep = /[\s-]/.test(m[0]);
      // High-confidence: valid checksum with a separator OR an explicit keyword.
      // Context fallback: a "tfn"/"tax file" label means flag by format even when
      // the checksum fails (test/placeholder TFNs frequently won't validate, and
      // a labelled TFN must never leak).
      if ((tfnValid(digits) && (hasCtx || hasSep)) || hasCtx) {
        out.push(finding("TFN", "Tax File Number", m[0].trim(), m.index, "high"));
      }
    }
  }

  function detectPassport(text, out) {
    // AU passports: 1-2 letters + 7-8 digits. The bare shape also matches
    // order/tracking references ("UT2024881", "AU12345678"), so require the
    // word "passport" nearby (or in a table header) before flagging.
    const re = /\b([A-Z]{1,2}\d{7,8})\b/g;
    let m;
    while ((m = re.exec(text))) {
      if (
        near(text, m.index, m.index + m[0].length, ["passport"], 40) ||
        rowCtx(text, m.index, ["passport"])
      ) {
        out.push(finding("PASSPORT", "Passport number", m[1], m.index, "high"));
      }
    }
  }

  function detectLicence(text, out) {
    // (a) Keyword-anchored: "Driver Licence <id>". The id may be a state-letter
    //     prefix + digits (e.g. NSW45612378 = 3 letters + 8 digits = 11 chars),
    //     so the old {6,9} cap was too short and missed it. Allow up to 12.
    const reKw =
      /\b(?:driver'?s?\s*licen[cs]e|licen[cs]e\s*(?:no\.?|number|#)?|dl)\s*[:#]?\s*([A-Z]{0,3}\s?\d{5,9}|[A-Z0-9]{6,12})\b/gi;
    let m;
    while ((m = reKw.exec(text))) {
      out.push(finding("LICENCE", "Driver licence number", m[1].trim(), m.index + m[0].indexOf(m[1]), "high"));
    }
    // (b) Keyword-free: an AU state code immediately followed by 6-9 digits is a
    //     licence pattern even without the word "licence" (postcodes are only 4
    //     digits, so "NSW 2095" can't false-match). Catches a licence that sits in
    //     a table cell with the label only in the header row.
    const reState = /\b((?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s?\d{6,9})\b/g;
    while ((m = reState.exec(text))) {
      out.push(finding("LICENCE", "Driver licence number", m[1].trim(), m.index, "high"));
    }
  }

  function detectDOB(text, out) {
    const months =
      "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
    const written = new RegExp(
      `\\b(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+(?:${months})\\.?\\s+(?:19|20)\\d\\d\\b`,
      "gi"
    );
    const numeric = /\b(0?[1-9]|[12]\d|3[01])[\/.-](0?[1-9]|1[0-2])[\/.-](?:19|20)\d\d\b/g;
    const iso = /\b(?:19|20)\d\d-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])\b/g;
    const ctx = ["born", "dob", "d.o.b", "date of birth", "birthday", "birthdate", "b-day", "birth"];
    for (const re of [written, numeric, iso]) {
      let m;
      while ((m = re.exec(text))) {
        // Prose: keyword within 25 chars. Tables: keyword in the header row
        // ("Date Of Birth" column) with the date sitting in a record row.
        if (
          near(text, m.index, m.index + m[0].length, ctx, 25) ||
          rowCtx(text, m.index, ctx)
        ) {
          out.push(finding("DOB", "Date of birth", m[0].trim(), m.index, "medium"));
        }
      }
    }
  }

  // ---- Business -----------------------------------------------------------
  function detectABN(text, out) {
    const re = /\b(\d{2})\s?(\d{3})\s?(\d{3})\s?(\d{3})\b/g;
    let m;
    while ((m = re.exec(text))) {
      const digits = m[1] + m[2] + m[3] + m[4];
      const hasCtx = near(text, m.index, re.lastIndex, ["abn"], 15);
      if (abnValid(digits) || hasCtx) {
        out.push(finding("ABN", "Australian Business Number", m[0].trim(), m.index, "medium"));
      }
    }
  }

  function detectACN(text, out) {
    const re = /\b(\d{3})\s?(\d{3})\s?(\d{3})\b/g;
    let m;
    while ((m = re.exec(text))) {
      if (near(text, m.index, re.lastIndex, ["acn", "company number"], 15)) {
        out.push(finding("ACN", "Australian Company Number", m[0].trim(), m.index, "medium"));
      }
    }
  }

  /* ---- Organisation / company names --------------------------------------
   * A client's, employer's or supplier's company name is an identifier in
   * exactly the way a person's name is — "Bellweather Logistics owes us
   * $40,000" identifies a real business relationship even with every personal
   * name removed. Detected in two tiers because the confidence genuinely
   * differs:
   *
   *   1. LEGAL designator ("... Pty Ltd", "... Inc", "... LLC"). Naming a
   *      registered entity is unambiguous, so these are flagged regardless of
   *      how well known the company is.
   *   2. INDUSTRY descriptor ("... Logistics", "... Group", "... Holdings").
   *      Weaker — plenty of ordinary phrases fit "Capitalised Word +
   *      descriptor" — so this tier additionally rejects generic lead-ins
   *      ("Customer Services", "Financial Solutions") and a short list of
   *      global brands that are almost always the SUBJECT of a question
   *      rather than someone's confidential business contact.
   */
  const ORG_LEGAL = [
    // Longest-first: alternation is ordered, so "Pty Ltd" must be tried
    // before a bare "Pty" or the match would stop short of "Ltd".
    "Pty\\.?\\s+Ltd\\.?", "Pty\\.?\\s+Limited", "Pty\\.?",
    "Ltd\\.?", "Limited", "Incorporated", "Inc\\.?",
    "L\\.L\\.C\\.?", "LLC", "LLP", "PLC", "P/L",
    "Corporation", "Corp\\.?", "GmbH", "S\\.A\\.", "N\\.V\\.", "B\\.V\\.",
  ].join("|");

  const ORG_DESCRIPTOR = [
    "Group", "Holdings", "Partners", "Partnership", "Enterprises", "Industries",
    "Solutions", "Services", "Systems", "Technologies", "Consulting",
    "Consultancy", "Consultants", "Logistics", "Trading", "Ventures",
    "Associates", "Agency", "Studios", "Studio", "Laboratories", "Labs",
    "Foundation", "Institute", "Company", "Contractors", "Constructions",
    "Developments", "Investments", "Removals", "Freight", "Transport",
    "Supplies", "Distribution", "Manufacturing", "Engineering", "Motors",
  ].join("|");

  /**
   * Words that must never START an organisation name. Two kinds: sentence
   * lead-ins ("The", "Our", "Please") that would drag surrounding prose into
   * the match, and generic qualifiers ("Financial Services", "Customer
   * Solutions", "Emergency Services") that describe a category rather than
   * name a specific business. COMMON_WORDS is checked alongside this, which
   * already covers the form-label and finance vocabulary.
   */
  const ORG_LEAD_STOPWORDS = new Set([
    "the", "this", "that", "these", "those", "our", "your", "my", "their",
    "his", "her", "its", "a", "an", "and", "but", "or", "for", "from", "with",
    "without", "about", "into", "over", "under", "after", "before", "all",
    "some", "any", "each", "every", "other", "another", "such", "more", "most",
    "best", "good", "great", "key", "main", "top", "first", "last", "next",
    "same", "please", "thanks", "thank", "dear", "hi", "hello", "regards",
    "kind", "sincerely", "we", "they", "you", "it", "he", "she", "i", "many",
    "few", "several", "various", "multiple", "both", "either", "neither",
    // sentence adverbs/connectives — these start a clause, so without them
    // "Also Smith & Sons Pty Ltd" captures the "Also" as part of the company
    "also", "however", "therefore", "meanwhile", "additionally", "furthermore",
    "moreover", "plus", "then", "so", "now", "today", "tomorrow", "yesterday",
    "finally", "lastly", "overall", "basically", "actually", "currently",
    "previously", "recently", "unfortunately", "hopefully", "regarding",
    "attention", "attn", "re", "cc", "bcc", "subject", "from", "sent",
    // generic qualifiers — category descriptions, not company names
    "professional", "financial", "emergency", "cloud", "web", "digital",
    "global", "international", "local", "general", "public", "private",
    "community", "social", "medical", "legal", "technical", "creative",
    "corporate", "enterprise", "managed", "integrated", "advanced", "premium",
    "quality", "support", "human", "information", "real", "estate", "aged",
    "child", "care", "cyber", "security", "online", "mobile", "smart",
  ]);

  /**
   * Global brands that overwhelmingly appear as the SUBJECT of a question
   * ("how do I use Amazon Web Services") rather than as someone's
   * confidential client or employer. Consulted ONLY for the weaker descriptor
   * tier — a legal designator names a specific registered entity and is
   * masked regardless. Deliberately short and tech-weighted; this is a
   * false-positive damper, NOT an exhaustive list of public companies, and it
   * is not relied on for any security property.
   */
  const ORG_PUBLIC_BRANDS = new Set([
    "google", "microsoft", "amazon", "apple", "meta", "facebook", "openai",
    "anthropic", "adobe", "atlassian", "slack", "zoom", "notion", "github",
    "gitlab", "oracle", "salesforce", "ibm", "intel", "nvidia", "samsung",
    "sony", "netflix", "spotify", "dropbox", "shopify", "stripe", "paypal",
    "cisco", "dell", "lenovo", "canva", "figma", "linkedin", "youtube",
  ]);

  function detectOrg(text, out) {
    // A name token: capitalised, or a bare "&" acting as a connector
    // ("Smith & Sons Pty Ltd").
    const TOK = "(?:[A-Z][A-Za-z0-9'\u2019\\-]*|&)";
    const LEAD = "((?:" + TOK + "\\s+){0,3}[A-Z][A-Za-z0-9'\u2019\\-]*)";

    const push = (m, tier) => {
      const words = m[1].trim().split(/\s+/);
      // TRIM disqualified leading words rather than dropping the whole match.
      // "Client Bellweather Logistics" and "Also Smith & Sons Pty Ltd" both
      // name a real company — the stopword just isn't part of the name.
      // Rejecting outright lost the company entirely AND let detectNames
      // claim the leftover pair ("Also Smith") as a person instead, which is
      // strictly worse than either masking or ignoring it.
      let dropped = 0;
      while (words.length) {
        const w = words[0].toLowerCase().replace(/[^a-z0-9]/g, "");
        if (w && !ORG_LEAD_STOPWORDS.has(w) && !COMMON_WORDS.has(w)) break;
        words.shift();
        dropped++;
      }
      if (!words.length) return false; // nothing left but stopwords
      const first = words[0].toLowerCase();
      if (tier === "descriptor" && ORG_PUBLIC_BRANDS.has(first)) return false;

      let offset = 0;
      if (dropped) {
        const skip = new RegExp("^(?:\\S+\\s+){" + dropped + "}").exec(m[0]);
        offset = skip ? skip[0].length : 0;
      }
      let value = m[0].slice(offset).trim();
      // Drop a trailing sentence period. "Ltd\.?" can't tell an abbreviation
      // dot from the end of the sentence, and swallowing the latter would
      // make the stored value "Acme Pty Ltd." — which then fails to restore
      // when the AI writes the company back without the period. Genuine
      // dotted initialisms ("L.L.C.", "S.A.") are left intact.
      if (value.endsWith(".") && !/(?:\b[A-Za-z]\.){2,}$/.test(value)) {
        value = value.slice(0, -1).trim();
      }
      if (!value) return false;
      out.push(finding("ORG", "Company / organisation name", value, m.index + offset, "medium"));
      return true;
    };

    const legal = new RegExp("\\b" + LEAD + "\\s+(?:" + ORG_LEGAL + ")(?![A-Za-z])", "g");
    let m;
    while ((m = legal.exec(text))) push(m, "legal");

    const desc = new RegExp("\\b" + LEAD + "\\s+(?:" + ORG_DESCRIPTOR + ")(?![A-Za-z])", "g");
    while ((m = desc.exec(text))) push(m, "descriptor");
  }

  function detectBusiness(text, out) {
    // Trailing context stops at "$" or a digit so this warning-only span never
    // swallows an adjacent structured value (e.g. "revenue was $1" eating into
    // a MONEY finding for "$1.85 million" — the two would then overlap and
    // resolveOverlaps would have to arbitrate instead of both simply existing).
    const re =
      /\b(?:annual\s+)?(?:revenue|turnover|arr|mrr|profit|ebitda|valuation|gross margin|net income|client list|customer list)\b[^.\n$0-9]{0,40}/gi;
    let m;
    while ((m = re.exec(text))) {
      out.push(
        finding("BUSINESS_CONFIDENTIAL", "Confidential business data", m[0].trim(), m.index, "medium")
      );
    }
  }

  function detectConfidential(text, out) {
    const re =
      /\b(confidential|do not (?:share|forward|distribute)|internal use only|internal only|private and confidential|non-disclosure|nda|proprietary|classified|not for distribution)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      out.push(finding("CONFIDENTIAL", "Confidential / restricted", m[0], m.index, "medium"));
    }
  }

  // ---- Health & sensitive personal ---------------------------------------
  function detectHealth(text, out) {
    const re =
      /\b(medicare(?:\s*(?:card|number))?|diagnos(?:ed|is)|prescrib(?:ed|tion)|prescription|medication|dosage|\d+\s?mg\b|symptoms?|cancer|diabet(?:es|ic)|depression|anxiety|bipolar|schizophreni\w*|hiv|aids|pregnan\w*|chemotherapy|therapy|psychiatr\w*|mental health|blood test|medical (?:record|history|condition))\b/gi;
    let m;
    while ((m = re.exec(text))) {
      out.push(finding("HEALTH", "Health / medical information", m[0], m.index, "medium"));
    }
  }

  function detectLegal(text, out) {
    const re =
      /\b(lawsuit|litigation|court (?:case|order|reference)|case\s*(?:no\.?|number)\s*[:#]?\s*[A-Z0-9][A-Z0-9\/-]{2,}|settlement agreement|legal proceedings|subpoena|plaintiff|defendant)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      out.push(finding("LEGAL", "Legal / court information", m[0].trim(), m.index, "medium"));
    }
  }

  function detectImmigration(text, out) {
    const re =
      /\b(visa\s*subclass\s*\d{3}|subclass\s*\d{3}|visa(?:\s*(?:application|status|number))?|immigration|permanent residency|work permit|bridging visa|citizenship application|sponsorship|green card)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      out.push(finding("IMMIGRATION", "Immigration / visa details", m[0].trim(), m.index, "medium"));
    }
  }

  // ---- Passwords & credentials -------------------------------------------
  /**
   * Trim sentence punctuation from a captured secret WITHOUT eating characters
   * that are plausibly part of it.
   *
   * "!" and "?" are stripped by a naive `[.,;:!?]+$` trim, and both are among
   * the most common password symbols — "the password is Tr0ub4dor!" was being
   * captured as "Tr0ub4dor", leaving the final character of a real password
   * sitting in the message. Worse, the trim also removed the only symbol from
   * "Summer2026!", which then failed the strong-token test and was not flagged
   * at all.
   *
   * So only ".,;:" count as sentence punctuation here. Over-masking one
   * character of punctuation is harmless; under-masking one character of a
   * real password is not.
   */
  function trimSecret(s) {
    return s.replace(/[.,;:]+$/, "");
  }

  /**
   * Words that follow a credential trigger in ordinary prose rather than being
   * the credential itself: "username is required", "login is broken", "I
   * forgot my password again". Without this guard, phrasing-driven detection
   * flags the complaint instead of a secret.
   */
  const CRED_STOPWORDS = new Set([
    "required", "invalid", "incorrect", "wrong", "missing", "empty", "blank",
    "unknown", "unable", "broken", "disabled", "locked", "expired", "expiring",
    "correct", "fine", "ok", "okay", "working", "valid", "case-sensitive",
    "the", "a", "an", "my", "your", "his", "her", "their", "our", "its",
    "it", "that", "this", "there", "not", "no", "yes", "still", "now", "also",
    "just", "same", "different", "above", "below", "attached", "saved",
    "stored", "changed", "change", "reset", "resetting", "forgotten", "forgot",
    "safe", "secure", "strong", "weak", "long", "short", "hidden", "visible",
    "needed", "manager", "managers", "management", "policy", "policies",
    "rule", "rules", "requirement", "requirements", "protection", "security",
    "field", "box", "prompt", "hint", "again", "please", "what", "why", "how",
    "when", "where", "who", "which", "something", "anything", "nothing",
    "everything", "someone", "anyone", "set", "setup", "used", "using",
    "shared", "sent", "here", "gone", "down", "up", "off", "on",
    // Function words. Without these the no-separator forms capture the
    // preposition itself — "The login for the billing portal is acme_admin"
    // matched "login" + "for" and masked the word "for", rewriting the
    // sentence into nonsense.
    "for", "to", "in", "at", "by", "with", "and", "or", "but", "from",
    "into", "onto", "about", "over", "under", "after", "before", "than",
    "was", "were", "will", "would", "can", "could", "should", "may", "might",
    "must", "has", "have", "had", "does", "did", "been", "being", "get",
    // Nouns that commonly follow a credential word in prose rather than
    // being the credential.
    "page", "screen", "button", "link", "form", "process", "issue", "issues",
    "problem", "problems", "error", "errors", "attempt", "attempts", "name",
    "info", "information", "area", "portal", "system", "server", "site",
    "app", "detail", "details", "help", "support", "access", "attempt",
    // The trigger words themselves. A credential is never named by another
    // credential label, and in "login is username: rwalsh_admin" the naive
    // capture took "username" as the value — masking the LABEL and leaving
    // the real credential in the clear. See the rewind in scanCredential().
    "username", "usernames", "user", "users", "userid", "userids",
    "login", "logins", "logon", "logons", "signin", "sign-in",
    "handle", "handles", "screenname", "nickname",
    "password", "passwords", "passwd", "pwd", "passcode", "pass",
    "passphrase", "credential", "credentials", "secret", "token", "auth",
    "apikey", "key", "keys", "pin",
    // Predicate adjectives. "the password is important" and "the new password
    // is stronger" are statements ABOUT a password, and flagging them replaces
    // an ordinary English word with a fake credential — the same
    // rewrite-the-user's-sentence failure as the address over-capture. The
    // -ed/-ing/-ly/-s inflection rule in isCredentialValue() already covers
    // forms like "compromised" and "expiring"; these are the ones it can't.
    "important", "stronger", "weaker", "temporary", "permanent", "simple",
    "complex", "unique", "similar", "obvious", "random", "generic",
    "standard", "confidential", "private", "public", "sensitive", "critical",
    "essential", "mandatory", "optional", "ready", "active", "inactive",
    "available", "unavailable", "old", "older", "newer", "better", "worse",
  ]);

  /**
   * Drive a "<trigger> <sep> <value>" credential regex over `text`.
   *
   * The important part is what happens when a captured value is REJECTED: the
   * scan rewinds to the value's own offset instead of continuing past it.
   *
   * Chained labels are the reason. In "client portal login is username:
   * rwalsh_admin" the outer trigger ("login is") captures "username:" as its
   * value. Rejecting that is necessary but not sufficient — the regex had
   * already consumed through "username:", so the inner trigger never got its
   * own turn and the REAL credential went out unmasked. Rejecting a value and
   * moving on silently converts a mislabelling bug into a data leak.
   *
   * Rewinding is safe from infinite looping because the value always starts
   * strictly after the match did, so each pass begins later in the string.
   *
   * @param re     global regex whose group 1 is the value
   * @param accept (value, index) => boolean; false means "not a credential"
   */
  function scanCredential(text, re, accept) {
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 5000) {
      const raw = m[1];
      const value = trimSecret(raw);
      const idx = m.index + m[0].lastIndexOf(raw);
      if (accept(value, idx)) continue;
      // Rejected — give whatever sits at the value position its own chance.
      const resume = Math.max(idx, m.index + 1);
      if (resume < re.lastIndex) re.lastIndex = resume;
    }
  }

  /** True if `v` is plausibly an actual credential rather than prose. */
  function isCredentialValue(v) {
    if (!v || v.length < 3 || v.length > 128) return false;
    if (CRED_STOPWORDS.has(v.toLowerCase())) return false;
    // A bare word ending in common inflections is prose, not a handle.
    if (/^[a-z]+(?:ing|ed|ly|s)$/.test(v) && !/\d/.test(v)) return false;
    return true;
  }

  function detectPassword(text, out) {
    // Context-driven: "password is ...", "api key: ...", etc.
    const re =
      // "login" deliberately NOT in this list: detectUsername owns the bare
      // "login is X" form, where the value is normally the identifier rather
      // than the secret. Nothing is lost by that — a value after "login:" that
      // actually looks like a password (mixed case + digit + symbol) is still
      // claimed here by the strong-token rule below, which outranks USERNAME
      // in overlap resolution. So "login: acme_admin" reads as a username and
      // "login: Tr0ub4dor!" still reads as a password.
      /\b(?:password|passwd|pwd|passcode|pass(?:phrase)?|credentials?|api[\s_-]?key|secret(?:\s*key)?|token|auth)\b\s*(?:is|are|=|:)\s*(\S{4,})/gi;
    scanCredential(text, re, (secret, idx) => {
      if (!isCredentialValue(secret)) return false;
      out.push(finding("PASSWORD", "Password / credential", secret, idx, "high"));
      return true;
    });

    // "the password for the billing portal is X", "the temp password for the
    // VPN is X" — the trigger and the value are separated by the name of the
    // system the credential belongs to. Every other phrasing in this family
    // ("temp password is X", "her password is X", "WiFi password is X",
    // "account password: X") already works without its own pattern, because
    // the rule above keys on the word "password" sitting immediately before
    // the separator, so any number of leading modifiers come for free. This
    // form is the exception: words intervene AFTER the trigger.
    const forRe =
      /\b(?:passwords?|passwd|pwd|passcode|pass(?:phrase)?)\s+(?:for|to|on)\s+[^,.;:!?\n]{1,48}?\s+(?:is|are|=|:)\s*(\S{4,})/gi;
    scanCredential(text, forRe, (secret, idx) => {
      if (!isCredentialValue(secret)) return false;
      out.push(finding("PASSWORD", "Password / credential", secret, idx, "high"));
      return true;
    });

    // Same trigger words with NO separator: "pass Summer2026!", "pwd hunter2".
    // Riskier than the separated form (any noun can follow "password" in
    // prose), so the value must additionally LOOK like a secret — a digit, a
    // symbol, or mixed case. That is what keeps "password managers work" and
    // "forgot my password again" from matching, since "managers" and "again"
    // are plain lowercase words.
    const noSep =
      /\b(?:password|passwd|pwd|passcode|pass(?:phrase)?)\b\s+(\S{4,})/gi;
    scanCredential(text, noSep, (secret, idx) => {
      if (!isCredentialValue(secret)) return false;
      const looksSecret =
        /\d/.test(secret) || /[^A-Za-z0-9]/.test(secret) ||
        (/[a-z]/.test(secret) && /[A-Z]/.test(secret));
      if (!looksSecret) return false;
      out.push(finding("PASSWORD", "Password / credential", secret, idx, "high"));
      return true;
    });

    // Connection strings with embedded credentials: scheme://user:pass@host/...
    // The whole URL is the secret — flag it all so nothing identifying remains.
    const connRe = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@[^\s]+/gi;
    while ((m = connRe.exec(text))) {
      const secret = trimSecret(m[0]);
      out.push(finding("PASSWORD", "Connection string with credentials", secret, m.index, "high"));
    }

    // Wallet seed / recovery phrases: a labelled run of 4+ lowercase words.
    const seedRe =
      /\b(?:seed|recovery|mnemonic|backup)\s+(?:phrase|words?)\s*(?:is|=|:)?\s*((?:[a-z]+ ){3,23}[a-z]+)/gi;
    while ((m = seedRe.exec(text))) {
      const idx = m.index + m[0].indexOf(m[1]);
      out.push(finding("PASSWORD", "Wallet seed phrase", m[1].trim(), idx, "high"));
    }

    // Standalone strong-password-looking tokens (mixed case + digit + symbol).
    const tokRe = /(?:^|\s)(\S{8,64})/g;
    let t;
    while ((t = tokRe.exec(text))) {
      const tok = trimSecret(t[1]);
      if (/^https?:\/\//i.test(tok) || tok.includes("@") || tok.includes("/")) continue;
      if (
        /[a-z]/.test(tok) &&
        /[A-Z]/.test(tok) &&
        /\d/.test(tok) &&
        /[^A-Za-z0-9]/.test(tok)
      ) {
        const idx = t.index + t[0].indexOf(tok);
        out.push(finding("PASSWORD", "Possible password", tok, idx, "high"));
      }
    }
  }

  /**
   * Usernames / login identifiers.
   *
   * Like passwords, these have no format of their own — "jsmith92", "admin"
   * and "a.person" are all ordinary tokens — so detection is entirely
   * phrasing-driven, and the value is whatever follows the trigger up to the
   * next whitespace or punctuation. Capturing to the next SPACE (rather than
   * to the sentence break) is deliberate: in "the username is jsmith92 and the
   * password is ..." the credential is one token, and taking everything to the
   * full stop would swallow the rest of the clause — the over-capture failure
   * mode that deletes words from the user's message when masked.
   */
  function detectUsername(text, out) {
    const push = (value, idx) => {
      if (!isCredentialValue(value)) return false;
      out.push(finding("USERNAME", "Username / login", value, idx, "high"));
      return true;
    };

    // "username is X", "username: X", "user id = X", "login: X", "handle: X".
    const sep =
      /\b(?:user\s?names?|user\s?ids?|screen\s?names?|account\s?names?|logins?|logons?|sign[\s-]?in|handles?|user)\b\s*(?:is|are|=|:)\s*(\S{3,})/gi;
    scanCredential(text, sep, push);

    // "the login for the billing portal is acme_admin" — the trigger and the
    // value are separated by the name of the site or system.
    const forRe =
      /\b(?:login|logon|username|user\s?name|account|credentials?)\s+(?:for|to|on)\s+[^,.;:!?\n]{1,48}?\s+(?:is|are|=|:)\s*(\S{3,})/gi;
    scanCredential(text, forRe, push);

    // "user admin", "username jsmith92" — no separator at all. Much weaker
    // evidence on its own (any noun can follow the word "user"), so this form
    // is only accepted when the message is independently about credentials.
    // That co-signal is what distinguishes "Login details: user admin, pass
    // ..." from "the user account was suspended".
    const noSep = /\b(?:user\s?names?|logins?|user)\b\s+(\S{3,})/gi;
    scanCredential(text, noSep, (value, idx) => {
      if (!nearWord(text, idx - 20, idx + value.length,
        ["login", "logins", "login details", "credentials", "credential",
         "password", "passwords", "pass", "pwd", "passcode", "sign in",
         "signin", "log in"], 60)) return false;
      return push(value, idx);
    });
  }

  // ---- Names (only with another identifier) ------------------------------
  /**
   * One capitalised name token.
   *
   * Two deliberate properties, each fixing a real miss in the ASCII-only
   * `[A-Z][a-z]+` this replaces:
   *
   *  - UNICODE. `[a-z]` cannot match the accented and diacritic characters in
   *    José, Zoë, Björn, Siobhán, Renée or Nguyễn, so every one of those was
   *    missed even with a phone number beside it. Since the point of name
   *    detection is protecting people's identities, a matcher that only works
   *    on unaccented English names protects an arbitrary subset of them.
   *
   *  - INTERNAL HYPHENS AND APOSTROPHES. "Mary-Anne Douglas" matched only
   *    "Anne Douglas" (the hyphen creates a word boundary), so masking left
   *    "Mary-" behind attached to a fake name — half a leak, half a corrupted
   *    sentence. O'Brien, D'Angelo and Mary-Anne are all single tokens here.
   *
   * The lowercase run is `*` rather than `+` so "O'Brien" parses; tokens of
   * fewer than two letters are rejected in the caller instead, which keeps
   * this pattern simple and avoids matching stray initials.
   *
   * Not ReDoS-prone: the repeating group must start with a separator that the
   * letter class cannot match, so there is exactly one way to parse any input.
   */
  const NAME_TOKEN =
    "(?:al|el|ad|abu|ibn|bin)?-?\\p{Lu}[\\p{Ll}\\p{M}]*(?:['’\\-]\\p{Lu}?[\\p{Ll}\\p{M}]+)*";
  /**
   * Lowercase particles that sit INSIDE a name rather than ending it: "Johan
   * van der Berg", "María de la Cruz", "Abd al-Rahman Hassan". They are not
   * capitalised, so a run of capitalised tokens stops dead at them and the
   * name is truncated — the same half-leak as the two-token limit. Kept as a
   * fixed, short list: these are specific words, so matching them cannot
   * generalise into ordinary prose.
   */
  const NAME_PARTICLES = new Set([
    "van", "von", "de", "del", "della", "di", "da", "dos", "das", "du",
    "la", "le", "den", "der", "ter", "ten", "bin", "binti", "binte", "ibn",
    "al", "el", "af", "av", "y", "i", "op", "aan",
  ]);
  // JS `\b` is ASCII-only, so it fires in the middle of "José". These do the
  // job properly: the character either side must not be part of a name token.
  const NAME_PARTICLE_RE = "(?:van|von|de|del|della|di|da|dos|das|du|la|le|den|der|ter|ten|bin|binti|binte|ibn|al|el|af|av|y|i|op|aan)";
  const NAME_BOUNDARY_BEFORE = "(?<![\\p{L}\\p{M}'’-])";
  const NAME_BOUNDARY_AFTER = "(?![\\p{L}\\p{M}'’-])";
  /** Letters only, so "O'Brien" counts 6 and a stray "J" counts 1. */
  function letterCount(s) {
    return (s.match(/\p{L}/gu) || []).length;
  }

  // Identifier / category keywords that must never be read as a name. If either
  // word of a candidate "First Last" pair is one of these (e.g. "Her Medicare",
  // "My TFN", "His Licence"), it's a reference to an identifier, not a person.
  const NAME_CONTEXT_WORDS = new Set([
    "medicare", "tfn", "abn", "acn", "bsb", "licence", "license", "passport",
    "visa", "ssn", "pension", "centrelink", "ndis", "ihi", "ahpra",
    "number", "card", "id", "identifier",
    // Corporate suffixes — prevent "Acme Corp" / "Pacific Ltd" matching as a person name.
    "corp", "corporation", "inc", "incorporated", "ltd", "limited", "pty",
    "plc", "llc", "llp", "lp", "group", "holdings", "partners", "associates",
    "solutions", "services", "industries", "technologies", "enterprises",
    "consulting", "management", "financial", "capital", "ventures", "global",
  ]);
  // Explicit self-introduction phrases that make a capitalised word pair a clear
  // name even when no other identifier is present in the message.
  const NAME_INTRO_PHRASES = [
    "my name is", "name is", "i am", "i'm", "im ", "call me", "i'm called",
    "my name's", "this is", "i go by",
  ];
  // Common capitalised English / business / form-label words that look like a
  // "First Last" pair but are NOT a person's name. A candidate pair is rejected
  // if EITHER word appears here, so structural text like "Account Balance",
  // "Date Of", "Phone Number", "Credit Card", "Home Address" is never masked as
  // a name. Real names (e.g. "James Whitfield") have neither word listed.
  const COMMON_WORDS = new Set([
    // form labels / record headers
    "account", "balance", "phone", "mobile", "email", "address", "date", "birth",
    "number", "client", "customer", "patient", "name", "first", "last", "middle",
    "full", "contact", "details", "detail", "record", "records", "reference",
    "file", "profile", "entry", "row", "column", "field", "label", "header",
    // finance
    "credit", "debit", "card", "bank", "branch", "savings", "cheque", "checking",
    "total", "amount", "due", "paid", "payment", "invoice", "salary", "income",
    "balance", "transfer", "deposit", "withdrawal", "fee", "charge", "statement",
    // address parts
    "home", "work", "street", "road", "suburb", "city", "state", "postcode",
    "post", "code", "country", "unit", "level", "floor", "building",
    // id categories (mirrors NAME_CONTEXT_WORDS but kept here for clarity)
    "driver", "tax", "passport", "policy", "membership", "subscription",
    // time / misc structural
    "monthly", "annual", "yearly", "weekly", "daily", "quarterly", "current",
    "previous", "next", "new", "old", "primary", "secondary", "main", "other",
    "status", "active", "inactive", "pending", "type", "category", "group",
    "notes", "note", "comment", "comments", "summary", "description", "subject",
    "title", "company", "business", "organisation", "organization", "department",
    // meeting / project jargon — "Action Items", "Next Steps", "Meeting Agenda"
    "action", "items", "item", "steps", "step", "agenda", "minutes", "overview",
    "objectives", "objective", "goals", "goal", "tasks", "task", "deadline",
    "deadlines", "priorities", "priority", "milestone", "milestones", "update",
    "updates", "attendees", "recap",
    // common geographic / venue second-words — "Sydney Harbour", "Blue
    // Mountains", "Central Park" are places, not people, even though they fit
    // the capitalised-two-word shape a name would.
    "harbour", "harbor", "mountain", "mountains", "beach", "river", "valley",
    "island", "islands", "bay", "falls", "gardens", "zoo", "museum", "bridge",
    "airport", "stadium", "tower", "palace", "cathedral", "square", "lake",
    "forest", "desert", "coast", "peninsula", "reef", "canyon", "glacier",
    "volcano", "harbourside", "national", "reserve",
    // holiday / seasonal greetings — "Merry Christmas", "Happy Easter"
    "merry", "christmas", "happy", "easter", "thanksgiving", "halloween",
    "ramadan", "diwali", "hanukkah", "festive",
    // organisation designators/descriptors — "Bellweather Logistics" and
    // "Acme Pty Ltd" fit the capitalised-two-word shape a person's name has,
    // so without these detectNames would claim them as people and then fight
    // detectOrg over the same span in resolveOverlaps (identical span, both
    // maskable, so the winner would come down to sort order). Excluding them
    // here means only detectOrg ever matches an organisation.
    "pty", "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc",
    "corp", "corporation", "gmbh", "holdings", "partners", "partnership",
    "enterprises", "industries", "solutions", "services", "systems",
    "technologies", "consulting", "consultancy", "consultants", "logistics",
    "trading", "ventures", "associates", "agency", "studio", "studios",
    "laboratories", "labs", "foundation", "institute", "contractors",
    "constructions", "developments", "investments", "removals", "freight",
    "transport", "supplies", "distribution", "manufacturing", "engineering",
    "motors",
  ]);

  function detectNames(text, out, hasIdentifier) {
    // Also detect when the user explicitly introduces themselves, even in a short
    // message with no other identifier (e.g. "my name is John Smith").
    const lc = text.toLowerCase();
    // Word-bounded, not substring. `NAME_INTRO_PHRASES` contains bare "im ",
    // and a plain includes() matched it INSIDE ordinary words — "Send Aroha
    // Nkemdirim the draft" contains "im ", which unlocked name detection with
    // no identifier anywhere in the message. Any text containing "Kim ",
    // "claim ", "trim " or "swim " did the same.
    const hasNameCtx = NAME_INTRO_PHRASES.some((p) => {
      const esc = p.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("\\b" + esc + "\\b", "i").test(lc);
    });
    if (!hasIdentifier && !hasNameCtx) return;
    // Two to FOUR tokens, not exactly two. A strictly two-token rule truncates
    // every name that isn't First+Last — "Ng Wei Ming" was captured as
    // "Ng Wei", so masking left the real "Ming" sitting in the message next to
    // a fake name. That is the same half-leak as the hyphen bug, and it lands
    // on Chinese, Vietnamese, Spanish double-surname, Arabic and "van der"
    // naming conventions rather than being spread evenly. The run is trimmed
    // from the right below, so a trailing non-name word can't be absorbed.
    const re = new RegExp(
      `${NAME_BOUNDARY_BEFORE}(${NAME_TOKEN}(?:\\s+(?:${NAME_PARTICLE_RE}\\s+){0,2}${NAME_TOKEN}){1,3})${NAME_BOUNDARY_AFTER}`,
      "gu"
    );
    const STOPWORDS = new Set([
      "Hi", "Hello", "Dear", "Thanks", "Thank", "Kind", "Best", "The", "This",
      "That", "My", "Please", "Could", "Would", "Should", "Date", "Tax", "File",
      "Her", "His", "Their", "Our", "Your", "Its",
      // Sentence connectives. A capitalised connective followed by a
      // capitalised word ("Also Smith", "And Riverstone") fits the two-word
      // name shape exactly, and turns the first word of a company name into
      // a fake person.
      "Also", "And", "But", "So", "Then", "However", "Therefore", "Meanwhile",
      "Additionally", "Furthermore", "Moreover", "Plus", "Finally", "Lastly",
      "Regarding", "Attention", "Attn", "Subject", "From", "Sent", "Now",
      "Today", "Tomorrow", "Yesterday", "Unfortunately", "Hopefully",
      // Short message/thread openers. These are the same hazard as the
      // connectives above but were missed because they are only two or three
      // letters: "Re James Whitfield" captured "Re James" as the name, which
      // masked the word "Re" and left the SURNAME in the message.
      "Re", "Ref", "Fwd", "Fw", "Cc", "Bcc", "Reply", "Forwarded",
      "Note", "Notes", "Update", "Reminder", "Urgent", "Important",
      "Confidential", "Draft", "Copy", "Meeting", "Call", "Email",
      // Imperative verbs. Harmless while the rule was strictly two tokens,
      // but a 2-4 token run absorbs them ("Ask Aroha Nkemdirim" became one
      // three-word name), and masking then replaces the verb too. Only verbs
      // that are NOT also common given names are listed — "Mark", "Will",
      // "Grace", "Chase" and "Bill" are deliberately absent.
      "Ask", "Tell", "Send", "Check", "See", "Meet", "Find", "Let", "Get",
      "Give", "Take", "Bring", "Look", "Watch", "Follow", "Add", "Remove",
      "Reply", "Forward", "Book", "Confirm", "Cancel", "Review", "Approve",
      "Sign", "Pay", "Ship", "Deliver", "Notify", "Remind", "Invite",
      "Schedule", "Arrange", "Try", "Use", "Keep", "Make", "Put", "Show",
      "Start", "Stop", "Help", "Ping", "Order", "Set", "Join", "Leave",
    ]);
    /** Could this single token be part of a person's name? */
    const isNameWord = (tok) => {
      // A particle is part of the name, never the end of it.
      if (NAME_PARTICLES.has(tok.toLowerCase()) && tok === tok.toLowerCase()) return true;
      if (STOPWORDS.has(tok)) return false;
      const lc = tok.toLowerCase();
      // Identifier/category keywords ("Medicare", "Licence") and common
      // non-name words (form labels, finance and address parts, and company
      // designators like "Consulting" / "Logistics" / "Group") are never part
      // of a person's name. Checking EVERY token, not just the first two, is
      // what stops the widened run from turning "James Whitfield Consulting"
      // into a three-word person instead of a person beside a company.
      if (NAME_CONTEXT_WORDS.has(lc) || COMMON_WORDS.has(lc)) return false;
      // A bare initial ("J K Rowling") is not enough on its own.
      if (letterCount(tok) < 2) return false;
      return true;
    };

    /** Decide one candidate run. Returns false when it is NOT a name. */
    const accept = (m) => {
      const parts = m[1].split(/\s+/);
      // Trim from the RIGHT while the trailing token isn't name-like, so a
      // greedy run gives back words it shouldn't have taken
      // ("James Whitfield Tomorrow" -> "James Whitfield").
      while (parts.length > 2 && !isNameWord(parts[parts.length - 1])) parts.pop();
      // Never end on a particle ("Johan van" is not a name).
      while (parts.length && NAME_PARTICLES.has(parts[parts.length - 1].toLowerCase()) &&
             parts[parts.length - 1] === parts[parts.length - 1].toLowerCase()) parts.pop();
      if (parts.length < 2 || !parts.every(isNameWord)) return false;
      // At least two CAPITALISED tokens — particles alone don't make a name.
      const realTokens = parts.filter((t) => !NAME_PARTICLES.has(t.toLowerCase()) || t !== t.toLowerCase());
      if (realTokens.length < 2) return false;
      // Rebuild the value from the ORIGINAL text so the real spacing (and the
      // index) stay exact — never parts.join(" "), which would silently
      // normalise whitespace and desynchronise the span from the message.
      let end = 0;
      let cursor = 0;
      for (const p of parts) {
        const at = m[1].indexOf(p, cursor);
        end = at + p.length;
        cursor = end;
      }
      const value = m[1].slice(0, end);
      out.push(finding("NAME_PII", "Full name (with other PII)", value, m.index, "medium"));
      return true;
    };

    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 20000) {
      if (accept(m)) continue;
      // REWIND. The rejected pair's SECOND word may itself be the first word
      // of a real name, and continuing past it loses that name entirely:
      // "Contact James Whitfield on 0412 556 781" matched "Contact James",
      // correctly rejected it (Contact is a form-label word), and then resumed
      // AFTER "James" — so "James Whitfield" was never tested and went out
      // completely unmasked, with a phone number sitting beside it. Every
      // common business opener does this: Contact / Regarding / Attention /
      // Dear / From / Subject.
      //
      // Same failure as the credential scanner: rejecting a candidate is not
      // neutral, because the rejected span is still consumed. See
      // scanCredential() for the identical fix.
      // Find the first WHITESPACE RUN, not a literal space: name tokens are
      // separated by "\n" inside a CSV or table row, and an indexOf(" ")
      // here resumed at the wrong token and lost the name entirely
      // ("Email\nJessica Taylor" rewound to "Taylor", not "Jessica").
      const sep = /\s+/.exec(m[0]);
      const w2at = sep ? m.index + sep.index + sep[0].length : m.index + 1;
      const resume = Math.max(w2at, m.index + 1);
      if (resume < re.lastIndex) re.lastIndex = resume;
    }

    // ---- Lowercase names ------------------------------------------------
    // People type "contact oliver scholefield his number is 0414 593 204" all
    // the time, and a name is PII regardless of case. The pass above cannot
    // see it: capitalisation was the ONLY signal marking a token as a proper
    // noun, and without it every adjacent word pair is a candidate filtered
    // by a ~223-word list — nowhere near enough for arbitrary English.
    //
    // The GAZETTEER substitutes for capitalisation: token 1 must be a given
    // name the list vouches for. That is only affordable because the list
    // already exists for aggressive name detection.
    //
    // Still gated on hasIdentifier (checked by the caller), so this adds no
    // standalone-name detection — it only recovers names the message already
    // proves are next to other PII.
    const gaz = (typeof window !== "undefined" && window.GuardAI && window.GuardAI.NAME_GAZETTEER) || null;
    if (!gaz) return;
    const LTOK = "[\\p{L}\\p{M}]['\u2019\\-]?[\\p{L}\\p{M}]+";
    const lre = new RegExp(
      "(?<![\\p{L}\\p{M}'\u2019-])(" + LTOK + "(?:\\s+" + LTOK + "){1,3})(?![\\p{L}\\p{M}'\u2019-])",
      "gu"
    );
    let lm;
    let lguard = 0;
    while ((lm = lre.exec(text)) && lguard++ < 20000) {
      const parts = lm[1].split(/\s+/);
      const t1 = parts[0].toLowerCase();
      const t2 = (parts[1] || "").toLowerCase();
      // Rewind on rejection — the fifth place in this file that needs it.
      const rewind = () => {
        const sp = /\s+/.exec(lm[0]);
        const at = sp ? lm.index + sp.index + sp[0].length : lm.index + 1;
        if (at < lre.lastIndex) lre.lastIndex = at;
      };
      // Only when token 1 is genuinely LOWERCASE. If it is capitalised, the
      // pass above owns it — and that pass correctly requires token 2 to be
      // capitalised too, which is what stops "James is" pairing a real name
      // with the following verb.
      if (parts[0] !== t1) { rewind(); continue; }
      if (!gaz.isFirst(t1)) { rewind(); continue; }
      // Don't double-report what the capitalised pass already found.
      if (out.some((x) => x.type === "NAME_PII" &&
          x.index <= lm.index && x.index + x.value.length > lm.index)) { rewind(); continue; }
      if (COMMON_WORDS.has(t2) || NAME_CONTEXT_WORDS.has(t2) || NON_SURNAME_WORDS.has(t2)) { rewind(); continue; }
      if (STOPWORDS.has(parts[1]) ||
          STOPWORDS.has(parts[1][0].toUpperCase() + parts[1].slice(1))) { rewind(); continue; }

      // THIS PATH IS DELIBERATELY STRICTER THAN THE CAPITALISED ONE. Each of
      // the three rules below was added because it was measured, not guessed:
      // without them the false-positive rate on a 60-message lowercase corpus
      // was 3/60 rather than 0/60.

      // 1. Ambiguous given names are rejected outright. Surname corroboration
      //    is not enough once capitalisation is gone — "the hunter green
      //    colour" has a gazetteer given name AND a gazetteer surname.
      //    Cost: "grace whitfield" typed lowercase is missed. Capitalised
      //    still works.
      if (AMBIGUOUS_FIRST.has(t1)) { rewind(); continue; }
      // 2. A participle or adverb is not a surname ("carol singing tonight").
      if (/(?:ing|ed|ly)$/.test(t2)) { rewind(); continue; }
      // 3. A verb particle is not a surname ("jack up the price").
      if (LC_PARTICLES.has(t2)) { rewind(); continue; }
      // 4. A function word or common verb is not a surname ("james is at ...").
      if (LC_NON_SURNAME.has(t2)) { rewind(); continue; }

      let end = 0;
      let cursor = 0;
      for (const q of [parts[0], parts[1]]) {
        const at = lm[1].indexOf(q, cursor);
        end = at + q.length;
        cursor = end;
      }
      out.push(finding("NAME_PII", "Full name (with other PII)",
        lm[1].slice(0, end), lm.index, "medium"));
    }
  }

  /* ---- Aggressive (standalone) name detection — OPT-IN, DEFAULT OFF ------ *
   *
   * Flags a name with no other PII beside it, using the bundled gazetteer.
   * The default rule above is untouched and keeps working when this is off.
   *
   * Words that are BOTH a common given name and an ordinary word or place.
   * These are the reason this mode is off by default, and they never fire on
   * the strength of the given name alone.
   */
  /**
   * Function words and common verbs. Token 2 of a lowercase name candidate
   * must not be one of these: "james is at 14 Grove Street" otherwise matches
   * "james is" as a full name and masking DELETES the word "is", which is the
   * corrupt-the-sentence failure this codebase treats as the worst outcome.
   * The all-lowercase prose corpus missed this whole class — every entry in it
   * was prose without a given name, so "given name + verb" never appeared.
   */
  const LC_NON_SURNAME = new Set([
    "is", "was", "are", "were", "am", "be", "been", "being", "has", "have",
    "had", "do", "does", "did", "will", "would", "can", "could", "should",
    "shall", "may", "might", "must", "and", "or", "but", "so", "if", "then",
    "than", "as", "at", "to", "of", "in", "on", "for", "with", "by", "from",
    "the", "a", "an", "this", "that", "these", "those", "not", "no", "yes",
    "he", "she", "they", "we", "you", "it", "i", "his", "her", "their",
    "my", "your", "our", "its", "him", "them", "us", "me",
    "just", "also", "very", "really", "please", "still", "now", "here",
    "there", "when", "where", "who", "which", "what", "why", "how",
    "said", "says", "told", "tells", "rang", "rings", "sent", "sends",
    "works", "lives", "needs", "wants", "gets", "goes", "comes", "makes",
    "takes", "gives", "knows", "thinks", "wrote", "writes", "left", "went",
    "got", "put", "run", "runs", "ran", "keep", "keeps", "kept", "let",
    "lets", "asked", "asks", "wait", "waits", "seems", "looks", "feels",
  ]);

  /** Verb particles — never a surname ("jack up the price"). */
  const LC_PARTICLES = new Set([
    "up", "down", "off", "out", "in", "on", "back", "over", "through",
    "away", "around", "along", "across", "apart", "aside", "together",
    "forward",
  ]);

  const AMBIGUOUS_FIRST = new Set([
    // ordinary nouns / verbs / adjectives
    "grace", "hope", "faith", "joy", "rose", "lily", "daisy", "jasmine",
    "amber", "pearl", "ruby", "crystal", "summer", "autumn", "dawn", "sky",
    "star", "angel", "art", "bill", "mark", "will", "rob", "chase", "drew",
    "miles", "reed", "wade", "hunter", "frank", "earl", "rich", "buck",
    "dale", "glen", "cliff", "brook", "brooke", "heath", "field", "ford",
    "rain", "storm", "sunny", "major", "guy", "van", "gene", "bud", "chip",
    "penny", "hazel", "olive", "ivy", "iris", "jade", "sage", "clay",
    "colt", "dean", "kent", "lane", "moss", "reign", "trinity", "melody",
    "harmony", "serenity", "justice", "royal", "king", "prince", "duke",
    // months and seasons
    "april", "may", "june", "august", "julie", "noel",
    // places
    "sydney", "perth", "adelaide", "victoria", "georgia", "charlotte",
    "florence", "paris", "austin", "houston", "dallas", "memphis", "phoenix",
    "jordan", "kenya", "india", "china", "asia", "israel", "cyprus", "madison",
    "jackson", "lincoln", "washington", "brooklyn", "chelsea", "kingston",
    "richmond", "hamilton", "cleveland", "carolina", "dakota", "montana",
    "savannah", "sierra", "cairo", "eden", "alexandria", "adelaide",
  ]);

  /**
   * Capitalised words that are ordinary nouns or institutions, used to reject
   * the SECOND token. This is what stops "Sydney Airport" and "Victoria
   * Police" while still accepting a surname the gazetteer has never heard of
   * — which matters, because any bounded surname list under-covers non-Anglo
   * names, and gating on list membership alone would quietly protect those
   * people less.
   */
  const NON_SURNAME_WORDS = new Set([
    "airport", "police", "hospital", "university", "college", "school",
    "station", "street", "road", "avenue", "highway", "bridge", "harbour",
    "harbor", "beach", "park", "gardens", "square", "centre", "center",
    "tower", "plaza", "mall", "market", "museum", "gallery", "library",
    "stadium", "arena", "theatre", "theater", "cinema", "hotel", "motel",
    "restaurant", "cafe", "bar", "club", "church", "cathedral", "temple",
    "mosque", "council", "court", "prison", "clinic", "pharmacy", "bank",
    "office", "building", "campus", "terminal", "port", "wharf", "quay",
    "island", "bay", "river", "creek", "valley", "hill", "mount", "lake",
    "forest", "desert", "coast", "north", "south", "east", "west", "central",
    "city", "town", "suburb", "state", "county", "region", "district",
    "day", "week", "month", "year", "morning", "evening", "night",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "time", "date", "report", "invoice", "meeting", "project", "team",
    "department", "division", "branch", "group", "company", "limited",
  ]);

  /** True when this offset begins a sentence (every word is capitalised there). */
  function atSentenceStart(text, index) {
    for (let i = index - 1; i >= 0; i--) {
      const ch = text[i];
      if (/\s/.test(ch)) continue;
      return /[.!?;:\n]/.test(ch);
    }
    return true;
  }

  function detectStandaloneNames(text, out) {
    const gaz = (typeof window !== "undefined" && window.GuardAI && window.GuardAI.NAME_GAZETTEER) || null;
    if (!gaz) return;

    const re = new RegExp(
      `${NAME_BOUNDARY_BEFORE}(${NAME_TOKEN}(?:\\s+(?:${NAME_PARTICLE_RE}\\s+){0,2}${NAME_TOKEN}){1,3})${NAME_BOUNDARY_AFTER}`,
      "gu"
    );
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 20000) {
      const parts = m[1].split(/\s+/);
      const first = parts[0];
      const second = parts[1];
      if (!first || !second) continue;
      const f1 = first.toLowerCase();
      const f2 = second.toLowerCase();

      // REWIND on every rejection, for the third time in this file: the run
      // may START on a word that is not a given name ("Contact Chidi Okafor"),
      // and continuing past it would skip the real name behind it. See
      // detectNames() and scanCredential() for the same fix.
      const rewind = () => {
        const sep = /\s+/.exec(m[0]);
        const at = sep ? m.index + sep.index + sep[0].length : m.index + 1;
        if (at < re.lastIndex) re.lastIndex = at;
      };

      // The first token must be a given name the gazetteer vouches for.
      if (!gaz.isFirst(f1)) { rewind(); continue; }
      // Never re-flag something the ordinary rule already found.
      if (out.some((x) => x.type === "NAME_PII" && x.index === m.index)) { rewind(); continue; }
      if (NON_SURNAME_WORDS.has(f2) || COMMON_WORDS.has(f2)) { rewind(); continue; }

      const ambiguous = AMBIGUOUS_FIRST.has(f1);
      // An ambiguous word at the start of a sentence is almost always the
      // ordinary word, not a name — every word is capitalised there, so the
      // capitalisation carries no signal at all.
      const surnameKnown = gaz.isLast(f2);
      // Sentence-initial suppression, but a gazetteer surname outranks it:
      // "Sydney Whitfield called" opens a sentence, yet "Whitfield" is
      // corroboration that no amount of position can explain away. Without
      // this, any name at the start of a message was invisible to this mode.
      if (ambiguous && !surnameKnown && atSentenceStart(text, m.index)) { rewind(); continue; }

      // HIGH: the gazetteer vouches for the surname too.
      // MEDIUM: it doesn't, but the word isn't a common noun either. Kept
      // rather than dropped so that a surname absent from a bounded,
      // Anglo-leaning list is still protected — a spurious flag is a better
      // failure than silently weaker protection. Medium findings are what
      // force the warning card even in silent mode (see content.js).
      const confidence = surnameKnown ? "high" : "medium";

      // Trim the run the same way the ordinary rule does.
      const kept = [first, second];
      for (let i = 2; i < parts.length; i++) {
        const t = parts[i];
        const lc = t.toLowerCase();
        const isParticle = NAME_PARTICLES.has(lc) && t === lc;
        if (isParticle) { kept.push(t); continue; }
        if (COMMON_WORDS.has(lc) || NON_SURNAME_WORDS.has(lc) || NAME_CONTEXT_WORDS.has(lc)) break;
        kept.push(t);
      }
      while (kept.length > 2 && NAME_PARTICLES.has(kept[kept.length - 1].toLowerCase())) kept.pop();
      let end = 0;
      let cursor = 0;
      for (const p of kept) {
        const at = m[1].indexOf(p, cursor);
        end = at + p.length;
        cursor = end;
      }
      const value = m[1].slice(0, end);

      const f = finding("NAME_PII", "Name (standalone detection)", value, m.index, confidence);
      // Marks this as produced by the opt-in aggressive rule, so the silent-
      // mode escalation can tell it apart from an ordinary NAME_PII finding
      // (which also carries "medium" confidence).
      f.aggressive = true;
      out.push(f);
    }
  }

  /* ================================================================== *
   * Public class
   * ================================================================== */
  // Hard ceiling on how much text a single scan() call will process. Chat
  // messages are practically always far below this; it exists to bound
  // worst-case latency on an extreme paste (a huge log/CSV dump) so one
  // scan can never block the page for an unbounded amount of time,
  // regardless of which detector runs over it. Detection simply stops
  // looking at content past this point rather than throwing or hanging.
  const MAX_SCAN_LENGTH = 100000;

  /**
   * Run one detector function in isolation. A bug or an unforeseen
   * pathological input in ONE detector must never take down the whole scan
   * (which would silently drop every OTHER finding too — for a tool whose
   * entire job is catching sensitive data, a partial result is far safer
   * than "detection crashed, so nothing was flagged and the message went
   * out unmasked"). Failures are logged, not swallowed silently.
   */
  function runDetector(name, fn, text, out) {
    try {
      fn(text, out);
    } catch (err) {
      console.warn(`[GuardAI] detector "${name}" failed, continuing with other detectors:`, err);
    }
  }

  class Detector {
    constructor() {
      // Category toggles ("What GuardAI masks"): types the user has switched
      // off. Empty by default — every category runs, matching the "all
      // toggles ON by default" requirement. Deliberately stores the OFF set
      // rather than an ON map: a type this file adds in the future is
      // automatically enabled for existing users without any settings
      // migration, since it's simply absent from a disabled-list that only
      // ever names things explicitly turned off.
      this.disabledTypes = new Set();
      // "Aggressive name detection" (settings.html). DEFAULT OFF — this one
      // is opt-in, unlike the category toggles, so it is stored as its own
      // boolean rather than in the disabled-categories OFF-list (which
      // cannot express a default-off setting: absence there means enabled).
      this.aggressiveNames = false;
    }

    /** Called by content.js after loading (or on change of) the
     * guardai_disabled_categories setting. Takes effect on the next scan(). */
    setDisabledTypes(types) {
      this.disabledTypes = new Set(types || []);
    }

    /** Called by content.js from loadSettings() and on storage change. */
    setAggressiveNames(on) {
      this.aggressiveNames = on === true;
    }

    scan(text) {
      if (!text || typeof text !== "string") return [];
      if (text.length > MAX_SCAN_LENGTH) {
        console.warn(`[GuardAI] input truncated for scanning (${text.length} > ${MAX_SCAN_LENGTH} chars)`);
        text = text.slice(0, MAX_SCAN_LENGTH);
      }
      const out = [];

      // High-confidence structured detectors first.
      runDetector("creditCard", detectCreditCard, text, out);
      runDetector("medicare", detectMedicare, text, out);
      runDetector("tfn", detectTFN, text, out);
      runDetector("abn", detectABN, text, out);
      runDetector("acn", detectACN, text, out);
      runDetector("passport", detectPassport, text, out);
      runDetector("licence", detectLicence, text, out);
      runDetector("bsb", detectBSB, text, out);
      runDetector("bankAccount", detectBankAccount, text, out);
      runDetector("refCode", detectRefCode, text, out);
      runDetector("gps", detectGPS, text, out);
      runDetector("email", detectEmail, text, out);
      runDetector("phone", detectPhone, text, out);
      runDetector("address", detectAddress, text, out);
      runDetector("dob", detectDOB, text, out);
      runDetector("money", detectMoney, text, out);

      // Keyword / contextual detectors. Organisations run BEFORE names so a
      // company name already counts as an identifier when detectNames decides
      // whether the message has enough context to flag a person's name.
      runDetector("org", detectOrg, text, out);
      runDetector("confidential", detectConfidential, text, out);
      runDetector("business", detectBusiness, text, out);
      runDetector("health", detectHealth, text, out);
      runDetector("legal", detectLegal, text, out);
      runDetector("immigration", detectImmigration, text, out);
      runDetector("password", detectPassword, text, out);
      runDetector("username", detectUsername, text, out);

      // Names: only when another identifier (or banking context) is present.
      try {
        const hasIdentifier =
          out.some((f) => IDENTIFIER_TYPES.has(f.type)) ||
          /\b(bank|account holder|savings account)\b/i.test(text);
        detectNames(text, out, hasIdentifier);
        // Opt-in standalone detection runs AFTER the ordinary rule so it can
        // skip anything already found, and so the ordinary finding (which is
        // not marked `aggressive`) always wins for a span both would match.
        if (this.aggressiveNames) detectStandaloneNames(text, out);
      } catch (err) {
        console.warn("[GuardAI] detector \"names\" failed, continuing:", err);
      }

      // Correct phone-shaped values that are explicitly labelled as a Medicare
      // number / TFN / account etc. BEFORE dedupe+overlap resolution, so
      // everything downstream (masking, the colour key, the panel) sees the
      // real type rather than "Phone".
      try {
        retypeLabelledNumbers(text, out);
      } catch (err) {
        console.warn("[GuardAI] label re-typing failed, continuing:", err);
      }

      // Whatever a detector captured, it must not span a sentence boundary.
      // This is a safety net, not the primary fix: the value a detector
      // returns is the exact span masking REPLACES, so a greedy pattern that
      // runs past the end of its match doesn't merely mis-flag — it deletes
      // the swallowed words from the user's message and substitutes part of a
      // fake value for them. That is how "88 Kellett Parade. Let me know"
      // became "23 Hibiscus Rd Hobart me know": the address pattern captured
      // "88 Kellett Parade. Let". Detection is allowed to miss things; it is
      // never allowed to rewrite the sentence around what it found.
      try {
        clampToSentence(out);
      } catch (err) {
        console.warn("[GuardAI] sentence clamp failed, continuing:", err);
      }

      // Category toggles are applied LAST, after every detector (including
      // the cross-detector context checks above — hasIdentifier for names,
      // retypeLabelledNumbers) has already run on the FULL, unfiltered set.
      // Detection itself is completely unchanged by this setting; a disabled
      // category is simply removed from what scan() hands back, so it can
      // never reach the warning card, the review model, or masking — "not
      // just hidden from the panel, actually not masked at all".
      const withoutDisabled = (arr) =>
        this.disabledTypes.size ? arr.filter((f) => !this.disabledTypes.has(f.type)) : arr;

      try {
        return withoutDisabled(resolveOverlaps(dedupe(out))).sort((a, b) => a.index - b.index);
      } catch (err) {
        console.warn("[GuardAI] overlap resolution failed, returning unresolved findings:", err);
        return withoutDisabled(out).sort((a, b) => a.index - b.index);
      }
    }

    hasSensitive(text) {
      return this.scan(text).length > 0;
    }
  }

  window.GuardAI = window.GuardAI || {};
  window.GuardAI.Detector = Detector;
  window.GuardAI.REASONS = REASONS;
})();
