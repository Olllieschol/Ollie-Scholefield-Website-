"use client";

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { demoBooking, demoMembers, demoPlan } from "@/lib/demo-data";
import type { Attendance, BookingReport, MemberSummary, MyAnswers, Occasion, PlanPublic } from "@/lib/types";

// In-memory state for the design preview only. Nothing is saved or sent anywhere.

export const SCREENS = [
  "start",
  "create-when",
  "create-extras",
  "created",
  "organiser-empty",
  "invite",
  "invite-invalid",
  "join",
  "pref-when",
  "pref-budget",
  "pref-keen",
  "waiting",
  "organiser-ready",
  "options",
  "options-nomatch",
  "options-simple",
  "commit",
  "commit-changed",
  "organiser-commit",
  "record-booking",
  "final",
] as const;

export type ScreenId = (typeof SCREENS)[number];

export interface DraftWindow {
  id: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM
  end: string;
}

export interface CreateDraft {
  name: string;
  occasion: Occasion;
  area: string;
  windows: DraftWindow[];
  organiserName: string;
  description: string;
  decideBy: string;
  groupSize: string;
}

interface DemoState {
  screen: ScreenId;
  go: (s: ScreenId) => void;
  back: () => void;
  plan: PlanPublic;
  draft: CreateDraft;
  setDraft: (d: CreateDraft) => void;
  myName: string;
  setMyName: (n: string) => void;
  answers: MyAnswers;
  setAnswers: (a: MyAnswers) => void;
  members: MemberSummary[];
  favourite: string | null;
  toggleFavourite: (optionId: string) => void;
  attendance: Attendance;
  setAttendance: (a: Attendance) => void;
  readyToBook: boolean;
  setReadyToBook: (r: boolean) => void;
  booking: BookingReport;
  setBooking: (b: BookingReport) => void;
}

const Ctx = createContext<DemoState | null>(null);

export function useDemo() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDemo outside DemoProvider");
  return v;
}

function subscribeHash(cb: () => void) {
  const onHash = () => {
    cb();
    window.scrollTo({ top: 0 });
  };
  window.addEventListener("hashchange", onHash);
  return () => window.removeEventListener("hashchange", onHash);
}

function readHash(): ScreenId {
  if (typeof window === "undefined") return "start";
  const h = window.location.hash.replace("#", "");
  return (SCREENS as readonly string[]).includes(h) ? (h as ScreenId) : "start";
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const screen = useSyncExternalStore(subscribeHash, readHash, () => "start" as ScreenId);

  const go = useCallback((s: ScreenId) => {
    window.location.hash = s;
  }, []);
  const back = useCallback(() => window.history.back(), []);

  const [draft, setDraft] = useState<CreateDraft>({
    name: "",
    occasion: "birthday",
    area: "Inner West",
    windows: [
      { id: "d1", date: "2026-11-07", start: "18:00", end: "22:00" },
      { id: "d2", date: "2026-11-08", start: "13:00", end: "17:00" },
    ],
    organiserName: "",
    description: "",
    decideBy: "2026-11-04",
    groupSize: "",
  });
  const [myName, setMyName] = useState("");
  const [answers, setAnswers] = useState<MyAnswers>({ availability: {}, budget: 50, keen: [], note: "", needs: "" });
  const [favourite, setFavourite] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<Attendance>(null);
  const [readyToBook, setReadyToBook] = useState(false);
  const [booking, setBooking] = useState<BookingReport>(demoBooking);

  const toggleFavourite = useCallback((id: string) => setFavourite((f) => (f === id ? null : id)), []);

  const plan = demoPlan;
  const members = demoMembers;

  const value = useMemo<DemoState>(
    () => ({
      screen,
      go,
      back,
      plan,
      draft,
      setDraft,
      myName,
      setMyName,
      answers,
      setAnswers,
      members,
      favourite,
      toggleFavourite,
      attendance,
      setAttendance: (a) => {
        setAttendance(a);
        if (a !== "in") setReadyToBook(false);
      },
      readyToBook,
      setReadyToBook,
      booking,
      setBooking,
    }),
    [screen, go, back, plan, draft, myName, answers, members, favourite, toggleFavourite, attendance, readyToBook, booking],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
