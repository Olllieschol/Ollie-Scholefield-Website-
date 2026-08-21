/**
 * Lowercase name detection.
 *
 * People type "contact oliver scholefield his phone number is 0414 593 204"
 * constantly in chat, and a name is PII regardless of case. The capitalised
 * matcher cannot see it, because capitalisation was the ONLY signal marking a
 * token as a proper noun. The gazetteer substitutes for it: token 1 must be a
 * given name the list vouches for.
 *
 * ═══ WHY THIS FILE IS SHAPED THE WAY IT IS ════════════════════════════════
 *
 * Removing the capitalisation requirement is a precision risk, so the
 * NEGATIVE corpus below is the point of this file — not the positive cases.
 * It is deliberately adversarial: 60 lowercase messages that all contain
 * other PII (the only condition under which this rule runs) and are stuffed
 * with words that are BOTH gazetteer given names and ordinary English —
 * will, mark, bill, may, rose, hope, faith, art, chase, drew, hunter, frank,
 * rich, van, guy, penny, sunny, major, king, justice, summer, april, june,
 * dawn, sky, star, olive, iris, jade, sage, clay, dean, lane, moss, brook,
 * heath, ford, jack, carol, grant, sue, don, bob, wade, buck, glen, cliff,
 * rain, storm, earl, dale.
 *
 * The first implementation scored 3/60 on the original corpus, not 0/60. The
 * three failures — "hunter green", "jack up", "carol singing" — are what
 * forced the lowercase path to be STRICTER than the capitalised one.
 *
 * The corpus was then still WRONG: every entry was prose with no given name in
 * it, so "given name + verb" never appeared, and a regression that masked
 * "james is" as a full name (deleting the word "is") got through this file
 * entirely and was caught by text-integrity.cjs instead. Those cases are now
 * included, and rules 4 and 5 exist because of them. Five rules, each pinned
 * by its own case below, so removing any one fails this suite rather than
 * silently regressing precision.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const PH = " on 0412 556 781";

/** Lowercase prose WITH other PII but NO person's name. */
const NEGATIVE = [
  "i will call you back", "can you mark this as done", "please bill the client",
  "we may need more time", "the rose garden looks good", "i hope everyone agrees",
  "have faith in the process", "what a joy that was", "the art department replied",
  "let me chase this up", "i drew a diagram", "he will reed the notes",
  "the hunter green colour", "be frank with me", "that is rich coming from him",
  "book a van for friday", "that guy from accounts", "a penny saved",
  "it was sunny today", "a major issue came up", "the king street office",
  "justice was served", "summer is coming", "in april we launch",
  "by june it should ship", "at dawn tomorrow", "the sky looks clear",
  "a star performer", "olive oil please", "the iris scanner broke",
  "jade coloured tiles", "sage advice honestly", "clay tiles arrived",
  "dean of the faculty", "down the lane", "moss on the roof",
  "by the brook", "heath is dry", "ford the river",
  "jack up the price", "carol singing tonight", "please grant access",
  "i can sue them", "don a hard hat", "bob the ball back",
  "check the mike level", "wade through the docs", "buck the trend",
  "a glen in scotland", "off the cliff edge", "heavy rain today",
  "the storm passed", "an earl grey tea", "a dale in yorkshire",
  "please review the report", "send me the invoice", "can we reschedule",
  "the meeting ran over", "thanks for your help", "sounds good to me",
  // GIVEN NAME + VERB. This whole class was MISSING from the first version of
  // this corpus, which was all lowercase prose containing no given names at
  // all. It let a regression through that masked "james is" as a full name and
  // DELETED the word "is" from the message — the corrupt-the-sentence failure
  // this codebase treats as the worst outcome. Caught by text-integrity.cjs,
  // not by this file, which is exactly why it is pinned here now.
  "james is at the office", "sarah was here earlier", "oliver will call later",
  "grace has the file", "daniel can help", "priya said yes",
  "chidi went home", "maria works upstairs", "hiroshi lives nearby",
  "aroha needs the draft", "kwame got it done", "zeynep asks about it",
  "james and sarah agreed", "oliver or daniel can go", "priya to confirm",
];

/** Lowercase prose that DOES contain a name. */
const POSITIVE = [
  ["contact oliver scholefield his phone number is 0414 593 204", "oliver scholefield"],
  ["call priya sharma on 0412 556 781", "priya sharma"],
  ["email james whitfield at j@x.com", "james whitfield"],
  ["chidi okafor rang about it, 0412 556 781", "chidi okafor"],
  ["ask zeynep yilmaz, her number is 0412 556 781", "zeynep yilmaz"],
  ["nguyen tran will attend, 0412 556 781", "nguyen tran"],
  ["kwame mensah sent it, 0412 556 781", "kwame mensah"],
  ["tell aroha nkemdirim, 0412 556 781", "aroha nkemdirim"],
  ["maria garcia called, 0412 556 781", "maria garcia"],
  ["hiroshi tanaka emailed h@x.com", "hiroshi tanaka"],
];

(async () => {
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const names = (t) =>
    det.scan(t).filter((f) => f.type === "NAME_PII").map((f) => f.value);

  /* ---- Recall ---- */
  console.log("\n--- lowercase names are detected ---");
  for (const [text, expected] of POSITIVE) {
    check(names(text).some((v) => v.toLowerCase() === expected),
      `detected: ${expected}`, JSON.stringify(names(text)));
  }

  /* ---- Precision: the adversarial corpus ---- */
  console.log("\n--- lowercase prose is NOT flagged (60-message corpus) ---");
  let fp = 0;
  for (const base of NEGATIVE) {
    const text = base + PH;
    const found = names(text);
    if (found.length) { fp++; console.log(`FAIL  false positive ${JSON.stringify(found)} in: ${base}`); }
  }
  check(fp === 0, `zero false positives across ${NEGATIVE.length} lowercase messages`,
    `${fp} false positive(s)`);

  /* ---- The three strictness rules, pinned individually ---- */
  console.log("\n--- each strictness rule is load-bearing ---");
  // 1. ambiguous given name rejected outright, even with a gazetteer surname
  check(names("the hunter green colour" + PH).length === 0,
    "rule 1: ambiguous given name + gazetteer surname is still rejected in lowercase",
    JSON.stringify(names("the hunter green colour" + PH)));
  // 2. participle / adverb is not a surname
  check(names("carol singing tonight" + PH).length === 0,
    "rule 2: -ing/-ed/-ly token is not treated as a surname",
    JSON.stringify(names("carol singing tonight" + PH)));
  check(names("grace reported it" + PH).length === 0,
    "rule 2: -ed token is not treated as a surname",
    JSON.stringify(names("grace reported it" + PH)));
  // 3. verb particle is not a surname
  check(names("jack up the price" + PH).length === 0,
    "rule 3: verb particle is not treated as a surname",
    JSON.stringify(names("jack up the price" + PH)));
  // 4. function word / verb after a given name
  check(names("james is at 14 Grove Street" + PH).length === 0,
    "rule 4: a verb after a given name is not a surname (would delete the verb)",
    JSON.stringify(names("james is at 14 Grove Street" + PH)));
  // 5. the pass only fires on a genuinely lowercase token 1
  check(names("James is currently at 14 Grove Street, Ryan is at 88 Kellett Parade.").length === 0,
    "rule 5: capitalised token 1 is left to the capitalised pass, which requires a capitalised surname",
    JSON.stringify(names("James is currently at 14 Grove Street, Ryan is at 88 Kellett Parade.")));

  /* ---- The gate is unchanged: no standalone lowercase names ---- */
  console.log("\n--- still requires other PII ---");
  check(names("contact oliver scholefield about the invoice").length === 0,
    "a lowercase name with NO other PII is not flagged (gate intact)",
    JSON.stringify(names("contact oliver scholefield about the invoice")));
  check(names("my name is john smith and my email is john.smith@work.com")
      .some((v) => v.toLowerCase() === "john smith"),
    "a name-intro phrase still unlocks lowercase detection");

  /* ---- Capitalised behaviour is untouched ---- */
  console.log("\n--- capitalised path unaffected ---");
  for (const [text, expected] of [
    ["Contact James Whitfield on 0412 556 781", "James Whitfield"],
    ["Contact José Martinez on 0412 556 781", "José Martinez"],
    ["Contact Mary-Anne Douglas on 0412 556 781", "Mary-Anne Douglas"],
    ["Contact Ng Wei Ming on 0412 556 781", "Ng Wei Ming"],
  ]) {
    check(names(text).includes(expected), `capitalised still works: ${expected}`,
      JSON.stringify(names(text)));
  }
  // An ambiguous name IS still caught when capitalised — the strictness in
  // rule 1 applies only to the lowercase path.
  check(names("I met Grace Whitfield on 0412 556 781").includes("Grace Whitfield"),
    "rule 1 does NOT leak into the capitalised path (Grace Whitfield still caught)",
    JSON.stringify(names("I met Grace Whitfield on 0412 556 781")));

  /* ---- Documented residual limits (asserted so they stay honest) ---- */
  console.log("\n--- known limits, asserted so they can't silently change ---");
  // See project notes: these are accepted costs, not oversights. If one of
  // these starts passing, the limit has been fixed and the note should be
  // updated rather than the test loosened.
  check(names("i met grace whitfield" + PH).length === 0,
    "LIMIT: an ambiguous given name in lowercase is NOT caught (accepted cost of rule 1)",
    JSON.stringify(names("i met grace whitfield" + PH)));
  check(names("contact xylophia quandrix" + PH).length === 0,
    "LIMIT: a lowercase name absent from the gazetteer is NOT caught",
    JSON.stringify(names("contact xylophia quandrix" + PH)));

  console.log(`\nLOWERCASE-NAMES: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
