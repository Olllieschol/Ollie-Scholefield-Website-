"use client";

import { useState, type FormEvent } from "react";
import { APP_PROMISE, APP_SUPPORT } from "@/lib/config";
import { OCCASION_LABEL, type Occasion, type PlanPublic } from "@/lib/types";
import { formatDay } from "@/lib/format";
import {
  Button,
  CountStub,
  FieldError,
  FieldLabel,
  Icon,
  NextAction,
  Note,
  Poster,
  Screen,
  Section,
  StepProgress,
  TextButton,
} from "@/components/ui";
import { PreviewBanner } from "./PreviewBanner";
import { useDemo, type CreateDraft, type DraftWindow } from "./demo-state";

export const SYDNEY_AREAS = [
  "CBD",
  "Inner West",
  "Inner City and Surry Hills",
  "Eastern Suburbs",
  "North Shore",
  "Northern Beaches",
  "Parramatta",
  "Western Sydney",
  "South Sydney",
  "Sutherland Shire",
  "Hills District",
];

const TIMES = Array.from({ length: 34 }, (_, i) => {
  const mins = 7 * 60 + i * 30; // 7:00am to 11:30pm
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const label = `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  return { value, label };
});

function draftToPlan(d: CreateDraft, base: PlanPublic): PlanPublic {
  return {
    ...base,
    name: d.name || "Your plan",
    occasion: d.occasion,
    area: d.area,
    organiserName: d.organiserName || "You",
    description: d.description,
    windows: d.windows.map((w) => ({
      id: w.id,
      start: `${w.date}T${w.start}:00+11:00`,
      end: `${w.date}T${w.end}:00+11:00`,
    })),
    joinedCount: 1,
    answeredCount: 0,
  };
}

/* ---------- Step 1: basics ---------- */

export function StartScreen() {
  const { draft, setDraft, go } = useDemo();
  const [error, setError] = useState<string>();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) {
      setError("Give the plan a name so friends know what it’s for.");
      return;
    }
    go("create-when");
  }

  return (
    <form onSubmit={submit} noValidate className="contents">
      <Screen
        banner={<PreviewBanner />}
        actions={
          <Button type="submit" className="w-full">
            Next
          </Button>
        }
      >
        <h1 className="type-poster mt-2 text-[clamp(2.6rem,13vw,3.6rem)]">{APP_PROMISE}</h1>
        <p className="mt-3 max-w-[34ch] text-ink-soft">{APP_SUPPORT}</p>

        <div className="mt-8">
          <StepProgress step={1} total={3} label="Start a plan" />
        </div>

        <div className="mt-6 step-in">
          <FieldLabel htmlFor="plan-name">What’s the plan called?</FieldLabel>
          <input
            id="plan-name"
            className="field"
            value={draft.name}
            maxLength={40}
            placeholder="Mia’s 21st"
            autoComplete="off"
            enterKeyHint="next"
            aria-invalid={!!error}
            aria-describedby={error ? "plan-name-error" : undefined}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              if (error) setError(undefined);
            }}
          />
          <FieldError id="plan-name-error">{error}</FieldError>

          <fieldset className="mt-7">
            <legend className="mb-2 font-bold">What’s the occasion?</legend>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(OCCASION_LABEL) as Occasion[]).map((o) => (
                <label key={o} className="choice font-bold">
                  <input
                    type="radio"
                    name="occasion"
                    value={o}
                    checked={draft.occasion === o}
                    onChange={() => setDraft({ ...draft, occasion: o })}
                  />
                  {OCCASION_LABEL[o]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Screen>
    </form>
  );
}

/* ---------- Step 2: when and where ---------- */

function WindowEditor({
  w,
  index,
  onChange,
  onRemove,
}: {
  w: DraftWindow;
  index: number;
  onChange: (w: DraftWindow) => void;
  onRemove?: () => void;
}) {
  const invalid = w.end <= w.start;
  return (
    <fieldset className="rounded-2xl bg-card p-4 shadow-[inset_0_0_0_1.5px_var(--color-line)]">
      <div className="flex items-center justify-between">
        <legend className="float-left font-bold">Option {index + 1}</legend>
        {onRemove && (
          <button type="button" onClick={onRemove} className="-mr-2 inline-flex min-h-11 items-center gap-1 px-2 font-bold text-ink-soft">
            <Icon name="cross" className="size-4" />
            Remove
          </button>
        )}
      </div>
      <div className="clear-both mt-3 space-y-3">
        <div>
          <label htmlFor={`${w.id}-date`} className="sr-only">
            Date for option {index + 1}
          </label>
          <input
            id={`${w.id}-date`}
            type="date"
            className="field"
            value={w.date}
            min="2026-10-22"
            onChange={(e) => onChange({ ...w, date: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <label htmlFor={`${w.id}-start`} className="sr-only">
            Start time
          </label>
          <select id={`${w.id}-start`} className="field" value={w.start} onChange={(e) => onChange({ ...w, start: e.target.value })}>
            {TIMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span aria-hidden className="text-ink-soft">
            to
          </span>
          <label htmlFor={`${w.id}-end`} className="sr-only">
            End time
          </label>
          <select
            id={`${w.id}-end`}
            className="field"
            value={w.end}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${w.id}-err` : undefined}
            onChange={(e) => onChange({ ...w, end: e.target.value })}
          >
            {TIMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <FieldError id={`${w.id}-err`}>{invalid ? "End time needs to be after the start time." : undefined}</FieldError>
      </div>
    </fieldset>
  );
}

export function CreateWhenScreen() {
  const { draft, setDraft, go, back } = useDemo();

  function update(i: number, w: DraftWindow) {
    const windows = draft.windows.slice();
    windows[i] = w;
    setDraft({ ...draft, windows });
  }

  function addWindow() {
    setDraft({
      ...draft,
      windows: [...draft.windows, { id: `d${Date.now()}`, date: "2026-11-13", start: "19:00", end: "23:00" }],
    });
  }

  const valid = draft.windows.every((w) => w.date && w.end > w.start);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) go("create-extras");
      }}
      noValidate
      className="contents"
    >
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full" disabled={!valid}>
            Next
          </Button>
        }
      >
        <StepProgress step={2} total={3} label="When and where" />

        <div className="mt-6 step-in">
          <FieldLabel htmlFor="area" hint="Suggestions stay close to here.">
            Which part of Sydney?
          </FieldLabel>
          <select id="area" className="field" value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })}>
            {SYDNEY_AREAS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>

          <h2 className="mt-8 font-bold">Which times could work?</h2>
          <p className="mt-0.5 text-[0.95rem] text-ink-soft">Friends tick the ones they can make. Two or three keeps it easy.</p>
          <div className="mt-3 space-y-3">
            {draft.windows.map((w, i) => (
              <WindowEditor
                key={w.id}
                w={w}
                index={i}
                onChange={(nw) => update(i, nw)}
                onRemove={
                  draft.windows.length > 2
                    ? () => setDraft({ ...draft, windows: draft.windows.filter((x) => x.id !== w.id) })
                    : undefined
                }
              />
            ))}
          </div>
          {draft.windows.length < 3 && (
            <TextButton onClick={addWindow} className="mt-3">
              Add a third option
            </TextButton>
          )}
        </div>
      </Screen>
    </form>
  );
}

/* ---------- Step 3: last bits ---------- */

export function CreateExtrasScreen() {
  const { draft, setDraft, go, back } = useDemo();
  const [error, setError] = useState<string>();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.organiserName.trim()) {
          setError("Add your name. It’s shown on the invite.");
          return;
        }
        go("created");
      }}
      noValidate
      className="contents"
    >
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full">
            Create plan
          </Button>
        }
      >
        <StepProgress step={3} total={3} label="Last bits" />

        <div className="mt-6 space-y-7 step-in">
          <div>
            <FieldLabel htmlFor="org-name" hint="Shown on the invite as the organiser.">
              Your name
            </FieldLabel>
            <input
              id="org-name"
              className="field"
              value={draft.organiserName}
              maxLength={30}
              autoComplete="given-name"
              enterKeyHint="next"
              aria-invalid={!!error}
              aria-describedby={error ? "org-name-error" : undefined}
              onChange={(e) => {
                setDraft({ ...draft, organiserName: e.target.value });
                if (error) setError(undefined);
              }}
            />
            <FieldError id="org-name-error">{error}</FieldError>
          </div>

          <div>
            <FieldLabel htmlFor="desc" hint="Optional. A line on the vibe helps people answer.">
              Anything friends should know?
            </FieldLabel>
            <textarea
              id="desc"
              className="field min-h-24 resize-none"
              maxLength={200}
              value={draft.description}
              placeholder="Something fun before dinner. Nothing too far from the train."
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <p className="mt-1 text-right text-[0.85rem] text-ink-faint">{draft.description.length}/200</p>
          </div>

          <div>
            <FieldLabel htmlFor="decide-by" hint="Optional. Shown on the invite so people answer in time.">
              Decide by
            </FieldLabel>
            <input
              id="decide-by"
              type="date"
              className="field"
              value={draft.decideBy}
              onChange={(e) => setDraft({ ...draft, decideBy: e.target.value })}
            />
          </div>

          <div>
            <FieldLabel htmlFor="group-size" hint="Optional and only shown to you, so you can see how many have replied.">
              Roughly how many are you inviting?
            </FieldLabel>
            <input
              id="group-size"
              className="field max-w-32"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={2}
              value={draft.groupSize}
              onChange={(e) => setDraft({ ...draft, groupSize: e.target.value.replace(/\D/g, "") })}
            />
          </div>
        </div>
      </Screen>
    </form>
  );
}

/* ---------- Created: share straight away ---------- */

const DEMO_INVITE_URL = "https://inforit.example/i/7Qm2xPa9LwT4";

export function ShareControls({ url, message }: { url: string; message: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for browsers that block the clipboard API.
      const el = document.getElementById("invite-url") as HTMLInputElement | null;
      el?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ text: message, url });
        return;
      } catch {
        return; // dismissed
      }
    }
    copy();
  }

  return (
    <div>
      <label htmlFor="invite-url" className="sr-only">
        Invite link
      </label>
      <input id="invite-url" readOnly value={url} className="field font-bold" onFocus={(e) => e.currentTarget.select()} />
      <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
        <Button onClick={share}>
          <Icon name="share" />
          Share link
        </Button>
        <Button variant="secondary" onClick={copy} aria-live="polite">
          <Icon name={copied ? "check" : "copy"} />
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}

export function CreatedScreen() {
  const { draft, plan, go } = useDemo();
  const created = draftToPlan(draft, plan);
  const message = `${created.name}: tick which times work and set your budget here. Takes about a minute.`;

  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <Button className="w-full" variant="secondary" onClick={() => go("organiser-empty")}>
          Go to the plan
        </Button>
      }
    >
      <div className="stamp">
        <Poster plan={created} compact />
      </div>

      <NextAction title="Drop this in the group chat">
        Anyone with the link can join with just their name. No app or password.
      </NextAction>
      <div className="mt-4">
        <ShareControls url={DEMO_INVITE_URL} message={message} />
      </div>

      <Section title="Managing the plan">
        <p className="text-ink-soft">
          This browser is now the organiser for {created.name}. To manage it from another phone or laptop, keep your private
          organiser link somewhere safe. Don’t post it in the group.
        </p>
        <TextButton className="mt-2">Copy private organiser link</TextButton>
      </Section>
    </Screen>
  );
}

/* ---------- Organiser plan page, nobody joined yet ---------- */

export function OrganiserEmptyScreen() {
  const { draft, plan, go } = useDemo();
  const created = draftToPlan(draft, plan);
  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <Button className="w-full" onClick={() => go("pref-when")}>
          Add your own answers
        </Button>
      }
    >
      <Poster
        plan={created}
        stub={<CountStub items={[{ value: 1, label: "joined, just you" }, { value: 0, label: "answered" }]} />}
      />
      <NextAction title="Waiting for the group">
        Share the link in your group chat. Names appear here as people join, and you can find options once three people have
        answered.
      </NextAction>
      <div className="mt-4">
        <ShareControls url={DEMO_INVITE_URL} message={`${created.name}: tick which times work here.`} />
      </div>
      <Section title="Who’s joined">
        <Note>No one else yet. {draft.groupSize ? `You said you’re inviting about ${draft.groupSize}.` : ""}</Note>
      </Section>
      {draft.decideBy && (
        <p className="mt-6 text-[0.95rem] text-ink-soft">Decide by {formatDay(`${draft.decideBy}T21:00:00+11:00`)}</p>
      )}
    </Screen>
  );
}
