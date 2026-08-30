/**
 * AI tool usage: the one new thing that leaves the browser, and its limits.
 *
 * ═══ WHAT THIS FILE IS DEFENDING ═══════════════════════════════════════════
 *
 * The dashboard needed to answer "which AI tools does the team use", and
 * events could not: an event is only written when something is CAUGHT, so a
 * tool used all day with nothing sensitive in it was invisible. Filling that
 * gap meant sending something new, which on a privacy product is exactly the
 * kind of change that has to be pinned down by tests rather than by intent.
 *
 * Three properties, all of them attempts to break it:
 *
 *   THE BODY IS TWO FIELDS. A seat id and a site name, both of which already
 *   went on a catch. Nothing about the page, the message or the person.
 *
 *   ONCE PER TOOL PER DAY. Not per message. That is what makes the server's
 *   unit a browser-day rather than an activity log, and it is a privacy
 *   property, not an optimisation — so it is tested as one.
 *
 *   NEVER ON A PERSONAL LICENCE. No company, no report, no exceptions.
 *
 * Plus the SQL side: the counter has no employee_id column at all, and the
 * dashboard's breakdown is suppressed in the database rather than in the page.
 *
 * And the join between the two halves. The first version of this file drove
 * recordUsage directly and read content.js as text, which proved each end and
 * not the wire between them. A live company then showed an empty panel with
 * both ends correct, so section 5 delivers the message the way Chrome does and
 * follows it out to the request.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "..", "..", "..", "Documents", "guardaigo-landing 44");
const SEAT = "9c1f8e40-0000-4000-8000-00000000b27a";

function makeChrome(initial) {
  const storage = Object.assign({}, initial);
  const L = { installed: [], startup: [], message: [] };
  return {
    storage, listeners: L,
    chrome: {
      runtime: {
        onInstalled: { addListener: (f) => L.installed.push(f) },
        onStartup: { addListener: (f) => L.startup.push(f) },
        onMessage: { addListener: (f) => L.message.push(f) },
      },
      storage: { local: {
        get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {};
          for (const kk of ks) if (kk in storage) o[kk] = storage[kk]; return o; },
        set: async (o) => { Object.assign(storage, o); },
        remove: async (k) => { for (const kk of (Array.isArray(k) ? k : [k])) delete storage[kk]; },
      } },
      tabs: { create() {} },
    },
  };
}

const drain = () => new Promise((r) => setTimeout(r, 5));
let seq = 0;
async function loadWorker({ storage = {}, ok = true } = {}) {
  await drain();
  const env = makeChrome(storage);
  globalThis.chrome = env.chrome;
  env.calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    // `ok` may be a function, so one worker can answer differently over its
    // life. Section 5 needs exactly that: a server that 404s and then exists.
    const verdict = typeof ok === "function" ? ok(String(url), body) : ok;
    const status = typeof verdict === "number" ? verdict : (verdict ? 200 : 500);
    env.calls.push({ url: String(url), body, status });
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  };
  // Deliver a message the way Chrome does, rather than calling the handler.
  // Returns whatever the listener returned, which is itself a property worth
  // asserting: a truthy return holds the message port open.
  env.send = (msg) => {
    let ret;
    for (const f of env.listeners.message) ret = f(msg, { id: "test-sender" }, () => {});
    return ret;
  };
  env.mod = await import("../background.js?useq=" + (++seq));
  return env;
}

const connected = { guardai_company: { employeeId: SEAT, companyName: "Acme Pty Ltd", connectedAt: 1 } };
const usageCalls = (env) => env.calls.filter((c) => c.url.includes("record_usage"));

(async () => {
  console.log("\n--- 1. the body is two fields, both already sent on a catch ---");
  {
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordUsage("chatgpt.com");
    const c = usageCalls(env)[0];
    check(Boolean(c), "a connected seat reports the tool");
    check(JSON.stringify(Object.keys(c.body).sort()) === JSON.stringify(["p_employee_id", "p_site"]),
      "exactly two fields and nothing else", JSON.stringify(c.body));
    check(c.body.p_employee_id === SEAT, "the anonymous seat id, which already goes on a catch");
    check(c.body.p_site === "chatgpt.com", "and the site name, from the fixed allowlist");
  }
  {
    // A host outside the reportable list is not a tool we know, so nothing is
    // sent rather than something unrecognised being invented.
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordUsage("mail.google.com");
    check(usageCalls(env).length === 0, "an unsupported host is never reported");
    await env.mod.recordUsage("");
    check(usageCalls(env).length === 0, "and neither is an empty one");
  }
  {
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordUsage("app.chatgpt.com");
    check(usageCalls(env)[0].body.p_site === "chatgpt.com",
      "a subdomain normalises to the registered host, so one tool is one name");
  }

  console.log("\n--- 2. once per tool per day, which is the privacy property ---");
  {
    const env = await loadWorker({ storage: { ...connected } });
    for (let i = 0; i < 50; i++) await env.mod.recordUsage("chatgpt.com");
    check(usageCalls(env).length === 1,
      "fifty page loads of one tool in a day send ONE report, not fifty",
      String(usageCalls(env).length));
  }
  {
    const env = await loadWorker({ storage: { ...connected } });
    for (const h of ["chatgpt.com", "claude.ai", "gemini.google.com", "chatgpt.com", "claude.ai"]) {
      await env.mod.recordUsage(h);
    }
    check(usageCalls(env).length === 3, "three tools, three reports", String(usageCalls(env).length));
  }
  {
    // Yesterday's marker must not silence today.
    const env = await loadWorker({ storage: {
      ...connected, guardai_usage_sent: { "chatgpt.com": "2020-01-01" },
    } });
    await env.mod.recordUsage("chatgpt.com");
    check(usageCalls(env).length === 1, "a stale marker does not silence a new day");
  }
  {
    // A failed request must not consume the day.
    const env = await loadWorker({ storage: { ...connected }, ok: false });
    await env.mod.recordUsage("chatgpt.com");
    check(env.storage.guardai_usage_sent === undefined,
      "a refused report writes no marker, so the day is not silently lost");
  }
  {
    const env = await loadWorker({ storage: {
      ...connected,
      guardai_usage_sent: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => ["old" + i, "2020-01-01"])),
    } });
    await env.mod.recordUsage("chatgpt.com");
    check(Object.keys(env.storage.guardai_usage_sent).length === 1,
      "the marker is pruned to today, so it cannot grow without bound",
      String(Object.keys(env.storage.guardai_usage_sent).length));
  }

  console.log("\n--- 3. a personal licence reports nothing, ever ---");
  {
    const env = await loadWorker({ storage: {} });
    await env.mod.recordUsage("chatgpt.com");
    check(env.calls.length === 0, "no company connection means no request at all");
    check(env.storage.guardai_usage_sent === undefined, "and nothing is written locally either");
  }
  {
    const env = await loadWorker({ storage: {
      guardai_entitlement: { status: "active", kind: "individual", token: "t",
                             validUntil: null, hardStopAt: null, lastVerifiedAt: 1, lastError: null },
    } });
    await env.mod.recordUsage("chatgpt.com");
    check(env.calls.length === 0, "an individual licence holder is never reported on");
  }
  {
    const env = await loadWorker({ storage: {
      ...connected, guardai_usage_sent: { "chatgpt.com": new Date().toISOString().slice(0, 10) },
    } });
    await env.mod.disconnectCompany();
    check(env.storage.guardai_usage_sent === undefined,
      "disconnecting clears the local day markers with everything else");
  }

  console.log("\n--- 4. the content script asks for it once, on boot ---");
  {
    const src = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");
    const sends = (src.match(/GUARDAI_COMPANY_USAGE/g) || []).length;
    check(sends === 1, "content.js sends the usage message from exactly one place", String(sends));
    const at = src.indexOf("GUARDAI_COMPANY_USAGE");
    const around = src.slice(Math.max(0, at - 1200), at);
    check(/async function boot\(\)/.test(around) || /nlp\.init\(\)/.test(around),
      "and it is in boot(), not on a send path — a per-message ping would be an activity log");
    check(!/GUARDAI_COMPANY_USAGE[\s\S]{0,200}categories|categories[\s\S]{0,200}GUARDAI_COMPANY_USAGE/.test(src),
      "the usage message carries no findings");
  }

  console.log("\n--- 5. and the worker acts on it: boot() to POST, end to end ---");
  // Everything above proves the two halves separately: recordUsage is driven
  // directly, and content.js is read as text to confirm it sends. Neither
  // proves they are joined. They were not exercised together until the panel
  // came up empty on a live company with both halves demonstrably correct —
  // the answer was that nothing had booted a content script since the function
  // was deployed, and no test could have told us that, because no test ever
  // delivered the message. These do.
  {
    const env = await loadWorker({ storage: { ...connected } });
    const ret = env.send({ type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com" });
    await drain();
    const c = usageCalls(env)[0];
    check(usageCalls(env).length === 1, "one message from boot() becomes one record_usage POST",
      String(usageCalls(env).length));
    check(Boolean(c) && c.body.p_site === "chatgpt.com" && c.body.p_employee_id === SEAT,
      "carrying the seat and the tool, as recordUsage builds it");
    check(ret === undefined,
      "and the listener returns nothing: a usage ping never holds the message port open");
    check(Boolean(env.storage.guardai_usage_sent),
      "the day is marked only once the server has it");
  }
  {
    // The handler reads ONE field off the message. A content script that had
    // been tampered with cannot widen the body by attaching more to it.
    const env = await loadWorker({ storage: { ...connected } });
    env.send({
      type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com",
      categories: ["TFN"], text: "my tax file number is", employeeId: "someone-else",
    });
    await drain();
    const c = usageCalls(env)[0];
    check(JSON.stringify(Object.keys(c.body).sort()) === JSON.stringify(["p_employee_id", "p_site"]),
      "extra fields on the message are ignored, not forwarded", JSON.stringify(c.body));
    check(c.body.p_employee_id === SEAT, "and the seat comes from storage, never from the message");
  }
  {
    // The failure the deploy actually produced: the extension shipped before
    // the SQL landed. Every ping 404s. The day must survive that, or a single
    // badly timed release costs a day of every tool's usage.
    let deployed = false;
    const env = await loadWorker({
      storage: { ...connected },
      ok: () => (deployed ? 200 : 404),
    });

    env.send({ type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com" });
    await drain();
    check(usageCalls(env).length === 1 && usageCalls(env)[0].status === 404,
      "a ping sent before the function exists gets a 404");
    check(env.storage.guardai_usage_sent === undefined,
      "and writes no marker, so it has not spent the day");

    deployed = true;                       // the migration is applied
    env.send({ type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com" });
    await drain();
    check(usageCalls(env).length === 2, "the very next page load tries again");
    check(usageCalls(env)[1].status === 200 && Boolean(env.storage.guardai_usage_sent),
      "and lands, with no operator intervention");
  }
  {
    const env = await loadWorker({ storage: { ...connected } });
    env.send({ type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com" });
    await drain();
    env.send({ type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com" });
    await drain();
    check(usageCalls(env).length === 1,
      "a second boot the same day sends nothing, over the wire and not just in the function");
  }
  {
    const env = await loadWorker({ storage: {} });
    env.send({ type: "GUARDAI_COMPANY_USAGE", site: "chatgpt.com" });
    await drain();
    check(env.calls.length === 0, "an unconnected browser sends nothing when the message arrives");
  }

  console.log("\n--- 6. the SQL side ---");
  const SQL = path.join(SITE, "supabase", "usage-delta.sql");
  if (!fs.existsSync(SQL)) {
    console.log("skip  usage-delta.sql not found beside this checkout");
  } else {
    const sql = fs.readFileSync(SQL, "utf8");
    const table = (sql.match(/create table if not exists guardai_usage \(([\s\S]*?)\);/) || [])[1] || "";
    check(table.length > 0, "found the guardai_usage table");
    check(!/employee/i.test(table),
      "it has NO employee column — aggregate is a property of the schema, not of the queries",
      table.replace(/\s+/g, " ").trim());
    check(/primary key \(company_id, site, day\)/.test(table),
      "one company, one tool, one day, one number");

    const fn = (name) => {
      const i = sql.indexOf("create or replace function " + name);
      if (i === -1) return "";
      const a = sql.indexOf("as $$", i), b = sql.indexOf("$$;", a);
      return a === -1 ? "" : sql.slice(a, b);
    };
    const ru = fn("record_usage");
    check(/insert into guardai_usage/.test(ru) && !/employee_id\s*[,)]/.test(ru.split("insert into")[1] || ""),
      "record_usage stores no seat id, only the company it looked up");
    check(!/last_active_at/.test(ru),
      "and does not touch last_active_at — 'active' still means caught something");
    check(/p_site::guardai_site/.test(ru),
      "the site is cast through the allowlist, so a tool name cannot be invented");

    const br = fn("guardai_tool_breakdown");
    check(/< 5 then null/.test(br),
      "the breakdown is suppressed below five seats IN SQL, so the browser never holds the numbers");
    check(/round\(/.test(br) && !/'n',|'count',|'seats',/.test(br),
      "and returns rounded percentages only, never counts");
    check(/grant execute on function record_usage\(uuid, text\) to anon/.test(sql),
      "record_usage is reachable by the extension's key, like record_event");
    check(/alter table guardai_usage enable row level security/.test(sql) &&
          /revoke all on guardai_usage from public, anon, authenticated/.test(sql),
      "the table itself is closed to anon and RLS is on");
  }

  console.log("\n--- 7. the dashboard's tool list is generated, not a second copy ---");
  {
    const gen = path.join(SITE, "scripts", "gen-sites.mjs");
    if (!fs.existsSync(gen)) {
      console.log("skip  gen-sites.mjs not found beside this checkout");
    } else {
      const { spawnSync } = require("child_process");
      const r = spawnSync(process.execPath, [gen, "--check", ROOT], { cwd: SITE, encoding: "utf8" });
      check(r.status === 0, "sites.js is in step with the extension's SITES and PLATFORMS",
        (r.stderr || r.stdout || "").trim());

      const src = fs.readFileSync(path.join(SITE, "sites.js"), "utf8");
      const tools = JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
      const company = fs.readFileSync(path.join(ROOT, "src", "company.js"), "utf8");
      const sitesBlk = company.slice(company.indexOf("export const SITES"));
      const hosts = [...sitesBlk.slice(0, sitesBlk.indexOf("]")).matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1]);
      const covered = tools.flatMap((t) => t.hosts).sort();
      check(JSON.stringify(covered) === JSON.stringify(hosts.slice().sort()),
        `every reportable host appears exactly once (${hosts.length} hosts, ${tools.length} tools)`);
      const chatgpt = tools.find((t) => t.label === "ChatGPT");
      check(chatgpt && chatgpt.hosts.length === 2,
        "chatgpt.com and chat.openai.com are one row, not two");
      const gemini = tools.find((t) => t.label === "Gemini");
      check(gemini && gemini.hosts.length === 2, "and so are the two Gemini hosts");
    }
  }

  console.log(failures ? `\nUSAGE: ${failures} FAILURE(S)` : "\nUSAGE: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error("usage.cjs threw:", err); process.exit(1); });
