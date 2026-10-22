import type { ReactNode, ButtonHTMLAttributes, AnchorHTMLAttributes } from "react";
import { APP_NAME } from "@/lib/config";
import { formatDay, formatTimeRange } from "@/lib/format";
import { OCCASION_LABEL, type PlanPublic, type Tint, type TimeWindow } from "@/lib/types";

export const TINT_BG: Record<Tint, string> = {
  butter: "bg-tint-butter",
  pool: "bg-tint-pool",
  sage: "bg-tint-sage",
  blush: "bg-tint-blush",
};

/* ---------- Icons: only where they carry meaning ---------- */

type IconName = "back" | "check" | "share" | "copy" | "external" | "calendar" | "star" | "star-filled" | "cross";

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "back":
      return <svg {...common}><path d="M15 5l-7 7 7 7" /></svg>;
    case "check":
      return <svg {...common}><path d="M4.5 12.5l5 5L19.5 7" /></svg>;
    case "cross":
      return <svg {...common}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case "share":
      return <svg {...common}><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" /></svg>;
    case "copy":
      return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></svg>;
    case "external":
      return <svg {...common}><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" /></svg>;
    case "calendar":
      return <svg {...common}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>;
    case "star":
      return <svg {...common}><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>;
    case "star-filled":
      return <svg {...common} fill="currentColor"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>;
  }
}

/* ---------- Buttons ---------- */

type Variant = "primary" | "secondary";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" {...props} className={`btn btn-${variant} ${className}`} />;
}

export function LinkButton({
  variant = "primary",
  className = "",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...props} className={`btn btn-${variant} ${className}`} />;
}

export function TextButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-11 items-center gap-1.5 font-bold underline decoration-2 underline-offset-4 ${className}`}
    />
  );
}

/* ---------- Page frame ---------- */

export function Screen({
  children,
  actions,
  onBack,
  backLabel = "Back",
  banner,
  topRight,
}: {
  children: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  banner?: ReactNode;
  topRight?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col">
      {banner}
      <header className="flex min-h-14 items-center justify-between gap-3 px-4 sm:px-6">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-bold"
          >
            <Icon name="back" />
            {backLabel}
          </button>
        ) : (
          <span className="type-heading text-lg">{APP_NAME}</span>
        )}
        {topRight}
      </header>
      <main className="flex-1 px-4 pb-8 sm:px-6">{children}</main>
      {actions && (
        <div className="sticky bottom-0 z-10 border-t border-line bg-paper/95 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px] sm:px-6">
          {actions}
        </div>
      )}
    </div>
  );
}

/* ---------- Poster: the plan header ---------- */

export function WindowLines({ windows, large = true }: { windows: TimeWindow[]; large?: boolean }) {
  return (
    <ul className="space-y-1">
      {windows.map((w, i) => (
        <li key={w.id} className="flex flex-wrap items-baseline gap-x-3">
          {i > 0 && <span className="sr-only">or</span>}
          <span className={`type-heading ${large ? "text-[1.6rem]" : "text-xl"}`}>{formatDay(w.start)}</span>
          <span className="font-display text-[1.1rem] font-medium">{formatTimeRange(w.start, w.end)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Poster({
  plan,
  windows,
  stub,
  compact = false,
}: {
  plan: PlanPublic;
  windows?: TimeWindow[];
  stub?: ReactNode;
  compact?: boolean;
}) {
  const shown = windows ?? plan.windows;
  return (
    <article className={`overflow-hidden rounded-[22px] text-ink ${TINT_BG[plan.tint]}`} aria-label={`${plan.name}, plan details`}>
      <div className={`px-5 ${compact ? "pt-4 pb-5" : "pt-5 pb-6"}`}>
        <p className="type-heading text-lg">{OCCASION_LABEL[plan.occasion]}</p>
        <h1
          className={`type-poster mt-1 break-words ${
            compact ? "text-[clamp(2.5rem,13vw,3.5rem)]" : "text-[clamp(3.1rem,17vw,4.9rem)]"
          }`}
        >
          {plan.name}
        </h1>
        <div className={compact ? "mt-4" : "mt-6"}>
          <WindowLines windows={shown} large={!compact} />
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 text-[0.95rem]">
          <div>
            <dt className="text-ink/70">Area</dt>
            <dd className="font-bold">{plan.area}</dd>
          </div>
          <div>
            <dt className="text-ink/70">Organiser</dt>
            <dd className="font-bold">{plan.organiserName}</dd>
          </div>
        </dl>
      </div>
      {stub && (
        <>
          <div className="perforation" aria-hidden />
          <div className="px-5 pt-4 pb-5">{stub}</div>
        </>
      )}
    </article>
  );
}

/** Participation summary shown in the poster stub. Counts only. */
export function CountStub({ items }: { items: { value: number | string; label: string }[] }) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-2">
          <dd className="type-figure text-[2rem]">{it.value}</dd>
          <dt className="text-[0.95rem] leading-tight">{it.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/* ---------- Content blocks ---------- */

export function NextAction({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="mt-6" aria-labelledby="next-action">
      <h2 id="next-action" className="type-heading text-[1.75rem]">
        {title}
      </h2>
      {children && <div className="mt-2 text-ink-soft">{children}</div>}
    </section>
  );
}

export function Section({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-8 ${className}`}>
      <h2 className="type-heading text-xl">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Note({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "warn" | "go" }) {
  const toneClass =
    tone === "warn" ? "bg-coral-wash text-ink" : tone === "go" ? "bg-go-wash text-ink" : "bg-paper-deep text-ink-soft";
  return <div className={`rounded-xl px-4 py-3 text-[0.95rem] leading-snug ${toneClass}`}>{children}</div>;
}

export function StepProgress({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="mt-1">
      <div className="flex items-baseline justify-between text-[0.95rem]">
        <span className="font-bold">{label}</span>
        <span className="text-ink-soft">
          {step} of {total}
        </span>
      </div>
      <div className="mt-2 flex gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step} aria-label={`Step ${step} of ${total}`}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-200 ${i < step ? "bg-ink" : "bg-line"}`}
          />
        ))}
      </div>
    </div>
  );
}

export function FieldLabel({ htmlFor, children, hint }: { htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2">
      <label htmlFor={htmlFor} className="block font-bold">
        {children}
      </label>
      {hint && <p className="mt-0.5 text-[0.95rem] text-ink-soft">{hint}</p>}
    </div>
  );
}

export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="mt-2 text-[0.95rem] font-bold text-coral-deep" role="alert">
      {children}
    </p>
  );
}

export function DemoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-ink px-4 py-2 text-[0.85rem] text-paper sm:px-6">
      {children}
    </div>
  );
}
