"use client";

import { useState } from "react";
import { APP_NAME } from "@/lib/config";
import { demoCatalogue, demoProposal, demoSuggestions } from "@/lib/demo-data";
import { formatDay, formatLongDay, formatTimeRange, formatWindow, listNames } from "@/lib/format";
import type { MemberSummary, PlanPublic, Proposal, Suggestion } from "@/lib/types";
import {
  Button,
  CountStub,
  FieldLabel,
  Icon,
  LinkButton,
  NextAction,
  Note,
  Poster,
  Screen,
  Section,
  TINT_BG,
  TextButton,
} from "@/components/ui";
import { PreviewBanner } from "./PreviewBanner";
import { useDemo } from "./demo-state";

/* ---------- Members ---------- */

export function MemberList({
  members,
  mode,
  meId,
}: {
  members: MemberSummary[];
  mode: "answers" | "attendance";
  meId?: string;
}) {
  if (mode === "answers") {
    return (
      <ul className="divide-y divide-line border-y border-line">
        {members.map((m) => (
          <li key={m.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
            <span className="font-bold">
              {m.name}
              {m.id === meId && <span className="font-normal text-ink-soft">{m.name ? " (you)" : "You"}</span>}
              {m.isOrganiser && <span className="font-normal text-ink-soft"> (organiser)</span>}
            </span>
            <span className={m.answered ? "text-go" : "text-ink-faint"}>{m.answered ? "Answered" : "Not yet"}</span>
          </li>
        ))}
      </ul>
    );
  }

  const groups: { label: string; people: MemberSummary[] }[] = [
    { label: "In", people: members.filter((m) => m.attendance === "in" && !m.needsReconfirm) },
    { label: "Asked to confirm again", people: members.filter((m) => m.needsReconfirm) },
    { label: "Can’t make it", people: members.filter((m) => m.attendance === "out" && !m.needsReconfirm) },
    { label: "No reply yet", people: members.filter((m) => m.attendance === null && !m.needsReconfirm) },
  ];

  return (
    <dl className="divide-y divide-line border-y border-line">
      {groups
        .filter((g) => g.people.length > 0)
        .map((g) => (
          <div key={g.label} className="grid grid-cols-[7.5rem_1fr] gap-3 py-3 max-[359px]:grid-cols-1 max-[359px]:gap-1">
            <dt className="flex items-baseline gap-2">
              <span className="type-figure text-2xl">{g.people.length}</span>
              <span className="text-[0.95rem] leading-tight text-ink-soft">{g.label}</span>
            </dt>
            <dd className="font-bold">{listNames(g.people.map((p) => (p.id === meId ? (p.name ? `${p.name} (you)` : "You") : p.name)))}</dd>
          </div>
        ))}
    </dl>
  );
}

/* ---------- Organiser: ready to find options ---------- */

export function OrganiserReadyScreen() {
  const { plan, members, go } = useDemo();
  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <Button className="w-full" onClick={() => go("options")}>
          Find options
        </Button>
      }
    >
      <Poster plan={plan} stub={<CountStub items={[{ value: plan.joinedCount, label: "joined" }, { value: plan.answeredCount, label: "answered" }, { value: 8, label: "you’re inviting (your estimate)" }]} />} />
      <NextAction title="Enough answers to find options">
        {plan.answeredCount} of {plan.joinedCount} have answered. You can find options now and again later if more people
        answer.
      </NextAction>
      <Section title="Who’s joined">
        <MemberList members={members} mode="answers" />
        <p className="mt-3 text-[0.95rem] text-ink-soft">
          You see who has answered, not their budgets or reasons. Nobody else does either.
        </p>
      </Section>
    </Screen>
  );
}

/* ---------- Options ---------- */

function PriceLine({ s }: { s: Suggestion["entry"] }) {
  const range =
    s.priceMin == null ? "Price unknown" : s.priceMin === s.priceMax ? `$${s.priceMin}` : `$${s.priceMin}–$${s.priceMax}`;
  return (
    <p>
      <span className="type-figure text-[1.75rem]">{range}</span> <span className="text-ink-soft">per person</span>
      <span className="block text-[0.95rem] text-ink-soft">
        {s.priceIsEstimate ? "Estimate. " : ""}
        {s.priceNote}. Checked {formatDay(`${s.checkedOn}T12:00:00+11:00`)} on the venue’s site.
      </span>
    </p>
  );
}

function FitLine({ fit }: { fit: Suggestion["fit"] }) {
  const all = fit.budgetOk === fit.total && fit.timeOk === fit.total;
  if (all) {
    return (
      <p className="flex items-start gap-2 font-bold text-go">
        <Icon name="check" className="mt-0.5 size-5 shrink-0" />
        Fits the time and budget of all {fit.total} who answered
      </p>
    );
  }
  const misses: string[] = [];
  if (fit.budgetOk < fit.total) misses.push(`over budget for ${fit.total - fit.budgetOk}`);
  if (fit.timeOk < fit.total) misses.push(`${fit.total - fit.timeOk} can’t make this time`);
  return (
    <p className="font-bold text-coral-deep">
      Suits some of the group: {misses.join(", ")}
    </p>
  );
}

function OptionCard({
  s,
  plan,
  favCount,
  isFav,
  onFav,
  organiser,
  onPropose,
  showReason = true,
}: {
  s: Suggestion;
  plan: PlanPublic;
  favCount: number;
  isFav: boolean;
  onFav: () => void;
  organiser: boolean;
  onPropose: () => void;
  showReason?: boolean;
}) {
  const w = plan.windows.find((x) => x.id === s.windowId)!;
  return (
    <article className="rounded-[20px] bg-card p-5 shadow-[inset_0_0_0_1.5px_var(--color-line)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="type-heading text-[1.6rem]">{s.entry.name}</h3>
          <p className="text-ink-soft">
            {s.entry.activityType} in {s.entry.area}
          </p>
        </div>
        {s.entry.fictional && <span className="shrink-0 rounded-md bg-paper-deep px-2 py-1 text-[0.8rem] font-bold">Fictional</span>}
      </div>

      <p className="mt-4 font-bold">{formatWindow(w)}</p>
      <div className="mt-3">
        <PriceLine s={s.entry} />
      </div>
      <div className="mt-3">
        <FitLine fit={s.fit} />
      </div>

      {showReason && <p className="mt-3">{s.reason}</p>}

      <ul className="mt-3 space-y-1 text-[0.95rem] text-ink-soft">
        {s.entry.restrictions.map((r) => (
          <li key={r}>{r}</li>
        ))}
        <li>{s.entry.availabilityChecked ? "Availability checked with the venue." : "Availability not checked. Confirm when booking."}</li>
      </ul>

      <div className="mt-5 grid gap-2">
        <Button variant="secondary" aria-pressed={isFav} onClick={onFav} className={isFav ? "!bg-ink !text-paper" : ""}>
          <span key={String(isFav)} className="stamp inline-flex">
            <Icon name={isFav ? "star-filled" : "star"} />
          </span>
          {isFav ? "Your favourite" : "Make this my favourite"}
          <span className="type-figure text-[1.15rem] opacity-80" aria-label={`${favCount} favourites`}>{favCount}</span>
        </Button>
        {organiser && (
          <Button variant="secondary" onClick={onPropose}>
            Ask the group to commit
          </Button>
        )}
      </div>
      <a href={s.entry.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[0.95rem] font-bold underline underline-offset-4">
        Venue website
        <Icon name="external" className="size-4" />
      </a>
    </article>
  );
}

export function OptionsScreen({ simple = false }: { simple?: boolean }) {
  const { plan, members, favourite, toggleFavourite, go, back } = useDemo();
  const [organiser, setOrganiser] = useState(true);

  return (
    <Screen
      banner={<PreviewBanner />}
      onBack={back}
      topRight={
        <label className="flex min-h-11 items-center gap-2 text-[0.95rem]">
          <input type="checkbox" checked={organiser} onChange={(e) => setOrganiser(e.target.checked)} className="size-5 accent-ink" />
          Organiser view
        </label>
      }
    >
      <h1 className="type-heading mt-2 text-[2rem]">Options for {plan.name}</h1>
      <p className="mt-1 text-ink-soft">
        From {APP_NAME}’s checked list of Sydney activities, matched to {plan.answeredCount} people’s answers. Favourites help{" "}
        {plan.organiserName} choose. They aren’t a commitment.
      </p>

      {simple && (
        <div className="mt-5">
          <Note tone="warn">
            Suggestions are in simple mode right now, so these are sorted by time, budget and interests without the written
            explanations. Everything shown is still from the checked list.
          </Note>
        </div>
      )}

      <div className="mt-6 space-y-4">
        {demoSuggestions.map((s) => {
          const others = members.filter((m) => m.favouriteOptionId === s.entry.id).length;
          const isFav = favourite === s.entry.id;
          return (
            <OptionCard
              key={s.entry.id}
              s={s}
              plan={plan}
              favCount={others + (isFav ? 1 : 0)}
              isFav={isFav}
              onFav={() => toggleFavourite(s.entry.id)}
              organiser={organiser}
              onPropose={() => go("organiser-commit")}
              showReason={!simple}
            />
          );
        })}
      </div>
    </Screen>
  );
}

export function OptionsNoMatchScreen() {
  const { plan, back, go } = useDemo();
  return (
    <Screen
      banner={<PreviewBanner />}
      onBack={back}
      actions={
        <Button className="w-full" variant="secondary" onClick={() => go("create-when")}>
          Change the time options
        </Button>
      }
    >
      <h1 className="type-heading mt-2 text-[2rem]">Nothing on our list suits everyone yet</h1>
      <p className="mt-2 text-ink-soft">
        We checked {plan.answeredCount} people’s answers against activities around {plan.area}. Every option is either over
        at least one person’s budget or outside the times people can make.
      </p>
      <Section title="What would open things up">
        <ul className="space-y-3">
          <li className="rounded-xl bg-card p-4 shadow-[inset_0_0_0_1.5px_var(--color-line)]">
            <span className="block font-bold">A budget closer to $40 each</span>
            <span className="block text-[0.95rem] text-ink-soft">3 more activities would fit. You could mention this in the group chat.</span>
          </li>
          <li className="rounded-xl bg-card p-4 shadow-[inset_0_0_0_1.5px_var(--color-line)]">
            <span className="block font-bold">A daytime option</span>
            <span className="block text-[0.95rem] text-ink-soft">More people said a weekend afternoon could work.</span>
          </li>
        </ul>
        <p className="mt-4 text-[0.95rem] text-ink-soft">We don’t say whose budget or times are the limit.</p>
      </Section>
    </Screen>
  );
}

/* ---------- Commit ---------- */

function ProposalCard({ plan, proposal, changedFrom }: { plan: PlanPublic; proposal: Proposal; changedFrom?: string }) {
  const w = plan.windows.find((x) => x.id === proposal.windowId)!;
  return (
    <article className={`overflow-hidden rounded-[22px] ${TINT_BG[plan.tint]}`} aria-label="The plan you’re being asked to commit to">
      <div className="px-5 pt-5 pb-6">
      <p className="type-heading text-lg">{plan.name}</p>
      <h1 className="type-poster mt-1 text-[clamp(2.6rem,13vw,3.6rem)]">{proposal.entry.name}</h1>
      <dl className="mt-5 space-y-3">
        <div>
          <dt className="text-[0.95rem] text-ink/70">When</dt>
          <dd>
            <span className="type-heading text-[1.5rem]">{formatDay(w.start)}</span> {formatTimeRange(w.start, w.end)}
            {changedFrom && <span className="block text-[0.95rem]">Was {changedFrom}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-[0.95rem] text-ink/70">Expected price</dt>
          <dd>
            <span className="type-heading text-[1.5rem]">{proposal.pricePerPerson}</span> per person
            <span className="block text-[0.95rem]">Paid to the venue, not through {APP_NAME}</span>
          </dd>
        </div>
        <div>
          <dt className="text-[0.95rem] text-ink/70">Where</dt>
          <dd className="font-bold">
            {proposal.entry.activityType} in {proposal.entry.area}
          </dd>
        </div>
        {proposal.conditions.length > 0 && (
          <div>
            <dt className="text-[0.95rem] text-ink/70">Good to know</dt>
            <dd>{proposal.conditions.join(". ")}.</dd>
          </div>
        )}
      </dl>
      </div>
      {proposal.decideBy && (
        <>
          <div className="perforation" aria-hidden />
          <p className="px-5 pt-4 pb-5 font-bold">Reply by {formatLongDay(proposal.decideBy)}, 9pm</p>
        </>
      )}
    </article>
  );
}

function AttendanceChoice() {
  const { attendance, setAttendance, plan } = useDemo();
  return (
    <section className="mt-6" aria-labelledby="are-you-in">
      <h2 id="are-you-in" className="type-heading text-[1.75rem]">
        Are you in?
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
        <Button
          variant={attendance === "in" ? "primary" : "secondary"}
          aria-pressed={attendance === "in"}
          onClick={() => setAttendance(attendance === "in" ? null : "in")}
          className="min-h-16 text-lg"
        >
          {attendance === "in" && <Icon name="check" className="stamp size-5" />}
          I’m in
        </Button>
        <Button
          variant="secondary"
          aria-pressed={attendance === "out"}
          onClick={() => setAttendance(attendance === "out" ? null : "out")}
          className={`min-h-16 text-lg ${attendance === "out" ? "!bg-ink !text-paper" : ""}`}
        >
          {attendance === "out" && <Icon name="check" className="stamp size-5" />}
          Can’t make it
        </Button>
      </div>
      <p className="mt-3 min-h-12 text-[0.95rem] text-ink-soft" aria-live="polite">
        {attendance === "in" && `You’re in. ${plan.organiserName} books once enough people confirm. You can change this until then.`}
        {attendance === "out" && `Thanks for letting ${plan.organiserName} know. The group sees you can’t make it, not why.`}
        {attendance === null && "Until you answer, you’re counted as no reply, not as a yes."}
      </p>
    </section>
  );
}

function ReadyToBook() {
  const { attendance, readyToBook, setReadyToBook, members, plan } = useDemo();
  const count = members.filter((m) => m.readyToBook).length + (readyToBook ? 1 : 0);
  const disabled = attendance !== "in";
  return (
    <Section title="Ready to book?">
      <label className={`choice ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
        <input type="checkbox" checked={readyToBook} disabled={disabled} onChange={(e) => setReadyToBook(e.target.checked)} />
        <span className="grid size-6 shrink-0 place-items-center rounded-md shadow-[inset_0_0_0_2px_currentColor]" aria-hidden>
          {readyToBook && <Icon name="check" className="size-4" />}
        </span>
        <span className="font-bold">I’m ready to book</span>
      </label>
      <p className="mt-2 text-[0.95rem] text-ink-soft">
        Optional. Lets {plan.organiserName} know you’re good to go when they book. This does not charge you or reserve a place.
        {disabled && " Say you’re in first."}
      </p>
      <p className="mt-2 text-[0.95rem]">
        <span className="font-bold">{count}</span> {count === 1 ? "person has" : "people have"} said they’re ready to book.
      </p>
    </Section>
  );
}

export function CommitScreen({ changed = false }: { changed?: boolean }) {
  const { plan, members, myName, attendance, readyToBook } = useDemo();
  const proposal = changed ? { ...demoProposal, version: 2, windowId: "w2" } : demoProposal;
  const me: MemberSummary = {
    id: "me",
    name: myName,
    isOrganiser: false,
    answered: true,
    favouriteOptionId: null,
    attendance,
    readyToBook,
    needsReconfirm: false,
  };
  const shownMembers = changed
    ? members.map((m) => (m.attendance === "in" && !m.isOrganiser ? { ...m, attendance: null, needsReconfirm: true } : m))
    : members;
  const favs = members.filter((m) => m.favouriteOptionId === proposal.entry.id).length;

  return (
    <Screen banner={<PreviewBanner />}>
      {changed && (
        <div className="mb-4">
          <Note tone="warn">
            <span className="block font-bold">The time changed, so we need your answer again</span>
            {plan.organiserName} moved this from {formatWindow(plan.windows[0])} to {formatWindow(plan.windows[1])}. Earlier
            answers were for the old time and have been cleared.
          </Note>
        </div>
      )}
      <ProposalCard plan={plan} proposal={proposal} changedFrom={changed ? formatWindow(plan.windows[0]) : undefined} />
      <p className="mt-3 text-[0.95rem] text-ink-soft">
        Chosen by {plan.organiserName} from the options. {favs} {favs === 1 ? "person" : "people"} had it as their favourite.
      </p>

      <AttendanceChoice />

      <Section title="Who’s in so far">
        <MemberList members={[...shownMembers, me]} mode="attendance" meId="me" />
      </Section>

      <ReadyToBook />

      <Section title="Booking">
        <p className="text-ink-soft">Not booked yet. {plan.organiserName} books on the venue’s website and records it here.</p>
      </Section>
    </Screen>
  );
}

/* ---------- Organiser: commitments and booking ---------- */

export function OrganiserCommitScreen() {
  const { plan, members, go } = useDemo();
  const [opened, setOpened] = useState(false);
  const proposal = demoProposal;
  const inCount = members.filter((m) => m.attendance === "in").length;
  const outCount = members.filter((m) => m.attendance === "out").length;
  const noReply = members.filter((m) => m.attendance === null).length;
  const ready = members.filter((m) => m.readyToBook).length;

  return (
    <Screen
      banner={<PreviewBanner />}
      actions={
        <div className="grid gap-2">
          <LinkButton href={proposal.entry.bookingUrl} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
            Open venue booking
            <Icon name="external" />
          </LinkButton>
          <Button variant="secondary" onClick={() => go("record-booking")}>
            Record the booking
          </Button>
        </div>
      }
    >
      <ProposalCard plan={plan} proposal={proposal} />

      <NextAction title="Book it when you’re ready">
        Booking happens on the venue’s website. Opening it doesn’t mark the plan as booked. Come back and record it once the
        venue confirms.
      </NextAction>
      {opened && (
        <div className="mt-3">
          <Note>You opened the venue’s booking page. The plan stays “Not booked” until you record the booking.</Note>
        </div>
      )}

      <Section title="Replies">
        <CountStub
          items={[
            { value: inCount, label: "in" },
            { value: outCount, label: "can’t make it" },
            { value: noReply, label: "no reply" },
          ]}
        />
        <p className="mt-3 text-[0.95rem]">
          <span className="font-bold">{ready}</span> said they’re ready to book. That isn’t a payment.
        </p>
        <div className="mt-4">
          <MemberList members={members} mode="attendance" />
        </div>
      </Section>

      <Section title="Need to change something?">
        <p className="text-ink-soft">Changing the activity, time or price clears everyone’s answer and asks them to confirm again.</p>
        <TextButton className="mt-1" onClick={() => go("commit-changed")}>
          Change the time
        </TextButton>
      </Section>
    </Screen>
  );
}

export function RecordBookingScreen() {
  const { booking, setBooking, go, back, plan } = useDemo();
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        window.setTimeout(() => go("final"), 250);
      }}
      noValidate
      className="contents"
    >
      <Screen
        banner={<PreviewBanner />}
        onBack={back}
        actions={
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "Saving…" : "Save booking details"}
          </Button>
        }
      >
        <h1 className="type-heading mt-2 text-[2rem]">Record the booking</h1>
        <p className="mt-1 text-ink-soft">
          Add this once the venue has confirmed. The group will see it as reported by {plan.organiserName}. {APP_NAME} doesn’t
          check it with the venue.
        </p>
        <div className="mt-6 space-y-6">
          <div>
            <FieldLabel htmlFor="ref" hint="From the venue’s confirmation email. Optional.">
              Booking reference
            </FieldLabel>
            <input id="ref" className="field" value={booking.reference} onChange={(e) => setBooking({ ...booking, reference: e.target.value })} />
          </div>
          <div>
            <FieldLabel htmlFor="time">Confirmed time</FieldLabel>
            <input id="time" className="field" value={booking.confirmedTime} onChange={(e) => setBooking({ ...booking, confirmedTime: e.target.value })} />
          </div>
          <div>
            <FieldLabel htmlFor="addr">Address</FieldLabel>
            <input id="addr" className="field" autoComplete="street-address" value={booking.address} onChange={(e) => setBooking({ ...booking, address: e.target.value })} />
          </div>
          <div>
            <FieldLabel htmlFor="bnote" hint="Optional. Where to meet, what to bring.">
              Note for the group
            </FieldLabel>
            <textarea id="bnote" className="field min-h-24 resize-none" maxLength={240} value={booking.note} onChange={(e) => setBooking({ ...booking, note: e.target.value })} />
          </div>
        </div>
      </Screen>
    </form>
  );
}

/* ---------- Final plan page ---------- */

function downloadIcs(title: string, start: string, end: string, location: string, description: string) {
  const toUtc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${APP_NAME}//EN`,
    "BEGIN:VEVENT",
    `UID:${Date.now()}@inforit.example`,
    `DTSTAMP:${toUtc(new Date().toISOString())}`,
    `DTSTART:${toUtc(start)}`,
    `DTEND:${toUtc(end)}`,
    `SUMMARY:${esc(title)}`,
    `LOCATION:${esc(location)}`,
    `DESCRIPTION:${esc(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "plan.ics";
  a.click();
  URL.revokeObjectURL(url);
}

export function FinalScreen() {
  const { plan, members, booking } = useDemo();
  const entry = demoCatalogue[0];
  const w = plan.windows[0];
  const going = members.filter((m) => m.attendance === "in");

  return (
    <Screen
      banner={<PreviewBanner />}
      topRight={
        <TextButton>
          <Icon name="share" className="size-4" />
          Share
        </TextButton>
      }
      actions={
        <Button className="w-full" onClick={() => downloadIcs(`${plan.name}: ${entry.name}`, w.start, w.end, booking.address, booking.note)}>
          <Icon name="calendar" />
          Add to calendar
        </Button>
      }
    >
      <Poster
        plan={{ ...plan, name: plan.name }}
        windows={[w]}
        stub={
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="type-poster text-[2.4rem]">Booked</span>
            <span className="text-[0.95rem]">Reported by {booking.reportedBy}</span>
          </div>
        }
      />

      <dl className="mt-6 divide-y divide-line border-y border-line">
        {[
          ["What", entry.name],
          ["When", booking.confirmedTime],
          ["Where", booking.address],
          ["Who’s going", `${listNames(going.map((g) => g.name))} (${going.length})`],
          ["Expected price", `${demoProposal.pricePerPerson} each, paid to the venue`],
        ].map(([k, v]) => (
          <div key={k} className="grid grid-cols-[7rem_1fr] gap-3 py-3 max-[359px]:grid-cols-1 max-[359px]:gap-0.5">
            <dt className="text-ink-soft">{k}</dt>
            <dd className="font-bold">{v}</dd>
          </div>
        ))}
      </dl>

      <Section title="Booking details">
        <p>
          Reference <span className="font-bold">{booking.reference || "not added"}</span>
        </p>
        <p className="mt-1 text-[0.95rem] text-ink-soft">
          Reported by {booking.reportedBy}. {APP_NAME} hasn’t checked this with the venue.
        </p>
        <a href={entry.bookingUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-bold underline underline-offset-4">
          Venue website
          <Icon name="external" className="size-4" />
        </a>
      </Section>

      {booking.note && (
        <Section title="Notes">
          <p>{booking.note}</p>
        </Section>
      )}

      <p className="mt-8 text-[0.95rem] text-ink-soft">This page stays at the same invite link, so you can find it again from the group chat.</p>
    </Screen>
  );
}
