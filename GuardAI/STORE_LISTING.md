# Chrome Web Store submission

Everything the store needs that is not in the code. Keep this in step with
`manifest.json` and `backend/licences.sql`.

---

## ⛔ BLOCKER — do not submit yet

**The privacy policy is factually wrong and it is the single most likely cause
of rejection for this particular extension.**

`privacy-policy.html` says GuardAI *"never makes a single network request"* and
*"we do not request … any network permissions"*, and `popup.html` badges
*"100% local · zero external calls"*. The manifest carries
`https://*.supabase.co/*` and the extension now contacts it on activation.
A reviewer comparing the stated data practices against the requested host
permissions finds a direct contradiction, on a product whose entire pitch is
privacy.

`manifest.json`'s description — *"100% local — nothing ever leaves your
device"* — is the store listing text and is wrong for the same reason.

The rewrite was planned and deliberately deferred (2026-08-22). The honest
version of the claim is still strong: **your message text never leaves your
device.** What leaves is a code at activation, and — workplace accounts only —
a category counter.

Also required before submission:

- A working contact address in the privacy policy. There is none, and a policy
  with no way to reach anyone is its own rejection.
- The Privacy practices tab must declare what is collected. It currently
  implies nothing is. Authentication information (the licence key) now is.

---

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

## Listing copy

The current description promises masking without qualification. Since the
extension now requires a licence, the listing must say so above the fold, or
it collects one-star "doesn't work" reviews from people who installed it
expecting it to run.
