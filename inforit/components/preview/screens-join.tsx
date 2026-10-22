"use client";

import { useState, type FormEvent } from "react";
import { APP_NAME } from "@/lib/config";
import { formatDay, formatLongDay, formatTimeRange } from "@/lib/format";
import type { Availability } from "@/lib/types";
import {
  Button,
  CountStub,
  FieldError,
  FieldLabel,
  NextAction,
  Note,
  Poster,
  Screen,
  Section,
  StepProgress,
  TextButton,
} from "@/components/ui";
import { PreviewBanner } from "./PreviewBanner";
import { useDemo } from "./demo-state";
import { MemberList } from "./screens-decide";

/* ---------- Invitation, before joining ---------- */

export function InviteScreen() {
  const { plan, go } = useDemo();
  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <Button className="w-full" onClick={() => go("join")}>
          Join the plan
        </Button>
      }
    >
      <Poster plan={plan} stub={<CountStub items={[{ value: plan.joinedCount, label: "joined" }, { value: plan.answeredCount, label: "answered" }]} />} />

      <NextAction title={`${plan.organiserName} wants to know what works for you`}>
        {plan.description && <p className="text-ink">“{plan.description}”</p>}
      </NextAction>

      <ol className="mt-5 space-y-3">
        {[
          ["Tick which times you can do", "From the options above."],
          ["Set your budget", "Privately. The group never sees your number."],
          ["Pick what you’re keen on", "We match it to activities around " + plan.area + "."],
        ].map(([t, d], i) => (
          <li key={t} className="flex gap-3">
            <span className="type-figure grid size-8 shrink-0 place-items-center rounded-full bg-ink text-base text-paper" aria-hidden>
              {i + 1}
            </span>
            <span>
              <span className="block font-bold">{t}</span>
              <span className="block text-[0.95rem] text-ink-soft">{d}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-6 text-[0.95rem] text-ink-soft">
        About a minute. No app or password.
        {plan.decideBy && <> Answers by {formatLongDay(plan.decideBy)}.</>}
      </p>
    </Screen>
  );
}

export function InviteInvalidScreen() {
  const { go } = useDemo();
  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <Button variant="secondary" className="w-full" onClick={() => go("start")}>
          Start your own plan
        </Button>
      }
    >
      <h1 className="type-poster mt-6 text-[clamp(2.6rem,13vw,3.6rem)]">This invite link doesn’t work</h1>
      <p className="mt-4 text-ink-soft">
        It might be missing a few characters, or the plan was deleted. Ask whoever sent it to share the link again.
      </p>
    </Screen>
  );
}

/* ---------- Join with a name ---------- */

export function JoinScreen() {
  const { plan, myName, setMyName, go, back, members } = useDemo();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const clash = members.some((m) => m.name.toLowerCase() === myName.trim().toLowerCase());

  function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return; // one participant per tap, however many taps
    if (!myName.trim()) {
      setError("Add your name so the group knows who’s in.");
      return;
    }
    setSubmitting(true);
    window.setTimeout(() => go("pref-when"), 250);
  }

  return (
    <form onSubmit={submit} noValidate className="contents">
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Joining…" : "Join the plan"}
          </Button>
        }
      >
        <p className="type-heading mt-2 text-lg">{plan.name}</p>
        <h1 className="type-heading mt-1 text-[2rem]">What should we call you?</h1>

        <div className="mt-6">
          <FieldLabel htmlFor="my-name" hint="This is how you’ll show up to the group.">
            Your name
          </FieldLabel>
          <input
            id="my-name"
            className="field"
            value={myName}
            maxLength={30}
            autoComplete="given-name"
            autoCapitalize="words"
            enterKeyHint="go"
            aria-invalid={!!error}
            aria-describedby={error ? "my-name-error" : clash ? "my-name-clash" : undefined}
            onChange={(e) => {
              setMyName(e.target.value);
              if (error) setError(undefined);
            }}
          />
          <FieldError id="my-name-error">{error}</FieldError>
          {clash && !error && (
            <p id="my-name-clash" className="mt-2 text-[0.95rem] text-ink-soft">
              There’s already a {myName.trim()} in this plan. Adding an initial helps people tell you apart.
            </p>
          )}
        </div>

        <div className="mt-8">
          <Note>
            {APP_NAME} remembers you on this browser, so you can come back to the link and pick up where you left off. On a
            different phone, or if you clear your browser data, you’d join again as a new person.
          </Note>
        </div>
      </Screen>
    </form>
  );
}

/* ---------- Preferences 1: availability ---------- */

const AVAIL: { value: Availability; label: string }[] = [
  { value: "yes", label: "Works" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "Can’t" },
];

export function PrefWhenScreen() {
  const { plan, answers, setAnswers, go, back } = useDemo();
  const missing = plan.windows.filter((w) => !answers.availability[w.id]);
  const [tried, setTried] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (missing.length === 0) go("pref-budget");
      }}
      noValidate
      className="contents"
    >
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full">
            Next
          </Button>
        }
      >
        <StepProgress step={1} total={3} label="Your answers" />
        <h1 className="type-heading mt-6 text-[2rem]">When works?</h1>
        <p className="mt-1 text-ink-soft">So we only suggest times most people can make.</p>

        <div className="mt-6 space-y-5 step-in">
          {plan.windows.map((w) => {
            const err = tried && !answers.availability[w.id];
            return (
              <fieldset key={w.id} aria-describedby={err ? `${w.id}-avail-err` : undefined}>
                <legend className="flex w-full items-baseline gap-3">
                  <span className="type-heading text-[1.4rem]">{formatDay(w.start)}</span>
                  <span>{formatTimeRange(w.start, w.end)}</span>
                </legend>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {AVAIL.map((a) => (
                    <label key={a.value} className="choice justify-center font-bold">
                      <input
                        type="radio"
                        name={`avail-${w.id}`}
                        value={a.value}
                        checked={answers.availability[w.id] === a.value}
                        onChange={() =>
                          setAnswers({ ...answers, availability: { ...answers.availability, [w.id]: a.value } })
                        }
                      />
                      {a.label}
                    </label>
                  ))}
                </div>
                <FieldError id={`${w.id}-avail-err`}>{err ? "Pick one for this time." : undefined}</FieldError>
              </fieldset>
            );
          })}
        </div>
        <p className="mt-6 text-[0.95rem] text-ink-soft">Only you see your answer for each time. The group sees how many people can make it.</p>
      </Screen>
    </form>
  );
}

/* ---------- Preferences 2: budget ---------- */

const PRESETS = [30, 50, 80, 120];

export function PrefBudgetScreen() {
  const { answers, setAnswers, go, back } = useDemo();
  const [custom, setCustom] = useState(answers.budget != null && !PRESETS.includes(answers.budget));
  const [customText, setCustomText] = useState(custom && answers.budget ? String(answers.budget) : "");
  const [error, setError] = useState<string>();

  const shown = answers.budget;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!answers.budget || answers.budget < 5) {
          setError("Enter an amount of at least $5.");
          return;
        }
        go("pref-keen");
      }}
      noValidate
      className="contents"
    >
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full">
            Next
          </Button>
        }
      >
        <StepProgress step={2} total={3} label="Your answers" />
        <h1 className="type-heading mt-6 text-[2rem]">What’s your budget?</h1>
        <p className="mt-1 text-ink-soft">The most you’d spend on the activity itself, per person.</p>

        <div className="mt-6 step-in">
          <p className="flex items-baseline gap-3" aria-live="polite">
            <span className="type-figure text-[4.5rem]">{shown ? `$${shown}` : "$–"}</span>
            <span className="text-ink-soft">max for you</span>
          </p>

          <fieldset className="mt-4">
            <legend className="sr-only">Choose an amount</legend>
            <div className="grid grid-cols-4 gap-2">
              {PRESETS.map((p) => (
                <label key={p} className="choice type-figure justify-center px-2 text-[1.35rem]">
                  <input
                    type="radio"
                    name="budget"
                    checked={!custom && answers.budget === p}
                    onChange={() => {
                      setCustom(false);
                      setError(undefined);
                      setAnswers({ ...answers, budget: p });
                    }}
                  />
                  ${p}
                </label>
              ))}
            </div>
            <label className="choice mt-2 justify-center font-bold">
              <input
                type="radio"
                name="budget"
                checked={custom}
                onChange={() => {
                  setCustom(true);
                  setAnswers({ ...answers, budget: customText ? Number(customText) : null });
                  window.setTimeout(() => document.getElementById("custom-budget")?.focus(), 0);
                }}
              />
              Another amount
            </label>
          </fieldset>

          {custom && (
            <div className="mt-4 step-in">
              <FieldLabel htmlFor="custom-budget">Your amount in dollars</FieldLabel>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-bold" aria-hidden>
                  $
                </span>
                <input
                  id="custom-budget"
                  className="field pl-8 font-bold"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  enterKeyHint="next"
                  value={customText}
                  aria-invalid={!!error}
                  aria-describedby={error ? "budget-error" : undefined}
                  onChange={(e) => {
                    const t = e.target.value.replace(/\D/g, "");
                    setCustomText(t);
                    setError(undefined);
                    setAnswers({ ...answers, budget: t ? Number(t) : null });
                  }}
                />
              </div>
            </div>
          )}
          <FieldError id="budget-error">{error}</FieldError>

          <div className="mt-6">
            <Note>Your individual budget isn’t shown to the group. We use it to find suitable options.</Note>
          </div>
        </div>
      </Screen>
    </form>
  );
}

/* ---------- Preferences 3: keen on ---------- */

export const KEEN_OPTIONS = [
  "Mini golf",
  "Bowling",
  "Karaoke",
  "Escape room",
  "Arcade games",
  "Pottery or craft",
  "Comedy show",
  "Climbing",
];

export function PrefKeenScreen() {
  const { answers, setAnswers, go, back } = useDemo();
  const [saving, setSaving] = useState(false);

  function toggle(k: string) {
    setAnswers({ ...answers, keen: answers.keen.includes(k) ? answers.keen.filter((x) => x !== k) : [...answers.keen, k] });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        window.setTimeout(() => go("waiting"), 250);
      }}
      noValidate
      className="contents"
    >
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "Saving…" : "Save my answers"}
          </Button>
        }
      >
        <StepProgress step={3} total={3} label="Your answers" />
        <h1 className="type-heading mt-6 text-[2rem]">What are you keen on?</h1>
        <p className="mt-1 text-ink-soft">Pick any. We lean towards what most people choose.</p>

        <div className="mt-6 step-in">
          <fieldset>
            <legend className="sr-only">Activities</legend>
            <div className="grid grid-cols-2 gap-2">
              {KEEN_OPTIONS.map((k) => (
                <label key={k} className="choice font-bold leading-tight">
                  <input type="checkbox" checked={answers.keen.includes(k)} onChange={() => toggle(k)} />
                  {k}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-7">
            <FieldLabel htmlFor="note" hint="Optional. Something you’d love, or would rather skip.">
              Anything else?
            </FieldLabel>
            <input
              id="note"
              className="field"
              maxLength={120}
              value={answers.note}
              placeholder="Not too loud, please"
              onChange={(e) => setAnswers({ ...answers, note: e.target.value })}
            />
          </div>

          <details className="group mt-6 rounded-2xl bg-card px-4 shadow-[inset_0_0_0_1.5px_var(--color-line)]" open={!!answers.needs}>
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between font-bold">
              Dietary or access needs
              <span className="text-[0.95rem] font-normal text-ink-soft">Optional</span>
            </summary>
            <div className="pb-4">
              <label htmlFor="needs" className="text-[0.95rem] text-ink-soft">
                Used to rule out unsuitable places. Never shown with your name.
              </label>
              <textarea
                id="needs"
                className="field mt-2 min-h-20 resize-none"
                maxLength={160}
                value={answers.needs}
                onChange={(e) => setAnswers({ ...answers, needs: e.target.value })}
              />
              {answers.needs && (
                <TextButton className="mt-1" onClick={() => setAnswers({ ...answers, needs: "" })}>
                  Remove this
                </TextButton>
              )}
            </div>
          </details>

          <p className="mt-6 text-[0.95rem] text-ink-soft">
            Your answers are processed by {APP_NAME} and, when finding options, by our AI provider. The group sees that you’ve
            answered, not what you said.
          </p>
        </div>
      </Screen>
    </form>
  );
}

/* ---------- After answering: participant view ---------- */

export function WaitingScreen() {
  const { plan, go, members, myName } = useDemo();
  const answered = plan.answeredCount + 1;
  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <Button variant="secondary" className="w-full" onClick={() => go("pref-when")}>
          Edit my answers
        </Button>
      }
    >
      <Poster plan={plan} stub={<CountStub items={[{ value: plan.joinedCount + 1, label: "joined" }, { value: answered, label: "answered" }]} />} />
      <NextAction title="You’re all set">
        {plan.organiserName} will share options once a few more people answer. Come back to this link any time.
      </NextAction>
      <Section title="Who’s joined">
        <MemberList
          members={[...members, { id: "me", name: myName, isOrganiser: false, answered: true, favouriteOptionId: null, attendance: null, readyToBook: false, needsReconfirm: false }]}
          mode="answers"
          meId="me"
        />
      </Section>
    </Screen>
  );
}
