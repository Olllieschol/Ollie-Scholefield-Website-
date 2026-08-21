/**
 * Text integrity: masking must replace ONLY the detected values and must leave
 * every other character of the message exactly as written.
 *
 * The bug this locks down: with two people's names/addresses in one sentence,
 * the address pattern captured past the end of the address and swallowed the
 * next clause —
 *
 *   "James is currently at 14 Grove Street, Ryan is at 88 Kellett Parade.
 *    Let me know who you'd like to interview first."
 *
 * was detected as ADDRESS "14 Grove Street, Ryan" and ADDRESS
 * "88 Kellett Parade. Let". Masking then replaced those spans faithfully — so
 * the name "Ryan", the comma, the full stop and the word "Let" were all
 * DELETED from the user's message and a fake suburb appeared in their place,
 * reading as an invented word ("Cairns") that was never in the original.
 *
 * The checks below are deliberately structural rather than a golden string,
 * because the fakes are randomised per run:
 *
 *   1. INDEX INTEGRITY  — every finding's [index, index+len) actually spells
 *      its own `value` in the original text, and no two spans overlap.
 *   2. BOUNDARY         — no span starts or ends mid-word, and no captured
 *      value straddles a sentence boundary.
 *   3. RECONSTRUCTION   — the masked text equals the original with exactly
 *      those spans swapped for their fakes, and nothing else changed.
 *   4. SKELETON         — the specific non-sensitive words of the sentence
 *      survive verbatim. This is the one that actually catches over-capture:
 *      checks 1-3 all still pass when a detector's `value` wrongly includes
 *      the surrounding words, because the replacement machinery is doing
 *      exactly what it was told.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

/** Apply items to the original the only way that is correct by construction. */
function reconstruct(original, items) {
  const ordered = [...items].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const it of ordered) {
    out += original.slice(cursor, it.start) + it.fake;
    cursor = it.end;
  }
  return out + original.slice(cursor);
}

/**
 * Run checks 1-3 against any message. `survives` lists fragments of the
 * original that are not sensitive and must therefore appear untouched in the
 * masked output (check 4).
 */
function assertIntegrity(w, label, text, survives) {
  return maskText(w, text).then((r) => {
    const { items, masked, findings } = r;

    // 1. index integrity
    for (const f of findings) {
      const span = text.slice(f.index, f.index + f.value.length);
      check(span === f.value,
        `${label}: ${f.type} index points at its own value`,
        `index ${f.index} spells ${JSON.stringify(span)}, value is ${JSON.stringify(f.value)}`);
    }
    const ordered = [...items].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      check(ordered[i].start >= ordered[i - 1].end,
        `${label}: masked spans do not overlap`,
        `${JSON.stringify(ordered[i - 1].value)} and ${JSON.stringify(ordered[i].value)}`);
    }

    // 2. boundaries — nothing mid-word, nothing across a sentence break
    for (const f of findings) {
      const before = f.index > 0 ? text[f.index - 1] : "";
      const after = text[f.index + f.value.length] || "";
      check(!/[A-Za-z]/.test(before) || /[A-Za-z]/.test(f.value[0]) === false || !/[A-Za-z]/.test(before),
        `${label}: ${f.type} does not start mid-word`);
      check(!(/[A-Za-z0-9]/.test(after) && /[A-Za-z0-9]/.test(f.value.slice(-1))),
        `${label}: ${f.type} ${JSON.stringify(f.value)} does not end mid-word`,
        `next char is ${JSON.stringify(after)}`);
      check(!/[.!?;\n]\s/.test(f.value),
        `${label}: ${f.type} does not straddle a sentence boundary`,
        `value is ${JSON.stringify(f.value)}`);
    }

    // 3. reconstruction — masked is the original with only those spans swapped
    check(masked === reconstruct(text, items),
      `${label}: masked text is the original with only the detected spans replaced`,
      `got      ${JSON.stringify(masked)}\n        expected ${JSON.stringify(reconstruct(text, items))}`);

    // 4. the sentence skeleton survives verbatim
    for (const frag of survives) {
      check(masked.includes(frag),
        `${label}: preserved ${JSON.stringify(frag)}`,
        `masked: ${JSON.stringify(masked)}`);
    }

    return r;
  });
}

(async () => {
  const w = loadWindow();

  /* ---- 1. The exact reported message ---- */
  {
    const text =
      "James is currently at 14 Grove Street, Ryan is at 88 Kellett Parade. Let me know who you'd like to interview first.";
    const r = await assertIntegrity(w, "reported message", text, [
      // the second person's name, which used to be eaten by the first address
      "Ryan is at ",
      // the sentence break, which used to be eaten by the second address
      ". Let me know who you'd like to interview first.",
      "James is currently at ",
    ]);
    console.log("\n  original: " + text);
    console.log("  masked:   " + r.masked + "\n");
  }

  /* ---- 2. Two full names + two addresses (the shape the user asked for) ---- */
  {
    const text =
      "James Whitfield lives at 14 Grove Street, Ryan Mercer lives at 88 Kellett Parade. Please contact both.";
    const r = await assertIntegrity(w, "two full names + addresses", text, [
      " lives at ",
      ". Please contact both.",
    ]);
    check(!r.masked.includes("Whitfield"), "two full names: first surname masked");
    check(!r.masked.includes("Mercer"), "two full names: second surname masked");
    check(!r.masked.includes("Grove Street"), "two full names: first address masked");
    check(!r.masked.includes("Kellett Parade"), "two full names: second address masked");
    // "lives at" appears twice and must appear twice afterwards.
    check((r.masked.match(/ lives at /g) || []).length === 2,
      "two full names: both ' lives at ' clauses survive",
      JSON.stringify(r.masked));
    console.log("\n  original: " + text);
    console.log("  masked:   " + r.masked + "\n");
  }

  /* ---- 3. Legitimate suburb/state/postcode is still captured in full ---- */
  {
    const w2 = loadWindow();
    const det = new w2.GuardAI.Detector();
    const cases = [
      ["Send it to 14 Grove Street, Bondi Junction NSW 2022 before Friday.", "14 Grove Street, Bondi Junction NSW 2022"],
      ["He lives at 88 Kellett Parade, Randwick.", "88 Kellett Parade, Randwick"],
      ["The office is at 156 Esplanade, Cairns QLD 4870.", "156 Esplanade, Cairns QLD 4870"],
    ];
    for (const [text, expected] of cases) {
      const addr = det.scan(text).filter((f) => f.type === "ADDRESS").map((f) => f.value);
      check(addr.includes(expected),
        `suburb/state/postcode still captured in full: ${JSON.stringify(expected)}`,
        `got ${JSON.stringify(addr)}`);
    }
  }

  /* ---- 4. Address ending a sentence keeps its full stop out of the value ---- */
  {
    const w2 = loadWindow();
    const det = new w2.GuardAI.Detector();
    const text = "Mail it to 14 Grove Street. Thanks!";
    const addr = det.scan(text).filter((f) => f.type === "ADDRESS");
    check(addr.length === 1 && addr[0].value === "14 Grove Street",
      "trailing full stop is punctuation, not part of the address",
      JSON.stringify(addr.map((f) => f.value)));
  }

  /* ---- 5. Integrity holds across a battery of multi-entity messages ---- */
  {
    const battery = [
      ["two addresses, no names",
        "Drop off at 14 Grove Street, pick up from 88 Kellett Parade. Both are open.",
        [", pick up from ", ". Both are open."]],
      ["name, address, phone, email",
        "James Whitfield, 14 Grove Street, 0412 556 781, james@example.com. Call after 5.",
        [". Call after 5."]],
      ["address then capitalised sentence start",
        "The unit is 12 Wattle Road. Anna will meet you there.",
        [". Anna will meet you there."]],
      ["three people in a row",
        "Sarah Collins is at 5 Oak Street, Daniel Reeves is at 9 Pine Road, Grace Lam is at 22 Fig Lane. Confirm please.",
        [" is at ", ". Confirm please."]],
    ];
    for (const [label, text, survives] of battery) {
      await assertIntegrity(w, label, text, survives);
    }
  }

  console.log(`\nTEXT-INTEGRITY: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})();
