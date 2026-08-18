// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `?new=1` door (the Get Started button's landing): it must open the
 * create dialog EVERY time the param arrives, not just the first time in a
 * mount. A one-shot ref used to guard this and silently broke the second
 * press, since pressing Get Started again re-adds the param without
 * remounting the page.
 */

// IS_CLOUD is resolved at module load — pin the edition before imports. The
// migration gate this suite covers is cloud-only (a self-host deployment runs
// its own runner, so there is nothing to migrate).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  availability: "ready" as string,
  agents: [] as { id: string; kind: string; name: string }[],
  agentsPending: false,
}));

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  /** The live `onOpenChange` of whichever dialog is mounted — the test needs
   *  it to dismiss the dialog the way a user's Cancel does. */
  closeHosted: undefined as undefined | (() => void),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => state.params,
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  usePathname: () => "/w/w1/agents",
}));
// The roster's cards are not what this suite is about (and they read the route
// and format timestamps) — same stand-in the sibling suite uses.
vi.mock("./agent-card", () => ({
  AgentCard: ({ agent }: { agent: { name: string } }) => (
    <div>{agent.name}</div>
  ),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: state.agents, isPending: state.agentsPending }),
}));
vi.mock("@/hooks/use-grants", () => ({
  useGrantsSummary: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => state.availability,
}));
vi.mock("./create-agent-dialog", () => ({
  CreateAgentDialog: ({ open }: { open: boolean }) =>
    open ? <div>byo dialog</div> : null,
}));
vi.mock("./hosted-onboarding-dialog", () => ({
  HostedOnboardingDialog: ({ open }: { open: boolean }) =>
    open ? <div>onboarding call</div> : null,
}));
vi.mock("./new-hosted-agent-dialog", () => ({
  NewHostedAgentDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    mocks.closeHosted = () => onOpenChange(false);
    return open ? <div>hosted dialog</div> : null;
  },
}));

const { AgentsContent } = await import("./agents-content");

beforeEach(() => {
  state.params = new URLSearchParams();
  state.availability = "ready";
  state.agents = [];
  state.agentsPending = false;
  mocks.replace.mockClear();
  mocks.closeHosted = undefined;
});

describe("the ?new=1 create door", () => {
  it("opens the hosted flow and strips the param", () => {
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith("/w/w1/agents", {
      scroll: false,
    });
  });

  it("opens the BYO flow where there is no hosted surface", () => {
    state.params = new URLSearchParams("new=1");
    state.availability = "absent";
    render(<AgentsContent />);
    expect(screen.getByText("byo dialog")).toBeInTheDocument();
  });

  it("waits for availability rather than guessing the door", () => {
    state.params = new URLSearchParams("new=1");
    state.availability = "loading";
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("byo dialog")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("keeps other params when it strips its own", () => {
    state.params = new URLSearchParams("new=1&foo=bar");
    render(<AgentsContent />);
    expect(mocks.replace).toHaveBeenCalledWith("/w/w1/agents?foo=bar", {
      scroll: false,
    });
  });

  it("opens again when the param returns to an already-mounted page", () => {
    state.params = new URLSearchParams("new=1");
    const view = render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();

    // The param is stripped (the effect's own `router.replace`), then the user
    // dismisses the dialog — the exact state after a first Get Started press
    // that went nowhere.
    state.params = new URLSearchParams();
    view.rerender(<AgentsContent />);
    act(() => mocks.closeHosted?.());
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();

    // Pressing Get Started again re-adds it, with no remount in between.
    state.params = new URLSearchParams("new=1");
    view.rerender(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
  });

  it("books the onboarding call for a legacy BYO user, never hosted creation", () => {
    // A workspace with an existing BYO agent is a MIGRATION (§3.15 as
    // amended): its hosted entry books a human. Arriving by `?new=1` must not
    // be a way around that gate — this opened the hosted dialog directly
    // before, quietly bypassing it for anyone following the link.
    state.agents = [{ id: "a1", kind: "byo", name: "legacy agent" }];
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.getByText("onboarding call")).toBeInTheDocument();
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
  });

  it("waits for the agent list before choosing a door", () => {
    // `createDoor` reads an undefined list as "still loading" and falls back
    // to BYO, so acting before it resolves would show a legacy user the wrong
    // door on first paint.
    state.agentsPending = true;
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding call")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does nothing without the param", () => {
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
