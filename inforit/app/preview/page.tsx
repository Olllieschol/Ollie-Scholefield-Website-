import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = { title: "Design preview", robots: { index: false } };

const GROUPS: { title: string; who: string; screens: [string, string][] }[] = [
  {
    title: "Create a plan",
    who: "Organiser",
    screens: [
      ["start", "Start a plan: name and occasion"],
      ["create-when", "Area and two or three time options"],
      ["create-extras", "Your name, description, decide-by date"],
      ["created", "Plan created, share link straight away"],
      ["organiser-empty", "Empty state: nobody has joined yet"],
    ],
  },
  {
    title: "Join and answer",
    who: "Friend",
    screens: [
      ["invite", "Invitation preview before joining"],
      ["join", "Join with a name"],
      ["pref-when", "Answers 1 of 3: when works?"],
      ["pref-budget", "Answers 2 of 3: budget, kept private"],
      ["pref-keen", "Answers 3 of 3: what you’re keen on"],
      ["waiting", "All set, waiting for the group"],
      ["invite-invalid", "Broken or deleted invite link"],
    ],
  },
  {
    title: "Options",
    who: "Everyone",
    screens: [
      ["organiser-ready", "Organiser: enough answers to find options"],
      ["options", "Options with favourites (toggle organiser view)"],
      ["options-nomatch", "Nothing fits: which constraint to rethink"],
      ["options-simple", "AI unavailable: simple-mode fallback"],
    ],
  },
  {
    title: "Commit and book",
    who: "Everyone",
    screens: [
      ["commit", "Friend: I’m in or can’t make it, ready to book"],
      ["commit-changed", "Time changed: everyone confirms again"],
      ["organiser-commit", "Organiser: replies and venue booking"],
      ["record-booking", "Organiser records the booking"],
      ["final", "Final plan page"],
    ],
  },
];

export default function PreviewIndex() {
  return (
    <main className="mx-auto max-w-[30rem] px-4 py-8 sm:px-6">
      <p className="type-heading text-lg">{APP_NAME}</p>
      <h1 className="type-poster mt-2 text-[clamp(2.8rem,14vw,4rem)]">Design preview</h1>
      <p className="mt-3 text-ink-soft">
        Stage A. Every person, venue, price and link here is made up. Nothing is saved and nothing is sent anywhere. Tap through
        in order or jump to a screen.
      </p>
      <Link href="/preview/flow#start" className="btn btn-primary mt-6 w-full">
        Start from the beginning
      </Link>

      {GROUPS.map((g) => (
        <section key={g.title} className="mt-10">
          <h2 className="type-heading text-2xl">{g.title}</h2>
          <p className="text-[0.95rem] text-ink-soft">{g.who}</p>
          <ol className="mt-3 divide-y divide-line border-y border-line">
            {g.screens.map(([id, label]) => (
              <li key={id}>
                <Link href={`/preview/flow#${id}`} className="flex min-h-12 items-center py-2 font-bold underline-offset-4 hover:underline">
                  {label}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </main>
  );
}
