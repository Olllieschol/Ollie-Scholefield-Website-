/**
 * The activation UI: popup licence card and settings page.
 *
 * ═══ WHAT THIS IS DEFENDING ════════════════════════════════════════════════
 *
 * A locked Guard4AI must never be a DEAD POPUP. Somebody who installs the
 * extension, opens the dashboard and finds a greyed-out privacy score with no
 * explanation has been handed a broken product — and so has whoever is
 * reviewing the store listing, who will reject it rather than guess. The way
 * in has to be in the popup itself, not behind a link to somewhere else.
 *
 * The states are not two but four, and the awkward one is `warned`: still
 * protecting, but running out. It needs the status AND a place to type a new
 * key at the same time, which is the one combination a simple
 * connected/not-connected layout cannot express.
 *
 * Both pages are loaded from the REAL popup.html / settings.html with the real
 * scripts evaluated into them, so a markup change that orphans an id fails
 * here rather than in somebody's browser.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const DAY = 86400000;
const SEAT_ID = "4f2a9c31-7b60-4e8d-9f15-2c0a6d83be41";
const rec = (over) => Object.assign({
  status: "active", kind: "individual", token: "tok",
  validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
}, over || {});

/**
 * @param page      "popup.html" or "settings.html"
 * @param state     what the worker reports: locked | active | grace | warned
 * @param record    the entitlement record behind that state
 * @param onActivate what the worker should answer when a code is submitted
 */
function makeEnv(page, { state = "locked", record = null, onActivate, available = true } = {}) {
  const dom = new JSDOM(read(page), {
    url: "https://example.com/" + page,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const storage = { guardai_enabled: true };
  const sent = [];
  let cur = { state, record };

  window.chrome = {
    storage: {
      local: {
        get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
          if (kk in storage) o[kk] = storage[kk];
          return o;
        }, {})),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((kk) => delete storage[kk]); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL: (p) => "file://" + p,
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        let res;
        if (msg.type === "GUARDAI_ENTITLEMENT_STATUS") {
          res = { ok: true, available, state: cur.state, record: cur.record };
        } else if (msg.type === "GUARDAI_COMPANY_STATUS") {
          res = { ok: true, available, connection: cur.record && cur.record.kind === "company"
            ? { employeeId: SEAT_ID, companyName: "Northwind Pty Ltd" } : null };
        } else if (msg.type === "GUARDAI_ACTIVATE") {
          res = onActivate ? onActivate(msg.code) : { ok: false, error: "no stub" };
          if (res && res.ok) cur = { state: res.state || "active", record: res.record || rec() };
        } else if (msg.type === "GUARDAI_DEACTIVATE") {
          cur = { state: "locked", record: null };
          res = { ok: true };
        } else {
          res = { ok: true };
        }
        if (cb) setTimeout(() => cb(res), 0);
      },
    },
    tabs: { create() {} },
  };
  // jsdom has no clipboard. Record what the copy button writes so the test can
  // assert the id actually reached it, rather than only that a label changed.
  const clipboard = [];
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } },
    configurable: true,
  });
  window.eval(read(page === "popup.html" ? "popup.js" : "settings.js"));
  return { window, document: window.document, storage, sent, clipboard,
           setState: (s, r) => { cur = { state: s, record: r }; } };
}

const vis = (el) => !!el && el.style.display !== "none";

(async () => {
  /* ══ POPUP ═══════════════════════════════════════════════════════════ */
  console.log("\n--- popup: locked is not a dead end ---");
  {
    const env = makeEnv("popup.html", { state: "locked" });
    await wait(120);
    const card = env.document.getElementById("lock-card");
    check(card.classList.contains("is-on"), "the licence card is shown");
    check(env.document.getElementById("lock-title").textContent === "Guard4AI is not active",
      "and says plainly that nothing is running",
      env.document.getElementById("lock-title").textContent);
    check(!!env.document.getElementById("lock-code"),
      "THE CODE FIELD IS IN THE POPUP ITSELF — activation is not a link to somewhere else");
    check(!vis(env.document.getElementById("score-card")),
      "the privacy score is hidden: a score of 100 while scanning nothing is a lie");
    const body = env.document.getElementById("lock-body").textContent;
    check(/licence key/i.test(body) && /invite code/i.test(body),
      "both routes in are named, so nobody has to guess which they are", body);
  }

  console.log("\n--- popup: activating from the popup ---");
  {
    const env = makeEnv("popup.html", {
      state: "locked",
      onActivate: (code) => code === "GK-GOOD"
        ? { ok: true, kind: "individual", state: "active", record: rec() }
        : { ok: false, error: "That licence key was not recognised. Check it and try again." },
    });
    await wait(120);
    const input = env.document.getElementById("lock-code");
    const btn = env.document.getElementById("lock-activate");

    btn.click();
    await wait(40);
    check(/enter your licence key/i.test(env.document.getElementById("lock-msg").textContent),
      "an empty field is refused locally, without a pointless round-trip",
      env.document.getElementById("lock-msg").textContent);
    check(!env.sent.some((m) => m.type === "GUARDAI_ACTIVATE"), "and nothing was sent");

    input.value = "GK-WRONG";
    btn.click();
    await wait(60);
    check(/not recognised/i.test(env.document.getElementById("lock-msg").textContent),
      "the worker's error is shown verbatim, not replaced with something vaguer",
      env.document.getElementById("lock-msg").textContent);
    check(env.document.getElementById("lock-card").classList.contains("is-on"),
      "and the card stays up so the user can try again");
    check(btn.textContent === "Activate" && !btn.disabled,
      "the button is usable again after a failure", btn.textContent);

    input.value = "GK-GOOD";
    btn.click();
    await wait(60);
    check(!env.document.getElementById("lock-card").classList.contains("is-on"),
      "a good key puts the card away");
    check(vis(env.document.getElementById("score-card")), "and brings the dashboard back");
    check(input.value === "", "the key is cleared from the field once used");
  }
  {
    const env = makeEnv("popup.html", {
      state: "locked",
      onActivate: () => { throw new Error("worker asleep"); },
    });
    await wait(120);
    env.document.getElementById("lock-code").value = "GK-ANY";
    env.document.getElementById("lock-activate").click();
    await wait(60);
    const btn = env.document.getElementById("lock-activate");
    check(!btn.disabled && btn.textContent === "Activate",
      "a dead worker does not leave the button stuck on its loading label", btn.textContent);
    check(/could not reach/i.test(env.document.getElementById("lock-msg").textContent),
      "and says so", env.document.getElementById("lock-msg").textContent);
  }

  {
    // The dead popup arriving by a different route: if the worker cannot be
    // reached at all, a locked install must not sit there looking like a
    // working one. Built by hand rather than through makeEnv, because the
    // point is a chrome.runtime that does not answer.
    const dom = new JSDOM(read("popup.html"), {
      url: "https://example.com/popup.html", runScripts: "dangerously", pretendToBeVisual: true,
    });
    const { window } = dom;
    const storage = { guardai_enabled: true }; // no entitlement: never activated
    window.chrome = {
      storage: {
        local: {
          get: (k) => Promise.resolve((Array.isArray(k) ? k : [k]).reduce((o, kk) => {
            if (kk in storage) o[kk] = storage[kk]; return o;
          }, {})),
          set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
          remove: () => Promise.resolve(),
        },
        onChanged: { addListener() {} },
      },
      // The worker is simply not there.
      runtime: { getURL: (p) => "file://" + p, lastError: null,
                 sendMessage: () => { throw new Error("Could not establish connection"); } },
      tabs: { create() {} },
    };
    window.eval(read("popup.js"));
    await wait(150);
    check(window.document.getElementById("lock-card").classList.contains("is-on"),
      "A DEAD WORKER STILL SHOWS THE LOCKED CARD — read off the absence of a record in storage, which is the one thing that cannot be misread");
    check(window.document.getElementById("score-card").style.display === "none",
      "and still hides the score");
  }

  console.log("\n--- popup: running out, but still working ---");
  for (const [label, r, wants] of [
    ["a licence that lapsed", rec({ status: "warned", hardStopAt: Date.now() + 5 * DAY }), /lapsed/i],
    ["an install that predates the gate", rec({ status: "warned", kind: "legacy", hardStopAt: Date.now() + 14 * DAY }), /needs a licence/i],
  ]) {
    const env = makeEnv("popup.html", { state: "warned", record: r });
    await wait(120);
    const title = env.document.getElementById("lock-title").textContent;
    const body = env.document.getElementById("lock-body").textContent;
    check(wants.test(title), `${label}: titled honestly`, title);
    check(/\d+ more day/.test(body), `${label}: says how long is left, in days`, body);
    check(vis(env.document.getElementById("score-card")),
      `${label}: the dashboard STAYS — it is still protecting, and hiding it would say otherwise`);
    check(env.document.getElementById("lock-card").classList.contains("is-warning"),
      `${label}: styled as a warning, not as a lockout`);
  }
  {
    const env = makeEnv("popup.html", { state: "warned", record: rec({ status: "warned", hardStopAt: Date.now() + DAY }) });
    await wait(120);
    const body = env.document.getElementById("lock-body").textContent;
    check(/1 more day\b/.test(body) && !/1 more days/.test(body), "one day is not '1 days'", body);
  }
  for (const state of ["active", "grace"]) {
    const env = makeEnv("popup.html", { state, record: rec() });
    await wait(120);
    check(!env.document.getElementById("lock-card").classList.contains("is-on"),
      `${state}: no card at all — grace is our problem to fix, not something to worry the user with`);
    check(vis(env.document.getElementById("score-card")), `${state}: dashboard visible`);
  }

  /* ══ SETTINGS ════════════════════════════════════════════════════════ */
  console.log("\n--- settings: one field takes either kind of key ---");
  {
    const env = makeEnv("settings.html", { state: "locked" });
    await wait(150);
    const sec = env.document.getElementById("company");
    check(!sec.classList.contains("is-connected"), "locked shows the form");
    check(env.document.getElementById("activate-heading").textContent === "Activate Guard4AI",
      "headed as activation, not as a company-only feature",
      env.document.getElementById("activate-heading").textContent);
    const ph = env.document.getElementById("company-code").getAttribute("placeholder");
    check(/GK-/.test(ph) && /GA-/.test(ph), "the placeholder shows both shapes", ph);
    const shared = env.document.querySelector(".company__shared").textContent;
    check(/personal licence reports nothing/i.test(shared),
      "and it states plainly that a personal licence reports nothing");
    check(/how many/i.test(shared) && /what kind/i.test(shared),
      "while still disclosing exactly what a workplace code does report");
  }
  {
    const env = makeEnv("settings.html", {
      state: "locked",
      onActivate: (code) => code.startsWith("GA-")
        ? { ok: true, state: "active", record: rec({ kind: "company" }) }
        : { ok: true, state: "active", record: rec({ kind: "individual" }) },
    });
    await wait(150);
    env.document.getElementById("company-code").value = "GA-7K2M-QP4X";
    env.document.getElementById("company-connect").click();
    await wait(120);
    check(env.document.getElementById("company").classList.contains("is-connected"),
      "a workplace code switches to the connected view");
    check(/Northwind/.test(env.document.getElementById("activate-state").textContent),
      "naming the company", env.document.getElementById("activate-state").textContent);
    check(/visible to your admin/i.test(env.document.getElementById("activate-detail").textContent),
      "and repeating what the admin can see, where it is now relevant");
  }

  /* The seat id.
     The privacy policy promises the holder can ask for their data or have it
     deleted, and the seat id is deliberately the only handle that exists — we
     cannot look anyone up by name. If this control regresses, that promise
     silently becomes unkeepable, which is why it is tested rather than eyeballed. */
  console.log("\n--- settings: the seat id, which the privacy policy depends on ---");
  {
    const env = makeEnv("settings.html", { state: "active", record: rec({ kind: "company" }) });
    await wait(150);
    const seat = env.document.getElementById("company-seat");
    check(seat.classList.contains("is-on"), "a workplace seat shows its id");
    check(env.document.getElementById("seat-id").textContent === SEAT_ID,
      "showing the real id in full, not a truncation nobody could quote",
      env.document.getElementById("seat-id").textContent);

    const note = env.document.querySelector(".company__seatnote").textContent;
    check(/hello@guard4ai\.com/.test(note), "with an address to send it to");
    check(/deleted/i.test(note), "and what it is for");

    env.document.getElementById("seat-copy").click();
    await wait(60);
    check(env.clipboard.length === 1 && env.clipboard[0] === SEAT_ID,
      "the copy button copies the id itself", JSON.stringify(env.clipboard));
    check(/copied/i.test(env.document.getElementById("seat-copy").textContent),
      "and says so");
  }
  {
    const env = makeEnv("settings.html", { state: "active", record: rec({ kind: "individual" }) });
    await wait(150);
    check(!env.document.getElementById("company-seat").classList.contains("is-on"),
      "a personal licence shows no seat id, because it never mints one");
    check(env.document.getElementById("seat-id").textContent === "",
      "and nothing is left in the element to leak into a later paint");
  }
  {
    // A stale id left on screen after deactivating would be the kind of quiet
    // wrongness this whole section exists to avoid.
    const env = makeEnv("settings.html", { state: "active", record: rec({ kind: "company" }) });
    await wait(150);
    check(env.document.getElementById("seat-id").textContent === SEAT_ID, "connected: id present");
    env.document.getElementById("company-leave").click();
    await wait(120);
    check(!env.document.getElementById("company-seat").classList.contains("is-on"),
      "deactivating takes the seat id off the screen");
    check(env.document.getElementById("seat-id").textContent === "",
      "and clears it, rather than leaving the last one sitting there");
  }
  {
    const env = makeEnv("settings.html", {
      state: "locked",
      onActivate: () => ({ ok: true, state: "active", record: rec({ kind: "individual" }) }),
    });
    await wait(150);
    env.document.getElementById("company-code").value = "GK-ABCD-EFGH-IJKL";
    env.document.getElementById("company-connect").click();
    await wait(120);
    const detail = env.document.getElementById("activate-detail").textContent;
    check(/reported to anyone/i.test(detail) || /nothing about your usage/i.test(detail),
      "a personal licence says the opposite: nothing is reported", detail);
    check(!/admin/i.test(detail), "and does not mention an admin, because there isn't one", detail);
  }
  {
    // The awkward state: still protecting, but running out. Needs BOTH.
    const env = makeEnv("settings.html", {
      state: "warned",
      record: rec({ status: "warned", hardStopAt: Date.now() + 6 * DAY }),
    });
    await wait(150);
    const sec = env.document.getElementById("company");
    check(sec.classList.contains("is-warned"), "warned gets its own layout");
    check(!sec.classList.contains("is-connected"),
      "WHICH KEEPS THE FORM VISIBLE — being told your licence is running out is useless without somewhere to type the new one");
    check(/\d+ more day/.test(env.document.getElementById("activate-detail").textContent),
      "and still shows the countdown alongside it",
      env.document.getElementById("activate-detail").textContent);
  }
  {
    const env = makeEnv("settings.html", { state: "active", record: rec() });
    await wait(150);
    env.document.getElementById("company-leave").click();
    await wait(120);
    check(!env.document.getElementById("company").classList.contains("is-connected"),
      "deactivating returns to the form");
  }
  {
    const env = makeEnv("settings.html", { state: "locked", available: false });
    await wait(150);
    check(env.document.getElementById("company").style.display === "none",
      "a build with no backend hides the section rather than showing a control that cannot work");
  }

  console.log(`\nACTIVATION-UI: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
