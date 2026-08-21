/**
 * Section 1 regression tests — one test per confirmed bug, written so each
 * would have FAILED against the pre-fix code (git HEAD 279f4da):
 *
 *   Bug A: AU driver licences (NSW45612378 etc.) not masked at all.
 *   Bug B: address "156 Esplanade, Manly NSW 2095" leaked (standalone
 *          thoroughfare with no street-name word before it).
 *   Bug C: manual-panel auto-replace always substituted a first+last NAME
 *          regardless of the selected value's real type.
 *
 * Exit code 1 on any failure.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

function loadWindow({ withContent } = {}) {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://chatgpt.com/c/x",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const storage = {};
  w.chrome = {
    storage: {
      local: {
        get: (k) =>
          Promise.resolve(
            (Array.isArray(k) ? k : [k]).reduce((o, kk) => {
              if (kk in storage) o[kk] = storage[kk];
              return o;
            }, {})
          ),
        set: (o) => { Object.assign(storage, o); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => "file://" + p, sendMessage() {}, lastError: null },
  };
  if (!w.InputEvent) w.InputEvent = w.Event;
  const files = ["detector.js", "masker.js", "nlp-detector.js"];
  if (withContent) files.push("content.js");
  for (const f of files) w.eval(read(f));
  return w;
}

const LICENCES = ["NSW45612378", "NSW78234561", "NSW19283746", "NSW65498712", "NSW33219875"];
const ESPLANADE = "156 Esplanade, Manly NSW 2095";
const INPUT =
  "Please tidy this client data.\n" +
  "3. Connor Blake, 0401 223 998, connor.blake22@gmail.com, 156 Esplanade, Manly NSW 2095, DOB 27/06/1979, Driver Licence NSW45612378, Balance $52,400\n" +
  "6. Sarah Whitmore, 0467 123 456, sarah.w.business@gmail.com, 3/14 King St, Newtown NSW 2042, DOB 22/02/1990, Driver Licence NSW78234561, Balance $61,500\n" +
  "9. Lucas Ferreira, 0401 556 902, lucas.ferreira@yahoo.com, 12 Bay St, Cronulla NSW 2230, DOB 08/03/1987, Driver Licence NSW19283746, Balance $44,120\n" +
  "12. Olivia Marsh, 0422 667 901, olivia.marsh22@gmail.com, 19 Seaview St, Coogee NSW 2034, DOB 02/07/1996, Driver Licence NSW65498712, Balance $5,420\n" +
  "15. Marco Esposito, 0401 223 445, marco.esposito@gmail.com, 14 Marina Pde, Cronulla NSW 2230, DOB 21/11/1986, Driver Licence NSW33219875, Balance $39,600\n";

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log("pass  " + label);
  } else {
    failures++;
    console.log("FAIL  " + label + (detail ? " — " + detail : ""));
  }
}

(async () => {
  /* ---- Bugs A + B: detection + masking over real pipeline ---- */
  const w = loadWindow();
  const det = new w.GuardAI.Detector();
  const masker = new w.GuardAI.Masker();
  await masker.load();
  const findings = det.scan(INPUT);

  for (const lic of LICENCES) {
    const hit = findings.find((f) => f.type === "LICENCE" && f.value.includes(lic));
    check(!!hit, `licence detected: ${lic}`);
  }
  const addrHit = findings.find((f) => f.type === "ADDRESS" && f.value.includes("156 Esplanade"));
  check(!!addrHit, `address detected: ${ESPLANADE}`);

  // Mask with the real masker and confirm nothing leaks + fakes keep format.
  const { masked, replacements } = await masker.mask(INPUT, findings);
  for (const lic of LICENCES) {
    check(!masked.includes(lic), `licence masked: ${lic}`);
    const rep = replacements.find((r) => r.real.includes(lic));
    check(
      !!rep && /^NSW\d{8}$/.test(rep.fake) && rep.fake !== lic,
      `licence fake keeps NSW+8-digit shape: ${lic} -> ${rep && rep.fake}`
    );
  }
  check(!masked.includes(ESPLANADE), "esplanade address masked");
  check(!masked.includes("156 Esplanade"), "no fragment of the esplanade address remains");

  /* ---- Bug C: auto-replace same-type inference + fake shape ---- */
  const w2 = loadWindow({ withContent: true });
  await new Promise((r) => setTimeout(r, 50)); // let content.js boot()
  const hooks = w2.GuardAI._selectionTypeHooks;
  check(!!hooks, "content.js exposes selection-type test hooks");
  if (hooks) {
    const m2 = new w2.GuardAI.Masker();
    await m2.load();
    const CASES = [
      ["NSW45612378", "LICENCE", /^NSW\d{8}$/],
      ["0412 556 781", "PHONE", /^04\d{2} \d{3} \d{3}$/],
      ["234 567 891", "TFN", /^\d{3} \d{3} \d{3}$/],
      ["3456 78912 3", "MEDICARE", /^\d{4} \d{5} \d$/],
      ["03/04/1988", "DOB", /^\d{2}\/\d{2}\/\d{4}$/],
      ["$14,230", "MONEY", /^\$[\d,]+$/],
      ["062-000", "BSB", /^\d{3}-\d{3}$/],
      ["j.whitfield88@gmail.com", "EMAIL", /^[^@\s]+@[^@\s]+$/],
      ["12 Acacia Ave", "ADDRESS", /\d+ .+/],
      ["156 Esplanade", "ADDRESS", /\d+ .+/],
      ["James Whitfield", "NAME_PII", /^[A-Z][a-z]+ [A-Z][a-z]+$/],
    ];
    for (const [value, wantType, fakeShape] of CASES) {
      const got = hooks.inferSelectionType(value);
      check(got === wantType, `auto-replace type: ${JSON.stringify(value)} -> ${wantType}`, `got ${got}`);
      const fake = m2.previewFake(got, value);
      check(
        fakeShape.test(fake) && fake !== value,
        `auto-replace fake shape for ${wantType}: ${JSON.stringify(fake)}`
      );
      // The original bug: everything became "First Last". Non-name values must
      // never get a name-shaped fake.
      if (wantType !== "NAME_PII") {
        check(
          !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(fake),
          `non-name value does not get a person-name fake: ${JSON.stringify(value)}`
        );
      }
    }
    // Unknown junk must fall back to a generic redaction, not a name.
    const junkType = hooks.inferSelectionType("zx!!9 blorp-77 qq");
    const junkFake = m2.previewFake(junkType, "zx!!9 blorp-77 qq");
    check(junkType === "CUSTOM", "unclassifiable selection -> CUSTOM", `got ${junkType}`);
    check(
      !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(junkFake),
      `CUSTOM fake is not a person name: ${JSON.stringify(junkFake)}`
    );
  }

  console.log(`\nSECTION1: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
