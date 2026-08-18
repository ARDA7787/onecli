"use server";

import { db, type Prisma } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { notifyDiscord } from "@onecli/api/ee/notifications/discord";
import { findUserDefaultWorkspace } from "@onecli/api/services/organization-service";
import { getRedis } from "@onecli/api/ee/clients/redis-client";
import { redisKeys } from "@onecli/api/ee/clients/redis-keys";
import { safeAction, type ActionResult } from "@/lib/safe-action";
import type { OnboardingProgress, SetupStage } from "./steps";

const resolveOnboardingContext = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true },
  });
  if (!user) throw new Error("User not found");
  const workspace = await findUserDefaultWorkspace(user.id);
  if (!workspace) throw new Error("No workspace found");
  return {
    userId: user.id,
    userEmail: user.email,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
  };
};

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "github-copilot": "GitHub Copilot",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  nanoclaw: "NanoClaw",
  ironclaw: "IronClaw",
};

const upsertSurveyResponses = async (
  ctx: { userId: string; userEmail: string; workspaceId: string },
  responses: Record<string, unknown>,
) => {
  const discoveryArr = Array.isArray(responses.discovery)
    ? (responses.discovery as string[])
    : [];

  const surveyResponses = responses as Prisma.InputJsonValue;

  await db.onboardingSurvey.upsert({
    where: { workspaceId: ctx.workspaceId },
    create: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      responses: surveyResponses,
      discovery: discoveryArr,
    },
    update: {
      responses: surveyResponses,
      discovery: discoveryArr,
    },
  });
};

export async function saveOnboardingSurvey(
  responses: Record<string, unknown>,
): Promise<ActionResult> {
  return safeAction(async () => {
    const ctx = await resolveOnboardingContext();
    const { userId, userEmail, workspaceId } = ctx;

    await upsertSurveyResponses(ctx, responses);

    const agentId = responses.agent as string | undefined;
    const agentName =
      (responses.agentName as string | undefined) ??
      (agentId ? AGENT_LABELS[agentId] : undefined);

    if (agentName) {
      // Renames the workspace's oldest agent when one exists. Nothing is seeded
      // any more, so a workspace can legitimately have none here — skipping is
      // the intended no-op, not a failure.
      const oldest = await db.agent.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (oldest) {
        await db.agent.update({
          where: { id: oldest.id },
          data: { name: agentName },
        });
      }
    }

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const alreadyCompleted = user.onboardingCompletedAt !== null;

    if (!alreadyCompleted) {
      await db.user.update({
        where: { id: userId },
        data: { onboardingCompletedAt: new Date() },
      });

      notifyDiscord("onboarding_completed", {
        email: userEmail,
        flowType: responses.flowType as string | null | undefined,
        agent: responses.agent as string | null | undefined,
        agentName: responses.agentName as string | null | undefined,
      });
    }
  });
}

/** Persist in-progress answers without completing onboarding (no agent
 * rename, no completion timestamp, no notification). Used at step
 * transitions so refresh/resume can rehydrate the flow. */
export async function saveOnboardingProgress(
  responses: Record<string, unknown>,
): Promise<ActionResult> {
  return safeAction(async () => {
    const ctx = await resolveOnboardingContext();
    await upsertSurveyResponses(ctx, responses);
  });
}

/** `connectedAt` only counts after `installedAt`: agent containers write
 * `connectedAt` on /container-config fetches whenever a survey row exists
 * (created as early as the welcome step by progress saves), and that alone
 * must not read as a finished install. */
const stageFromSetupState = (setupState: unknown): SetupStage => {
  const state =
    setupState && typeof setupState === "object"
      ? (setupState as Record<string, unknown>)
      : {};
  if (!state.installedAt) return "pending";
  return state.connectedAt ? "connected" : "installed";
};

const emptyProgress = (): OnboardingProgress => ({
  discovery: [],
  interests: [],
  flowType: null,
  agent: null,
  agentName: null,
  setupStage: "pending",
});

/** Saved progress used to seed the client flow. Never throws: during first
 * login the default org/workspace may not exist yet (it's lazily created by
 * `getActiveWorkspacePath` in the same layout boot batch), and "no workspace"
 * simply means "no progress". Fields are defaulted independently because
 * `/v1/onboarding/install-complete` creates survey rows with empty
 * `responses`. */
export async function getOnboardingProgress(): Promise<OnboardingProgress> {
  try {
    const session = await getServerSession();
    if (!session) return emptyProgress();

    const { workspaceId } = await resolveOnboardingContext();

    const survey = await db.onboardingSurvey.findUnique({
      where: { workspaceId },
      select: { responses: true, setupState: true },
    });
    if (!survey) return emptyProgress();

    const responses =
      survey.responses &&
      typeof survey.responses === "object" &&
      !Array.isArray(survey.responses)
        ? (survey.responses as Record<string, unknown>)
        : {};

    return {
      discovery: Array.isArray(responses.discovery)
        ? responses.discovery.filter((d): d is string => typeof d === "string")
        : [],
      interests: Array.isArray(responses.interests)
        ? responses.interests.filter((i): i is string => typeof i === "string")
        : [],
      flowType:
        responses.flowType === "coding" || responses.flowType === "autonomous"
          ? responses.flowType
          : null,
      agent: typeof responses.agent === "string" ? responses.agent : null,
      agentName:
        typeof responses.agentName === "string" ? responses.agentName : null,
      setupStage: stageFromSetupState(survey.setupState),
    };
  } catch {
    return emptyProgress();
  }
}

export async function checkOnboardingComplete(): Promise<boolean> {
  const session = await getServerSession();
  if (!session) return false;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { onboardingCompletedAt: true },
  });

  return user?.onboardingCompletedAt !== null;
}

export type OnboardingSetupStatus =
  | { stage: Extract<SetupStage, "pending"> }
  | {
      stage: Exclude<SetupStage, "pending">;
      installType?: "install" | "migrate";
      agentName?: string;
    };

export async function hasFirstGatewayRequest(): Promise<boolean> {
  const session = await getServerSession();
  if (!session) return false;

  const { workspaceId, organizationId } = await resolveOnboardingContext();

  try {
    const redis = getRedis();

    const agents = await db.agent.findMany({
      where: { workspaceId },
      select: { id: true },
    });

    const now = new Date();
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;

    const keys = agents.map((a) =>
      redisKeys.requests(organizationId, workspaceId, a.id, today),
    );

    if (keys.length === 0) return false;

    const values = await redis.mget(...keys);
    return values.some((v) => v !== null && parseInt(v, 10) > 0);
  } catch {
    return false;
  }
}

export async function getOnboardingInstallStatus(): Promise<OnboardingSetupStatus> {
  const session = await getServerSession();
  if (!session) return { stage: "pending" };

  const { workspaceId } = await resolveOnboardingContext();

  const survey = await db.onboardingSurvey.findUnique({
    where: { workspaceId },
    select: { setupState: true },
  });

  const state =
    survey?.setupState && typeof survey.setupState === "object"
      ? (survey.setupState as Record<string, unknown>)
      : {};

  const installType = state.installType as "install" | "migrate" | undefined;
  const stage = stageFromSetupState(survey?.setupState);

  if (stage === "pending") {
    return { stage };
  }

  const agent = await db.agent.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { name: true },
  });

  return {
    stage,
    installType,
    agentName: agent?.name ?? undefined,
  };
}
