/**
 * Usernames and passwords / login credentials.
 *
 * Neither has a detectable FORMAT — "admin", "jsmith92" and "Tr0ub4dor!" are
 * just tokens — so both are detected purely from the phrasing around them,
 * and the value is bounded to the token that follows the trigger.
 *
 * Three things this file is really guarding:
 *
 *  - BOUNDARY. The captured value must be the credential and nothing else. An
 *    over-capture here is not a mis-flag, it deletes words from the user's
 *    message when masked (see text-integrity.cjs). "The login for the billing
 *    portal is acme_admin" briefly captured the word "for" and masked it,
 *    turning the sentence into nonsense — hence the integrity check below.
 *
 *  - NO PARTIAL SECRETS. "the password is Tr0ub4dor!" must capture the "!".
 *    A naive trailing-punctuation trim dropped it, leaving the last character
 *    of a real password in the message — and stripping the only symbol from
 *    "Summer2026!" also made it fail the strong-token test, so it went
 *    undetected entirely.
 *
 *  - FALSE POSITIVES. Phrasing-driven detection fires on prose unless it is
 *    guarded, so the complaint cases ("I forgot my password again") matter as
 *    much as the positive ones.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow, maskText } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

(async () => {
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const valuesOf = (text, type) =>
    det.scan(text).filter((f) => f.type === type).map((f) => f.value);

  /* ---- 1. The three requested positive cases ---- */
  console.log("\n--- requested positive cases ---");
  const positives = [
    {
      text: "Can you help me troubleshoot, the username is jsmith92 and the password is Tr0ub4dor!",
      user: "jsmith92",
      pass: "Tr0ub4dor!",
    },
    {
      text: "Login details: user admin, pass Summer2026!",
      user: "admin",
      pass: "Summer2026!",
    },
    {
      text: "Her Netflix password is bluewhale88 in case you need to log in",
      user: null,
      pass: "bluewhale88",
    },
  ];
  for (const c of positives) {
    if (c.user) {
      check(valuesOf(c.text, "USERNAME").includes(c.user),
        `username detected: ${JSON.stringify(c.user)}`,
        JSON.stringify(valuesOf(c.text, "USERNAME")));
    }
    check(valuesOf(c.text, "PASSWORD").includes(c.pass),
      `password detected in full (incl. trailing symbol): ${JSON.stringify(c.pass)}`,
      JSON.stringify(valuesOf(c.text, "PASSWORD")));

    const r = await maskText(w, c.text);
    if (c.user) check(!r.masked.includes(c.user), `username masked out: ${c.user}`, r.masked);
    check(!r.masked.includes(c.pass), `password masked out: ${c.pass}`, r.masked);
    // No fragment of the real secret may survive — the trailing-symbol bug
    // left "!" behind while reporting the value as masked.
    check(!r.masked.includes(c.pass.replace(/[^A-Za-z0-9]+$/, "")),
      `no partial secret left behind: ${c.pass}`, r.masked);
    console.log("      " + r.masked);
  }

  /* ---- 2. Additional trigger phrasings ---- */
  console.log("\n--- other phrasings ---");
  const phrasings = [
    ["username is X", "The username is jsmith92", "USERNAME", "jsmith92"],
    ["username: X", "username: jsmith92", "USERNAME", "jsmith92"],
    ["user: X", "user: admin", "USERNAME", "admin"],
    ["login is X", "The login is acme_admin", "USERNAME", "acme_admin"],
    ["user id = X", "user id = svc_backup", "USERNAME", "svc_backup"],
    ["login for <system> is X", "The login for the billing portal is acme_admin", "USERNAME", "acme_admin"],
    ["password: X", "password: hunter22", "PASSWORD", "hunter22"],
    ["pwd is X", "pwd is Xk7!vqla", "PASSWORD", "Xk7!vqla"],
    ["pass: X", "user: admin, pass: hunter2", "PASSWORD", "hunter2"],
    ["passphrase is X", "passphrase is correct-horse-battery", "PASSWORD", "correct-horse-battery"],
  ];
  for (const [label, text, type, expected] of phrasings) {
    check(valuesOf(text, type).includes(expected), `${label} -> ${JSON.stringify(expected)}`,
      JSON.stringify(valuesOf(text, type)));
  }

  /* ---- 2b. Full phrasing matrix ---- */
  // Most of these need no pattern of their own: the rule keys on the trigger
  // word sitting immediately before the separator, so leading modifiers
  // ("temp", "new", "her", "WiFi", "admin", "account") come for free. The
  // exception is the "<trigger> for <system> is X" shape, where words
  // intervene AFTER the trigger — that needs its own pattern, and this table
  // is what proves which forms genuinely rely on it.
  console.log("\n--- phrasing matrix: passwords ---");
  const PW_MATRIX = [
    ["password: X", "password: Th0rnBush42"],
    ["password is X", "password is Th0rnBush42"],
    ["password = X", "password = Th0rnBush42"],
    ["pwd: X", "pwd: Th0rnBush42"],
    ["pwd is X", "pwd is Th0rnBush42"],
    ["pass: X", "pass: Th0rnBush42"],
    ["pass is X", "pass is Th0rnBush42"],
    ["the password for [system] is X", "the password for the billing portal is Th0rnBush42"],
    ["[system] password is X", "the router password is Th0rnBush42"],
    ["temp password is X", "temp password is Th0rnBush42"],
    ["the temp password for [system] is X", "the temp password for the VPN is Th0rnBush42"],
    ["login password is X", "login password is Th0rnBush42"],
    ["her password is X", "her password is Th0rnBush42"],
    ["his password is X", "his password is Th0rnBush42"],
    ["their password is X", "their password is Th0rnBush42"],
    ["new password is X", "new password is Th0rnBush42"],
    ["updated password is X", "updated password is Th0rnBush42"],
    ["default password is X", "default password is Th0rnBush42"],
    ["shared password is X", "shared password is Th0rnBush42"],
    ["admin password is X", "admin password is Th0rnBush42"],
    ["WiFi password is X", "WiFi password is Th0rnBush42"],
    ["wifi pass: X", "wifi pass: Th0rnBush42"],
    ["account password: X", "account password: Th0rnBush42"],
  ];
  for (const [label, text] of PW_MATRIX) {
    check(valuesOf(text, "PASSWORD").includes("Th0rnBush42"), `PASSWORD | ${label}`,
      JSON.stringify(det.scan(text).map((f) => f.type + ":" + f.value)));
  }

  console.log("\n--- phrasing matrix: usernames ---");
  const UN_MATRIX = [
    ["username: X", "username: rwalsh_admin"],
    ["username is X", "username is rwalsh_admin"],
    ["user: X", "user: rwalsh_admin"],
    ["user is X", "user is rwalsh_admin"],
    ["login username is X", "login username is rwalsh_admin"],
    ["account username is X", "account username is rwalsh_admin"],
    ["her username is X", "her username is rwalsh_admin"],
    ["his username is X", "his username is rwalsh_admin"],
    ["login is X", "login is rwalsh_admin"],
    ["the login is X", "the login is rwalsh_admin"],
    ["login: X", "login: rwalsh_admin"],
  ];
  for (const [label, text] of UN_MATRIX) {
    check(valuesOf(text, "USERNAME").includes("rwalsh_admin"), `USERNAME | ${label}`,
      JSON.stringify(det.scan(text).map((f) => f.type + ":" + f.value)));
  }

  /* ---- 2c. Many phrasings in ONE message, none skipped ---- */
  console.log("\n--- multiple phrasings in one message ---");
  {
    const text = [
      "Handover notes:",
      "the username is rwalsh_admin and the password is Th0rnBush!42.",
      "For the billing portal, user: jdoe_01, pwd: Winter#2026.",
      "The temp password for the VPN is Sk8rBoi$99.",
      "Her login is s.chen_ops and her password is Marm0set!7.",
      "WiFi password is Coastal#Breeze21 and the default password is admin1234.",
      "The shared admin password = R00fTop%Garden.",
    ].join("\n");
    const secrets = [
      "rwalsh_admin", "Th0rnBush!42", "jdoe_01", "Winter#2026", "Sk8rBoi$99",
      "s.chen_ops", "Marm0set!7", "Coastal#Breeze21", "admin1234", "R00fTop%Garden",
    ];
    const r = await maskText(w, text);
    for (const s of secrets) {
      check(r.items.some((it) => it.value === s), `multi: detected ${JSON.stringify(s)}`,
        JSON.stringify(r.items.map((i) => i.value)));
      check(!r.masked.includes(s), `multi: masked out ${JSON.stringify(s)}`);
    }
    const fakes = r.items.map((it) => it.fake);
    check(fakes.length === secrets.length,
      `multi: every credential produced an item (${fakes.length}/${secrets.length})`);
    check(new Set(fakes).size === fakes.length,
      "multi: every fake is unique — none reused across phrasings", JSON.stringify(fakes));
    // Labels and prose must survive untouched.
    for (const kept of ["the username is ", "user: ", "pwd: ", "The temp password for the VPN is ",
      "Her login is ", "WiFi password is ", "the default password is ", "The shared admin password = "]) {
      check(r.masked.includes(kept), `multi: label preserved ${JSON.stringify(kept)}`, r.masked);
    }
    console.log("\n" + r.masked.split("\n").map((l) => "      " + l).join("\n") + "\n");
  }

  /* ---- 3. False positives ---- */
  console.log("\n--- false-positive controls ---");
  const negatives = [
    "I forgot my password again, need to reset it",
    "Can you explain how password managers work",
    "The username is required before you can continue",
    "My login is broken and I cannot get in",
    "Password protection should be enabled on that share",
    "Can you write a blog post about password security",
    "The user was unable to sign in this morning",
    "What is a good password policy for a small business",
    // Statements ABOUT a password, where the word after the trigger is an
    // ordinary predicate adjective rather than a secret. Flagging these
    // replaces a normal English word with a fake credential.
    "the password is important",
    "the password for security is important",
    "the new password is stronger",
    "her password is compromised",
    "the shared password is temporary",
  ];
  for (const text of negatives) {
    const found = det.scan(text).filter((f) => f.type === "USERNAME" || f.type === "PASSWORD");
    check(found.length === 0, `no credential flagged: ${JSON.stringify(text)}`,
      JSON.stringify(found.map((f) => `${f.type}:${f.value}`)));
  }

  /* ---- 4. Surrounding text is never altered ---- */
  console.log("\n--- text integrity ---");
  {
    const text = "The login for the billing portal is acme_admin and the password is Tr0ub4dor!";
    const r = await maskText(w, text);
    const ordered = [...r.items].sort((a, b) => a.start - b.start);
    let rebuilt = "";
    let cur = 0;
    for (const it of ordered) { rebuilt += text.slice(cur, it.start) + it.fake; cur = it.end; }
    rebuilt += text.slice(cur);
    check(rebuilt === r.masked, "only the detected spans were replaced", r.masked);
    check(r.masked.startsWith("The login for the billing portal is "),
      "the trigger phrase itself is preserved", r.masked);
    check(r.masked.includes(" and the password is "),
      "the joining clause is preserved", r.masked);
    for (const f of det.scan(text)) {
      check(!/\s/.test(f.value), `credential value is a single token: ${JSON.stringify(f.value)}`);
    }
    console.log("      " + r.masked);
  }

  /* ---- 4b. Chained labels: "<trigger> is <trigger>: <value>" ---- */
  console.log("\n--- chained labels ---");
  // "client portal login is username: rwalsh_admin" — the outer trigger
  // ("login is") captured the INNER LABEL "username:" as its value and masked
  // that, while the real credential went out in the clear. The visible symptom
  // was the wrong word being replaced; the actual failure was the leak. Both
  // halves are asserted here, and the leak half is the one that matters.
  {
    const chained = [
      ["login is username: X", "client portal login is username: rwalsh_admin",
        ["rwalsh_admin"], ["username:", "login is"]],
      ["login is username X, password Y",
        "client portal login is username: rwalsh_admin, password: Th0rnBush!42",
        ["rwalsh_admin", "Th0rnBush!42"], ["username:", "password:"]],
      ["credentials are username X",
        "The credentials are username: svc_deploy",
        ["svc_deploy"], ["username:"]],
      ["login details then labels",
        "Login details: username jdoe_01, password Winter#2026",
        ["jdoe_01", "Winter#2026"], ["username ", "password "]],
    ];
    for (const [label, text, secrets, labelsKept] of chained) {
      const r = await maskText(w, text);
      for (const s of secrets) {
        check(!r.masked.includes(s), `${label}: real value ${JSON.stringify(s)} is masked`, r.masked);
      }
      for (const kept of labelsKept) {
        check(r.masked.includes(kept), `${label}: label ${JSON.stringify(kept)} left in place`, r.masked);
      }
      // No finding may BE a label word.
      for (const f of det.scan(text)) {
        check(!/^(?:username|user|login|password|pass|pwd|credentials?)$/i.test(f.value),
          `${label}: no finding captured a label word`, JSON.stringify(f.value));
      }
      console.log("      " + r.masked);
    }
  }

  /* ---- 5. Both categories are individually toggleable ---- */
  console.log("\n--- settings toggles ---");
  {
    const text = "the username is jsmith92 and the password is Tr0ub4dor!";
    const d2 = new w.GuardAI.Detector();

    d2.setDisabledTypes(["USERNAME"]);
    let f = d2.scan(text);
    check(!f.some((x) => x.type === "USERNAME"), "USERNAME toggle off removes username findings");
    check(f.some((x) => x.type === "PASSWORD"), "USERNAME toggle off leaves passwords detected");

    d2.setDisabledTypes(["PASSWORD"]);
    f = d2.scan(text);
    check(!f.some((x) => x.type === "PASSWORD"), "PASSWORD toggle off removes password findings");
    check(f.some((x) => x.type === "USERNAME"), "PASSWORD toggle off leaves usernames detected");

    d2.setDisabledTypes([]);
    f = d2.scan(text);
    check(f.some((x) => x.type === "USERNAME") && f.some((x) => x.type === "PASSWORD"),
      "both detected again when re-enabled (ON is the default state)");
  }

  console.log(`\nCREDENTIALS: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})();
