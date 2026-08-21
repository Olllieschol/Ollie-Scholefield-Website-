/**
 * GuardAI — company reporting boundary.
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
