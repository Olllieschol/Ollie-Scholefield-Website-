/**
 * Single entry point for `npm test`. Runs every harness/test file and
 * aggregates their exit codes: exits 1 if ANY suite fails or leaks, 0 only if
 * every suite passes clean. This is what closes the loop on "detection/
 * masking regressions get caught automatically" — before this, none of the
 * four original harnesses (audit.cjs, harness.cjs, harness-submit.cjs,
 * bug1-variants.cjs) actually failed the process on a real regression; they
 * only wrote an output file. See each file's own exit-code fix for detail.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const SUITES = [
  // Root-level end-to-end harnesses (drive the real content.js/detector/masker
  // through jsdom, exercising send/pause/split behaviour and the field-level
  // masking audit).
  { name: "audit.cjs (15-record field-level masking audit)", file: "audit.cjs" },
  { name: "harness.cjs (send/pause/split end-to-end)", file: "harness.cjs" },
  { name: "harness-submit.cjs (hostile beforeinput editors)", file: "harness-submit.cjs" },
  { name: "bug1-variants.cjs (header-as-name regression)", file: "bug1-variants.cjs" },
  // Detection quality.
  { name: "detect-adversarial.cjs (realistic blind-spot battery)", file: "test/detect-adversarial.cjs" },
  { name: "detect-falsepositive.cjs (over-masking battery)", file: "test/detect-falsepositive.cjs" },
  { name: "table-layout.cjs (CSV/markdown table leaks)", file: "test/table-layout.cjs" },
  { name: "label-retype.cjs (labelled numbers not mislabelled 'Phone')", file: "test/label-retype.cjs" },
  { name: "masking-policy.cjs (always-mask / never-auto-mask / manual override)", file: "test/masking-policy.cjs" },
  { name: "category-toggles.cjs (What GuardAI masks — per-category on/off)", file: "test/category-toggles.cjs" },
  { name: "text-integrity.cjs (masking never alters surrounding text)", file: "test/text-integrity.cjs" },
  { name: "refs-email-flight.cjs (email formats, reference consistency, flight exclusion)", file: "test/refs-email-flight.cjs" },
  { name: "credentials.cjs (usernames + passwords detected by phrasing)", file: "test/credentials.cjs" },
  { name: "credential-fakes.cjs (unique realistic credential fakes, real pipeline)", file: "test/credential-fakes.cjs" },
  // Section 1 core bug regressions.
  { name: "section1-bugs.cjs (licence/address/auto-replace)", file: "test/section1-bugs.cjs" },
  { name: "restore-name-integrity.cjs (name cross-contamination)", file: "test/restore-name-integrity.cjs" },
  // Section 3 additions.
  { name: "restore-robustness.cjs (multi-turn restore edge cases)", file: "test/restore-robustness.cjs" },
  { name: "resilience.cjs (storage failure / malformed data / table cap)", file: "test/resilience.cjs" },
  { name: "perf-redos.cjs (malformed input + ReDoS regressions)", file: "test/perf-redos.cjs" },
  // Section 4 additions.
  { name: "site-config.cjs (per-platform selector consistency)", file: "test/site-config.cjs" },
  { name: "claude-selectors.cjs (claude.ai root + assistant bubble)", file: "test/claude-selectors.cjs" },
  { name: "generic-toggle.cjs (Show what AI sees on selector-less platforms)", file: "test/generic-toggle.cjs" },
  // Post-Section-5 fixes.
  { name: "toggle-off-hides-ui.cjs (master toggle hides all injected UI)", file: "test/toggle-off-hides-ui.cjs" },
  { name: "toggle-preserves-data.cjs (toggle pauses, never wipes history)", file: "test/toggle-preserves-data.cjs" },
  { name: "clear-remasks-page.cjs (Clear visibly remasks before wiping, both trigger paths)", file: "test/clear-remasks-page.cjs" },
  { name: "panel-item-delete.cjs (per-item forget, leaves other items untouched)", file: "test/panel-item-delete.cjs" },
  { name: "popup-clear-arm.cjs (popup Clear is click-to-arm, not window.confirm)", file: "test/popup-clear-arm.cjs" },
  { name: "panel-no-autoopen.cjs (panel never pops open on its own)", file: "test/panel-no-autoopen.cjs" },
  { name: "panel-autopanel-setting.cjs (opt-in panel auto-open after Mask & Send)", file: "test/panel-autopanel-setting.cjs" },
  { name: "silent-mode.cjs (silent auto-mask + safe fallback)", file: "test/silent-mode.cjs" },
];

let anyFail = false;
const results = [];

for (const suite of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [suite.file], { cwd: ROOT, encoding: "utf8" });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  if (!ok) anyFail = true;
  results.push({ ...suite, ok, ms, status: r.status });
  console.log(`${ok ? "PASS" : "FAIL"}  ${suite.name}  (${ms}ms, exit ${r.status})`);
  if (!ok) {
    // Show the tail of output for a failing suite so the failure is visible
    // without having to re-run it manually.
    const out = (r.stdout || "") + (r.stderr || "");
    const tail = out.split("\n").slice(-25).join("\n");
    console.log("  --- last 25 lines of output ---");
    console.log(tail.split("\n").map((l) => "  " + l).join("\n"));
    console.log("  --- end ---");
  }
}

console.log("\n========================================");
console.log(`RESULT: ${results.filter((r) => r.ok).length}/${results.length} suites passed`);
console.log("========================================");
if (anyFail) {
  console.log("\nFailing suites:");
  for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}`);
}
process.exit(anyFail ? 1 : 0);
