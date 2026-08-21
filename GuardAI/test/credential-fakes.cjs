/**
 * Credential fake-value generation, and USERNAME reaching the real pipeline.
 *
 * Why the fixed "[redacted-secret]" was a correctness bug, not just a cosmetic
 * one: EVERY password in a message mapped to that same string, so two
 * different secrets became indistinguishable. previewFake()'s collision guard
 * exists precisely to stop two distinct real values sharing a fake, but it
 * resolves collisions by RE-GENERATING — and a constant generator returns the
 * same value on all 100 retries, so it silently gave up and handed out the
 * duplicate. Unmasking then had no way to know which secret a given
 * "[redacted-secret]" belonged to.
 *
 * So the central assertion here is uniqueness across multiple credentials in
 * one message, not merely "the fake looks realistic".
 *
 * The last section drives the REAL content.js (via harness.cjs's editor
 * emulation) rather than the detector in isolation, because the reported
 * symptom — "username not masked, password masked" — could only have come
 * from the full extension pipeline.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText } = require("./_env.cjs");
const { makeEnv, wait } = require("../harness.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  const w = loadWindow();

  /* ---- 1. The two requested messages ---- */
  console.log("\n--- requested cases ---");
  {
    const text = "The username is jsmith92 and the password is Tr0ub4dor!";
    const r = await maskText(w, text);
    const byType = Object.fromEntries(r.items.map((it) => [it.type, it.fake]));
    check(!!byType.USERNAME, "username is detected and given a fake", JSON.stringify(r.items));
    check(!!byType.PASSWORD, "password is detected and given a fake", JSON.stringify(r.items));
    check(!r.masked.includes("jsmith92"), "real username gone from the message", r.masked);
    check(!r.masked.includes("Tr0ub4dor!"), "real password gone from the message", r.masked);
    check(!/redacted/i.test(r.masked), "no generic placeholder in the output", r.masked);
    check(byType.USERNAME !== byType.PASSWORD, "the two credentials get different fakes");
    console.log("      " + r.masked);
  }
  {
    const text = "Two accounts: username sarahk password Purple7Frog!, username admin2 password Green9Cat#";
    const r = await maskText(w, text);
    const reals = ["sarahk", "Purple7Frog!", "admin2", "Green9Cat#"];
    for (const real of reals) {
      check(r.items.some((it) => it.value === real), `detected: ${real}`,
        JSON.stringify(r.items.map((i) => i.value)));
      check(!r.masked.includes(real), `masked out: ${real}`, r.masked);
    }
    const fakes = r.items.map((it) => it.fake);
    check(fakes.length === 4, "four credentials produced four items", JSON.stringify(fakes));
    check(new Set(fakes).size === fakes.length, "all four fakes are unique", JSON.stringify(fakes));
    check(!/redacted/i.test(r.masked), "no generic placeholder in the output", r.masked);
    console.log("      " + r.masked);
  }

  /* ---- 2. Shape of the generated fakes ---- */
  console.log("\n--- fake value shape ---");
  {
    const masker = new w.GuardAI.Masker();
    await masker.load();
    const pw = [];
    const un = [];
    for (let i = 0; i < 200; i++) {
      pw.push(masker.previewFake("PASSWORD", "secret" + i, new Set()));
      un.push(masker.previewFake("USERNAME", "handle" + i, new Set()));
    }
    check(pw.every((p) => /[a-z]/.test(p)), "password fake always has a lowercase letter");
    check(pw.every((p) => /[A-Z]/.test(p)), "password fake always has an uppercase letter");
    check(pw.every((p) => /\d/.test(p)), "password fake always has a digit");
    check(pw.every((p) => /[^A-Za-z0-9]/.test(p)), "password fake always has a symbol");
    check(pw.every((p) => p.length >= 9 && p.length <= 12), "password fake is 9-12 chars",
      JSON.stringify(pw.slice(0, 3)));
    check(!pw.some((p) => /redacted/i.test(p)), "no password fake is a placeholder");
    // Uniqueness is the whole point — a generator that repeats defeats the
    // collision guard exactly the way the constant did.
    check(new Set(pw).size >= 198, "200 password fakes are essentially all distinct",
      `distinct=${new Set(pw).size}`);
    check(new Set(un).size >= 190, "200 username fakes are essentially all distinct",
      `distinct=${new Set(un).size}`);
    check(un.every((u) => /^[a-z]+\d+$/.test(u)), "username fake is a plausible handle",
      JSON.stringify(un.slice(0, 3)));
    console.log("      sample passwords: " + pw.slice(0, 4).join("  "));
    console.log("      sample usernames: " + un.slice(0, 4).join("  "));
  }

  /* ---- 3. The same real value still maps to the same fake ---- */
  console.log("\n--- coherence ---");
  {
    const text = "username jsmith92 password Tr0ub4dor!, confirm username jsmith92 again";
    const r = await maskText(w, text);
    const userFakes = [...new Set(r.items.filter((i) => i.type === "USERNAME").map((i) => i.fake))];
    check(userFakes.length === 1,
      "the same username twice in one message maps to ONE fake (conversation stays coherent)",
      JSON.stringify(r.items.filter((i) => i.type === "USERNAME")));
  }

  /* ---- 4. Real content.js pipeline, not just the detector ---- */
  console.log("\n--- real pipeline (content.js) ---");
  {
    const env = makeEnv({ pasteWorks: true });
    await wait(60); // let boot() settle
    const text = "The username is jsmith92 and the password is Tr0ub4dor!";
    env.EDITOR.textContent = text;
    env.EDITOR.dispatchEvent(
      new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await wait(120);

    const popup = env.document.querySelector(".guardai-prompt--warn");
    check(!!popup, "the real pipeline intercepts the credential message");
    check(env.sentMessages.length === 0, "nothing was sent before review");

    const btn = popup && popup.querySelector(".guardai-prompt__btn--send");
    if (btn) btn.onclick();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await wait(150);
      if (env.sentMessages.length > 0) { await wait(120); break; }
    }
    const sent = env.sentMessages.map((m) => m.text).join("\n");
    check(env.sentMessages.length === 1, "exactly one message was sent",
      `count=${env.sentMessages.length}`);
    check(!sent.includes("jsmith92"),
      "USERNAME really is masked by the full extension, not just the detector", sent);
    check(!sent.includes("Tr0ub4dor!"), "PASSWORD is masked by the full extension", sent);
    check(!/redacted/i.test(sent), "no generic placeholder in what actually gets sent", sent);
    console.log("      sent: " + sent);
  }

  console.log(`\nCREDENTIAL-FAKES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
