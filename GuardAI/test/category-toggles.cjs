/**
 * "What GuardAI masks" — per-category detection toggles (settings.html).
 *
 * Requirements being verified:
 *   - Every finding type detector.js actually produces has a matching row in
 *     settings.js's GROUPS catalogue (so nothing is silently un-toggleable).
 *   - All categories are ON by default (Detector.disabledTypes starts empty).
 *   - Disabling a category means it's REMOVED FROM scan()'s output entirely —
 *     not filtered later, not just hidden in some UI list. That's what makes
 *     it "not masked at all": the finding never reaches the warning card, the
 *     review model, or the masker, because none of those ever see it.
 *   - Disabling one category never affects detection of any OTHER category —
 *     the underlying detection logic is untouched; only what's returned is
 *     pruned.
 *   - Re-enabling restores exactly the prior behaviour.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { loadWindow } = require("./_env.cjs");

const ROOT = path.join(__dirname, "..");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/* ---- 1. settings.js's catalogue matches detector.js's actual output ---- */
const detectorSrc = fs.readFileSync(path.join(ROOT, "src", "detector.js"), "utf8");
const producedTypes = new Set(
  [...detectorSrc.matchAll(/finding\("([A-Z_]+)"/g)].map((m) => m[1])
);

const settingsSrc = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
// Extract the GROUPS array literal and eval it in isolation (no DOM/chrome
// needed for this — it's a plain data structure) to get the real catalogue,
// not a hand-copied transcription of it.
const groupsMatch = settingsSrc.match(/const GROUPS = (\[[\s\S]*?\n  \]);/);
check(!!groupsMatch, "settings.js exposes a GROUPS = [...] catalogue in the expected shape");
const GROUPS = groupsMatch ? eval(groupsMatch[1]) : [];
const catalogueTypes = new Set(GROUPS.flatMap((g) => g.categories.map((c) => c.type)));

for (const t of producedTypes) {
  check(catalogueTypes.has(t), `detector.js's "${t}" finding type has a settings.html toggle`);
}
for (const t of catalogueTypes) {
  check(producedTypes.has(t), `settings.js's "${t}" category corresponds to a real detector.js finding type (no stale/typo'd entries)`);
}
check(producedTypes.size === catalogueTypes.size,
  "catalogue count matches detector.js's actual finding-type count exactly",
  `detector.js: ${producedTypes.size}, settings.js: ${catalogueTypes.size}`);

/* ---- 2. Default is ALL ON ---- */
{
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  check(det.disabledTypes.size === 0, "Detector starts with nothing disabled (all categories on by default)");
}

/* ---- 3. Disabling a category removes it from scan() output entirely ---- */
{
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const text = "Call James Whitfield on 0412 556 781, email james@example.com.";

  const before = det.scan(text);
  check(before.some((f) => f.type === "PHONE"), "setup: PHONE is detected before disabling it", JSON.stringify(before.map(f=>f.type)));
  check(before.some((f) => f.type === "EMAIL"), "setup: EMAIL is detected before disabling it");

  det.setDisabledTypes(["PHONE"]);
  const after = det.scan(text);
  check(!after.some((f) => f.type === "PHONE"), "disabling PHONE: no PHONE finding in scan() output at all");
  check(after.some((f) => f.type === "EMAIL"), "disabling PHONE: EMAIL is still detected — other categories unaffected");
  check(after.some((f) => f.type === "NAME_PII"), "disabling PHONE: NAME_PII is still detected — other categories unaffected");
}

/* ---- 4. Disabled category never reaches masking (full pipeline, not just scan()) ---- */
{
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const masker = new w.GuardAI.Masker();
  det.setDisabledTypes(["EMAIL"]);

  const text = "Reach me at ollie@example.com or on 0412 556 781.";
  const findings = det.scan(text);
  check(!findings.some((f) => f.type === "EMAIL"), "EMAIL absent from findings when disabled");

  // Mirror content.js's buildReviewModel: only maskable findings become
  // review items. Since EMAIL never appears in `findings` at all, it can
  // never become a review item, so it's not merely "left unmasked in a list
  // that still names it" — the item never exists.
  const items = findings.filter((f) => masker.isMaskable(f.type));
  check(!items.some((it) => it.type === "EMAIL"), "EMAIL never becomes a maskable review item when disabled");
  check(items.some((it) => it.type === "PHONE"), "PHONE (not disabled) still becomes a review item");
}

/* ---- 5. Re-enabling restores exactly the prior behaviour ---- */
{
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const text = "Medicare 2123 45670 1, TFN 123 456 782.";

  det.setDisabledTypes(["MEDICARE"]);
  const withDisabled = det.scan(text);
  check(!withDisabled.some((f) => f.type === "MEDICARE"), "MEDICARE hidden while disabled");

  det.setDisabledTypes([]);
  const reenabled = det.scan(text);
  check(reenabled.some((f) => f.type === "MEDICARE"), "MEDICARE detected again immediately after re-enabling");
}

/* ---- 6. Disabling everything leaves scan() returning nothing ---- */
{
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  det.setDisabledTypes([...catalogueTypes]);
  const text = "James Whitfield, 0412 556 781, james@example.com, Medicare 2123 45670 1, Acme Pty Ltd.";
  const findings = det.scan(text);
  check(findings.length === 0, "disabling every category leaves scan() returning nothing", JSON.stringify(findings.map(f=>f.type)));
}

console.log(`\nCATEGORY-TOGGLES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
