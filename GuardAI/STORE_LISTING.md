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

Produces `dist/guardai-<version>.zip` (~176 KB) from an explicit allowlist.

**Do not zip the folder by hand.** It is 26 MB, of which 25 MB is
`node_modules` — jsdom and its dependency tree, pulled in for the test suite.
Shipping that is slow, exposes the adversarial test corpora, and invites
questions about code that has no business being in a privacy extension.
`test/packaging.cjs` checks the allowlist against the manifest on every run.

## web_accessible_resources

**Removed 2026-08-23.** The manifest declared `lib/*` and `models/*` for the
optional Transformers.js NER layer. Neither directory ships, and in a Web Store
build a user cannot add them, so the entry pointed at nothing — a loose end for
a reviewer to ask about, and a way for any page to probe for the extension.

`src/nlp-detector.js` still references those paths, but it is gated behind
`ENABLE_NLP = false` and returns before it ever calls `getURL`, so nothing
breaks and there is no console noise.

**If the model is ever bundled, this must go back**, because a content script
loading an extension resource needs it:

```json
"web_accessible_resources": [
  { "resources": ["lib/*", "models/*"], "matches": [ ...the AI chat hosts... ] }
]
```

## Listing copy

The current description promises masking without qualification. Since the
extension now requires a licence, the listing must say so above the fold, or
it collects one-star "doesn't work" reviews from people who installed it
expecting it to run.
