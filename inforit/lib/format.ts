import { LOCALE, TIME_ZONE } from "./config";

const dayFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

const longDayFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

const partsFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "Sat 7 Nov" in Sydney time. */
export function formatDay(iso: string): string {
  return dayFmt.format(new Date(iso)).replace(",", "");
}

/** "Saturday 7 November" in Sydney time. */
export function formatLongDay(iso: string): string {
  return longDayFmt.format(new Date(iso)).replace(",", "");
}

function timeParts(iso: string) {
  const parts = partsFmt.formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().replace(/\./g, "");
  return { label: minute === "00" ? hour : `${hour}:${minute}`, period };
}

/** "6–10pm", "11am–2pm" in Sydney time. */
export function formatTimeRange(startIso: string, endIso: string): string {
  const a = timeParts(startIso);
  const b = timeParts(endIso);
  if (a.period === b.period) return `${a.label}–${b.label}${b.period}`;
  return `${a.label}${a.period}–${b.label}${b.period}`;
}

export function formatWindow(w: { start: string; end: string }): string {
  return `${formatDay(w.start)}, ${formatTimeRange(w.start, w.end)}`;
}

export function formatAud(amount: number): string {
  return `$${Math.round(amount)}`;
}

export function formatPriceRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Price unknown";
  if (min != null && max != null && min !== max) return `${formatAud(min)}–${formatAud(max)}`;
  return formatAud((min ?? max) as number);
}

/** "Alex, Sam and Jo" */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
