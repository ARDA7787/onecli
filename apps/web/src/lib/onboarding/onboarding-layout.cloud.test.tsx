// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the billing edition before imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/onboarding",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    signOut: vi.fn(),
  }),
}));

const {
  getSubscriptionStatus,
  checkOnboardingComplete,
  getOnboardingProgress,
  getActiveWorkspacePath,
} = vi.hoisted(() => ({
  getSubscriptionStatus: vi.fn(),
  checkOnboardingComplete: vi.fn(),
  getOnboardingProgress: vi.fn(),
  getActiveWorkspacePath: vi.fn(),
}));

vi.mock("@/ee/billing/actions", () => ({ getSubscriptionStatus }));
vi.mock("@/lib/onboarding/actions", () => ({
  checkOnboardingComplete,
  getOnboardingProgress,
}));
vi.mock("@/lib/workspaces/actions", () => ({ getActiveWorkspacePath }));

vi.mock("@/lib/onboarding/onboarding-context", () => ({
  OnboardingProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/onboarding/_components/flow-chrome", () => ({
  FlowChrome: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flow">{children}</div>
  ),
}));
vi.mock("@/lib/onboarding/_components/onboarding-footer", () => ({
  OnboardingFooter: () => null,
}));
vi.mock("@/lib/onboarding/_components/skip-introduction-link", () => ({
  SkipIntroductionLink: () => null,
}));

import OnboardingLayout from "./onboarding-layout";

const emptyProgress = {
  discovery: [],
  interests: [],
  flowType: null,
  agent: null,
  agentName: null,
  setupStage: "pending" as const,
};

beforeEach(() => {
  replace.mockReset();
  getSubscriptionStatus.mockReset().mockResolvedValue({ status: "free" });
  checkOnboardingComplete.mockReset().mockResolvedValue(false);
  getActiveWorkspacePath.mockReset().mockResolvedValue("/w/p1/overview");
  getOnboardingProgress.mockReset().mockResolvedValue(emptyProgress);
});

afterEach(cleanup);

describe("onboarding layout boot (billing edition)", () => {
  it("boots the flow for a free, not-yet-onboarded user", async () => {
    render(<OnboardingLayout>step</OnboardingLayout>);
    expect(await screen.findByTestId("flow")).toHaveTextContent("step");
    expect(replace).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when a boot action rejects — home, never an eternal spinner", async () => {
    // MUTATION-TESTED (the fail-open catch): remove the boot().catch and a
    // rejecting server action strands the user on the loading spinner forever
    // (the 500-loop half of the release blocker) instead of landing home.
    getSubscriptionStatus.mockRejectedValue(new Error("500"));
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByTestId("flow")).toBeNull();
  });

  it("bounces a paid-org user to the dashboard", async () => {
    getSubscriptionStatus.mockResolvedValue({ status: "team" });
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/p1/overview"));
  });
});
