/**
 * Detector resilience: malformed/non-string input must never throw, and no
 * adversarial input should be able to hang the page. Every case must
 * complete well under a second; the detector's own MAX_SCAN_LENGTH truncation
 * already bounds worst-case work, so this is a tight ceiling once that's
 * working, not a generous one.
 *
 * The two ReDoS-shaped cases are explicit regressions for real bugs found in
 * Section 3 testing:
 *   - detectEmail's old `[localpart]+@[domain]` pattern catastrophically
 *     backtracked on a long run of local-part-eligible chars (digits/dots/
 *     dashes) with no "@" following — measured 5.5s on a 100K-char input.
 *   - detectCreditCard's old `(?:\d[ -]?){13,19}` pattern catastrophically
 *     backtracked on a long digit/dash run that ultimately fails to match —
 *     measured 73.9s on a 380K-char input.
 * Both were fixed by restructuring the regex to avoid an ambiguous optional-
 * inside-a-repeated-group shape. This test exists so neither can regress
 * silently — a future edit that reintroduces the pattern will show up here
 * as a multi-second (or multi-minute) run, not a subtle behavioural diff.
 */
const { loadWindow } = require("./_env.cjs");

const MAX_MS = 1000;

const CASES = [
  ["empty string", ""],
  ["null", null],
  ["undefined", undefined],
  ["number", 12345],
  ["object", { foo: "bar" }],
  ["array", ["a", "b"]],
  ["huge plain text (2MB)", "a".repeat(2_000_000)],
  ["huge digit run", "5".repeat(500_000)],
  ["huge dollar signs", "$".repeat(200_000) + "1000"],
  ["many repeated money amounts", "Balance $1,234.56 ".repeat(50_000)],
  ["many repeated phone-shaped numbers", "call 0412 556 781 now. ".repeat(50_000)],
  ["pathological whitespace/separators", "0" + " -.()[]".repeat(100_000) + "0"],
  ["zero-width + combining chars", "J​ám‌es Whitfield ".repeat(5000)],
  ["RTL override abuse", "‮evil‬ ".repeat(20000) + "TFN 234 567 891"],
  ["deeply nested emoji", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(20000)],
  ["ReDoS regression: email local-part run, no @", ("a1.b2-c3_" .repeat(15000))],
  ["ReDoS regression: card-shaped digit/dash run, no match", "4111-1111-1111-111".repeat(20000)],
  ["single huge line no newlines", "x".repeat(300000) + " $5000 balance"],
  ["adversarial nested parens for phone ctx", "(".repeat(50000) + "0412556781" + ")".repeat(50000)],
];

(async () => {
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  let failures = 0;
  for (const [name, input] of CASES) {
    const t0 = Date.now();
    try {
      const findings = det.scan(input);
      const ms = Date.now() - t0;
      const slow = ms > MAX_MS;
      console.log(`${slow ? "FAIL " : "pass "} ${name.padEnd(48)} ${ms}ms  findings=${Array.isArray(findings) ? findings.length : "N/A"}${slow ? " ** OVER " + MAX_MS + "ms **" : ""}`);
      if (slow) failures++;
    } catch (e) {
      const ms = Date.now() - t0;
      failures++;
      console.log(`FAIL  ${name.padEnd(48)} ${ms}ms  THREW: ${e && e.message}`);
    }
  }
  console.log(`\nPERF/REDOS: ${failures === 0 ? "ALL OK" : failures + " problem(s)"}`);
  process.exit(failures ? 1 : 0);
})();
