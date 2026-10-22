"use client";

import { DemoProvider, useDemo, type ScreenId } from "./demo-state";
import { CreateExtrasScreen, CreateWhenScreen, CreatedScreen, OrganiserEmptyScreen, StartScreen } from "./screens-create";
import { InviteInvalidScreen, InviteScreen, JoinScreen, PrefBudgetScreen, PrefKeenScreen, PrefWhenScreen, WaitingScreen } from "./screens-join";
import {
  CommitScreen,
  FinalScreen,
  OptionsNoMatchScreen,
  OptionsScreen,
  OrganiserCommitScreen,
  OrganiserReadyScreen,
  RecordBookingScreen,
} from "./screens-decide";

const VIEWS: Record<ScreenId, () => React.ReactNode> = {
  start: () => <StartScreen />,
  "create-when": () => <CreateWhenScreen />,
  "create-extras": () => <CreateExtrasScreen />,
  created: () => <CreatedScreen />,
  "organiser-empty": () => <OrganiserEmptyScreen />,
  invite: () => <InviteScreen />,
  "invite-invalid": () => <InviteInvalidScreen />,
  join: () => <JoinScreen />,
  "pref-when": () => <PrefWhenScreen />,
  "pref-budget": () => <PrefBudgetScreen />,
  "pref-keen": () => <PrefKeenScreen />,
  waiting: () => <WaitingScreen />,
  "organiser-ready": () => <OrganiserReadyScreen />,
  options: () => <OptionsScreen />,
  "options-nomatch": () => <OptionsNoMatchScreen />,
  "options-simple": () => <OptionsScreen simple />,
  commit: () => <CommitScreen />,
  "commit-changed": () => <CommitScreen changed />,
  "organiser-commit": () => <OrganiserCommitScreen />,
  "record-booking": () => <RecordBookingScreen />,
  final: () => <FinalScreen />,
};

function Router() {
  const { screen } = useDemo();
  return <div key={screen}>{VIEWS[screen]()}</div>;
}

export function Prototype() {
  return (
    <DemoProvider>
      <Router />
    </DemoProvider>
  );
}
