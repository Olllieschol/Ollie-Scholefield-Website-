/**
 * Guard4AI — company reporting boundary.
 * ---------------------------------------------------------------------------
 * Everything that leaves this device for a company dashboard passes through
 * buildEventBody() below, and nothing else in the extension is allowed to talk
 * to the backend directly.
 *
 * The rule is that a report may carry only:
 *
 *     employee_id   an anonymous id minted when the invite code was redeemed
 *     category      one of the fixed detection types
 *     site          the platform host, from a fixed list
 *
 * and never the value that was masked, never the text around it, and never a
 * URL. That is enforced here rather than trusted:
 *
 *   - the body is assembled one primitive at a time. No object is ever spread
 *     in, so handing this function a whole finding cannot leak .real or .fake
 *     through it: only three strings are read, by name.
 *   - each of the three is checked against a shape or an allowlist. A value
 *     smuggled into the category or site slot fails the check and the whole
 *     report is dropped rather than sent.
 *   - the finished body is counted. If this function ever grows a fourth field
 *     it refuses to send at all, which fails closed instead of quietly
 *     shipping whatever was added.
 *
 * The database repeats all of this independently: record_event() takes the same
 * three arguments and the events table has no column that could hold anything
 * else. This file is the near end of that guarantee, not the whole of it.
 * ---------------------------------------------------------------------------
 */

/** Detection types, mirroring settings.js GROUPS and the guardai_category domain. */
export const CATEGORIES = new Set([
  "NAME_PII", "ORG",
  "PHONE", "EMAIL", "ADDRESS", "GPS",
  "PASSPORT", "LICENCE", "MEDICARE", "TFN", "DOB",
  "CREDIT_CARD", "BSB", "BANK_ACCOUNT", "REF_CODE", "ABN", "ACN", "MONEY",
  "PASSWORD", "CONFIDENTIAL", "BUSINESS_CONFIDENTIAL", "HEALTH", "LEGAL", "IMMIGRATION",
]);

/** Platform hosts, mirroring content.js PLATFORMS and the guardai_site domain. */
export const SITES = new Set([
  "chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com",
  "bard.google.com", "copilot.microsoft.com", "bing.com", "perplexity.ai",
  "poe.com", "character.ai", "mistral.ai", "chat.mistral.ai", "groq.com",
  "huggingface.co", "you.com", "writesonic.com", "jasper.ai", "copy.ai",
  "rytr.me", "pi.ai", "inflection.ai", "cohere.com", "phind.com",
  "deepseek.com", "qwen.ai", "grok.com", "meta.ai", "use.ai",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = ["p_employee_id", "p_category", "p_site"];

/**
 * Build the one body shape the backend accepts, or null if anything about it
 * is wrong. Callers must treat null as "do not send", never as "send anyway".
 *
 * @param {string} employeeId anonymous employee uuid
 * @param {string} category   a member of CATEGORIES
 * @param {string} site       a member of SITES
 * @returns {{p_employee_id: string, p_category: string, p_site: string}|null}
 */
export function buildEventBody(employeeId, category, site) {
  if (typeof employeeId !== "string" || !UUID_RE.test(employeeId)) return null;
  if (typeof category !== "string" || !CATEGORIES.has(category)) return null;
  if (typeof site !== "string" || !SITES.has(site)) return null;

  const body = {
    p_employee_id: employeeId,
    p_category: category,
    p_site: site,
  };

  const keys = Object.keys(body);
  if (keys.length !== ALLOWED_KEYS.length) return null;
  for (const k of keys) if (!ALLOWED_KEYS.includes(k)) return null;

  return body;
}

/* ------------------------------------------------------------------------- *
 * Attachments.
 *
 * The dashboard needs to say how much of what a team attaches Guard4AI can
 * actually see into. That means the server has to hear about files it did NOT
 * block, which it never has: today a file reaches this boundary only through
 * record_event, only when something was found, and arrives indistinguishable
 * from a typed message.
 *
 * Two fields per file and nothing else. What is deliberately absent is the
 * whole of the interesting part: no filename, no size, no page count, no
 * extract, no findings, and no seat id in the row the server stores.
 * ------------------------------------------------------------------------- */

/** Broad file types, mirroring KIND in src/filescan.js. `other` is every
 *  format we do not read — Excel, PowerPoint, archives, HEIC. */
export const FILE_KINDS = new Set(["pdf", "docx", "text", "image", "other"]);

/**
 * The three states an admin is shown, folded down from the eight the file
 * card distinguishes. The fold is deliberate: "we could not read this" is one
 * fact to a person deciding whether to trust the tool, whether it happened
 * because the format is unsupported, the PDF was a scan, the image was too
 * blurry to OCR, or the file was over the size cap.
 */
export const FILE_OUTCOMES = new Set(["checked", "blocked", "unreadable"]);

/** filescan.js action -> the outcome the dashboard counts. */
const OUTCOME_OF = {
  pass: "checked",
  "img-nothing": "checked",
  block: "blocked",
  "img-found": "blocked",
  unreadable: "unreadable",
  unsupported: "unreadable",
  "too-large": "unreadable",
  "img-unreadable": "unreadable",
  // A scanned PDF where the page cap stopped OCR partway: some pages read,
  // the file as a whole not. "We could not see all of this" is exactly what
  // the third column reports, so it is unreadable rather than checked.
  "pdf-partial": "unreadable",
};

/** filescan.js kind -> the type the dashboard counts. */
const KIND_OF = { pdf: "pdf", docx: "docx", text: "text", image: "image", unsupported: "other" };

/**
 * Fold one scan result down to { kind, outcome }, or null if either is
 * unrecognised.
 *
 * An action this build does not know is null rather than a guess, and a null
 * is dropped rather than counted — the same fail-closed rule the file card
 * itself uses for an unknown verdict. A miscounted row is a lie on a
 * dashboard an admin is using to judge coverage.
 */
export function fileFacts(kind, action) {
  const k = KIND_OF[String(kind)];
  const o = OUTCOME_OF[String(action)];
  return k && o ? { kind: k, outcome: o } : null;
}

const FILE_KEYS = ["kind", "outcome"];

/**
 * Build the one attachment body the backend accepts, or null.
 *
 * Same construction as buildEventBody above, for the same reason: assembled
 * one primitive at a time from named reads, so handing this a whole scan
 * result cannot leak the filename or the extracted text through it, and the
 * finished object is counted so that a third field added here refuses to send
 * rather than shipping quietly.
 */
export function buildFileBody(kind, outcome) {
  if (typeof kind !== "string" || !FILE_KINDS.has(kind)) return null;
  if (typeof outcome !== "string" || !FILE_OUTCOMES.has(outcome)) return null;

  const body = { kind, outcome };

  const keys = Object.keys(body);
  if (keys.length !== FILE_KEYS.length) return null;
  for (const k of keys) if (!FILE_KEYS.includes(k)) return null;

  return body;
}

/**
 * Normalise a hostname the way content.js resolves a platform, so that
 * app.chatgpt.com and chatgpt.com report as the same site. Anything not on the
 * list returns null and is not reported at all.
 */
export function normaliseSite(hostname) {
  if (typeof hostname !== "string") return null;
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (SITES.has(host)) return host;
  for (const known of SITES) {
    if (host.endsWith("." + known)) return known;
  }
  return null;
}
