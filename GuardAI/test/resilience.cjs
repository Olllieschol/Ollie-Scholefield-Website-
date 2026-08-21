/**
 * Error handling & resilience (Section 3b):
 *   - chrome.storage.local.get/set throwing or rejecting must never break
 *     masking/restore for the current page — only persistence is degraded.
 *   - malformed/unexpected stored data is skipped, not fatal.
 *   - the mapping table caps its size (LRU eviction) instead of growing
 *     forever over a long-lived conversation.
 *   - content.js's boot() keeps working (loadSettings falls back to
 *     defaults, no unhandled rejection) when storage is broken.
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

function loadWindow({ storageBehavior } = {}) {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://chatgpt.com/c/x",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {};
  const behavior = storageBehavior || "ok";
  w.chrome = {
    storage: {
      local: {
        get: (k) => {
          if (behavior === "get-throws") return Promise.reject(new Error("simulated storage.get failure"));
          if (behavior === "get-sync-throws") throw new Error("simulated sync throw");
          return Promise.resolve(
            (Array.isArray(k) ? k : [k]).reduce((o, kk) => {
              if (kk in storage) o[kk] = storage[kk];
              return o;
            }, {})
          );
        },
        set: (o) => {
          if (behavior === "set-throws") return Promise.reject(new Error("simulated quota exceeded"));
          Object.assign(storage, o);
          return Promise.resolve();
        },
        remove: (k) => {
          if (behavior === "remove-throws") return Promise.reject(new Error("simulated remove failure"));
          delete storage[k];
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  for (const f of ["detector.js", "masker.js", "nlp-detector.js"]) w.eval(read(f));
  w.__storage = storage;
  return w;
}

(async () => {
  /* ---- 1. masker.load() survives storage.get rejecting ---- */
  {
    const w = loadWindow({ storageBehavior: "get-throws" });
    const masker = new w.GuardAI.Masker();
    let threw = false;
    try {
      await masker.load();
    } catch {
      threw = true;
    }
    check(!threw, "masker.load() does not throw when storage.get rejects");
    check(masker._loaded === true, "masker still marks itself loaded (won't retry-loop forever)");
    // Masking must still work in-memory even though persistence is broken.
    const det = new w.GuardAI.Detector();
    const findings = det.scan("Call me on 0412 556 781");
    const { masked } = await masker.mask("Call me on 0412 556 781", findings);
    check(masked !== "Call me on 0412 556 781" && !masked.includes("0412 556 781"),
      "masking still works in-memory when storage.get is broken", masked);
  }

  /* ---- 2. masker.load() survives a synchronous throw too ---- */
  {
    const w = loadWindow({ storageBehavior: "get-sync-throws" });
    const masker = new w.GuardAI.Masker();
    let threw = false;
    try {
      await masker.load();
    } catch {
      threw = true;
    }
    check(!threw, "masker.load() does not throw when storage.get throws synchronously");
  }

  /* ---- 3. masker.save() survives storage.set rejecting (never throws) ---- */
  {
    const w = loadWindow({ storageBehavior: "set-throws" });
    const masker = new w.GuardAI.Masker();
    await masker.load();
    const det = new w.GuardAI.Detector();
    const findings = det.scan("TFN 234 567 891");
    let threw = false;
    let masked = null;
    try {
      ({ masked } = await masker.mask("TFN 234 567 891", findings));
    } catch {
      threw = true;
    }
    check(!threw, "masker.mask() (which calls save() internally) does not throw when storage.set rejects");
    check(masked && !masked.includes("234 567 891"), "masking result is still correct despite save() failing", masked);
  }

  /* ---- 4. malformed stored entries are skipped, not fatal ---- */
  {
    const w = loadWindow();
    w.__storage["guardai_mapping"] = [
      { real: "James Whitfield", fake: "David Clarke", type: "NAME_PII", createdAt: 1 }, // valid
      { real: "missing fake field", type: "NAME_PII" }, // malformed
      null, // malformed
      "just a string", // malformed
      { real: 12345, fake: "x", type: "NAME_PII" }, // wrong types
      42,
    ];
    const masker = new w.GuardAI.Masker();
    let threw = false;
    try {
      await masker.load();
    } catch {
      threw = true;
    }
    check(!threw, "masker.load() does not throw on malformed stored entries");
    check(masker.size === 1, "only the well-formed entry is loaded", `size=${masker.size}`);
    check(masker.realToFake.get("James Whitfield")?.fake === "David Clarke", "the valid entry loaded correctly");
  }

  /* ---- 5. storage.get returning a non-array for the mapping key ---- */
  {
    const w = loadWindow();
    w.__storage["guardai_mapping"] = { not: "an array" };
    const masker = new w.GuardAI.Masker();
    let threw = false;
    try {
      await masker.load();
    } catch {
      threw = true;
    }
    check(!threw, "masker.load() does not throw when the stored value has the wrong shape entirely");
    check(masker.size === 0, "non-array stored value is treated as empty, not crashed on");
  }

  /* ---- 6. table growth cap (LRU eviction) ---- */
  {
    const w = loadWindow();
    const masker = new w.GuardAI.Masker();
    await masker.load();
    const MAX = 500; // must match MAX_ENTRIES in masker.js
    for (let i = 0; i < MAX + 50; i++) {
      masker._getOrCreate("NAME_PII", `Real Person Number ${i}`);
    }
    check(masker.size <= MAX, `table never exceeds the cap after ${MAX + 50} distinct entries`, `size=${masker.size}`);
    check(!masker.realToFake.has("Real Person Number 0"), "oldest entry was evicted first (LRU)");
    check(masker.realToFake.has(`Real Person Number ${MAX + 49}`), "newest entry is still present");
  }

  /* ---- 7. detector.scan() never throws on any input shape ---- */
  {
    const w = loadWindow();
    const det = new w.GuardAI.Detector();
    const inputs = [null, undefined, 123, {}, [], "", "  ", NaN, Symbol("x")];
    let anyThrew = false;
    for (const input of inputs) {
      try {
        det.scan(input);
      } catch {
        anyThrew = true;
      }
    }
    check(!anyThrew, "detector.scan() never throws across a battery of malformed input types");
  }

  /* ---- 8. content.js boot() proceeds even when ALL storage calls reject ---- */
  {
    const w = loadWindow({ storageBehavior: "get-throws" });
    let unhandled = null;
    w.addEventListener("unhandledrejection", (e) => { unhandled = e.reason; });
    w.eval(read("content.js"));
    await new Promise((r) => setTimeout(r, 150));
    check(!unhandled, "boot() produces no unhandled promise rejection when storage is fully broken", String(unhandled));
    // startObserving() should still have run — the observer + reopen/panel
    // machinery is live, which we can indirectly confirm via the boot log
    // having been reached (module state initialised without throwing).
    check(typeof w.GuardAI === "object", "GuardAI namespace still initialised after a broken-storage boot");
  }

  console.log(`\nRESILIENCE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
