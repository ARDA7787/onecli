// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";

/**
 * The chat's inline approval strip: a held request must surface INSIDE the
 * conversation it blocks — filtered to this agent, wired to the shared
 * decision pair, and invisible (no reserved space) when nothing is pending.
 */

const state = vi.hoisted(() => ({
  approvals: [] as PendingApproval[],
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-approvals", () => ({
  usePendingApprovals: () => ({ data: state.approvals }),
  useDecideApproval: () => ({
    mutate: state.mutate,
    isPending: false,
    variables: undefined,
  }),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "Support Triage" }),
}));

const { InlineApprovals } = await import("./inline-approvals");

const approval = (
  overrides: Partial<PendingApproval> = {},
): PendingApproval => ({
  id: "ap-1",
  method: "POST",
  url: "https://api.github.com/repos/acme/site/issues",
  host: "api.github.com",
  path: "/repos/acme/site/issues",
  headers: {},
  summary: { action: "Create a GitHub issue", details: [] },
  agent: { id: "ag-1", name: "Support Triage" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  ...overrides,
});

beforeEach(() => {
  state.approvals = [];
  state.mutate.mockClear();
});

describe("InlineApprovals", () => {
  it("renders a pending approval with its actions wired", async () => {
    const user = userEvent.setup();
    state.approvals = [approval()];
    render(<InlineApprovals />);

    expect(screen.getByText("Create a GitHub issue")).toBeInTheDocument();
    // Countdown: ~2 minutes away, formatted m:ss.
    expect(screen.getByText(/^[12]:\d{2}$/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "approve" },
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(state.mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "deny" },
      expect.anything(),
    );
  });

  it("filters out another agent's approvals — this strip is this thread's", () => {
    state.approvals = [
      approval({
        id: "ap-2",
        summary: { action: "Send a Stripe refund", details: [] },
        agent: { id: "ag-OTHER", name: "Billing Bot" },
      }),
    ];
    const { container } = render(<InlineApprovals />);

    expect(screen.queryByText("Send a Stripe refund")).not.toBeInTheDocument();
    // Nothing of this agent's → nothing at all, not an empty frame.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing at all when the list is empty — no reserved space", () => {
    const { container } = render(<InlineApprovals />);
    expect(container).toBeEmptyDOMElement();
  });
});
