/**
 * The contract between backend/licences.sql and the extension.
 *
 * ═══ WHAT THIS CAN AND CANNOT DO ═══════════════════════════════════════════
 *
 * This is a STATIC check. There is no Postgres on this machine and the SQL
 * runs in a hosted Supabase project, so nothing here proves the file executes.
 * What it does prove is that the two halves still agree — which is the part
 * that silently rots, because they live in different languages, in different
 * files, and are deployed by different people at different times.
 *
 * The failure it exists to catch: someone renames an exception in the SQL,
 * the extension stops recognising it, and a specific actionable message
 * ("That licence is already in use on 3 devices") degrades into "Could not
 * reach GuardAI. Check your connection" — which sends the user to look at
 * their wifi instead of their subscription. Nothing crashes. Nothing logs. The
 * only symptom is a support email that makes no sense.
 *
 * It also asserts the safety clauses are still in the file, because SQL nobody
 * can run locally is SQL nobody reviews carefully. A dropped `enable row level
 * security` would not be noticed by any other test in this suite.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sql = fs.readFileSync(path.join(ROOT, "backend", "licences.sql"), "utf8");
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/** Everything the SQL can raise. */
const raised = new Set([...sql.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]));
/** Everything the extension knows how to explain. */
const handled = new Set([...bg.matchAll(/text\.includes\("([A-Z_]+)"\)/g)].map((m) => m[1]));

/** Codes raised by the company-side SQL, which is not in this repo at all. */
const COMPANY_CODES = new Set(["SEAT_LIMIT_REACHED", "INVALID_CODE"]);

(async () => {
  console.log("\n--- the error contract ---");
  check(raised.size > 0, "the SQL raises named exceptions", [...raised].join(", "));

  for (const code of raised) {
    check(handled.has(code),
      `${code} raised by the SQL is explained by the extension`,
      "background.js has no branch for it, so the user would be told to check their connection");
  }
  for (const code of handled) {
    if (COMPANY_CODES.has(code)) continue;
    check(raised.has(code),
      `${code} handled by the extension is actually raised by the SQL`,
      "dead branch — either the SQL dropped it or it was never there");
  }
  for (const code of COMPANY_CODES) {
    check(handled.has(code),
      `${code} is still handled (company-side SQL, NOT in this repo — cannot be verified here)`);
  }

  console.log("\n--- refresh_entitlement must never raise ---");
  {
    // This is the subtle one. The extension fails OPEN on any non-200, because
    // a 500 or a captive portal is the server failing to answer rather than
    // answering "no". A raise inside refresh_entitlement would therefore make
    // a CANCELLED licence keep working indefinitely — the exact mirror of the
    // failure the fail-open design exists to prevent.
    const fn = sql.slice(sql.indexOf("function public.refresh_entitlement"));
    const body = fn.slice(0, fn.indexOf("$$;") + 3);
    check(!/raise\s+exception/i.test(body),
      "refresh_entitlement raises nothing: it returns valid:false with a 200, because a non-200 would fail OPEN and keep a cancelled licence alive",
      (body.match(/raise[^\n]*/i) || [""])[0]);
    check(/'valid', false/.test(body) && /'valid', true/.test(body),
      "and answers with an explicit boolean either way");
    check(/if not found then\s*return json_build_object\('valid', false\)/.test(body),
      "including for a token it has never seen");
  }

  console.log("\n--- the anon key ships in the extension, so lock the tables ---");
  for (const [needle, why] of [
    ["alter table public.licences            enable row level security", "RLS on licences"],
    ["alter table public.licence_activations enable row level security", "RLS on licence_activations"],
    ["revoke all on public.licences            from anon, authenticated", "anon cannot read licences"],
    ["revoke all on public.licence_activations from anon, authenticated", "anon cannot read activations"],
    ["grant execute on function public.activate_licence(text)    to anon", "anon may call activate_licence"],
    ["grant execute on function public.refresh_entitlement(uuid) to anon", "anon may call refresh_entitlement"],
  ]) {
    check(sql.includes(needle), why, "missing from backend/licences.sql");
  }
  {
    const defs = (sql.match(/security definer/g) || []).length;
    const paths = (sql.match(/set search_path = public/g) || []).length;
    check(defs === 2 && paths === defs,
      "both functions are SECURITY DEFINER with a pinned search_path — a definer function without one is a privilege-escalation hole",
      `${defs} definer, ${paths} pinned`);
  }
  {
    // The word appears in a comment warning against it, which is fine and
    // should stay. What must not appear is an actual grant or key. Checking
    // the raw text caught the warning and called it a leak — a test that
    // fails on its own documentation trains people to ignore it.
    const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    check(!/service_role/.test(code),
      "no service_role grant in the executable part (the comment warning about it is meant to be there)",
      (code.match(/[^\n]*service_role[^\n]*/) || [""])[0]);
    check(!/\bey[A-Za-z0-9_-]{20,}\b|\bsb_secret/.test(sql),
      "and no JWT or secret key pasted into the file");
  }

  console.log("\n--- the reviewer licence ---");
  {
    const E = await import("../src/entitlement.js");
    const m = sql.match(/values \('(GK-[A-Z0-9-]+)', 'review', (null|[^,]+), (\d+)\)/);
    check(!!m, "there is a reviewer licence in the file", m ? m[1] : "not found");
    if (m) {
      const [, key, expiry, activations] = m;
      const parsed = E.parseCode(key);
      check(parsed && parsed.kind === "individual",
        "it is shaped like a licence key the extension will route correctly", JSON.stringify(parsed));
      check(parsed && parsed.code === key, "and needs no normalising — it is already upper-case", parsed && parsed.code);
      check(expiry === "null",
        "IT NEVER EXPIRES — store review recurs on every update, months apart, and a key that lapses gets the extension rejected as non-functional",
        expiry);
      check(Number(activations) >= 1000,
        "and cannot exhaust its activations across repeat review rounds", activations);
      check(key.length <= 32,
        "it fits the popup and settings input maxlength, so a reviewer can actually paste it", String(key.length));
    }
  }

  console.log("\n--- key entropy ---");
  {
    // No rate limit exists on a PostgREST RPC, so the key is the only defence.
    check(/80 bits/.test(sql) && /base32/i.test(sql),
      "the file states the required key format and entropy where whoever writes the generator will see it");
    check(/upper\(btrim\(p_key\)\)/.test(sql),
      "and activate_licence normalises the same way the extension does, so a pasted key with a stray space still works");
  }

  console.log(`\nBACKEND-CONTRACT: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
