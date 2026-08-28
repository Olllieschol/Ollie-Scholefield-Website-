/**
 * Image scanning policy — the pure half.
 *
 * ═══ WHAT WAS MEASURED, AND WHERE ══════════════════════════════════════════
 *
 * Every threshold asserted here came out of the 2026-08-28 OCR measurement:
 * seven realistic UI screenshots (banking, ATO, payroll, Medicare card,
 * dark-mode chat, email; six retina, one 1x) with 19 checksum-valid planted
 * values, all 19 verified detectable in clean text FIRST so an OCR miss was
 * attributable to OCR. Results the fixtures below reuse:
 *
 *   readable pages    confidence 61–95, all planted values digit-exact
 *   degraded (60%)    confidence 27, digits DESTROYED ("sims 2811 70685008")
 *   dark chat, Otsu   confidence 0, ZERO characters — the silent failure
 *   the cut           OCR_MIN_CONF 45 sits in the 27→61 gap
 *
 * The card/flow half (three distinct screens, images never auto-release)
 * lives in test/file-attach.cjs §13, which has the jsdom attachment harness.
 *
 * The image fixtures are REAL encoder output, not hand-assembled headers:
 * sips wrote the PNG and JPEG, ffmpeg/libwebp wrote both WebP flavours, and
 * the Chrome header slice is the first 33 bytes of an actual 3024x1964
 * headless-Chrome screenshot. A parser tested only on bytes the test built
 * proves the test can read its own handwriting.
 *
 * Exit code 1 on any failure.
 */
const { loadWindow } = require("./_env.cjs");

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("pass  " + label);
  else { failures++; console.log("FAIL  " + label + (detail ? " — " + detail : "")); }
}

const w = loadWindow();
const FS = w.GuardAI.FileScan;
const det = new w.GuardAI.Detector();
const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

/* Real encoder output. All four small images are 40x26. */
const PNG_40x26 = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAaCAIAAABKLomcAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAKKADAAQAAAABAAAAGgAAAAChB41KAAABoElEQVRIDe1WSW7DMAzUQm9wnFv+2L/12I+0l6JfyLGLU0WmpI7sOIEB2UFa+NQIgUTREoczpI3Ih7dPNt9CSCoLEcRpyNFYbaXXx6dgjSZNRSWALKV3np1bDfEUmNTLc1NXRZEzs1IqhGA7blsjViYt3z9agGGAa2TcL1JKpfBTf+Tt4zjXbxKMiPTEMW7yPPOOkRCuaq0xO+8zojzPxyPXV3be2i55jiLX1ADgfr8/Hi0esmNAMjtkud1ud7td6kbCF5WciS+/WrR0YoAxcwd+ui88TkB/8D4cDjCc85tNfbUWHbtZxgnM0QWYozGAKcsSPqTuY+t1EKOuL6hznJDqGCmxUsJ3dqHAQqDj+xCoSAB48AGdZ4yxNlYhy7IhrfOli7GEKxaBhQQOyozQseVPpL2WqqrAOLquqn3JY2otAceicuxkGAMwZtIamyyjX0MOCcwCQ1R8VdBieJ17ieN5gDVNM9xEvQdjYZ4v/7zUXcfpF3AB55ZHf/023YI1OXsHnsix5uYu9ZrqTmLfpZ7Isebm/0lN+JuxpqKzsX8Ar+m7t40cceYAAAAASUVORK5CYII=";
const JPG_40x26 = "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAKKADAAQAAAABAAAAGgAAAAD/wAARCAAaACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAD/9oADAMBAAIRAxEAPwD9Jx+yZ4fWMoPHnisE9W+3W+c+v/Ht/SoW/ZJ0neyx+NfGcgU43DUbEA++DAD+dfWdW4rlYt+FJ3nPXp9OK9f+2sX/AM/X954S4cy/rQh/4Cv8j5Rg/Y+8N3MYlj+Ini/HvfW3B9P+PWpT+xx4fAJ/4WJ4v4/6frb/AORa+pbWSC1QLHFkjPzE88/hVs6hkEeX19//AK1L+28Z/wA/X94/9XMu/wCgeP8A4Cj47/4ZI0L/AKKD4u/8Drb/AORaP+GSNC/6KD4u/wDA62/+Ra+sqKr+28X/AM/X95P+rmX/APQPH/wFH//Q/dSioMn1oyfWtDMnoqDJ9aMn1oAnoqDJ9aMn1oA//9k=";
const WEBP_VP8_40x26 = "UklGRmYAAABXRUJQVlA4IFoAAABQBACdASooABoAPpE6mEeloyKhMAgAsBIJZQDQMuAAWbWImw6pmDE52hKAAP6RtL6E/jrHv4w/+U1RVacyrHPEvLPmozPp1+3v0uJF8V3veLy/vB4GAqAAAAA=";
const WEBP_VP8L_40x26 = "UklGRhABAABXRUJQVlA4TAQBAAAvJ0AGAM10IaL/sRn8iP6HcBrbtqvse/8nB0cLlE0DVIPDo5A5v3tIPzqcozaSJMkxB4KBMa9luoB3lQ7aRpIk1+zew+H4Azsim5iA9fd3vcL6v9QAbEHjy/d7v5989f4H2aSWprnVp9Hx9PTEEY/t5LLV2OL5C2GDMGK4nJqCsIJc8LurVCLICGLydKmStjsFoiCy5WaQVp5NyzVlRgUhCoptnurimQeM4MyJZGM5ZeoMrjH6gEyzJzLCARAFWB0K0w+GkLIz48oe6NCnwFYdmLhZHwCZlmdgLnCgSSO1ngwDTFmMjhwoSZ5bNdGT8DEAlAkAmjIgqj3stgPf1x342wetAQ==";
/* First 33 bytes of an actual 3024x1964 headless-Chrome screenshot. */
const CHROME_PNG_HEAD = "iVBORw0KGgoAAAANSUhEUgAAC9AAAAesCAIAAABjoAxT";

console.log("\n--- 1. classify: which images we read, and which we refuse ---");
{
  for (const [name, mime] of [
    ["shot.png", "image/png"], ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"], ["pic.webp", "image/webp"],
  ]) {
    const c = FS.classify(name, mime);
    check(c.kind === FS.KIND.IMAGE, `${name} is an image we scan`, c.kind);
  }
  // The formats tesseract cannot decode STAY unsupported — moving them to
  // IMAGE would put them on the OCR path, which would fail as "unreadable"
  // at best and as a decode-crash at worst. Either way they must keep the
  // unambiguous "not checked" screen.
  for (const name of ["anim.gif", "photo.heic", "photo.heif", "logo.svg", "old.bmp", "scan.tiff"]) {
    const c = FS.classify(name, "");
    check(c.kind === FS.KIND.UNSUPPORTED, `control: ${name} is still unsupported`, c.kind);
  }
  // MIME fallback only when there is no extension to trust.
  check(FS.classify("clipboard", "image/png").kind === FS.KIND.IMAGE,
    "extensionless image/png (a pasted screenshot) is an image");
  check(FS.classify("clipboard", "image/gif").kind === FS.KIND.UNSUPPORTED,
    "control: extensionless image/gif is not");
  check(FS.classify("report.pdf", "image/png").kind === FS.KIND.PDF,
    "control: a MIME that disagrees with a known extension does not override it");
}

console.log("\n--- 2. imageDims reads real encoder headers, not just its own ---");
{
  for (const [label, bytes, want] of [
    ["sips PNG", b64(PNG_40x26), { width: 40, height: 26 }],
    ["sips JPEG (with EXIF before the frame header)", b64(JPG_40x26), { width: 40, height: 26 }],
    ["libwebp lossy (VP8)", b64(WEBP_VP8_40x26), { width: 40, height: 26 }],
    ["libwebp lossless (VP8L)", b64(WEBP_VP8L_40x26), { width: 40, height: 26 }],
    ["Chrome screenshot header slice", b64(CHROME_PNG_HEAD), { width: 3024, height: 1964 }],
  ]) {
    const d = FS.imageDims(bytes);
    check(!!d && d.width === want.width && d.height === want.height,
      `${label} -> ${want.width}x${want.height}`, d ? `${d.width}x${d.height}` : "null");
  }

  // VP8X extended header, per spec: 24-bit little-endian canvas size minus 1.
  const vp8x = new Uint8Array(30);
  const put = (s, o) => { for (let i = 0; i < s.length; i++) vp8x[o + i] = s.charCodeAt(i); };
  put("RIFF", 0); put("WEBP", 8); put("VP8X", 12);
  vp8x[24] = (3024 - 1) & 0xff; vp8x[25] = ((3024 - 1) >> 8) & 0xff; vp8x[26] = ((3024 - 1) >> 16) & 0xff;
  vp8x[27] = (1964 - 1) & 0xff; vp8x[28] = ((1964 - 1) >> 8) & 0xff; vp8x[29] = ((1964 - 1) >> 16) & 0xff;
  const dx = FS.imageDims(vp8x);
  check(!!dx && dx.width === 3024 && dx.height === 1964,
    "VP8X extended header -> 3024x1964", dx ? `${dx.width}x${dx.height}` : "null");

  // Unknown must come back null, never a guess — null routes to "size
  // unknown, scan anyway", so a wrong number here would be a wrong refusal.
  check(FS.imageDims(new Uint8Array([1, 2, 3, 4])) === null, "garbage bytes -> null");
  check(FS.imageDims(b64(PNG_40x26).slice(0, 12)) === null, "truncated PNG -> null");
  check(FS.imageDims(new TextEncoder().encode("%PDF-1.7 not an image at all")) === null,
    "control: PDF bytes -> null");
  check(FS.imageDims(null) === null, "null input -> null");
}

console.log("\n--- 3. the pixel cap refuses, in words, before decoding ---");
{
  check(FS.imageTooLarge({ width: 3024, height: 1964 }) === null,
    "a full retina screenshot (5.9MP) is read");
  check(FS.imageTooLarge({ width: 3024, height: 7936 }) === null,
    "a 4-screens-tall capture (24.0MP) is still read");
  const why = FS.imageTooLarge({ width: 6000, height: 4200 });
  check(typeof why === "string" && /25 megapixels/.test(why) && /not been read/.test(why),
    "25.2MP: refused with the size and the fact nothing was read", why);
  check(FS.imageTooLarge(null) === null,
    "unknown dimensions are NOT 'too large' — that refusal would be a guess");
}

console.log("\n--- 4. ocrVerdict: three states, cut where the measurements say ---");
{
  // A summary with real findings, from the real detector over OCR-shaped text.
  const found = FS.summarise(det.scan("Tax file number 347 436 637 on BSB 062-948"));
  check(found.total > 0, "fixture sanity: the detector fires on the planted text", `${found.total}`);

  const v = (o) => FS.ocrVerdict(o).action;

  // The four measured corpus points, verbatim.
  check(v({ summary: found, confidence: 88, textChars: 347 }) === "img-found",
    "dark chat with adaptive thresholding (conf 88, findings) -> found");
  check(v({ confidence: 95, textChars: 523 }) === "img-nothing",
    "clean email page (conf 95, no findings) -> nothing-in-what-we-read");
  check(v({ confidence: 27, textChars: 143 }) === "img-unreadable",
    "the degraded 60% page (conf 27 — digits were DESTROYED) -> could not read");
  check(v({ confidence: 0, textChars: 0 }) === "img-unreadable",
    "the empty default-Otsu dark page (conf 0, zero chars) -> could not read");

  check(v({ summary: found, confidence: 20, textChars: 60 }) === "img-found",
    "found beats unreadable: rules firing on a blurry image still warn");

  // Negative controls — the directions this is never allowed to fail.
  check(v({ confidence: 100, textChars: 5 }) === "img-unreadable",
    "control: a confident read of 5 stray chars is NOT 'nothing found'");
  check(v({ confidence: NaN, textChars: 500 }) === "img-unreadable",
    "control: a NaN confidence fails CLOSED, not open");
  check(v({}) === "img-unreadable", "control: an empty result is unreadable, never clean");
  check(v({ confidence: 45, textChars: 20 }) === "img-nothing",
    "boundary: exactly at both floors still counts as read");
  check(v({ confidence: 44.9, textChars: 500 }) === "img-unreadable",
    "boundary: just under the confidence floor does not");

  const un = FS.ocrVerdict({ confidence: 0, textChars: 0 });
  check(/could not make out text/.test(un.reason || ""),
    "the unreadable state carries its plain one-line reason", un.reason);
}

console.log(`\nFILE IMAGE: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures ? 1 : 0);
