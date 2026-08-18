// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatePresenceResult } from "@/lib/api";

/**
 * The events-arm popup dance: the install popup must open *synchronously* inside
 * the click — before Slack's `apps.manifest.create` round-trip resolves, so it
 * survives a popup blocker — then be pointed at the URL on success. When the
 * browser blocks it even so, a plain install link takes over (a fresh gesture).
 * The socket "Create app" arm opens nothing.
 */

const state = vi.hoisted(() => ({
  attachData: undefined as unknown,
  isPending: false,
}));

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-channels", () => ({
  useAttachChannel: () => ({
    mutate: mocks.attach,
    isPending: state.isPending,
    data: state.attachData,
  }),
  useDetachChannel: () => ({ mutate: mocks.detach, isPending: false }),
  // Stubs for the child arms — never rendered in these branches, but the tree
  // imports them.
  useCompleteChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useChannelManifest: () => ({ data: undefined, isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}));

const { SlackAttachCard } = await import("./slack-attach-card");

const result = (
  overrides: Partial<CreatePresenceResult> = {},
): CreatePresenceResult => ({
  presenceId: "pr1",
  transport: "events",
  installUrl: "https://slack.com/oauth/v2/authorize?client_id=1",
  settingsUrl: "https://api.slack.com/apps/A123",
  ...overrides,
});

// The mutate mock hands back the `onSuccess` it was called with, so a test can
// drive the create's resolution by hand and prove the popup opened first.
let onSuccess: ((r: CreatePresenceResult) => void) | undefined;

beforeEach(() => {
  state.attachData = undefined;
  state.isPending = false;
  onSuccess = undefined;
  mocks.attach.mockReset();
  mocks.attach.mockImplementation(
    (
      _input: undefined,
      opts: { onSuccess: (r: CreatePresenceResult) => void },
    ) => {
      onSuccess = opts.onSuccess;
    },
  );
  mocks.toastError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the events arm popup", () => {
  it("opens a blank popup synchronously on click — before the create resolves — then points it at the install URL", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => popup as unknown as Window);
    vi.stubGlobal("open", open);

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        transport="events"
        hasOrgCredentials
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to Slack" }));

    // Opened blank, inside the gesture, while the create is still in flight —
    // the whole point of the fix. `""` is the placeholder URL.
    expect(open).toHaveBeenCalledWith("", "_blank", expect.any(String));
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(popup.location.href).toBe(""); // not navigated yet

    // The create returns — only now is the popup pointed at Slack.
    onSuccess?.(result({ installUrl: "https://slack.com/install" }));
    expect(popup.location.href).toBe("https://slack.com/install");
  });

  it("falls back to a clickable install link when the popup is blocked", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        transport="events"
        hasOrgCredentials
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    // No link yet — it appears only once we know the URL and that open failed.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    act(() => onSuccess?.(result({ installUrl: "https://slack.com/install" })));

    const link = screen.getByRole("link", { name: /Slack install page/i });
    expect(link).toHaveAttribute("href", "https://slack.com/install");
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("opens no popup for the socket 'Create app' arm", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        transport="socket"
        hasOrgCredentials
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create app" }));
    expect(open).not.toHaveBeenCalled();
    expect(mocks.attach).toHaveBeenCalledOnce();
  });
});

describe("the resume escape hatch", () => {
  it("offers Start over ONLY while resuming, and detaches WITH the remote app", async () => {
    // Without this button a half-finished setup pins the agent to its stamped
    // transport forever (posture changes and abandoned installs both need a
    // clean restart) — caught live when a socket-pending presence blocked the
    // events-arm re-attach.
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        transport="socket"
        hasOrgCredentials
        resuming
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(mocks.detach.mock.calls[0]?.[0]).toEqual({ deleteRemote: true });
  });

  it("shows no Start over on a fresh (non-resuming) card", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        transport="socket"
        hasOrgCredentials
        resuming={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Start over" }),
    ).not.toBeInTheDocument();
  });
});
