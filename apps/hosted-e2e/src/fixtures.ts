import type { PrismaClient } from "@prisma/client";
import { cryptoService } from "./crypto.js";
import type { TestIds } from "./ids.js";

/**
 * Hosted-world fixtures — lean and hosted-specific, in the gateway-e2e
 * spirit (Prisma-typed so a schema rename breaks `check-types`).
 *
 * TWO LAWS, both load-bearing:
 *
 *  - **Door 2 is seeded from day one.** A sandbox will not start without an
 *    injectable LLM credential: a stored secret whose type is a provider id
 *    AND a published `source:"grant"` allow rule naming the agent — exactly
 *    the rows the production grants compiler writes. Forgetting the grant is
 *    the rot that killed the hand-run dev proof scripts: every spawn parks
 *    and a suite asserting absence stays green.
 *  - **Hosted agents are fixture-seeded, never API-created**, so the
 *    `Sandbox.id` carries the `he2e-` prefix and every Docker object a stale
 *    run leaves is name-sweepable (see ids.ts).
 */

interface Tenant {
  org: string;
  workspace: string;
  user: string;
  apiKey: string;
}

const tenantOf = (ids: TestIds, which: "first" | "second"): Tenant =>
  which === "first"
    ? {
        org: ids.org,
        workspace: ids.workspace,
        user: ids.user,
        apiKey: ids.apiKey,
      }
    : {
        org: ids.secondOrg,
        workspace: ids.secondWorkspace,
        user: ids.secondUser,
        apiKey: ids.secondApiKey,
      };

/** Org + workspace + owner user + `oc_` workspace API key. */
export const seedTenant = async (
  prisma: PrismaClient,
  ids: TestIds,
  which: "first" | "second" = "first",
): Promise<void> => {
  const tenant = tenantOf(ids, which);
  const email = `${tenant.user}@e2e.invalid`;
  await prisma.organization.create({
    data: { id: tenant.org, name: tenant.org, slug: tenant.org },
  });
  await prisma.workspace.create({
    data: {
      id: tenant.workspace,
      name: tenant.workspace,
      organizationId: tenant.org,
    },
  });
  await prisma.user.create({
    data: { id: tenant.user, email, externalAuthId: tenant.user },
  });
  await prisma.organizationMember.create({
    data: {
      organizationId: tenant.org,
      userId: tenant.user,
      userEmail: email,
      role: "owner",
    },
  });
  await prisma.apiKey.create({
    data: {
      id: `${tenant.workspace}-key`,
      key: tenant.apiKey,
      scope: "workspace",
      workspaceId: tenant.workspace,
      userId: tenant.user,
      userEmail: email,
    },
  });
};

export interface SeedHostedAgentOptions {
  runnerId: string;
  which?: "first" | "second";
  harness?: string;
}

/** A hosted agent + its unprovisioned Sandbox row (the `agent-service`
 * create path's rows, with the sweepable pinned sandbox id). */
export const seedHostedAgent = async (
  prisma: PrismaClient,
  ids: TestIds,
  opts: SeedHostedAgentOptions,
): Promise<{ agentId: string; sandboxId: string }> => {
  const which = opts.which ?? "first";
  const tenant = tenantOf(ids, which);
  const agentId = which === "first" ? ids.agent : ids.secondAgent;
  const agentToken = which === "first" ? ids.agentToken : ids.secondAgentToken;
  const sandboxId = which === "first" ? ids.sandbox : ids.secondSandbox;

  await prisma.agent.create({
    data: {
      id: agentId,
      workspaceId: tenant.workspace,
      name: agentId,
      identifier: agentId,
      accessToken: agentToken,
      kind: "hosted",
      harness: opts.harness ?? "fake",
    },
  });
  await prisma.sandbox.create({
    data: {
      id: sandboxId,
      agentId,
      runnerId: opts.runnerId,
      status: "unprovisioned",
    },
  });
  return { agentId, sandboxId };
};

/**
 * Door 2: an anthropic-typed secret + the published grant rule attaching it
 * to the agent — byte-for-byte the production grants compiler's shape
 * (gateway-e2e's `createGrantRule`). Optional overrides let the injection
 * legs point the "provider" at a local stub upstream and demand approval.
 */
export const seedAnthropicGrant = async (
  prisma: PrismaClient,
  ids: TestIds,
  opts: {
    which?: "first" | "second";
    /** Where the credential injects (default: the real provider host). */
    hostPattern?: string;
    value?: string;
    requireApproval?: boolean;
  } = {},
): Promise<{ secretId: string }> => {
  const which = opts.which ?? "first";
  const tenant = tenantOf(ids, which);
  const agentId = which === "first" ? ids.agent : ids.secondAgent;
  const secretId = `${tenant.workspace}-anthropic`;
  const ruleId = `${tenant.workspace}-grant-anthropic`;

  await prisma.secret.create({
    data: {
      id: secretId,
      name: secretId,
      type: "anthropic",
      scope: "workspace",
      workspaceId: tenant.workspace,
      organizationId: tenant.org,
      valueSource: "inline",
      encryptedValue: await cryptoService.encrypt(
        opts.value ?? `sk-ant-e2e-${ids.nonce}`,
      ),
      hostPattern: opts.hostPattern ?? "api.anthropic.com",
      pathPattern: null,
      injectionConfig: {},
    },
  });
  await prisma.policyRuleV2.create({
    data: {
      id: ruleId,
      scope: "workspace",
      workspaceId: tenant.workspace,
      status: "published",
      generation: 1,
      enabled: true,
      isDefault: false,
      source: "grant",
      priority: 1000,
      name: `grant ${secretId}`,
      action: "allow",
      requireApproval: opts.requireApproval ?? false,
      targets: {
        create: [
          {
            id: `${ruleId}-t0`,
            kind: "secret",
            secret: { connect: { id: secretId } },
          },
        ],
      },
      identities: {
        create: [{ id: `${ruleId}-i0`, agent: { connect: { id: agentId } } }],
      },
    },
  });
  return { secretId };
};
