/**
 * The licence gate, driven through the real content.js pipeline.
 *
 * C1 proved the state machine is correct. This proves the extension actually
 * obeys it — and, more to the point, that obeying it never costs the user
 * something they should not lose.
 *
 * ═══ THE TWO THINGS BEING DEFENDED ═════════════════════════════════════════
 *
 * 1. LOCKED IS NOT MASTER-OFF.
 *
 *    master-off  the user asked for silence. Give them silence.
 *    locked      the user never asked for anything. An extension that does
 *                nothing and says nothing is indistinguishable from a broken
 *                one — to a new user, and to whoever reviews the store
 *                listing. So it says so, once, with the way out one click
 *                away.
 *
 * 2. LOCKING STOPS PROTECTION, IT DOES NOT CONFISCATE DATA.
 *
 *    Masking is the paid feature. Reading your own already-masked
 *    conversations back is not. If a lapsed subscription killed restore, the
 *    user would be left staring at fake names in their chat history with the
 *    real values sitting on their own disk — a paywall in front of their own
 *    data. So restore survives a lock; detection and send-interception do
 *    not. A fresh install has an empty mapping table, so it is still inert.
 *
 * Exit code 1 on any failure.
 */
const { makeEnv, wait } = require("../harness.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const DAY = 86400000;
const SECRET = "Contact Sarah Chen on 0412 345 678";

const rec = (over) => Object.assign({
  status: "active", kind: "individual", token: "tok",
  validUntil: null, hardStopAt: null, lastVerifiedAt: Date.now(), lastError: null,
}, over || {});

/** Type the text and press Enter, the way a user actually sends. */
async function typeAndSend(env) {
  env.EDITOR.textContent = SECRET;
  env.EDITOR.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(120);
}

const guardaiUI = (env) =>
  env.document.querySelectorAll(
    ".guardai-panel, .guardai-reopen, .guardai-prompt, .guardai-msgtoggle, .guardai-toast"
  ).length;

(async () => {
  /* ── 1. a fresh, never-activated install is inert ───────────────────── */
  console.log("\n--- 1. locked: does nothing at all ---");
  {
    const env = makeEnv({ licensed: false });
    await wait(80);
    await typeAndSend(env);

    check(env.sentMessages.length === 1, "the send went through — a lock must never block the user", String(env.sentMessages.length));
    check(env.sentMessages[0] && env.sentMessages[0].text === SECRET,
      "and the message was sent EXACTLY as typed, nothing masked, nothing altered",
      env.sentMessages[0] && env.sentMessages[0].text);
    check(guardaiUI(env) === 0, "no panel, no badge, no warning card injected", String(guardaiUI(env)));
    check(env.document.querySelectorAll(".guardai-msgtoggle").length === 0,
      "and no per-message buttons on a page it is not protecting");
  }

  /* ── 2. ...but it says so, which master-off does not ────────────────── */
  console.log("\n--- 2. locked is not master-off ---");
  {
    const env = makeEnv({ licensed: false });
    await wait(120);
    const notice = env.document.querySelector(".guardai-locked");
    check(!!notice, "locked shows a notice: an extension that is silently inert reads as broken");
    check(notice && /licence key|invite code/i.test(notice.textContent),
      "and the notice names both routes in, so nobody has to guess which they are",
      notice && notice.textContent.slice(0, 80));

    notice.querySelector(".guardai-locked__ok").click();
    await wait(20);
    check(env.runtimeMessages.some((m) => m && m.type === "GUARDAI_OPEN_ACTIVATION"),
      "one click opens activation — not a dead end",
      JSON.stringify(env.runtimeMessages));
  }
  {
    const env = makeEnv({ licensed: false, seed: { guardai_enabled: false } });
    await wait(120);
    check(!env.document.querySelector(".guardai-locked"),
      "master-off shows NO notice — that silence was asked for");
    check(guardaiUI(env) === 0, "and nothing else either");
  }
  {
    const env = makeEnv({ seed: { guardai_enabled: false } });
    await wait(120);
    check(!env.document.querySelector(".guardai-locked"),
      "a LICENSED install that is switched off also stays silent");
  }
  {
    const env = makeEnv({ licensed: false });
    await wait(120);
    env.document.querySelector(".guardai-locked__close").click();
    await wait(20);
    check(!env.document.querySelector(".guardai-locked"), "the notice can be dismissed");
    check(env.storage.guardai_lock_notice_seen === true,
      "and stays dismissed — the popup carries the state permanently, this is only a pointer to it");
  }
  {
    const env = makeEnv({ licensed: false, seed: { guardai_lock_notice_seen: true } });
    await wait(120);
    check(!env.document.querySelector(".guardai-locked"), "so it does not come back on the next page");
  }

  /* ── 3. licensed behaves exactly as before (the control) ────────────── */
  console.log("\n--- 3. licensed: unchanged ---");
  {
    const env = makeEnv();
    await wait(80);
    await typeAndSend(env);
    check(env.sentMessages.length === 0, "the send was intercepted for review", String(env.sentMessages.length));
    check(!!env.document.querySelector(".guardai-prompt--warn"), "and the warning card was shown");
    check(!env.document.querySelector(".guardai-locked"), "with no locked notice anywhere");
  }

  /* ── 4. every shape of entitlement, through the real pipeline ───────── */
  console.log("\n--- 4. what counts as licensed ---");
  const now = Date.now();
  for (const [label, entitlement, shouldMask] of [
    ["a review licence (hardStopAt null)", rec(), true],
    ["a live licence", rec({ hardStopAt: now + 30 * DAY }), true],
    ["one inside its grace window", rec({ hardStopAt: now + DAY, lastVerifiedAt: now - 20 * DAY }), true],
    ["a warned (cancelled) licence still in its 14 days", rec({ status: "warned", hardStopAt: now + 5 * DAY }), true],
    ["one that ran out yesterday", rec({ hardStopAt: now - DAY }), false],
    ["a damaged record", { hardStopAt: "whenever" }, true],
    ["an empty object", {}, true],
  ]) {
    const env = makeEnv({ licensed: false, seed: { guardai_entitlement: entitlement } });
    await wait(80);
    await typeAndSend(env);
    const masked = env.sentMessages.length === 0;
    check(masked === shouldMask, `${label} -> ${shouldMask ? "protects" : "locked"}`,
      masked ? "intercepted" : "sent through");
  }
  {
    // The mirror of "a damaged record fails open": corruption must not be an
    // activation route for someone who never had a licence at all.
    const env = makeEnv({ licensed: false, seed: { guardai_entitlement: null } });
    await wait(80);
    await typeAndSend(env);
    check(env.sentMessages.length === 1, "no record at all is still locked — corruption is not a way in");
  }

  /* ── 5. THE ONE THAT MATTERS: a lock never confiscates data ─────────── */
  console.log("\n--- 5. locking stops protecting, it does not confiscate ---");
  {
    // Mask something while licensed, then let the licence run out.
    const env = makeEnv();
    await wait(80);
    await typeAndSend(env);
    const card = env.document.querySelector(".guardai-prompt--warn");
    const maskBtn = card && card.querySelector(".guardai-prompt__btn--send");
    check(!!maskBtn, "set-up: the Mask & Send button is there", card ? card.textContent.slice(0, 60) : "no card");
    if (maskBtn) {
      maskBtn.click();
      await wait(400);
      check(env.sentMessages.length === 1, "set-up: a masked message was sent");
      const sent = env.sentMessages[0] && env.sentMessages[0].text;
      check(sent && !sent.includes("Sarah Chen"), "set-up: with the real name replaced", sent);

      const mapSize = Object.keys(env.storage.guardai_mapping || {}).length;
      check(mapSize > 0, "set-up: and a mapping table now exists on the device", String(mapSize));

      // Now the subscription lapses.
      await env.window.chrome.storage.local.set({
        guardai_entitlement: rec({ hardStopAt: Date.now() - DAY }),
      });
      await wait(150);

      check(!!env.document.querySelector(".guardai-locked") ||
            env.storage.guardai_lock_notice_seen === true,
        "the user is told they are now locked");

      // The point: their data is still reachable.
      env.EDITOR.textContent = SECRET;
      env.EDITOR.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await wait(150);
      check(env.sentMessages.length === 2 && env.sentMessages[1].text === SECRET,
        "new messages are no longer masked — the paid feature has stopped",
        env.sentMessages[1] && env.sentMessages[1].text);
      check((env.storage.guardai_mapping || []).length === mapSize,
        "the mapping table is untouched: locking is not deletion",
        String((env.storage.guardai_mapping || []).length));

      // The assertion that actually matters, and the one this test did not
      // make on its first attempt: not that the data still EXISTS, but that
      // the user can still READ it. Storage being intact is worth nothing if
      // restore has been gated off — they would be looking at a fake name in
      // their own chat history with the real value sitting on their disk.
      const pair = (env.storage.guardai_mapping || []).find((m) => m.type === "NAME_PII");
      check(!!pair, "set-up: a name pair to restore", JSON.stringify(pair));
      if (pair) {
        const main = env.document.createElement("main");
        const para = env.document.createElement("p");
        para.textContent = `Sure — I have noted the details for ${pair.fake}.`;
        main.appendChild(para);
        env.document.body.appendChild(main);
        await wait(500);
        check(para.textContent.includes(pair.real),
          "AND THE REAL NAME IS STILL RESTORED IN THE REPLY — a lapsed licence stops protecting, it does not put a paywall in front of data the user already has",
          para.textContent);
        check(!para.textContent.includes(pair.fake),
          "with the stand-in gone, not left alongside it", para.textContent);
      }
    }
  }

  /* ── 6. activating unlocks the tab you already have open ────────────── */
  console.log("\n--- 6. live transitions ---");
  {
    const env = makeEnv({ licensed: false });
    await wait(80);
    await typeAndSend(env);
    check(env.sentMessages.length === 1, "set-up: locked, so the message went straight out");

    await env.window.chrome.storage.local.set({ guardai_entitlement: rec() });
    await wait(120);

    check(!env.document.querySelector(".guardai-locked"), "activating clears the notice immediately");
    await typeAndSend(env);
    check(env.sentMessages.length === 1,
      "and masking starts without a reload — waiting for one would make a successful activation look like a failure",
      String(env.sentMessages.length));
  }
  {
    const env = makeEnv();
    await wait(80);
    await env.window.chrome.storage.local.remove("guardai_entitlement");
    await wait(120);
    await typeAndSend(env);
    check(env.sentMessages.length === 1, "and removing the entitlement locks the open tab just as fast");
  }

  /* ── 7. the side door: a storage failure must not lock anyone out ───── */
  console.log("\n--- 7. attacks on the gate ---");
  {
    // Broken from before boot: patching the stub afterwards is too late,
    // because loadSettings() has already run. Getting this wrong made the test
    // pass for the wrong reason on the first attempt.
    const env = makeEnv({ licensed: false, storageFails: true });
    await wait(120);
    await typeAndSend(env);
    check(env.sentMessages.length === 0,
      "a storage failure leaves GuardAI PROTECTING, not locked — an error is never the server saying no, even when the error is local",
      "message went out unmasked");
  }
  {
    // A licence that expires between the check and the send must not corrupt
    // anything: worst case it protects for a few more milliseconds.
    const env = makeEnv({ seed: { guardai_entitlement: rec({ hardStopAt: Date.now() + 60 }) } });
    await wait(120);
    await typeAndSend(env);
    check(true, "a licence expiring mid-flight neither crashed nor corrupted the message");
    const out = env.sentMessages[0];
    check(!out || out.text === SECRET || !out.text.includes("Sarah Chen"),
      "the message is either untouched or properly masked — never half-masked",
      out && out.text);
  }

  console.log(`\nGATE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
