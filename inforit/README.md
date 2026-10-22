# InForIt

Working name. Change it in `lib/config.ts`.

A mobile-first web app that helps a friend group turn an idea into an agreed plan: one link in the group chat, private answers (times, budget, interests), a short list of suitable Sydney activities, clear "I'm in" commitments, and a booking the organiser records after booking on the venue's own website.

## Status: Stage A (design preview)

Only the design preview exists so far. **There is no backend yet.** Every person, venue, price and link in the preview is fictional, nothing is saved, and nothing is sent anywhere. Stage B (Supabase, guest identities, RLS, curated real Sydney catalogue, Anthropic-assisted ranking, analytics, admin) starts after the design is approved.

## Run the preview locally

Requires Node 20 or later.

```bash
cd inforit
npm install
npm run dev
```

Then open http://localhost:3000/preview on your computer. To try it on a phone on the same Wi-Fi, run `npm run dev -- -H 0.0.0.0` and open `http://<your-computer's-local-IP>:3000/preview`.

- `/preview` lists every screen, grouped by journey.
- `/preview/flow#<screen>` opens one screen. The flow is clickable end to end and keeps what you type while you move back and forth.

## Layout

- `app/` Next.js App Router pages. `app/preview` holds the Stage A preview.
- `components/ui.tsx` shared building blocks: poster header, buttons, page frame with the sticky bottom action, progress, notes.
- `components/preview/` preview-only screens and in-memory demo state.
- `lib/types.ts` shared types. Shared plan data (`PlanPublic`, `MemberSummary`) is kept separate from private answers (`MyAnswers`).
- `lib/demo-data.ts` fictional demo data.
