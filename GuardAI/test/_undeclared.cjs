/**
 * Static sweep for the bug class behind the password outage: a function that
 * assigns to a name declared nowhere in its scope.
 *
 * Worth having alongside the runtime test because the runtime test only covers
 * the branches a sample reaches. The password bug lived in the fourth block of
 * detectPassword; a sample that never produced a connection string would have
 * left it undiscovered. This reads every branch whether or not anything runs it.
 *
 * Comments, strings, template literals and regex literals are blanked first.
 * "8 digits = 11 chars" in a comment reads as an assignment otherwise, and a
 * scan that cries wolf is a scan somebody deletes.
 */
/* Flag assignment to a name that is not declared in the enclosing function,
   not a parameter, and not declared at the IIFE's own top level. */
const fs = require("fs");
function scanUndeclared(file) {
  const raw = fs.readFileSync(file, "utf8");
/* Comments and literals are not code. "8 digits = 11 chars" in a comment and
   "user id = X" in a doc string both read as assignments to a scanner that
   does not strip them, and a false positive here is worse than useless: it
   trains the reader to ignore the output. Newlines are preserved so the line
   numbers still point at the real file. */
const blank = (m) => m.replace(/[^\n]/g, " ");
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)))
  .replace(/`(?:[^`\\]|\\.)*`/g, blank)
  .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
  .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
  .replace(/\/(?![\/*])(?:[^\/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, blank);

const BUILTINS = new Set(["window","console","document","Math","JSON","Object","Array","String",
  "Number","Boolean","RegExp","Date","Map","Set","WeakMap","WeakSet","Promise","Error","parseInt",
  "parseFloat","isNaN","isFinite","undefined","NaN","Infinity","globalThis","self","chrome",
  "setTimeout","clearTimeout","Intl","Symbol","BigInt","structuredClone","TextEncoder"]);

const declNames = (body) => {
  const out = new Set();
  /* Every declarator, not just the first. "let lo = 0, hi = n, ans = 0"
     declares three names, and reading only "lo" reports the other two as
     undeclared — which is exactly the kind of noise that makes a scan like
     this get switched off. */
  for (const m of body.matchAll(/\b(?:let|const|var)\s+/g)) {
    let i = m.index + m[0].length, depth = 0, buf = "";
    for (; i < body.length; i++) {
      const ch = body[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ";" && depth === 0) break;
      else if (ch === "\n" && depth === 0 && /(^|[^,])\s*$/.test(buf) && !/[=,]\s*$/.test(buf)) break;
      buf += ch;
    }
    let d = 0, part = "";
    for (const ch of buf + ",") {
      if ("([{".includes(ch)) d++;
      else if (")]}".includes(ch)) d--;
      if (ch === "," && d === 0) {
        const id = part.split("=")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(id)) out.add(id);
        part = "";
      } else part += ch;
    }
  }
  for (const m of body.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of body.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of body.matchAll(/\bfor\s*\(\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // destructuring, both forms
  for (const m of body.matchAll(/\b(?:let|const|var)\s*[\[{]([^\]}]*)[\]}]/g))
    for (const n of m[1].split(",")) {
      const id = n.split(":").pop().trim().replace(/^\.\.\./, "").split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) out.add(id);
    }
  return out;
};

/* top level of the IIFE = declarations at exactly two spaces of indent */
const topLevel = new Set();
for (const m of src.matchAll(/^ {2}(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)) topLevel.add(m[1]);
for (const m of src.matchAll(/^ {2}function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) topLevel.add(m[1]);
for (const m of src.matchAll(/^ {2}class\s+([A-Za-z_$][\w$]*)/gm)) topLevel.add(m[1]);

const findings = [];
for (const m of src.matchAll(/^ {2}function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
  const name = m[1];
  const params = new Set(m[2].split(",").map((p) => p.split("=")[0].trim()).filter(Boolean));
  // brace-match the body
  let i = m.index + m[0].length - 1, depth = 0, end = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(m.index, end + 1);
  const known = new Set([...params, ...declNames(body), ...topLevel, ...BUILTINS]);

  for (const a of body.matchAll(/(^|[;{}()\s])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    const target = a[2];
    const before = body.slice(Math.max(0, a.index - 2), a.index + a[1].length);
    if (/[.\]]\s*$/.test(before)) continue;          // property or index assignment
    if (known.has(target)) continue;
    const line = src.slice(0, m.index + a.index).split("\n").length;
    findings.push(`${name}(): assigns to "${target}" which is declared nowhere in scope  [line ~${line}]`);
  }
}
  return findings;
}

module.exports = { scanUndeclared };
