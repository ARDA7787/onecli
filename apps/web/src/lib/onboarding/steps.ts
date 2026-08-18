export type FlowType = "coding" | "autonomous";

export type StepSlug =
  | "welcome"
  | "agent"
  | "coding-agent"
  | "autonomous-agent"
  | "run";

export type SetupStage = "pending" | "installed" | "connected";

/** Answers + setup state persisted in `OnboardingSurvey`, used to seed the
 * client flow and to derive which step a user may visit. */
export interface OnboardingProgress {
  discovery: string[];
  interests: string[];
  flowType: FlowType | null;
  agent: string | null;
  agentName: string | null;
  setupStage: SetupStage;
}

export const onboardingPath = (slug?: StepSlug): string =>
  slug ? `/onboarding/${slug}` : "/onboarding";

export const STEP_SLUGS_BY_FLOW: Record<FlowType | "default", StepSlug[]> = {
  default: ["welcome", "agent", "autonomous-agent"],
  coding: ["welcome", "agent", "coding-agent", "run"],
  autonomous: ["welcome", "agent", "autonomous-agent"],
};

/** Human-readable step names, used for progress-dot accessibility labels. */
export const STEP_LABELS: Record<StepSlug, string> = {
  welcome: "Welcome",
  agent: "Agent",
  "coding-agent": "Install",
  "autonomous-agent": "Setup",
  run: "Run",
};

const ALL_STEP_SLUGS: StepSlug[] = [
  "welcome",
  "agent",
  "coding-agent",
  "autonomous-agent",
  "run",
];

const STEP_PATH_RE = /^\/onboarding\/([^/]+)\/?$/;

export const stepSlugFromPathname = (pathname: string): StepSlug | null => {
  const slug = STEP_PATH_RE.exec(pathname)?.[1];
  return ALL_STEP_SLUGS.find((s) => s === slug) ?? null;
};

export const deriveFlowType = (interests: string[]): FlowType => {
  if (interests.includes("coding")) return "coding";
  if (interests.includes("autonomous")) return "autonomous";
  return "coding";
};

const hasAgent = (progress: OnboardingProgress): boolean =>
  !!progress.agent &&
  (progress.agent !== "other" || !!progress.agentName?.trim());

/** The furthest step the user's saved progress supports — used by the index
 * resume redirect and as the fallback target when a step guard rejects. */
export const stepPathForProgress = (progress: OnboardingProgress): string => {
  if (!progress.flowType) return onboardingPath("welcome");
  if (!hasAgent(progress)) return onboardingPath("agent");
  if (progress.flowType === "autonomous") {
    return onboardingPath("autonomous-agent");
  }
  return onboardingPath(
    progress.setupStage === "connected" ? "run" : "coding-agent",
  );
};

/** Whether a step's prerequisites are met. `run` is reachable with a pending
 * setup stage (the coding-agent step's Skip goes there), and earlier steps
 * stay reachable after later progress so back-navigation always works. */
export const isStepAllowed = (
  slug: StepSlug,
  progress: OnboardingProgress,
): boolean => {
  switch (slug) {
    case "welcome":
      return true;
    case "agent":
      return !!progress.flowType;
    case "coding-agent":
    case "run":
      return progress.flowType === "coding" && hasAgent(progress);
    case "autonomous-agent":
      return progress.flowType === "autonomous" && hasAgent(progress);
  }
};
