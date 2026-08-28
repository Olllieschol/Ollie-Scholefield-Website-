/**
 * What actually ships.
 *
 * Zipping the extension folder produces a 26 MB package, 25 MB of which is
 * node_modules (jsdom and its dependency tree), plus the whole test suite and
 * its adversarial corpora. The extension is about half a megabyte. So
 * tools/package.sh works from an ALLOWLIST.
 *
 * An allowlist has one failure mode and it is a bad one: something the
 * extension needs is left off, and nobody finds out until a user clicks a
 * button that opens a blank page. settings.html is the live example — it is
 * opened with chrome.tabs.create() and appears nowhere in manifest.json, so
 * nothing declares it and nothing would have missed it.
 *
 * This suite derives the required file list from the manifest and the source
 * rather than restating it, so the check cannot drift by being edited in step
 * with the thing it checks.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const pkg = fs.readFileSync(path.join(ROOT, "tools", "package.sh"), "utf8");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

/** The FILES=( ... ) array from the packaging script. */
const allow = (() => {
  const m = pkg.match(/FILES=\(([\s\S]*?)\)/);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
})();

/** Is this path covered by the allowlist, directly or via a listed directory? */
const covered = (p) => allow.some((a) => p === a || p.startsWith(a + "/"));

(async () => {
  console.log("\n--- everything the manifest names ---");
  check(allow.length > 0, "the packaging script has a file list", allow.join(" "));

  const required = new Set();
  required.add("manifest.json");
  if (manifest.background && manifest.background.service_worker) {
    required.add(manifest.background.service_worker);
  }
  if (manifest.action && manifest.action.default_popup) required.add(manifest.action.default_popup);
  for (const icons of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    for (const p of Object.values(icons || {})) required.add(p);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const p of [...(cs.js || []), ...(cs.css || [])]) required.add(p);
  }
  for (const war of manifest.web_accessible_resources || []) {
    // Globs like lib/* are optional bundles; only concrete paths are required.
    for (const p of war.resources || []) if (!p.includes("*")) required.add(p);
  }

  for (const p of [...required].sort()) {
    check(fs.existsSync(path.join(ROOT, p)), `exists on disk: ${p}`);
    check(covered(p), `SHIPS: ${p}`, "not covered by tools/package.sh FILES");
  }

  console.log("\n--- what the parser frame pulls in ---");
  {
    // parser.html is an extension page, so nothing it loads needs declaring in
    // the manifest — which means nothing but this would notice vendor/ being
    // dropped from the packaging allowlist. The extension would install fine
    // and then fail to read a single PDF.
    const html = fs.readFileSync(path.join(ROOT, "parser.html"), "utf8");
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    check(srcs.length >= 4, "parser.html loads its scripts", srcs.join(", "));
    for (const p of srcs) {
      check(fs.existsSync(path.join(ROOT, p)), `exists on disk: ${p}`);
      check(covered(p), `SHIPS: ${p} (loaded by parser.html)`, "not covered by tools/package.sh FILES");
    }
    // ES imports and worker URLs, which are not <script src>.
    const js = fs.readFileSync(path.join(ROOT, "src", "parser.js"), "utf8");
    const refs = new Set([
      ...[...js.matchAll(/from\s+"\.\.\/([^"]+)"/g)].map((m) => m[1]),
      ...[...js.matchAll(/getURL\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
    ]);
    check(refs.size >= 2, "parser.js references its libraries", [...refs].join(", "));
    for (const p of refs) {
      check(fs.existsSync(path.join(ROOT, p)), `exists on disk: ${p}`);
      check(covered(p), `SHIPS: ${p} (imported by parser.js)`, "not covered by tools/package.sh FILES");
    }
  }

  console.log("\n--- the ones nothing declares ---");
  {
    // Extension pages opened with chrome.tabs.create() are referenced only in
    // JavaScript. Nothing in the manifest points at them, so nothing but this
    // would notice them going missing.
    const js = ["popup.js", "settings.js", "background.js", "src/content.js"]
      .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
    const opened = new Set([...js.matchAll(/getURL\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]));
    check(opened.size > 0, "found pages opened via getURL()", [...opened].join(", "));
    for (const p of opened) {
      if (p.includes("*")) continue;
      check(fs.existsSync(path.join(ROOT, p)), `exists on disk: ${p}`);
      check(covered(p), `SHIPS: ${p} (opened from JS, declared nowhere)`,
        "not covered by tools/package.sh FILES");
    }
  }

  console.log("\n--- and nothing that should not ---");
  for (const junk of ["node_modules", "test", "backend", "tools", "harness.cjs", "audit.cjs",
                      "package.json", "package-lock.json", "dist", "audit.out"]) {
    check(!covered(junk), `does NOT ship: ${junk}`);
  }
  {
    const src = path.join(ROOT, "src");
    const shipped = fs.readdirSync(src).filter((f) => f.endsWith(".js"));
    check(shipped.length >= 7, "the whole src/ directory ships, so a new module needs no packaging change",
      shipped.join(", "));
  }

  console.log(`\nPACKAGING: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
