// Shapes shared by the design preview and, later, the real app.
// Shared plan data and private participant answers are deliberately separate types.

export type Tint = "butter" | "pool" | "sage" | "blush";

export type Occasion = "birthday" | "night-out" | "day-out" | "other";

export const OCCASION_LABEL: Record<Occasion, string> = {
  birthday: "Birthday",
  "night-out": "Night out",
  "day-out": "Day out",
  other: "Get-together",
};

export interface TimeWindow {
  id: string;
  start: string; // ISO, interpreted in Australia/Sydney
  end: string;
}

export type PlanStage = "gathering" | "options" | "deciding" | "booked";

/** Everything here is visible to anyone holding the invite link. */
export interface PlanPublic {
  id: string;
  name: string;
  occasion: Occasion;
  area: string;
  windows: TimeWindow[];
  description: string;
  decideBy: string | null;
  organiserName: string;
  tint: Tint;
  stage: PlanStage;
  joinedCount: number;
  answeredCount: number;
}

export type Availability = "yes" | "maybe" | "no";

/** Private to the participant who wrote it. Never sent to other members. */
export interface MyAnswers {
  availability: Record<string, Availability | undefined>;
  budget: number | null;
  keen: string[];
  note: string;
  needs: string;
}

export type Attendance = "in" | "out" | null;

/** What group members can see about each other. No budgets, no reasons. */
export interface MemberSummary {
  id: string;
  name: string;
  isOrganiser: boolean;
  answered: boolean;
  favouriteOptionId: string | null;
  attendance: Attendance;
  readyToBook: boolean;
  needsReconfirm: boolean;
}

export interface CatalogueEntry {
  id: string;
  name: string;
  activityType: string;
  area: string;
  bookingUrl: string;
  sourceUrl: string;
  priceMin: number | null;
  priceMax: number | null;
  priceNote: string;
  priceIsEstimate: boolean;
  checkedOn: string; // YYYY-MM-DD
  restrictions: string[];
  availabilityChecked: boolean;
  fictional?: boolean;
}

export interface Suggestion {
  entry: CatalogueEntry;
  windowId: string;
  /** Counts only: never which person is outside budget or unavailable. */
  fit: { total: number; budgetOk: number; timeOk: number };
  reason: string;
}

export interface Proposal {
  id: string;
  version: number;
  entry: CatalogueEntry;
  windowId: string;
  pricePerPerson: string;
  conditions: string[];
  decideBy: string | null;
}

export interface BookingReport {
  reference: string;
  confirmedTime: string;
  address: string;
  note: string;
  reportedBy: string;
}
