import { Hono } from "hono";
import { z } from "zod";
import { db, Prisma } from "@onecli/db";
import type { ApiEnv } from "../types";
import { auth, requireWorkspaceId } from "../middleware/auth";
import { getCrypto } from "../providers";
import { generateAccessToken } from "../services/agent-service";
import {
  detectAnthropicAuthMode,
  hostPatternSchema,
  injectionConfigSchema,
} from "../validations/secret";
import { logger } from "../lib/logger";
import { ServiceError } from "../services/errors";

// ── Validation schemas ──────────────────────────────────────────────

const secretSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(["anthropic", "openai", "generic"]),
  value: z.string().min(1),
  hostPattern: hostPatternSchema,
  pathPattern: z.string().nullable(),
  // The full injection-config union (header / param / path), so param- and
  // path-injected secrets migrate too — not just header ones.
  injectionConfig: injectionConfigSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const agentSchema = z.object({
  name: z.string().min(1).max(255),
  identifier: z.string().min(1).max(50),
  // Tolerated for old exports, never persisted: the default-agent concept is
  // gone (like `secretMode` below).
  isDefault: z.boolean().optional(),
  // Tolerated for old exports, never persisted: the column is gone. An "all"
  // agent's implicit whole-pool access is legacy grant data — reported as
  // skipped (like `agentSecrets`), re-authored in the Policy console.
  secretMode: z.enum(["all", "selective"]).optional(),
});

const agentSecretSchema = z.object({
  agentIdentifier: z.string().min(1),
  secretName: z.string().min(1),
});

const ruleSchema = z.object({
  name: z.string().min(1).max(255),
  hostPattern: z.string().min(1),
  pathPattern: z.string().nullable(),
  method: z.string().nullable(),
  action: z.enum(["block", "rate_limit", "manual_approval"]),
  enabled: z.boolean(),
  agentIdentifier: z.string().nullable(),
  rateLimit: z.number().int().positive().nullable(),
  rateLimitWindow: z.enum(["minute", "hour", "day"]).nullable(),
});

const importPayloadSchema = z.object({
  version: z.literal(1),
  secrets: z.array(secretSchema).default([]),
  agents: z.array(agentSchema).default([]),
  agentSecrets: z.array(agentSecretSchema).default([]),
  rules: z.array(ruleSchema).default([]),
});

type ImportPayload = z.infer<typeof importPayloadSchema>;

// ── Types ───────────────────────────────────────────────────────────

interface SkippedEntry {
  type: string;
  name: string;
  reason: string;
}

interface ImportResult {
  imported: {
    secrets: number;
    agents: number;
    agentSecrets: number;
    rules: number;
  };
  skipped: SkippedEntry[];
}

// ── Import logic ────────────────────────────────────────────────────

/**
 * Both legacy arms would write tables the engine stopped reading at step 10, so
 * importing them would be a silent no-op reported as "imported".
 *
 * They are REPORTED, not rejected. The payload is built by the customer's own
 * self-hosted instance (`POST /v1/migrate/export` takes only a cloud key + URL),
 * so on any release older than this one they cannot strip these arms — refusing
 * the whole request would fail the migration outright, secrets and agents
 * included, over data we were never going to carry anyway. Each dropped item
 * comes back in `skipped`, which the CLI prints, the same way a 1Password-sourced
 * secret is reported below.
 *
 * The one case that still fails loud: a payload made ONLY of these arms. Nothing
 * would be imported at all, so "success" would be a lie.
 */
const RULE_SKIP_REASON =
  "Not migrated: policy rules are authored in the Policy console (/v1/policy) on " +
  "the destination. Re-create this rule there.";

const AGENT_SECRET_SKIP_REASON =
  "Not migrated: per-agent credential access is granted by policy rules now. " +
  "Grant this agent its credentials in the Policy console (/v1/policy).";

const ALL_MODE_SKIP_REASON =
  "Not migrated: this agent had access to every workspace credential " +
  '(legacy "all" mode). Grant it the credentials it needs in the Policy ' +
  "console (/v1/policy).";

const LEGACY_ONLY_PAYLOAD =
  "This payload contains only legacy policy rules and per-agent credential " +
  "grants, neither of which this deployment can import (the policy engine " +
  "manages both now). Nothing would be created. Re-author them in the Policy " +
  "console (/v1/policy).";

/** One skip entry per dropped rule, and one per agent whose grants were dropped
 * (per-pair would be noise — the actionable unit is "this agent needs access"). */
const legacySkips = (data: ImportPayload): SkippedEntry[] => {
  const grantsByAgent = new Map<string, number>();
  for (const m of data.agentSecrets) {
    grantsByAgent.set(
      m.agentIdentifier,
      (grantsByAgent.get(m.agentIdentifier) ?? 0) + 1,
    );
  }
  return [
    ...data.rules.map((r) => ({
      type: "rule",
      name: r.name,
      reason: RULE_SKIP_REASON,
    })),
    ...[...grantsByAgent].map(([agentIdentifier, count]) => ({
      type: "agentSecrets",
      name: `${agentIdentifier} (${count} credential${count === 1 ? "" : "s"})`,
      reason: AGENT_SECRET_SKIP_REASON,
    })),
    ...data.agents
      .filter((a) => a.secretMode === "all")
      .map((a) => ({
        type: "agentSecrets",
        name: a.identifier,
        reason: ALL_MODE_SKIP_REASON,
      })),
  ];
};

const importData = async (
  workspaceId: string,
  data: ImportPayload,
): Promise<ImportResult> => {
  const imported = { secrets: 0, agents: 0, agentSecrets: 0, rules: 0 };

  const hasImportable = data.secrets.length > 0 || data.agents.length > 0;
  const hasLegacy = data.rules.length > 0 || data.agentSecrets.length > 0;
  if (hasLegacy && !hasImportable) {
    throw new ServiceError("GONE", LEGACY_ONLY_PAYLOAD);
  }
  const skipped: SkippedEntry[] = legacySkips(data);

  await db.$transaction(
    async (tx) => {
      // ── Agents ────────────────────────────────────────────────────
      for (const agent of data.agents) {
        const existing = await tx.agent.findFirst({
          where: { workspaceId, identifier: agent.identifier },
          select: { id: true },
        });

        if (existing) {
          skipped.push({
            type: "agent",
            name: agent.name,
            reason: "already exists",
          });
          continue;
        }

        await tx.agent.create({
          data: {
            workspaceId,
            name: agent.name,
            identifier: agent.identifier,
            accessToken: generateAccessToken(),
            // Explicit at every creation site (house convention): imported
            // agents are byo — the export format predates hosted agents.
            kind: "byo",
          },
        });

        imported.agents++;
      }

      // ── Secrets ───────────────────────────────────────────────────
      for (const secret of data.secrets) {
        const existing = await tx.secret.findFirst({
          where: { workspaceId, name: secret.name },
          select: { id: true },
        });

        if (existing) {
          skipped.push({
            type: "secret",
            name: secret.name,
            reason: "already exists",
          });
          continue;
        }

        const encryptedValue = await getCrypto().encrypt(secret.value);

        // Re-detect auth mode for anthropic secrets from the actual value
        const metadata =
          secret.type === "anthropic"
            ? ({
                authMode: detectAnthropicAuthMode(secret.value) ?? "api-key",
              } as Prisma.InputJsonValue)
            : secret.metadata
              ? (secret.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull;

        // Already validated against the shared injection-config union — store it
        // faithfully (header, param, or path); no header-only reconstruction.
        const injectionConfig = secret.injectionConfig
          ? (secret.injectionConfig as Prisma.InputJsonValue)
          : Prisma.JsonNull;

        await tx.secret.create({
          data: {
            workspaceId,
            name: secret.name,
            type: secret.type,
            encryptedValue,
            hostPattern: secret.hostPattern,
            pathPattern: secret.pathPattern,
            injectionConfig,
            metadata,
          },
        });

        imported.secrets++;
      }
    },
    { timeout: 30_000 },
  );

  return { imported, skipped };
};

export const migrateImportRoutes = () => {
  const app = new Hono<ApiEnv>();

  // POST /import
  app.post("/import", auth(), async (c) => {
    try {
      const authCtx = c.get("auth");
      const workspaceId = requireWorkspaceId(authCtx);

      const body = await c.req.json().catch(() => null);
      const parsed = importPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: parsed.error.issues[0]?.message ?? "Invalid import payload",
          },
          400,
        );
      }

      const result = await importData(workspaceId, parsed.data);

      logger.info(
        { workspaceId, imported: result.imported },
        "migration import completed",
      );

      return c.json(result);
    } catch (err) {
      if (err instanceof ServiceError) {
        const status =
          err.code === "NOT_FOUND"
            ? 404
            : err.code === "BAD_REQUEST"
              ? 400
              : err.code === "CONFLICT"
                ? 409
                : err.code === "FORBIDDEN"
                  ? 403
                  : err.code === "GONE"
                    ? 410
                    : 500;
        return c.json({ error: err.message }, status as 400);
      }
      logger.error({ err }, "migration import failed");
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
};
