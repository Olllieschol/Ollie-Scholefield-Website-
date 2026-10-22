// FICTIONAL demo data for the design preview.
// None of these people, venues, prices or links are real.

import type {
  BookingReport,
  CatalogueEntry,
  MemberSummary,
  PlanPublic,
  Proposal,
  Suggestion,
} from "./types";

export const demoPlan: PlanPublic = {
  id: "demo-plan",
  name: "Mia’s 21st",
  occasion: "birthday",
  area: "Inner West",
  windows: [
    { id: "w1", start: "2026-11-07T18:00:00+11:00", end: "2026-11-07T22:00:00+11:00" },
    { id: "w2", start: "2026-11-08T13:00:00+11:00", end: "2026-11-08T17:00:00+11:00" },
    { id: "w3", start: "2026-11-13T19:00:00+11:00", end: "2026-11-13T23:00:00+11:00" },
  ],
  description: "Something fun before dinner. Nothing too fancy, nothing too far from the train.",
  decideBy: "2026-11-04T21:00:00+11:00",
  organiserName: "Mia",
  tint: "butter",
  stage: "gathering",
  joinedCount: 6,
  answeredCount: 4,
};

export const demoMembers: MemberSummary[] = [
  { id: "m1", name: "Mia", isOrganiser: true, answered: true, favouriteOptionId: "c1", attendance: "in", readyToBook: true, needsReconfirm: false },
  { id: "m2", name: "Jordan", isOrganiser: false, answered: true, favouriteOptionId: "c1", attendance: "in", readyToBook: true, needsReconfirm: false },
  { id: "m3", name: "Priya", isOrganiser: false, answered: true, favouriteOptionId: "c2", attendance: "in", readyToBook: false, needsReconfirm: false },
  { id: "m4", name: "Tom", isOrganiser: false, answered: true, favouriteOptionId: null, attendance: "out", readyToBook: false, needsReconfirm: false },
  { id: "m5", name: "Lani", isOrganiser: false, answered: false, favouriteOptionId: null, attendance: null, readyToBook: false, needsReconfirm: false },
  { id: "m6", name: "Sam", isOrganiser: false, answered: false, favouriteOptionId: null, attendance: null, readyToBook: false, needsReconfirm: false },
];

export const demoCatalogue: CatalogueEntry[] = [
  {
    id: "c1",
    name: "Lantern Lane Mini Golf",
    activityType: "Mini golf",
    area: "Marrickville",
    bookingUrl: "https://example.com/lantern-lane",
    sourceUrl: "https://example.com/lantern-lane/prices",
    priceMin: 28,
    priceMax: 34,
    priceNote: "Weekend evening price for 18 holes",
    priceIsEstimate: false,
    checkedOn: "2026-10-20",
    restrictions: ["Groups over 10 need to book ahead", "18+ after 8pm"],
    availabilityChecked: false,
    fictional: true,
  },
  {
    id: "c2",
    name: "The Kiln Room",
    activityType: "Pottery class",
    area: "Newtown",
    bookingUrl: "https://example.com/kiln-room",
    sourceUrl: "https://example.com/kiln-room/workshops",
    priceMin: 55,
    priceMax: 70,
    priceNote: "2-hour wheel session, BYO drinks",
    priceIsEstimate: true,
    checkedOn: "2026-10-18",
    restrictions: ["Minimum 6 people for a private session"],
    availabilityChecked: false,
    fictional: true,
  },
  {
    id: "c3",
    name: "Pitch & Pin Lanes",
    activityType: "Bowling",
    area: "Leichhardt",
    bookingUrl: "https://example.com/pitch-pin",
    sourceUrl: "https://example.com/pitch-pin/pricing",
    priceMin: 22,
    priceMax: 22,
    priceNote: "Per person, per game, shoes included",
    priceIsEstimate: false,
    checkedOn: "2026-10-21",
    restrictions: [],
    availabilityChecked: false,
    fictional: true,
  },
];

export const demoSuggestions: Suggestion[] = [
  {
    entry: demoCatalogue[0],
    windowId: "w1",
    fit: { total: 4, budgetOk: 4, timeOk: 4 },
    reason: "Mini golf came up most, it’s a short walk from Marrickville station and it fits everyone’s budget.",
  },
  {
    entry: demoCatalogue[2],
    windowId: "w1",
    fit: { total: 4, budgetOk: 4, timeOk: 4 },
    reason: "The cheapest option here, and easy to add people on the night.",
  },
  {
    entry: demoCatalogue[1],
    windowId: "w2",
    fit: { total: 4, budgetOk: 3, timeOk: 3 },
    reason: "A calmer daytime option two people asked for. It’s over one person’s budget and one person can’t do Sunday.",
  },
];

export const demoProposal: Proposal = {
  id: "p1",
  version: 1,
  entry: demoCatalogue[0],
  windowId: "w1",
  pricePerPerson: "$28–$34",
  conditions: ["18+ after 8pm", "Groups over 10 need to book ahead"],
  decideBy: "2026-11-04T21:00:00+11:00",
};

export const demoBooking: BookingReport = {
  reference: "LLMG-48213",
  confirmedTime: "Sat 7 Nov, 6:30pm tee-off",
  address: "12 Example Lane, Marrickville NSW 2204 (fictional)",
  note: "Meet out the front at 6:15. Dinner after at Mia’s.",
  reportedBy: "Mia",
};
