# Chrome Web Store submission

Everything the store needs that is not in the code. Keep this in step with
`manifest.json` and `backend/licences.sql`.

---

## This submission — 1.1.0, renamed to Guard4AI

**Version 1.1.0**, a minor bump, not a patch: file scanning, image OCR,
scanned-PDF fallback, "Send as masked text" and admin policy are new features,
not fixes.

**The product is now Guard4AI**, matching the domain the listing and the
privacy policy have always pointed at (`guard4ai.com`). The rename covers the
manifest name, the toolbar title, the popup, the settings page, every card and
toast in the page, and this listing.

**What was deliberately NOT renamed, and why it matters for existing installs:**

| Identifier | Example | Left alone |
|---|---|---|
| Storage keys | `guardai_mapping`, `guardai_entitlement`, `guardai_enabled` | 21 keys, all lowercase |
| CSS classes / DOM ids | `guardai-panel`, `guardai-warning` | 382 in `styles.css` |
| JS namespace | `window.GuardAI` | every module hangs off it |

These are internal names no user ever sees, and renaming them would be a
**data-losing migration for no benefit**: an updated extension looking for
`guard4ai_mapping` would find nothing, and every existing user would silently
lose their real↔fake mapping table, their licence record, their settings and
their activity log on update. The rename is a case-sensitive replace of the
string `GuardAI`, which cannot touch the lowercase `guardai_` and `guardai-`
forms, plus a guard against the `window.GuardAI` namespace. Verified after the
change: 21 storage keys present and unchanged, 0 occurrences of `guard4ai_`,
382 `guardai-` classes intact, 0 `guard4ai-`.

**Permissions are unchanged** — still `storage` plus the same host list — so the
update installs without a new permission prompt and without re-review on that
basis.

**The screenshots are stale.** Four of the five in `store/final-1280x800/` show
the old name in the product UI and cannot be uploaded as-is against a listing
titled Guard4AI:

| Shot | Shows the old name | Also |
|---|---|---|
| 1 | tab title "GuardAI — Settings" | |
| 2 | card header "GuardAI detected sensitive data" | |
| 3 | panel header "GuardAI", tab title | |
| 4 | — usable as-is | |
| 5 | "What GuardAI masks", "Every category GuardAI can detect", body copy, tab title, omnibox chip | also shows the old "DETECTION MODE" heading (now "Modes") and a test company, "Test co Guard AI v2" |

Shot 5 needs retaking regardless of the rename, since that settings page has
changed twice since it was captured.

### Release checklist

1. `bash tools/package.sh` — check the version in the filename is what you
   intended.
2. **Mint a fresh reviewer key** (SQL under *Reviewer access*) and paste it
   into Privacy practices → test credentials. The old one is revoked; there is
   no standing key any more, and a submission without one is rejected as
   non-functional.
3. Retake any screenshot showing a changed UI or the old name.
4. Confirm `hello@guard4ai.com` receives mail — a privacy policy with a dead
   contact address is its own rejection.
5. **Re-read "Where your data goes" against the code that actually sends.**
   Twice now this listing has claimed less traffic than the extension makes:
   once when the policy said "never makes a single network request" while the
   manifest carried supabase, and again on 2026-08-31 when `record_usage` and
   `record_files` landed while the copy still said "the category and the
   count … never the page you were on". Site reporting made that sentence
   false. On a privacy product an under-claim is not a safe error — it is the
   disclosure being wrong. Anything new that calls `rpcUrl(...)` changes this
   section and the Dashboard's Privacy practices tab together.
6. After the submission is approved, revoke that submission's key by key.

---

## Privacy policy

**https://guard4ai.com/privacy** — this is the URL the Developer Dashboard
wants. A `chrome-extension://` page does not qualify, so the policy lives on
the site and `popup.js` / `settings.js` link out to it. The copy that used to
ship inside the package has been deleted rather than left to drift.

Rewritten 2026-08-22. The old version claimed Guard4AI *"never makes a single
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

Paste this into that field, substituting the key for this submission:

> Guard4AI masks personal data before it is sent to AI chat sites. It stays
> inactive until a licence key is entered, so please activate it first:
>
> 1. Install the extension.
> 2. Click the Guard4AI toolbar icon.
> 3. Paste this key into the "Activate" field and click Activate:
>    `GK-REVIEW-…` ← the key minted for THIS submission
> 4. Open https://chatgpt.com and type, without sending:
>    `Contact Sarah Chen on 0412 345 678`
> 5. Press Enter. Guard4AI intercepts the send and offers to replace the name
>    and phone number with realistic fakes. Choose "Mask & Send".
>
> Detection runs entirely in the browser. The only network request the
> extension makes is the licence check in step 3.

### The reviewer key is per-submission, and is never written down here

**The literal key is deliberately absent from this file and from
`backend/licences.sql`.** It used to be in both, as a never-expiring
`GK-REVIEW-CHROME-STORE-0001`, and this repository is public — so it was
revoked on 2026-08-29. Writing a fresh key here leaks it again on the next
push; an expiry only bounds how long the next leak lasts. It lives in the
Developer Dashboard field above and in the `licences` table, and nowhere else.

**This is a real trade, not a free win.** The old design never expired on
purpose: review recurs on every update, months apart, with a different person
each time, and a key that has lapsed by the time the NEXT update is reviewed
gets that update rejected as non-functional. A 90-day per-submission key keeps
a leak bounded, at the cost of making "mint a reviewer key" a release step
that has to actually happen. Hence its place on the checklist below.

Note also **which side of the expiry has grace**: `activate_licence` raises
`LICENCE_EXPIRED` immediately once `current_period_end` passes, so a reviewer
who *types the key* after expiry is stopped dead. The 14-day `GRACE_MS` in
`src/entitlement.js` only extends an install that already activated. So the
expiry has to outlast the last moment a reviewer might enter it — including a
rejection and a resubmission — not the last moment they might use it.

**Per submission:**

```sql
-- Mint. Generate <random> with real entropy, never sequentially.
insert into public.licences (key, plan, status, current_period_end, max_activations)
values ('GK-REVIEW-<random>', 'review', 'active', now() + interval '90 days', 10000);
```

```sql
-- Revoke, once the submission is through. BY KEY, never by plan: `where plan
-- = 'review'` cancels every reviewer key, including one for a submission
-- still in flight.
update public.licences set status = 'cancelled' where key = 'GK-REVIEW-<random>';
```

```sql
-- Worth running on any key you revoke: did anyone but the reviewer find it?
select l.key, count(a.token) as activations, max(a.last_seen_at) as last_used
  from public.licences l
  left join public.licence_activations a on a.licence_id = l.id
 where l.plan = 'review' group by l.key order by activations desc;
```

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Stores the user's settings, the local real↔fake mapping table, and the licence record. All `chrome.storage.local`; none of it is synced or transmitted. |
| Host access to the AI chat sites listed in the manifest | The content script reads the message box on those sites and scans it locally before the user sends. Access is requested only for sites the extension actively protects. |
| `https://*.supabase.co/*` | Licence validation, and — only for workplace accounts, only after an invite code is entered — three anonymous tallies: how many items of each category were masked; which supported AI site the browser used, once per site per day (`normaliseSite()` maps the hostname onto a fixed list, so it is a site name and never a page or URL); and the type and outcome of a checked attachment (`buildFileBody()` allowlists the payload to `{kind, outcome}`, both from fixed sets). Never the values, never the message text, never a filename, never a URL. Individual licences send nothing but the licence check — `recordUsage()` returns early without a company connection. |

No remote code is executed. Everything runs from the package; the optional NLP
model, if bundled, is loaded from inside the extension with remote fetching
explicitly disabled.

## Packaging

```bash
bash tools/package.sh
```

Produces `dist/guard4ai-<version>.zip` (4.8 MB, 36 files) from an explicit
allowlist.

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
gets the document flow's "checked / nothing found" wording. There are three
outcomes and they read differently on purpose:

| Outcome | What happens | What it says |
|---|---|---|
| Found something | **Stops and waits** | Same category rows and counts as a document, plus "Guard4AI may not have read all of it" |
| Read it, found nothing | **Stops and waits** | "Nothing found, your call": it read what it could see, cannot read everything a person can, so look it over yourself |
| Could not read it | **Stops and waits** | "Guard4AI could not read this image properly" — treat as unchecked |

The middle row went hard stop -> notice (2026-08-28) -> hard stop again
(2026-09-02), and the round trip is worth recording because both moves were
right about different things. The notice existed because a click on every
clean screenshot, while a clean *document* attached itself, taught people to
dismiss the card without reading — which is what the two outcomes that carry
news depend on. What settled it was removing the inconsistency instead of the
friction: **every upload waits now, documents included**, so there is no
asymmetry left to teach the wrong habit. And a file is the one thing that
cannot be partly masked — text is swapped word by word, a file goes or it
does not — so the only decision it offers belongs to the user, every time.

**Always stop on images** is therefore inert. It is left in Settings, marked
as no longer changing anything, rather than removed: a switch that vanishes
leaves whoever turned it on wondering what became of it.

PNG, JPEG and WebP. There is no "send the text instead" option for an image: a
screenshot's meaning is its layout, so there is nothing faithful to paste, and
the parser frame refuses an extract request for an image even if one is made.

## Scanned PDFs

A PDF with **no text layer** is a scan — an emailed invoice, payslip or signed
contract — and used to be reported "not checked". It is now rasterised page by
page and read with the same OCR, using the same three outcomes as an image. A
PDF that *has* text is read directly from its text layer exactly as before;
nothing about that path changed, and it never rasterises.

Measured 2026-08-29 in a real browser inside the extension's own parser page:
rasterising costs 4–26ms a page (under 2% of the work) and OCR ~0.4s on a
sparse page, ~1.0s on a dense one.

**Rendered at 144 dpi**, because accuracy falls off a cliff below it and
confidence does not warn you: at 108 dpi a dense page came back at confidence
62 with plausible-looking text and **none** of the planted BSB, account, TFN or
Medicare surviving. At 144 dpi all four were found. Higher costs 20–40% more
for nothing.

**The first 5 pages**, which is about 5 seconds — less than the 14s the image
path already spends on a dense screenshot — and covers what actually arrives by
email. Past that, the rest is not read, and **a partially-read scan is always a
decision, never an automatic attach**: "nothing in the 5 pages we read of 40"
is not "nothing in this file", and delivered like a clean result it would read
as exactly that. The card states the numbers before any reassurance — *"It read
the first 5 pages of 40 and did not read the other 35 … treat this as not fully
checked."* A scan read in full with nothing found behaves like any other image.

No new libraries, no size change, no new permission: pdf.js and tesseract were
already bundled, and canvas is a DOM API in the parser page. One addition to
`src/compat.js` was required — pdf.js's *render* path (which its text path
never touches) calls `Map.prototype.getOrInsertComputed`, shipped in **Chrome
145, January 2026**. That is newer than the Chrome 140 the existing `toHex`
shim covers, so without it a browser new enough to read a PDF's text could
still be too old to rasterise one.

## What the parser frame is for, if a reviewer asks

The file bytes and the extracted text exist only inside `parser.html`, which is
process-isolated from the chat page. On a scan, the only thing that crosses
back out is a count per category — the reply is assembled field by field in
`src/parser.js` so that handing it an extraction result cannot leak the text
through it, the same construction as `src/company.js`. There is no `fetch` or
`XHR` anywhere in the parser, and pdf.js is configured with
`useWorkerFetch: false` and `isEvalSupported: false` so it cannot reach the
network or evaluate code.

**One deliberate exception**: "Send as masked text" (added 2026-08-28) lets the
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

Two rules this copy is written to, both learned from rejections and reviews
rather than invented:

1. **The licence goes above the fold.** The extension does nothing until a code
   is entered. A description that promises masking without saying so collects
   one-star "doesn't work" reviews from people who installed it expecting it to
   run.
2. **Never let an unread file sound safe.** The product's own rule is that a
   file it cannot read must never be presented the way a checked one is. A
   listing that says "scans your attachments" without naming what it does not
   read breaks that rule before the extension is even installed.

### Short description (`manifest.json`, 132-char limit)

> Masks sensitive data in messages, documents and images before it reaches AI
> chatbots. Detection runs entirely on your device.

125 characters. The previous version said "your message text never leaves your
browser", which was true and is now incomplete: file bytes and extracted text
do not leave either. "Detection runs entirely on your device" covers all three
and is the claim the code actually supports.

### Detailed description (Developer Dashboard)

Paste from the line below to the end of this section.

---

Guard4AI checks what you are about to send to an AI chatbot, and catches
sensitive details before they leave your browser.

It works on what you type, and on what you attach.

**Messages.** Type or paste into ChatGPT, Claude, Gemini, Copilot, Perplexity
and 23 other AI sites. Guard4AI reads the message before it sends, and offers
to swap real details for realistic stand-ins — Sarah Chen becomes Emma Walsh,
and stays Emma Walsh for the rest of the conversation, so the reply still makes
sense. When the reply comes back, the real values are put back in front of you.

**Documents.** PDFs, Word documents, and text, CSV, TSV, Markdown and log files
are read before they upload, up to 30 MB. Guard4AI stops the file for a narrow
set of things that are never deliberately in a document you meant to share:
passwords and API keys, card numbers, BSBs and account numbers, tax file
numbers, Medicare numbers, passports and licence numbers. Names, addresses and
phone numbers are counted and shown to you rather than blocked — a contract has
hundreds of them, and a warning that fires on every attachment gets clicked
without being read.

**Screenshots and images.** PNG, JPEG and WebP are read with text recognition,
up to 24 megapixels. Text recognition reads what it can see, which is less than
you can, so an image never gets a clean bill of health: whether it finds
something, finds nothing, or cannot read the picture at all, it tells you which
of the three happened and lets you decide.

**Every attachment is a decision.** Messages can be sent automatically with
nothing to click — that is the point of Automatic protection. Files are the
exception, in both modes and whatever your settings say. A message can be
masked word by word; a file cannot be partly masked, so the only choice it
offers is whether it goes at all, and that one is always yours. You get the
filename, what was found inside it if scanning is on, and Send anyway or
Cancel. If Guard4AI cannot look inside that kind of file, the card says so
rather than letting it through quietly.

**Scanned PDFs.** A PDF with no text layer — an emailed invoice, a payslip, a
signed contract — is rasterised and read with the same text recognition, using
the same three outcomes as an image. It reads the first 5 pages, and if there
are more it tells you how many it did not read and makes it your decision:
"nothing in the 5 pages we read of 40" is not "nothing in this file", and it
never presents one as the other.

**Send the text instead.** For a document that reads as prose, Guard4AI can
offer to send the text as a masked message rather than attaching the file, with
the reply unmasked as usual. It only offers this when the extraction genuinely
reads — forms, table grids and shuffled columns are refused rather than pasted
as fragments.

WHAT IT DOES NOT READ

Excel, PowerPoint, legacy .doc, Pages, Numbers, Keynote, archives, and HEIC
photos from an iPhone. A file Guard4AI cannot read is unchecked, not safe, and
it says so by name rather than letting the file look like one that came back
clean. Attach several files at once and they are decided together: if one is
stopped, none are attached.

Guard4AI is a browser extension, so the ChatGPT and Claude desktop apps sit
outside it, and so does Gemini's "Add from Drive", where the file goes to Google
without passing through your browser.

WHERE YOUR DATA GOES

Detection runs on your device. Your message text is never sent anywhere for
analysis. Files are read inside an isolated frame in your own browser using
libraries that ship with the extension — nothing is uploaded and nothing is
fetched — and the bytes and extracted text never leave that frame.

The extension makes one kind of network request: a licence check. On a workplace
plan it also sends anonymous tallies so an admin can see the tool is working:
how many items of each category were masked, which of the supported AI sites
this browser used (the site name only, once a day, never a page or a web
address), and the type and outcome of attachments that were checked. Never the
value, never the filename, never the message. Full detail:
https://guard4ai.com/privacy

A LICENCE IS REQUIRED

Guard4AI does nothing until a licence key or a workplace invite code is entered.
Fourteen days free on any plan. Details at https://guard4ai.com/pricing
