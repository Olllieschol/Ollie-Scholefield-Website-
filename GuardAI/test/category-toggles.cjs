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
// MODE rows are deliberately NOT categories: they have their own storage keys
// because the category list is an OFF-list where absence means enabled, which
// cannot express a DEFAULT-OFF setting. They must therefore stay out of the
// bijection above — if a mode were ever added to GROUPS it would fail the
// check as a "category with no finding type", and weakening that check to
// accommodate it would also stop it catching genuine catalogue drift.
{
  const modesMatch = settingsSrc.match(/const MODES = (\[[\s\S]*?\n  \]);/);
  check(!!modesMatch, "settings.js exposes a separate MODES list");
  const MODES = modesMatch ? eval(modesMatch[1]) : [];
  check(MODES.length > 0, "at least one mode row exists");
  for (const mode of MODES) {
    check(!!mode.key && mode.key.startsWith("guardai_"),
      `mode "${mode.title}" has its own guardai_* storage key (${mode.key})`);
    check(!catalogueTypes.has(mode.key),
      `mode "${mode.title}" is NOT in the category catalogue`);
    check(!producedTypes.has(mode.key),
      `mode "${mode.title}" is not a finding type`);
  }
  check(MODES.some((m) => m.key === "guardai_aggressive_names"),
    "the aggressive-names mode is present");
  const agg = MODES.find((m) => m.key === "guardai_aggressive_names");
  check(agg && /off by default/i.test(agg.desc),
    "the aggressive-names row says it is off by default");
  check(agg && /false positive/i.test(agg.desc),
    "the aggressive-names row warns about false positives");
  check(agg && /warning card|masking mode/i.test(agg.note || ""),
    "the aggressive-names row states the silent-mode interaction");

  // Superseded 2026-09-02: every upload waits now, so this switch changes
  // nothing. It is kept in the list rather than deleted, because a setting
  // that vanishes leaves anyone who turned it on wondering what happened to
  // it — and the row has to SAY it is inert, or it reads as a live control
  // that silently does nothing, which is worse than either.
  const stop = MODES.find((m) => m.key === "guardai_image_hard_stop");
  check(!!stop, "the always-stop-on-images mode is still listed");
  check(stop && /no longer changes anything/i.test(stop.desc),
    "…and says plainly that it no longer changes anything",
    stop ? stop.desc : "");
  check(stop && /cannot be partly masked|every upload/i.test((stop.note || "") + stop.desc),
    "…and says why, so it does not read as an unexplained dead control",
    stop ? stop.note : "");
  check(stop && stop.dead === true,
    "…and is marked dead in the data, not only in prose");

  /**
   * EVERY mode key must be read by the side that acts on it. settings.js
   * writes chrome.storage.local[key] and content.js reads it; a typo in
   * either leaves a switch that moves, persists, and does nothing at all —
   * a failure with no error message and no visible symptom except that the
   * product ignores the user. Neither file's own tests can see it, because
   * each is internally consistent.
   */
  const contentSrc = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");
  for (const mode of MODES) {
    const readInLoad = contentSrc.includes(`"${mode.key}"`);
    const readOnChange = contentSrc.includes(`changes.${mode.key}`);
    check(readInLoad, `content.js reads ${mode.key} at startup`);
    check(readOnChange, `content.js reacts to ${mode.key} changing live`);
  }
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
