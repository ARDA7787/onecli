// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentPageAgent } from "./agent-page-frame";

/**
 * The rail's connected mark (PR #845): the channels row — and ONLY the
 * channels row — swaps its grey glyph for the colorful Slack mark, and only
 * once an install actually completed. A `pending_setup` presence (clicked
 * but unfinished) keeps the plain glyph, matching the Channels section's own
 * attached test.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/p1/agents/ag-1/chat",
}));

vi.mock("@/hooks/use-counts", () => ({
  useCounts: () => ({ data: undefined }),
}));

// Structural chrome (AppIcon renders through next/image).
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

const { AgentSectionRail } = await import("./agent-section-rail");

const agentWith = (channels: AgentPageAgent["channels"]): AgentPageAgent => ({
  id: "ag-1",
  name: "Donna",
  identifier: "donna",
  accessToken: "tok",
  kind: "hosted",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  channels,
  imageUrl: null,
  lastSeenAt: null,
  workingInBackground: false,
});

const slackChannel = (status: string) => ({
  provider: "slack",
  identityName: "donna",
  externalId: "A123",
  settingsUrl: null,
  status,
});

describe("the rail's Slack connected mark", () => {
  it("marks the channels row — and only it — when the install completed", () => {
    render(<AgentSectionRail agent={agentWith([slackChannel("active")])} />);

    // The rail renders twice (desktop aside + mobile strip) — both marked.
    const marks = screen.getAllByText("(connected to Slack)");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.closest("a")).toHaveAttribute(
        "href",
        "/w/p1/agents/ag-1/channels",
      );
    }
  });

  it("keeps the grey glyph for a pending_setup presence — existence is not connection", () => {
    render(
      <AgentSectionRail agent={agentWith([slackChannel("pending_setup")])} />,
    );
    expect(screen.queryByText("(connected to Slack)")).not.toBeInTheDocument();
  });

  it("shows no mark when no Slack presence exists", () => {
    render(<AgentSectionRail agent={agentWith([])} />);
    expect(screen.queryByText("(connected to Slack)")).not.toBeInTheDocument();
  });
});
