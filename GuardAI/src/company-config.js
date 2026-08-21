/**
 * GuardAI — backend endpoint for company reporting.
 *
 * Matches the website's config.js. Leave these blank and the company features
 * simply do not appear: nothing is sent, and the extension behaves exactly as
 * it did before this file existed.
 *
 * The anon key is safe to ship in the extension. No table grants anything to
 * the anon role; the only reachable surface is connect_company() and
 * record_event(), and neither can read data back out. The service_role key
 * must never appear here.
 */
export const SUPABASE_URL = "https://oiwmcewuwbkjmgyrdjwe.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_PUREue-M-9yifPPeQ0Hpmw_W2tiFE4t";

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
