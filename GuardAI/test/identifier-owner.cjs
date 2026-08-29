/**
 * A person's fake email belongs to that person's fake name.
 *
 * ═══ WHY THIS IS NOT COSMETIC ══════════════════════════════════════════════
 *
 * Every generator drew independently, so a masked signature block named two
 * different people:
 *
 *     Dakota Ellery                       (real: Dana Whitcombe)
 *     declan.marshall45@placeholder.com   (real: dana.whitcombe@…)
 *
 * Filed as a cosmetic incoherence. A live round trip through ChatGPT showed
 * it costs more than that. The model read the local part, inferred a person
 * from it, and reported
 *
 *     "the sender is Dakota Ellery but the email belongs to Declan Marshall"
 *
 * as a DEFECT IN THE DOCUMENT — two of its fifteen findings were artefacts of
 * our own masking. And the second half of that sentence could not be
 * restored: the mapping table holds the whole address, never the name a
 * reader infers from it, so "Declan Marshall" stayed on screen while
 * "Dakota Ellery" beside it turned back into "Dana Whitcombe". The user's
 * report was "names unmask but emails don't"; emails restore fine, and what
 * did not restore was a name that had never been masked in the first place.
 *
 * Deriving the address from its owner's stand-in fixes both halves: the
 * signature reads as one person, and the name the AI infers is now a fake
 * that IS in the table.
 *
 * ═══ WHAT MUST NOT BREAK ═══════════════════════════════════════════════════
 *
 * Coherence never outranks safety. A derived local part is built from the
 * owner's FAKE name, which can itself collide with the REAL address — a
 * stand-in of "Dakota Ellery" is fine for "dana.whitcombe@…" and a leak for
 * "dakota.smith@…". §4 pins that. §3 pins the other direction: a shared
 * mailbox belongs to nobody, and binding hr@ to whoever is standing nearby
 * would invent a relationship the real document never asserted.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");
/* The MANIFEST's list, in the manifest's order — not a hand-written subset.
 * A shorter list silently changes behaviour: without names-gazetteer.js the
 * heading rule cannot rescue a name standing alone on its own line, and the
 * signature name in the fixture below stops being detected at all. That cost
 * an hour of chasing a "detection failure" that was only ever a harness
 * artefact. */
const SCRIPTS = require(path.join(ROOT, "manifest.json"))
  .content_scripts[0].js.map((p) => p.replace(/^src\//, ""));

function loadWindow() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://chatgpt.com/c/x",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {
    guardai_entitlement: {
      status: "active", kind: "individual", token: "test-token",
      validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
    },
  };
  w.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk];
          return o;
        }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  for (const f of SCRIPTS) w.eval(read(f));
  return w;
}

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/**
 * The offer letter's shape, reduced to what the rule needs.
 *
 * BLANK lines between blocks, not single newlines — this is load-bearing, not
 * formatting. A name run still crosses a single newline (limit #24), so
 * "Dana Whitcombe\nPeople and Culture" is captured as one over-long run and
 * fails the name shape, and the signature name is never detected at all.
 * Written with single newlines first, this fixture made §1 fail and §3 pass
 * VACUOUSLY — the role-account test cannot bind a name that was never found.
 * Hence the exercised-counters on every loop below.
 */
const LETTER = [
  "MERIDIAN FACILITIES GROUP PTY LTD",
  "",
  "Priya Raghunathan",
  "",
  "12/48 Larkspur Avenue, Marrickville NSW 2204",
  "",
  "Dear Priya,",
  "",
  "Thank you for meeting with Dana and me last Thursday. Your offer is",
  "attached. Marcus Ellery in payroll will be in touch about superannuation.",
  "",
  "You listed Anand Raghunathan as your emergency contact, reachable on",
  "0413 887 220. We will keep that on file alongside your personal email",
  "address, p.raghunathan91@outlook.com, which we use only for this.",
  "",
  "Yours sincerely,",
  "",
  "Dana Whitcombe",
  "",
  "People and Culture, Meridian Facilities Group",
  "",
  "dana.whitcombe@meridianfacilities.com.au",
].join("\n");

const localOf = (email) => String(email).split("@")[0];
/** The name a reader infers from a local part: "reese.marshall61" -> "Reese Marshall". */
const inferName = (email) =>
  localOf(email).split(/[.\d_-]+/).filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1)).join(" ");

(async () => {
  const w = loadWindow();
  await new Promise((r) => setTimeout(r, 60));
  const hooks = w.GuardAI._fileHooks;
  const restore = w.GuardAI._restoreHooks;
  check(!!hooks && !!restore, "content.js exposes the file + restore hooks");
  if (!hooks || !restore) { process.exit(1); return; }

  /* ---- 1. The signature block names ONE person ---- */
  console.log("\n--- a signature block reads as one person ---");
  {
    const { items } = await hooks.buildDocPreview(LETTER);
    const sig = items.find((i) => i.type === "NAME_PII" && i.value === "Dana Whitcombe");
    const em = items.find((i) => i.type === "EMAIL" && i.value.startsWith("dana."));
    check(!!sig && !!em, "the fixture's signature name and address are both detected",
      `name=${sig && sig.value} email=${em && em.value}`);
    if (sig && em) {
      const np = sig.fake.toLowerCase().split(/\s+/);
      check(localOf(em.fake).includes(np[np.length - 1]),
        "the fake address carries the fake signatory's surname",
        `${sig.fake} / ${em.fake}`);
      check(localOf(em.fake).startsWith(np[0]),
        "and their fake given name", `${sig.fake} / ${em.fake}`);
    }
  }

  /* ---- 2. Two people share a surname — the initial decides ---- */
  console.log("\n--- p.raghunathan91 belongs to Priya, not Anand ---");
  {
    // Run repeatedly: the fake names are random draws, and a rule that
    // happened to work for one pair proves nothing.
    let wrong = 0, checked = 0;
    const ex = [];
    for (let i = 0; i < 25; i++) {
      const w2 = loadWindow();
      await new Promise((r) => setTimeout(r, 20));
      const { items } = await w2.GuardAI._fileHooks.buildDocPreview(LETTER);
      const priya = items.find((x) => x.type === "NAME_PII" && x.value === "Priya Raghunathan");
      const anand = items.find((x) => x.type === "NAME_PII" && x.value === "Anand Raghunathan");
      const em = items.find((x) => x.type === "EMAIL" && x.value.startsWith("p.raghunathan"));
      if (!priya || !anand || !em) continue;
      checked++;
      const last = (f) => f.toLowerCase().split(/\s+/).pop();
      if (localOf(em.fake).includes(last(anand.fake)) &&
          !localOf(em.fake).includes(last(priya.fake))) {
        wrong++;
        if (ex.length < 2) ex.push(`${em.fake} (Priya=${priya.fake}, Anand=${anand.fake})`);
      }
    }
    check(checked >= 20, "the ambiguous case was actually exercised", `${checked}/25 runs usable`);
    check(wrong === 0,
      "a shared surname resolves by initial, not by whoever was found first",
      `${wrong}/${checked} bound to the wrong Raghunathan: ${ex.join(" | ")}`);
  }

  /* ---- 3. A shared mailbox belongs to nobody ---- */
  console.log("\n--- role accounts are not attached to a passer-by ---");
  {
    const TEXT = "Yours sincerely,\n\nDana Whitcombe\n\nPeople and Culture\n\nhr@meridianfacilities.com.au";
    let bound = 0, usable = 0;
    for (let i = 0; i < 20; i++) {
      const w2 = loadWindow();
      await new Promise((r) => setTimeout(r, 20));
      const { items } = await w2.GuardAI._fileHooks.buildDocPreview(TEXT);
      const name = items.find((x) => x.type === "NAME_PII");
      const em = items.find((x) => x.type === "EMAIL");
      if (!name || !em) continue;
      usable++;
      // The DERIVATION's signature is "first.last" — both halves of the
      // owner's stand-in. A surname alone matching is something else: two
      // different fake people drawing the same surname out of a 40-entry
      // pool, which happens about 1 run in 40 and is a coincidence, not a
      // binding. Asserting on the surname alone made this test fail 1/20 on
      // exactly that.
      const [first, ...rest] = name.fake.toLowerCase().split(/\s+/);
      const derived = `${first}.${rest[rest.length - 1]}`;
      if (localOf(em.fake).replace(/\d+$/, "") === derived) bound++;
    }
    // Without this the assertion below passes when nothing was detected.
    check(usable >= 18, "the role-account case was actually exercised", `${usable}/20 runs usable`);
    check(bound === 0, "hr@ does not inherit the name standing next to it", `${bound}/${usable} bound`);
  }

  /* ---- 4. SAFETY: the derived local part must not leak the real name ---- */
  console.log("\n--- coherence never outranks safety ---");
  {
    /**
     * The engineered collision: the owner's FAKE surname is the REAL address's
     * own surname. Deriving blindly would hand back the real name inside the
     * fake address. Forced deterministically via registerManual rather than
     * waiting for a ~2% coincidence.
     */
    const masker = new w.GuardAI.Masker();
    await masker.load();
    check(masker.wouldLeak("EMAIL", "dakota.smith@corp.com.au", "dakota.ellery9@placeholder.com"),
      "a derived address carrying the real given name is recognised as a leak");
    check(!masker.wouldLeak("EMAIL", "dana.whitcombe@corp.com.au", "dakota.ellery9@placeholder.com"),
      "control: an unrelated derived address is not flagged");
    check(masker.wouldLeak("USERNAME", "dellery", "dellery42"),
      "the same check covers handles");

    // The REFUSAL itself, driven directly. Waiting for the collision to occur
    // by chance needs the owner's random fake name to land on the real
    // address's own name — about 1 draw in 40 — so a 40-run loop is a coin
    // that mostly never comes up, and disabling the guard would not reliably
    // turn this red. Forcing the inputs makes it deterministic.
    const item = (type, value, fake) => ({ type, value, fake });
    check(hooks.safeDerivedFake(
      item("EMAIL", "dakota.smith@corp.com.au", "blake.wells12@placeholder.com"),
      "Dakota Ellery", new Set()) === null,
      "REFUSED: a fake given name that is the real address's given name");
    check(hooks.safeDerivedFake(
      item("EMAIL", "marcus.ellery@corp.com.au", "blake.wells12@placeholder.com"),
      "Rupert Ellery", new Set()) === null,
      "REFUSED: a fake surname that is the real address's surname");
    check(hooks.safeDerivedFake(
      item("USERNAME", "mellery", "bwells12"),
      "Rupert Ellery", new Set()) === null,
      "REFUSED: a handle whose derived form rebuilds the real surname");
    check(hooks.safeDerivedFake(
      item("EMAIL", "dana.whitcombe@corp.com.au", "blake.wells12@placeholder.com"),
      "Dakota Ellery", new Set()) === "dakota.ellery12@placeholder.com",
      "ACCEPTED: an unrelated owner derives cleanly, keeping domain and digits",
      String(hooks.safeDerivedFake(
        item("EMAIL", "dana.whitcombe@corp.com.au", "blake.wells12@placeholder.com"),
        "Dakota Ellery", new Set())));
    check(hooks.safeDerivedFake(
      item("EMAIL", "dana.whitcombe@corp.com.au", "blake.wells12@placeholder.com"),
      "Dakota Ellery", new Set(["dakota.ellery12@placeholder.com"])) === null,
      "REFUSED: a stand-in already handed to something else in this batch");

    // End to end: a document where the real address shares a token with a
    // plausible stand-in. Whatever is produced, the real tokens must not be in it.
    const TEXT = "Yours sincerely,\n\nDakota Smith\n\nOperations\n\ndakota.smith@corp.com.au";
    let leaks = 0, usable = 0;
    const ex = [];
    for (let i = 0; i < 40; i++) {
      const w2 = loadWindow();
      await new Promise((r) => setTimeout(r, 15));
      const { items } = await w2.GuardAI._fileHooks.buildDocPreview(TEXT);
      const em = items.find((x) => x.type === "EMAIL");
      const nm = items.find((x) => x.type === "NAME_PII");
      if (!em || !nm) continue;
      usable++;
      const local = localOf(em.fake).toLowerCase();
      if (local.includes("dakota") || local.includes("smith")) {
        leaks++;
        if (ex.length < 2) ex.push(em.fake);
      }
    }
    check(usable >= 35, "the collision case was actually exercised", `${usable}/40 runs usable`);
    check(leaks === 0, "no derived address ever carries a word of the real address",
      `${leaks}/${usable}: ${ex.join(" | ")}`);
  }

  /* ---- 5. The round trip: what the AI infers now restores ---- */
  console.log("\n--- the phantom defect is gone ---");
  {
    const { items } = await hooks.buildDocPreview(LETTER);
    const { buildSwapRules, applyRules, masker } = restore;
    await masker.clear();
    for (const it of items) masker.registerManual(it.value, it.fake, it.type);

    const sig = items.find((i) => i.type === "NAME_PII" && i.value === "Dana Whitcombe");
    const em = items.find((i) => i.type === "EMAIL" && i.value.startsWith("dana."));
    const inferred = inferName(em.fake);
    check(inferred === sig.fake,
      "the name a reader infers from the fake address IS the fake signatory",
      `inferred ${JSON.stringify(inferred)} vs ${JSON.stringify(sig.fake)}`);

    const reply = `The letter is signed by ${sig.fake} and the contact address is ` +
      `${em.fake}, so the email belongs to ${inferred}.`;
    const p = w.document.createElement("p");
    p.textContent = reply;
    w.document.body.appendChild(p);
    applyRules(p, buildSwapRules("unmask"));
    const out = p.textContent;

    check(!out.includes(sig.fake) && !out.includes(em.fake) && !out.includes(inferred),
      "no fake survives into what the user reads", out);
    check(out.includes("Dana Whitcombe") && out.includes("dana.whitcombe@meridianfacilities.com.au"),
      "and both real values are back", out);
  }

  /* ---- 6. Controls: the feature must not break ordinary masking ---- */
  console.log("\n--- controls ---");
  {
    const { items } = await hooks.buildDocPreview(LETTER);
    const emails = items.filter((i) => i.type === "EMAIL");
    const names = items.filter((i) => i.type === "NAME_PII");
    check(new Set(emails.map((e) => e.fake)).size === emails.length,
      "two people's addresses are still distinct", emails.map((e) => e.fake).join(" | "));
    check(new Set(names.map((n) => n.fake)).size === names.length,
      "and so are their names", names.map((n) => n.fake).join(" | "));
    const all = items.map((i) => i.fake);
    check(new Set(all).size === all.length, "no two findings share a stand-in at all");

    // An address with no person anywhere near it still gets a stand-in.
    const w2 = loadWindow();
    await new Promise((r) => setTimeout(r, 20));
    const { items: solo } = await w2.GuardAI._fileHooks.buildDocPreview(
      "Send the invoice to k.tremayne@example-supplier.com.au before Friday.");
    const em = solo.find((x) => x.type === "EMAIL");
    check(!!em && /@/.test(em.fake) && em.fake !== em.value,
      "an unowned address is still masked", em && em.fake);

    // PHONE has no name in it, so there is nothing to derive; it must be
    // untouched by this pass rather than quietly bound to someone.
    const phones = items.filter((i) => i.type === "PHONE");
    check(phones.every((p) => /\d/.test(p.fake) && p.fake !== p.value),
      "PHONE is unaffected", phones.map((p) => p.fake).join(" | "));
  }

  console.log(`\nIDENTIFIER-OWNER: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
