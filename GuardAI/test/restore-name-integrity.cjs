/**
 * Regression test for the name cross-contamination bug (Section 1 follow-up).
 *
 * Root cause (two parts, both in src/content.js):
 *   1. buildSwapRules() added a per-token alias for EVERY NAME_PII entry's
 *      fake first/last name ("Mia Clarke" -> also alias "Mia"->real-first and
 *      "Clarke"->real-last). The fake-name pool is only 16 first names x 14
 *      last names, so with enough people in one conversation two different
 *      real people commonly share a fake first OR last name. A per-token
 *      alias can only point at ONE real name, so the token became a GLOBAL
 *      rule — every other person who also drew that token silently got a
 *      stranger's real name spliced into their row.
 *   2. applyRules()/runUnmaskPass() ran the per-node pass (which includes
 *      those aliases) BEFORE the cross-node pass that resolves a name split
 *      across two DOM nodes (e.g. separate table cells) as one whole unit.
 *      So even an intact split name got its two halves independently
 *      "corrected" via mismatched aliases before the correct whole-name match
 *      ever got a chance to run.
 *
 * Fix: aliases are only created for tokens that are UNIQUE to one entry
 * (ambiguous tokens are left unaliased — better to leave a lone echo
 * unrestored than hand back a different real person's data), and cross-node
 * matching now runs first so an intact split name is resolved before any
 * per-node alias can touch it.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

function loadWindow() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://chatgpt.com/c/x",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {};
  w.chrome = {
    storage: {
      local: {
        get: (k) =>
          Promise.resolve(
            (Array.isArray(k) ? k : [k]).reduce((o, kk) => {
              if (kk in storage) o[kk] = storage[kk];
              return o;
            }, {})
          ),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  for (const f of ["detector.js", "masker.js", "nlp-detector.js", "content.js"]) w.eval(read(f));
  return w;
}

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log("pass  " + label);
  } else {
    failures++;
    console.log("FAIL  " + label + (detail ? " — " + detail : ""));
  }
}

/** Build a <table> with one <td> per given cell string (own text node each). */
function buildTable(doc, rows) {
  const table = doc.createElement("table");
  for (const cells of rows) {
    const tr = doc.createElement("tr");
    for (const cell of cells) {
      const td = doc.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  doc.body.appendChild(table);
  return table;
}

(async () => {
  const w = loadWindow();
  await new Promise((r) => setTimeout(r, 50)); // let content.js boot()
  const hooks = w.GuardAI._restoreHooks;
  check(!!hooks, "content.js exposes restore test hooks");
  if (!hooks) {
    process.exit(1);
    return;
  }
  const { buildSwapRules, applyRules, masker } = hooks;

  /* ---- Test A: deterministic engineered collision, split across cells ---- */
  {
    await masker.clear();
    masker.registerManual("Priya Natarajan", "Mia Clarke", "NAME_PII");
    masker.registerManual("Lucas Ferreira", "Grace Clarke", "NAME_PII"); // shares "Clarke"
    masker.registerManual("Ravi Chandrasekar", "Mia Whitmore", "NAME_PII"); // shares "Mia"

    const table = buildTable(w.document, [
      ["Mia", "Clarke", "row1"],
      ["Grace", "Clarke", "row2"],
      ["Mia", "Whitmore", "row3"],
    ]);

    const rules = buildSwapRules("unmask");
    applyRules(table, rules);

    const rowText = (i) => table.rows[i].textContent;
    check(rowText(0) === "PriyaNatarajanrow1" || rowText(0).includes("Priya") && rowText(0).includes("Natarajan"),
      "row1 (shared last-name token) restores to Priya Natarajan, not mixed", rowText(0));
    check(!rowText(0).includes("Ferreira") && !rowText(0).includes("Chandrasekar"),
      "row1 contains no OTHER person's real name fragment", rowText(0));

    check(rowText(1).includes("Lucas") && rowText(1).includes("Ferreira"),
      "row2 (shared last-name token) restores to Lucas Ferreira, not mixed", rowText(1));
    check(!rowText(1).includes("Priya") && !rowText(1).includes("Natarajan") && !rowText(1).includes("Chandrasekar"),
      "row2 contains no OTHER person's real name fragment", rowText(1));

    check(rowText(2).includes("Ravi") && rowText(2).includes("Chandrasekar"),
      "row3 (shared first-name token) restores to Ravi Chandrasekar, not mixed", rowText(2));
    check(!rowText(2).includes("Priya") && !rowText(2).includes("Natarajan") && !rowText(2).includes("Ferreira"),
      "row3 contains no OTHER person's real name fragment", rowText(2));

    table.remove();
  }

  /* ---- Test B: buildSwapRules never emits an alias for an ambiguous token ---- */
  {
    await masker.clear();
    masker.registerManual("Priya Natarajan", "Mia Clarke", "NAME_PII");
    masker.registerManual("Ravi Chandrasekar", "Mia Whitmore", "NAME_PII"); // shares "Mia"
    masker.registerManual("Daniel Okafor", "Henry Reid", "NAME_PII"); // all-unique tokens

    const rules = buildSwapRules("unmask");
    const aliasKeys = rules.filter((r) => !r.multi).map((r) => r.key);
    check(!aliasKeys.includes("Mia"), "ambiguous token \"Mia\" gets NO alias rule", JSON.stringify(aliasKeys));
    check(aliasKeys.includes("Henry") && aliasKeys.includes("Reid"),
      "unique tokens still get their alias rule (feature preserved)", JSON.stringify(aliasKeys));
  }

  /* ---- Test C: ambiguous lone-token echo stays unrestored (not guessed wrong) ---- */
  {
    await masker.clear();
    masker.registerManual("Priya Natarajan", "Mia Clarke", "NAME_PII");
    masker.registerManual("Ravi Chandrasekar", "Mia Whitmore", "NAME_PII");
    const p = w.document.createElement("p");
    p.textContent = "Hi Mia, following up on your request.";
    w.document.body.appendChild(p);
    applyRules(p, buildSwapRules("unmask"));
    check(p.textContent.includes("Mia"), "ambiguous lone token is left as-is, not restored to either person", p.textContent);
    check(!p.textContent.includes("Priya") && !p.textContent.includes("Ravi"),
      "ambiguous lone token is not silently assigned to the wrong person", p.textContent);
    p.remove();
  }

  /* ---- Test D: unique lone-token echo still restores (partial-echo feature) ---- */
  {
    await masker.clear();
    masker.registerManual("James Whitfield", "Zephyrina Quokka", "NAME_PII"); // globally unique tokens
    const p = w.document.createElement("p");
    p.textContent = "Hi Zephyrina, thanks for the update.";
    w.document.body.appendChild(p);
    applyRules(p, buildSwapRules("unmask"));
    check(p.textContent.includes("James"), "unique lone token still restores via alias", p.textContent);
    p.remove();
  }

  /* ---- Test E: intact single-node full name still restores (no regression) ---- */
  {
    await masker.clear();
    masker.registerManual("Priya Natarajan", "Mia Clarke", "NAME_PII");
    masker.registerManual("Lucas Ferreira", "Grace Clarke", "NAME_PII");
    const p = w.document.createElement("p");
    p.textContent = "Please contact Mia Clarke about the invoice.";
    w.document.body.appendChild(p);
    applyRules(p, buildSwapRules("unmask"));
    check(p.textContent.includes("Priya Natarajan"), "intact single-node full fake name still restores correctly", p.textContent);
    check(!p.textContent.includes("Ferreira"), "no cross-contamination on the intact-node path", p.textContent);
    p.remove();
  }

  /* ---- Test F: at-scale, real masker-generated fakes for 15 real names ---- */
  {
    await masker.clear();
    const REAL_NAMES = [
      "James Whitfield", "Priya Natarajan", "Connor Blake", "Mei Lin Tan", "Daniel Okafor",
      "Sarah Whitmore", "Tomasz Kowalski", "Aisha Rahman", "Lucas Ferreira", "Grace Tomlinson",
      "Ravi Chandrasekar", "Olivia Marsh", "Hassan Al-Amin", "Chloe Bennett", "Marco Esposito",
    ];
    const pairs = [];
    for (const real of REAL_NAMES) {
      const findings = [{ type: "NAME_PII", value: real, index: 0 }];
      const { replacements } = await masker.mask(real, findings);
      pairs.push({ real, fake: replacements[0].fake });
    }
    const firstTokens = pairs.map((p) => p.fake.split(" ")[0]);
    const lastTokens = pairs.map((p) => p.fake.split(" ").slice(1).join(" "));
    const collisions =
      firstTokens.length - new Set(firstTokens).size + (lastTokens.length - new Set(lastTokens).size);
    console.log(`  (info) ${collisions} fake first/last-name token collision(s) among 15 natural draws`);

    // Row cells hold ONLY fake text (first name, last name split across two
    // <td>s) — exactly what applyRules ever sees in production, since real
    // names are masked before the AI sees anything and can never appear in
    // an AI response. Row identity is tracked by array position, not by
    // embedding real-name text in the DOM (embedding it would let an
    // unrelated fake that happens to collide with another attendee's actual
    // real name — both drawn from the same everyday-name pool — match a
    // string that could never legitimately occur in a live response, which
    // is a test-harness artifact, not a product bug).
    const rows = pairs.map((p) => {
      const [first, ...rest] = p.fake.split(" ");
      return [first, rest.join(" ")];
    });
    const table = buildTable(w.document, rows);
    applyRules(table, buildSwapRules("unmask"));

    let bad = 0;
    for (let i = 0; i < pairs.length; i++) {
      const text = table.rows[i].textContent;
      const ownReal = pairs[i].real;
      const othersReal = pairs.filter((_, j) => j !== i).map((p) => p.real);
      const hasOwnFull = text.includes(ownReal);
      const hasOtherFragment = othersReal.some((r) => {
        const [f, ...rest] = r.split(" ");
        const l = rest.join(" ");
        return (text.includes(f) && !ownReal.startsWith(f)) || (text.includes(l) && !ownReal.endsWith(l));
      });
      if (!hasOwnFull || hasOtherFragment) {
        bad++;
        console.log(`  FAIL row for ${ownReal}: got "${text}"`);
      }
    }
    check(bad === 0, `all 15 rows restore to their own real name with no cross-contamination (${collisions} collisions were present)`);
    table.remove();
  }

  console.log(`\nRESTORE-NAME-INTEGRITY: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
