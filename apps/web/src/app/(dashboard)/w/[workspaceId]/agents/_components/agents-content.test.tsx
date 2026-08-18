// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { HostedAvailability } from "@/lib/agents/availability";

/**
 * The agents page's create door, end to end through the real page.
 *
 * `create-door.test.ts` proves the decision and `agent-create-door.test.tsx`
 * proves the control, but the thing a user actually feels lives HERE: which
 * dialog opens. In particular that a legacy user's hosted entry books a call
 * while a new user's button opens creation — a wiring claim that neither
 * lower test can make.
 *
 * This file is the CLOUD arm (the booking funnel is cloud-only); the onprem
 * arm lives in `agents-content.onprem.test.tsx`.
 */

// IS_CLOUD is resolved at module load — pin the edition before imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  agents: [] as { id: string; kind: string; name: string }[] | undefined,
  availability: "ready" as HostedAvailability,
  quota: {
    current: 1,
    limit: 10,
    plan: "pro",
    atLimit: false,
    organizationId: "org-1",
  },
}));

vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: state.agents, isPending: false }),
  useCreateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateHostedAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
    error: null,
  }),
}));

vi.mock("@/hooks/use-grants", () => ({
  useGrantsSummary: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => state.availability,
}));

// The card pulls in a wide tail of hooks; the door is what's under test.
vi.mock("./agent-card", () => ({
  AgentCard: ({ agent }: { agent: { name: string } }) => (
    <div>{agent.name}</div>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/ws-1/agents",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ workspaceId: "ws-1" }),
}));

// The EE quota gate, whose button IS the production primary (see below).
vi.mock("@/ee/billing/quota-actions", () => ({
  getResourceQuota: () => Promise.resolve(state.quota),
}));
vi.mock("@/ee/billing/_components/quota-limit-dialog", () => ({
  QuotaLimitDialog: ({ open }: { open: boolean }) =>
    open ? <div>Plan limit reached</div> : null,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const { AgentsContent } = await import("./agents-content");
const { CreateAgentButton } =
  await import("@/lib/agents/_components/create-agent-button");

// The page always mounts both create dialogs (closed), and they embed
// SecretDialog for the LLM-key guided setup, which reads the query client —
// so the tree needs a real QueryClient even with every page hook mocked.
const renderPage = (props?: React.ComponentProps<typeof AgentsContent>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentsContent {...props} />
    </QueryClientProvider>,
  );

/**
 * PRODUCTION composition. The routed page (`app/.../agents/page.tsx` →
 * `lib/agents/agents-page.tsx`) ALWAYS passes `renderCreateButton`, so the
 * bare `renderPage()` above exercises a fallback that ships to nobody.
 * These render what a cloud user actually gets.
 */
const renderComposed = () =>
  renderPage({
    renderCreateButton: (primary) => <CreateAgentButton {...primary} />,
  });

const agent = (kind: string, id = `ag-${kind}`) => ({
  id,
  kind,
  name: `${kind} agent`,
});

beforeEach(() => {
  state.agents = [];
  state.availability = "ready";
  state.quota = {
    current: 1,
    limit: 10,
    plan: "pro",
    atLimit: false,
    organizationId: "org-1",
  };
});
afterEach(cleanup);

describe("the agents page create door", () => {
  it("takes a NEW user straight into hosted creation", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    // The hosted create dialog — a brief, not a booking.
    expect(
      await screen.findByRole("heading", { name: /new agent/i }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });

  it("keeps a LEGACY user's primary button on the access-token flow", async () => {
    state.agents = [agent("byo")];
    renderPage();
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    // The BYO dialog is the one with an SDK identifier field.
    expect(screen.getByLabelText(/identifier/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });

  it("offers a LEGACY user the onboarding call behind the chevron", async () => {
    state.agents = [agent("byo")];
    renderPage();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    // A booking, NOT the create form: this is the whole point of the change.
    const book = await screen.findByRole("link", { name: /book 15 minutes/i });
    expect(book.getAttribute("href")).toBe("https://cal.com/onecli/15min");
    expect(book.getAttribute("target")).toBe("_blank");
    // Pin BOTH rel tokens: dropping noreferrer would keep a contains-check
    // green while silently shedding the Referer suppression.
    expect(book.getAttribute("rel")?.split(" ").sort()).toEqual([
      "noopener",
      "noreferrer",
    ]);
    expect(screen.queryByPlaceholderText(/Support Triage/i)).toBeNull();
  });

  it("sends a hosted-only workspace to creation, never to the call", async () => {
    state.agents = [agent("hosted")];
    renderPage();
    expect(
      screen.queryByRole("button", { name: /more ways to create an agent/i }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
  });

  it("leaves a runner-less deployment exactly as it was: one BYO button", async () => {
    state.availability = "absent";
    state.agents = [agent("byo")];
    renderPage();
    expect(
      screen.queryByRole("button", { name: /more ways to create an agent/i }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    expect(screen.getByLabelText(/identifier/i)).toBeTruthy();
  });

  it("shows exactly ONE create button in every state — the point of the merge", () => {
    for (const [availability, agents] of [
      ["ready", []],
      ["ready", [agent("byo")]],
      ["offline", [agent("byo")]],
      ["absent", [agent("byo")]],
      ["loading", []],
    ] as const) {
      state.availability = availability;
      state.agents = [...agents];
      renderPage();
      const creates = screen
        .getAllByRole("button")
        .filter((b) => /create agent|new agent/i.test(b.textContent ?? ""));
      expect(creates).toHaveLength(1);
      cleanup();
    }
  });

  it("tells an empty workspace about the button it can actually see", () => {
    renderPage();
    // No "connect your own with an access token" — that door isn't rendered.
    expect(screen.getByText(/start chatting/i)).toBeTruthy();
    expect(screen.queryByText(/access token/i)).toBeNull();
  });

  it("still renders a page when the agent read FAILS", () => {
    // An error leaves data undefined with isPending false. Reading that as
    // "undefined, so render nothing" paints a blank page — no cards, no empty
    // state, no create button — which is worse than any error message.
    state.agents = undefined;
    renderPage();
    expect(screen.getByRole("button", { name: /create agent/i })).toBeTruthy();
    expect(screen.getByText(/no agents yet/i)).toBeTruthy();
    // The copy must describe the BYO primary actually rendered here, not the
    // hosted flow that sits behind the chevron.
    expect(screen.getByText(/access token/i)).toBeTruthy();
  });
});

/**
 * The composition cloud actually ships. Everything above renders the fallback
 * primary button; the routed page never does.
 */
describe("the create door as the routed page composes it", () => {
  it("routes a NEW user's quota-gated button into hosted creation", async () => {
    renderComposed();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
  });

  it("keeps the split shape when the EE button is the primary", async () => {
    state.agents = [agent("byo")];
    renderComposed();
    // The quota button must carry the flat inner edge through, or the pair
    // renders as two separate pills with a seam floating between them.
    const primary = screen.getByRole("button", { name: /create agent/i });
    expect(primary.className).toContain("rounded-r-none");
    // And the chevron still reaches hosted, through the composed primary.
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    expect(
      await screen.findByRole("link", { name: /book 15 minutes/i }),
    ).toBeTruthy();
  });

  it("lets the quota stop creation instead of opening a dialog", async () => {
    state.quota = { ...state.quota, atLimit: true, current: 10 };
    renderComposed();
    // findBy: the quota arrives from an async server action after mount.
    await screen.findByRole("button", { name: /new agent/i });
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(await screen.findByText(/plan limit reached/i)).toBeTruthy();
    // The create dialog must NOT have opened behind the paywall.
    expect(screen.queryByPlaceholderText(/Support Triage/i)).toBeNull();
  });

  it("does not let the quota block the onboarding CALL — it costs no slot", async () => {
    state.agents = [agent("byo")];
    state.quota = { ...state.quota, atLimit: true, current: 10 };
    renderComposed();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    // Booking a conversation is not creating a resource; a full plan must
    // never be the reason someone can't ask us about upgrading.
    expect(
      await screen.findByRole("link", { name: /book 15 minutes/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/plan limit reached/i)).toBeNull();
  });
});
