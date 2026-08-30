/**
 * Attachment counts: the second thing that now leaves the browser.
 *
 * ═══ WHAT THIS FILE IS DEFENDING ═══════════════════════════════════════════
 *
 * Before this, the server heard about an attachment only when something was
 * BLOCKED in it, arriving as a category indistinguishable from a typed
 * message. So an admin saw catches with no denominator, and had no way at all
 * to see how much of what their team attaches Guard4AI cannot open — which is
 * the honest limit of the product.
 *
 * Filling that meant sending something new about every file, including the
 * ones nothing was found in. On a privacy product that is exactly the change
 * that has to be pinned down:
 *
 *   TWO FIELDS. A broad type and one of three outcomes. Not the filename, not
 *   the size, not a character of the contents, not the findings.
 *
 *   EVERY VERDICT IS MAPPED. Eight verdicts fold to three outcomes, and the
 *   fold lives in two files because a classic content script cannot import a
 *   module. A verdict with no mapping would be silently dropped and undercount
 *   the very number the panel exists for, so both copies are run over every
 *   ACTION constant and compared.
 *
 *   NOTHING ON A PERSONAL LICENCE.
 *
 *   AND THE WIRE BETWEEN THE TWO ENDS. Driving recordFiles directly and
 *   reading content.js as text proves each end and not the join. The usage
 *   ping showed what that misses: both ends correct, nothing ever delivered,
 *   an empty dashboard panel and no failing test. Section 7 delivers the
 *   message the way Chrome does and follows it out to the request.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "..", "..", "..", "Documents", "guardaigo-landing 44");
const SEAT = "9c1f8e40-0000-4000-8000-00000000b27a";

/** filescan.js the way a content script loads it: a classic script on window. */
function loadFileScan() {
  const sb = { window: {}, module: undefined };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "filescan.js"), "utf8"), sb);
  return sb.window.GuardAI.FileScan;
}

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
    // `ok` may be a function so one worker can answer differently over its
    // life, and may say "offline" to make the request throw the way a dropped
    // connection does. Section 7 needs both.
    const verdict = typeof ok === "function" ? ok(String(url), body) : ok;
    const status = typeof verdict === "number" ? verdict : (verdict ? 200 : 500);
    env.calls.push({ url: String(url), body, status: verdict === "offline" ? null : status });
    if (verdict === "offline") throw new TypeError("Failed to fetch");
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  };
  // Deliver a message the way Chrome does, rather than calling the handler.
  // Returns whatever the listener returned, which is itself worth asserting:
  // a truthy return holds the message port open.
  env.send = (msg) => {
    let ret;
    for (const f of env.listeners.message) ret = f(msg, { id: "test-sender" }, () => {});
    return ret;
  };
  env.mod = await import("../background.js?fseq=" + (++seq));
  return env;
}
const connected = { guardai_company: { employeeId: SEAT, companyName: "Acme Pty Ltd", connectedAt: 1 } };
const fileCalls = (env) => env.calls.filter((c) => c.url.includes("record_files"));

(async () => {
  const C = await import("../src/company.js");
  const FS = loadFileScan();

  console.log("\n--- 1. eight verdicts, three outcomes, none unmapped ---");
  {
    const actions = Object.values(FS.ACTION);
    check(actions.length >= 9, `filescan declares ${actions.length} verdicts`);
    const unmapped = actions.filter((a) => C.fileFacts("pdf", a) === null);
    check(unmapped.length === 0,
      "every verdict folds to an outcome — an unmapped one would be dropped and undercount",
      unmapped.join(", "));
    const kinds = Object.values(FS.KIND);
    const unmappedK = kinds.filter((k) => C.fileFacts(k, "pass") === null);
    check(unmappedK.length === 0, "and every file kind maps", unmappedK.join(", "));
  }
  {
    // The three buckets the dashboard shows, spelled out rather than inferred.
    const want = {
      pass: "checked", "img-nothing": "checked",
      block: "blocked", "img-found": "blocked",
      unreadable: "unreadable", unsupported: "unreadable", "too-large": "unreadable",
      "img-unreadable": "unreadable", "pdf-partial": "unreadable",
    };
    let wrong = 0;
    for (const [action, outcome] of Object.entries(want)) {
      const got = C.fileFacts("pdf", action);
      if (!got || got.outcome !== outcome) { wrong++; console.log(`      ${action} -> ${got && got.outcome}`); }
    }
    check(wrong === 0, "each verdict lands in the bucket an admin would expect");
    check(C.fileFacts("pdf", "pdf-partial").outcome === "unreadable",
      "a scanned PDF cut off by the page cap counts as UNREADABLE, not checked — " +
      "the file as a whole was not seen");
    check(C.fileFacts("unsupported", "unsupported").kind === "other",
      "an unsupported format reports as 'other', not as its extension");
  }

  console.log("\n--- 2. the two copies of the fold agree ---");
  {
    /* company.js is imported by the worker; filescan.js carries a copy because
       content.js is a classic script and cannot import it. */
    let mismatch = 0;
    const kinds = Object.values(FS.KIND).concat(["nonsense", "", null]);
    const actions = Object.values(FS.ACTION).concat(["nonsense", "", null]);
    for (const k of kinds) {
      for (const a of actions) {
        const x = JSON.stringify(C.fileFacts(k, a));
        const y = JSON.stringify(FS.fileFacts(k, a));
        if (x !== y) { mismatch++; console.log(`      ${k}/${a}: module ${x} vs filescan ${y}`); }
      }
    }
    check(mismatch === 0,
      `both copies agree across ${kinds.length * actions.length} pairs`, mismatch + " mismatches");
  }

  console.log("\n--- 3. the body is two fields, and refuses anything else ---");
  {
    check(JSON.stringify(C.buildFileBody("pdf", "checked")) === '{"kind":"pdf","outcome":"checked"}',
      "a valid pair builds the body");
    for (const [k, o] of [["exe", "checked"], ["pdf", "deleted"], ["", ""], [null, null],
                          ["PDF", "checked"], ["pdf", "CHECKED"]]) {
      check(C.buildFileBody(k, o) === null, `refused: ${JSON.stringify([k, o])}`);
    }
    const body = C.buildFileBody("image", "unreadable");
    check(Object.keys(body).length === 2, "and the finished body has exactly two keys");
  }

  console.log("\n--- 4. what the worker actually sends ---");
  {
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordFiles([
      { kind: "pdf", outcome: "checked" },
      { kind: "image", outcome: "unreadable" },
    ]);
    const c = fileCalls(env)[0];
    check(Boolean(c), "a connected seat reports the batch");
    check(JSON.stringify(Object.keys(c.body).sort()) === JSON.stringify(["p_employee_id", "p_items"]),
      "two top-level fields", JSON.stringify(Object.keys(c.body)));
    check(fileCalls(env).length === 1, "one request per attach, not one per file");
    check(c.body.p_items.every((i) => Object.keys(i).length === 2),
      "and every item is exactly two fields");
  }
  {
    // The thing that must never happen: a whole scan result being forwarded.
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordFiles([{
      kind: "pdf", outcome: "checked",
      name: "Q4 payroll.pdf", bytes: 918_233, text: "Sarah Chen 0412 345 678",
      summary: { counts: { TFN: 2 } }, pagesRead: 3,
    }]);
    const sent = JSON.stringify(fileCalls(env)[0].body);
    check(!/payroll|Sarah|0412|bytes|918|summary|TFN|pagesRead|name/i.test(sent),
      "a result carrying a filename, a size and extracted text sends NONE of it", sent);
    check(sent.includes('"kind":"pdf"') && sent.includes('"outcome":"checked"'),
      "only the two fields survive");
  }
  {
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordFiles([{ kind: "exe", outcome: "checked" }]);
    check(fileCalls(env).length === 0, "a batch of only-invalid items sends nothing");
    await env.mod.recordFiles([{ kind: "exe", outcome: "checked" }, { kind: "pdf", outcome: "blocked" }]);
    const c = fileCalls(env)[0];
    check(c && c.body.p_items.length === 1, "and a mixed batch drops the bad row rather than the good one");
  }
  {
    const env = await loadWorker({ storage: { ...connected } });
    await env.mod.recordFiles([]);
    await env.mod.recordFiles(null);
    await env.mod.recordFiles("pdf");
    check(fileCalls(env).length === 0, "empty, null and nonsense batches send nothing");
  }

  console.log("\n--- 5. nothing on a personal licence ---");
  {
    const env = await loadWorker({ storage: {} });
    await env.mod.recordFiles([{ kind: "pdf", outcome: "checked" }]);
    check(env.calls.length === 0, "no company connection means no request at all");
  }

  console.log("\n--- 6. the content script sends it from the file path only ---");
  {
    const src = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");
    check((src.match(/GUARDAI_COMPANY_FILES/g) || []).length === 1,
      "content.js sends it from exactly one place");
    const fnAt = src.indexOf("function reportCompanyFiles");
    const fn = src.slice(fnAt, src.indexOf("\n  }", fnAt));
    check(/it\.kind/.test(fn) && /it\.outcome/.test(fn),
      "and builds each row from two named reads");
    check(!/\.\.\.|Object\.assign/.test(fn),
      "never by spreading a result, which is how a filename would get out");
  }

  console.log("\n--- 7. and the worker acts on it: the attach path, end to end ---");
  // Sections 4 and 6 prove each end and not the wire between them: recordFiles
  // is driven directly, and content.js is read as text. The usage ping showed
  // what that misses — both ends correct, nothing delivered, an empty panel and
  // no failing test anywhere. So deliver the message the way Chrome does and
  // follow it out to the request. This path matters more than the usage one:
  // a whole scan result is what sits on the other side of it.
  {
    const env = await loadWorker({ storage: { ...connected } });
    const ret = env.send({ type: "GUARDAI_COMPANY_FILES", items: [
      { kind: "pdf", outcome: "checked" },
      { kind: "image", outcome: "unreadable" },
    ] });
    await drain();
    const c = fileCalls(env)[0];
    check(fileCalls(env).length === 1, "one attach becomes one record_files POST",
      String(fileCalls(env).length));
    check(Boolean(c) && c.body.p_items.length === 2 && c.body.p_employee_id === SEAT,
      "carrying both rows and the seat, as recordFiles builds it");
    check(ret === undefined,
      "and the listener returns nothing: an attach report never holds the message port open");
  }
  {
    // The leak this whole design exists to prevent, tested at the boundary a
    // scan result actually crosses. The handler is handed the real shape.
    const env = await loadWorker({ storage: { ...connected } });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{
      kind: "pdf", outcome: "blocked",
      name: "Q4 payroll.pdf", bytes: 918_233, text: "Sarah Chen 0412 345 678",
      summary: { counts: { TFN: 2 } }, pagesRead: 3,
    }] });
    await drain();
    const sent = JSON.stringify(fileCalls(env)[0].body);
    check(!/payroll|Sarah|0412|bytes|918|summary|TFN|pagesRead|name/i.test(sent),
      "a message carrying a filename, a size and extracted text sends NONE of it", sent);
    check(sent.includes('"kind":"pdf"') && sent.includes('"outcome":"blocked"'),
      "only the two fields survive the trip");
  }
  {
    // Fields hung off the message itself, rather than off an item.
    const env = await loadWorker({ storage: { ...connected } });
    env.send({
      type: "GUARDAI_COMPANY_FILES", items: [{ kind: "docx", outcome: "checked" }],
      site: "chatgpt.com", categories: ["TFN"], employeeId: "someone-else",
      text: "the whole document", filename: "contract.docx",
    });
    await drain();
    const c = fileCalls(env)[0];
    check(JSON.stringify(Object.keys(c.body).sort()) === JSON.stringify(["p_employee_id", "p_items"]),
      "extra fields on the message are ignored, not forwarded", JSON.stringify(c.body));
    check(c.body.p_employee_id === SEAT, "and the seat comes from storage, never from the message");
  }
  {
    // Unlike the usage ping there is no dedupe here, deliberately: a second
    // attach is a second attach, and the panel counts attachments.
    const env = await loadWorker({ storage: { ...connected } });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{ kind: "pdf", outcome: "checked" }] });
    await drain();
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{ kind: "pdf", outcome: "checked" }] });
    await drain();
    check(fileCalls(env).length === 2, "a second attach is counted, not swallowed as a duplicate",
      String(fileCalls(env).length));
  }
  {
    // A batch of nothing sendable must not produce an empty request, and a
    // malformed message must not reach the network at all.
    const env = await loadWorker({ storage: { ...connected } });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{ kind: "exe", outcome: "checked" }] });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [] });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: null });
    env.send({ type: "GUARDAI_COMPANY_FILES" });
    await drain();
    check(env.calls.length === 0, "invalid, empty and absent batches send nothing",
      JSON.stringify(env.calls));
  }
  {
    // Losing a batch is acceptable; queueing one is not. Nothing about an
    // attachment may sit on disk waiting for a second attempt.
    const env = await loadWorker({ storage: { ...connected }, ok: () => 500 });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{ kind: "pdf", outcome: "checked" }] });
    await drain();
    check(fileCalls(env).length === 1 && fileCalls(env)[0].status === 500, "a refused batch is attempted once");
    check(JSON.stringify(env.storage) === JSON.stringify(connected),
      "and is dropped, never queued: nothing about it is written to storage",
      JSON.stringify(env.storage));
  }
  {
    // Offline. The handler does not await recordFiles, so a rejection here
    // would be an unhandled one, which in a service worker is a crash.
    const env = await loadWorker({ storage: { ...connected }, ok: () => "offline" });
    let unhandled = null;
    const onBad = (e) => { unhandled = e; };
    process.on("unhandledRejection", onBad);
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{ kind: "image", outcome: "unreadable" }] });
    await drain();
    await drain();
    process.off("unhandledRejection", onBad);
    check(unhandled === null, "a thrown request is swallowed, not left as an unhandled rejection",
      String(unhandled));
    check(JSON.stringify(env.storage) === JSON.stringify(connected), "and nothing is written");
  }
  {
    const env = await loadWorker({ storage: {} });
    env.send({ type: "GUARDAI_COMPANY_FILES", items: [{ kind: "pdf", outcome: "checked" }] });
    await drain();
    check(env.calls.length === 0, "an unconnected browser sends nothing when the message arrives");
  }

  console.log("\n--- 8. the SQL side ---");
  const SQL = path.join(SITE, "supabase", "files-delta.sql");
  if (!fs.existsSync(SQL)) {
    console.log("skip  files-delta.sql not found beside this checkout");
  } else {
    const sql = fs.readFileSync(SQL, "utf8");
    const table = (sql.match(/create table if not exists guardai_files \(([\s\S]*?)\);/) || [])[1] || "";
    check(table.length > 0, "found the guardai_files table");
    check(!/employee/i.test(table), "it has NO employee column", table.replace(/\s+/g, " ").trim());
    check(!/name|size|bytes|filename/i.test(table), "and no filename or size column");
    check(/guardai_file_kind/.test(table) && /guardai_file_outcome/.test(table),
      "both columns are closed allowlists, so a type or outcome cannot be invented");

    const fn = (n) => { const i = sql.indexOf("create or replace function " + n);
      if (i === -1) return ""; const a = sql.indexOf("as $$", i); return sql.slice(a, sql.indexOf("$$;", a)); };
    const rf = fn("record_files");
    check(/TOO_MANY_ITEMS/.test(rf), "record_files caps a batch rather than accepting any length");
    check(!/last_active_at/.test(rf), "and does not touch last_active_at");
    const summary = fn("guardai_file_summary");
    check(/< 5 then null/.test(summary),
      "the panel is suppressed below five seats IN SQL, the same gate as the tools panel");
    check(/unreadable_by_kind/.test(summary),
      "and breaks the unreadable count down by type, which is the row an admin acts on");
    check(/grant execute on function record_files\(uuid, jsonb\) to anon/.test(sql),
      "record_files is reachable by the extension's key");
    check(/alter table guardai_files enable row level security/.test(sql),
      "RLS is on");
  }

  console.log(failures ? `\nFILES: ${failures} FAILURE(S)` : "\nFILES: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("files.cjs threw:", e); process.exit(1); });
