# Chrome Web Store submission

Everything the store needs that is not in the code. Keep this in step with
`manifest.json` and `backend/licences.sql`.

---

## Privacy policy

**https://guard4ai.com/privacy** — this is the URL the Developer Dashboard
wants. A `chrome-extension://` page does not qualify, so the policy lives on
the site and `popup.js` / `settings.js` link out to it. The copy that used to
ship inside the package has been deleted rather than left to drift.

Rewritten 2026-08-22. The old version claimed GuardAI *"never makes a single
network request"* and *"we do not request … any network permissions"* while the
manifest carried `https://*.supabase.co/*` — a direct contradiction between the
stated data practices and the requested permissions, on a product whose entire
pitch is privacy. Fixed at the same time: `popup.html`'s *"zero external calls"*
badge, and the manifest description's *"nothing ever leaves your device"*.

The honest claim is still the strong one and it is what the listing now says:
**your message text never leaves your browser.** What leaves is a code at
activation, and — workplace accounts only — a category counter.

Contact address in the policy: **hello@guard4ai.com**. Make sure it actually
receives mail before submitting; a policy with a dead address is its own
rejection, and it is now also the address the in-product rights flow points at.

Still to do on the Developer Dashboard:

- **The Privacy practices tab must declare what is collected.** It currently
  implies nothing is. Authentication information (the licence key) now is, and
  for workplace accounts so is the category counter.

## Reviewer access

The extension does nothing until a code is entered, so **a reviewer who
installs it cold sees an inert extension and will reject it as
non-functional.** The Developer Dashboard's *Privacy practices → test
credentials / instructions* field is the remedy and must be filled in on every
submission.

Paste this into that field:

> GuardAI masks personal data before it is sent to AI chat sites. It stays
> inactive until a licence key is entered, so please activate it first:
>
> 1. Install the extension.
> 2. Click the GuardAI toolbar icon.
> 3. Paste this key into the "Activate" field and click Activate:
>    `GK-REVIEW-CHROME-STORE-0001`
> 4. Open https://chatgpt.com and type, without sending:
>    `Contact Sarah Chen on 0412 345 678`
> 5. Press Enter. GuardAI intercepts the send and offers to replace the name
>    and phone number with realistic fakes. Choose "Mask & Send".
>
> Detection runs entirely in the browser. The only network request the
> extension makes is the licence check in step 3.

**The review key never expires and cannot exhaust its activations.** That is
deliberate: review recurs on every update, months apart, with a different
person each time, and a key that lapses or runs out of seats gets a future
update rejected. It is defined at the bottom of `backend/licences.sql`.

Revoke it if it leaks:

```sql
update public.licences set status = 'cancelled' where plan = 'review';
```

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Stores the user's settings, the local real↔fake mapping table, and the licence record. All `chrome.storage.local`; none of it is synced or transmitted. |
| Host access to the AI chat sites listed in the manifest | The content script reads the message box on those sites and scans it locally before the user sends. Access is requested only for sites the extension actively protects. |
| `https://*.supabase.co/*` | Licence validation, and — only for workplace accounts, only after an invite code is entered — an anonymous count of how many items of each category were masked. Never the values, never the message text, never a URL. |

No remote code is executed. Everything runs from the package; the optional NLP
model, if bundled, is loaded from inside the extension with remote fetching
explicitly disabled.

## Packaging

```bash
bash tools/package.sh
```

Produces `dist/guardai-<version>.zip` (~4.7 MB) from an explicit allowlist.

**Do not zip the folder by hand.** It is 26 MB, of which 25 MB is
`node_modules` — jsdom and its dependency tree, pulled in for the test suite.
Shipping that is slow, exposes the adversarial test corpora, and invites
questions about code that has no business being in a privacy extension.
`test/packaging.cjs` checks the allowlist against the manifest on every run.

## web_accessible_resources

**Removed 2026-08-23, restored 2026-08-28 for a different resource.**

The original entry declared `lib/*` and `models/*` for the optional
Transformers.js NER layer. Neither directory shipped, so it pointed at nothing
and was dropped.

It is back because file scanning needs it, and needs exactly one entry:

```json
"web_accessible_resources": [
  { "resources": ["parser.html"], "matches": [ ...the 51 AI chat hosts... ] }
]
```

`parser.html` is the hidden extension-origin iframe the content script injects
to read an attachment. A frame loaded by a web page has to be declared, so this
is unavoidable — but only the frame does. Everything the frame then loads
(`src/*`, `vendor/*`) is a same-origin extension load and is deliberately NOT
listed, so a page cannot fetch pdf.js or the detector out of the extension.

`matches` is the same 51 AI chat hosts as the content script, not `<all_urls>`,
so only those pages can detect the extension by requesting the URL. If that
residual fingerprinting matters later, `"use_dynamic_url": true` rotates the
resource URL per session; it is not enabled now because it changes how the
frame URL resolves and that has not been tested against every host.

## Permissions — unchanged

File scanning added **no new `permissions` entry** and no new host permission,
and **image OCR added none either**. Reading an attachment is ordinary DOM work
on a `File` the user handed to the page, and every parsing library — pdf.js,
mammoth, and now tesseract — is bundled rather than fetched. `storage` is still
the only permission, so the install-time warning string does not change.

The manifest's existing `content_security_policy.extension_pages` already
carries `'wasm-unsafe-eval'`, which is what tesseract's WebAssembly core needs,
so OCR required no CSP change either.

## Package size

Went from 185 KB to roughly 900 KB when file scanning landed, and to **4.7 MB**
when image OCR did. Every byte is vendored third-party code:

| File | Purpose | Raw |
|---|---|---|
| `vendor/pdf.min.mjs` | pdf.js API | 455 KB |
| `vendor/pdf.worker.min.mjs` | pdf.js parsing worker | 1.26 MB |
| `vendor/mammoth.browser.min.js` | DOCX raw-text extraction | 636 KB |
| `vendor/tesseract/tesseract.min.js` | tesseract.js API | 63 KB |
| `vendor/tesseract/worker.min.js` | tesseract.js worker | 111 KB |
| `vendor/tesseract/tesseract-core-simd-lstm.wasm` | OCR engine (WASM) | 2.86 MB |
| `vendor/tesseract/eng.traineddata.gz` | English OCR model | 2.95 MB |

Vendored unmodified from npm: `pdfjs-dist@6.2.108` (Apache-2.0),
`mammoth@1.12.1` (BSD-2-Clause), `tesseract.js@6` and `tesseract.js-core@6`
(Apache-2.0), with the English model from `@tesseract.js-data/eng` (Apache-2.0).
A reviewer asking about minified third-party code should be pointed at those
exact versions.

Only the **SIMD LSTM** core is shipped, not all six builds tesseract.js-core
publishes — that alone is the difference between 2.9 MB and 17 MB of WASM. It
does mean OCR requires WebAssembly SIMD, which Chrome has had since 91; the
fallback cores would add ~3 MB each for hardware far older than anything else
in this extension supports.

**Nothing is fetched at runtime.** tesseract.js defaults to pulling its core
and language model from the jsdelivr CDN; `src/parser.js` overrides `corePath`,
`workerPath` and `langPath` to `chrome.runtime.getURL()` paths and sets
`workerBlobURL: false`, so the worker, the WASM and the model all load from the
extension's own origin. This is the same "no remote code" claim the rest of the
extension makes, and it is the reason the CSP needs no `blob:` allowance.

OCR loads **lazily**: the scripts are injected the first time an image is
actually attached, so a user who only scans documents never pays the cost
beyond disk.

pdf.js 6.2 calls `Uint8Array.prototype.toHex()`, which Chrome shipped in 140.
`src/compat.js` polyfills it rather than setting `minimum_chrome_version`, so
the extension still installs and works on older Chrome.

## Image scanning — what it claims, and what it does not

OCR reads what it can see, which is less than a person can. So an image never
gets the document flow's "checked / nothing found" wording and is **never
auto-attached the way a clean document is**. There are three outcomes and they
read differently on purpose:

| Outcome | What the card says |
|---|---|
| Found something | Same category rows and counts as a document, plus "GuardAI may not have read all of it" |
| Read it, found nothing | "Nothing found, your call" — it read what it could see, cannot read everything a person can, look it over yourself |
| Could not read it | "GuardAI could not read this image properly" — treat as unchecked |

PNG, JPEG and WebP. There is no "send the text instead" option for an image: a
screenshot's meaning is its layout, so there is nothing faithful to paste, and
the parser frame refuses an extract request for an image even if one is made.

## What the parser frame is for, if a reviewer asks

The file bytes and the extracted text exist only inside `parser.html`, which is
process-isolated from the chat page. On a scan, the only thing that crosses
back out is a count per category — the reply is assembled field by field in
`src/parser.js` so that handing it an extraction result cannot leak the text
through it, the same construction as `src/company.js`. There is no `fetch` or
`XHR` anywhere in the parser, and pdf.js is configured with
`useWorkerFetch: false` and `isEvalSupported: false` so it cannot reach the
network or evaluate code.

**One deliberate exception**: "Send as safe text" (added 2026-08-28) lets the
user send a document's text as a masked message instead of attaching the file.
When — and only when — the user clicks that button, the frame re-extracts the
text and passes it over the private MessagePort to the content script, which
masks it with the same rules as a typed message and shows the user the masked
result before anything is inserted into the page. The text still never touches
the page's own scripts or the network from the frame; the frame re-runs its
own suitability check before releasing anything, so a forged request cannot
pull text out of a document the check refused; and what ultimately reaches the
page is the masked text the user approved on screen — which is the feature.

The option is gated by a measured readability check (`suitability()` in
`src/filescan.js`) so it is never offered on a document whose extraction would
paste as garbled fragments — forms, table grids, shuffled columns, shattered
equations — and per-site paste ceilings measured on the live composers
(ChatGPT converts pastes ≥10,000 chars into attachments; Gemini's composer
silently truncates at 32,000; the caps ship with margin below both).

## Listing copy

The current description promises masking without qualification. Since the
extension now requires a licence, the listing must say so above the fold, or
it collects one-star "doesn't work" reviews from people who installed it
expecting it to run.
