/**
 * End-to-end: the REAL parser frame, in a REAL chrome-extension:// origin,
 * under the REAL manifest CSP, OCRing REAL screenshots.
 *
 * ═══ WHY THIS EXISTS OUTSIDE test/ ═════════════════════════════════════════
 *
 * The rest of the suite runs in jsdom, which has no WebAssembly worker, no
 * extension origin and no CSP — so it cannot execute a single line of the OCR
 * path. Everything jsdom CAN check (classification, header parsing, the three
 * verdict states, the card wording, fail-closed routing) is checked in
 * test/file-image.cjs and test/file-attach.cjs §13. This file covers the rest:
 * WASM under the real manifest CSP, the worker loading from the extension
 * origin with workerBlobURL:false, the bundled language model, adaptive
 * thresholding, and the verdict the frame actually returns for a real
 * screenshot.
 *
 * It is NOT in test/ and NOT in run-all.cjs because it needs a browser
 * download. Branded Google Chrome refuses --load-extension outright
 * ("--disable-extensions-except is not allowed in Google Chrome, ignoring"),
 * so this needs a plain Chromium:
 *
 *   npx @puppeteer/browsers install chromium@latest
 *   node tools/e2e-ocr.cjs
 *
 * It launches its own headless browser with its own profile and never touches
 * the user's Chrome. Run it after any change to the OCR path, the parser
 * frame, the vendored tesseract files, or the manifest CSP.
 *
 * The handshake trick: parser.html is opened as a TOP-LEVEL page, where
 * window.parent === window, so the frame's own `e.source !== window.parent`
 * check is satisfied by posting to itself. From there it is the real private
 * MessagePort, carrying real image bytes, exactly as content.js sends them.
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..");
const PROFILE = path.join(__dirname, ".e2e-profile");
const PORT = 9333;

/** A Chromium that still allows --load-extension. */
function findChromium() {
  const roots = [__dirname, path.join(__dirname, ".."), process.cwd()];
  for (const root of roots) {
    const base = path.join(root, "chromium");
    if (!fs.existsSync(base)) continue;
    for (const build of fs.readdirSync(base)) {
      const p = path.join(base, build, "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
      if (fs.existsSync(p)) return p;
      const linux = path.join(base, build, "chrome-linux/chrome");
      if (fs.existsSync(linux)) return linux;
    }
  }
  return null;
}
const CHROME = findChromium();
if (!CHROME) {
  console.error(
    "No Chromium found. Branded Chrome refuses --load-extension, so this needs one:\n" +
    "  npx @puppeteer/browsers install chromium@latest\n" +
    "(run it from this directory, or from the extension root)");
  process.exit(1);
}

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(ws, method, params, sessionId) {
  const id = ++cdp.seq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg);
      if (m.error) reject(new Error(method + ": " + JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
}
cdp.seq = 0;

(async () => {
  try { execSync(`rm -rf ${JSON.stringify(PROFILE)}`); } catch (_) {}

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--load-extension=" + EXT,
    "--disable-extensions-except=" + EXT,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (d) => { stderr += d; });

  const kill = () => { try { chrome.kill("SIGKILL"); } catch (_) {} };
  process.on("exit", kill);

  // Wait for the debugging port.
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(250);
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch (_) {}
  }
  if (!version) { console.log("FAIL  Chrome never opened the debug port\n" + stderr.slice(-800)); process.exit(1); }
  console.log("pass  headless Chrome up: " + version["Browser"]);

  // Chrome derives an unpacked extension's id from the SHA-256 of its
  // absolute path: first 16 bytes, each nibble mapped 0-15 -> a-p. Deriving
  // it beats scanning targets, which finds Chrome's own bundled extensions.
  const hash = require("crypto").createHash("sha256").update(EXT, "utf8").digest();
  let extId = "";
  for (let i = 0; i < 16; i++) {
    extId += String.fromCharCode(97 + (hash[i] >> 4)) + String.fromCharCode(97 + (hash[i] & 15));
  }
  console.log("pass  extension id derived from path: " + extId);

  // Open parser.html as a top-level page.
  const parserUrl = `chrome-extension://${extId}/parser.html`;
  const newTab = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(parserUrl)}`, { method: "PUT" })).json();
  const ws = new WebSocket(newTab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Log.enable").catch(() => {});
  const consoleErrors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      consoleErrors.push(m.params.entry.text);
    }
  });
  await sleep(1500);

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await cdp(ws, "Runtime.evaluate", {
      expression, awaitPromise, returnByValue: true, timeout: 180000,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception
        ? (r.exceptionDetails.exception.description || r.exceptionDetails.text)
        : r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const where = await evaluate(`({ url: location.href, title: document.title,
    scripts: [...document.querySelectorAll("script")].map(s => s.src.split("/").pop()),
    body: document.body ? document.body.innerHTML.slice(0, 200) : null })`);
  console.log("    page: " + JSON.stringify(where));

  const loaded = await evaluate(`({
    url: location.href,
    hasFileScan: !!(window.GuardAI && window.GuardAI.FileScan),
    hasDetector: !!(window.GuardAI && window.GuardAI.Detector),
    hasMammoth: !!window.mammoth,
    imageKind: window.GuardAI.FileScan.classify("x.png","image/png").kind
  })`);
  check(loaded.hasFileScan && loaded.hasDetector, "parser.html booted its scripts in the extension origin");
  check(loaded.imageKind === "image", "the shipped filescan.js knows the image kind", loaded.imageKind);

  // Complete the REAL handshake against the frame's own listener.
  await evaluate(`
    window.__replies = [];
    window.__ch = new MessageChannel();
    window.__ch.port1.onmessage = (e) => window.__replies.push(e.data);
    window.__ch.port1.start();
    window.postMessage({ guardai: "parser-port" }, "*", [window.__ch.port2]);
    "posted"
  `);
  await sleep(500);
  const ready = await evaluate(`window.__replies.map(r => r.ready === true ? "ready" : JSON.stringify(r).slice(0,80))`);
  check(ready.includes("ready"), "the frame accepted the port and said ready", JSON.stringify(ready));

  // Send one real image over the port and wait for the verdict.
  const send = async (file, name, mime) => {
    const b64 = fs.readFileSync(file).toString("base64");
    await evaluate(`
      window.__replies = [];
      (async () => {
        const bin = atob("${b64}");
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        window.__ch.port1.postMessage(
          { id: "e2e", name: ${JSON.stringify(name)}, type: ${JSON.stringify(mime)}, bytes: u.buffer },
          [u.buffer]);
        return "sent";
      })()
    `);
    const t0 = Date.now();
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      const done = await evaluate(`(window.__replies.find(r => r.action) || null)`);
      if (done) return { reply: done, ms: Date.now() - t0,
        progress: await evaluate(`window.__replies.filter(r => r.progress).length`) };
    }
    return { reply: null, ms: Date.now() - t0 };
  };

  console.log("\n--- a dark-mode chat screenshot with real planted values ---");
  const dark = await send(path.join(__dirname, "ocr-fixtures/s5-chat-dark.png"), "s5-chat-dark.png", "image/png");
  console.log("    verdict: " + JSON.stringify(dark.reply) + `  (${dark.ms}ms, ${dark.progress} progress ticks)`);
  check(dark.reply && dark.reply.action === "img-found",
    "OCR ran under the extension CSP and the rules FIRED on a dark screenshot",
    dark.reply ? dark.reply.action + " " + (dark.reply.reason || "") : "no reply");
  if (dark.reply && dark.reply.summary) {
    const c = dark.reply.summary.counts || {};
    check(!!(c.CREDIT_CARD && c.BSB && c.BANK_ACCOUNT && c.MEDICARE),
      "all four planted categories came back", JSON.stringify(c));
    check(!JSON.stringify(dark.reply).match(/4054|013-442|8827|4355/),
      "and NO value text crossed the port — counts only");
  }
  check(dark.progress > 0, "progress ticks crossed while it worked", String(dark.progress));

  console.log("\n--- a benign screenshot: read it, found nothing ---");
  const benign = await send(path.join(__dirname, "ocr-fixtures/benign-1x.png"), "hike-notes.png", "image/png");
  console.log("    verdict: " + JSON.stringify(benign.reply) + `  (${benign.ms}ms)`);
  check(benign.reply && benign.reply.action === "img-nothing",
    "a readable benign screenshot reports nothing-in-what-we-read",
    benign.reply ? benign.reply.action : "no reply");

  console.log("\n--- a degraded screenshot: could not read it ---");
  const blurry = await send(path.join(__dirname, "ocr-fixtures/s7-40.png"), "blurry.png", "image/png");
  console.log("    verdict: " + JSON.stringify(blurry.reply) + `  (${blurry.ms}ms)`);
  check(blurry.reply && blurry.reply.action === "img-unreadable",
    "the degraded page (digits destroyed) reports could-not-read, NOT clean",
    blurry.reply ? blurry.reply.action : "no reply");

  console.log("\n--- send-as-text is refused for images ---");
  await evaluate(`
    window.__replies = [];
    (async () => {
      const bin = atob("${fs.readFileSync(path.join(__dirname, "ocr-fixtures/benign-1x.png")).toString("base64")}");
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      window.__ch.port1.postMessage({ id: "x", name: "a.png", type: "image/png", bytes: u.buffer, mode: "extract" }, [u.buffer]);
      return "sent";
    })()
  `);
  await sleep(1500);
  const ext = await evaluate(`(window.__replies.find(r => r.mode === "extract") || null)`);
  check(ext && ext.ok === false && !ext.text,
    "the frame refuses to hand out OCR text, and returns no text field", JSON.stringify(ext));

  const csp = consoleErrors.filter((e) => /Content Security Policy|blob:|wasm/i.test(e));
  check(csp.length === 0, "no CSP violations logged", csp.join(" | ").slice(0, 300));

  kill();
  console.log(`\nE2E: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
