import { Hono } from "hono";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  withAudit,
} from "../services/audit-service";
import {
  getWebAccessProfile,
  setWebAccessProfile,
  type WebAccessScope,
} from "../services/web-access-service";
import { webAccessProfileSchema } from "../validations/web-access";

const scopeOf = (auth: AuthContext): WebAccessScope => ({
  workspaceId: requireWorkspaceId(auth),
  organizationId: auth.organizationId,
});

const auditBase = (auth: AuthContext) => ({
  workspaceId: requireWorkspaceId(auth),
  userId: auth.userId,
  userEmail: auth.userEmail,
  service: AUDIT_SERVICES.POLICY,
  source: AUDIT_SOURCE.API,
});

const parseBody = async (c: { req: { json: () => Promise<unknown> } }) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = webAccessProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      parsed.error.issues[0]?.message ?? "Invalid Web Access profile.",
    );
  }
  return parsed.data;
};

export const agentWebAccessRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/web-access", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await getWebAccessProfile(scopeOf(auth), c.req.param("agentId")),
    );
  });

  app.put("/:agentId/web-access", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const input = await parseBody(c);
    const result = await withAudit(
      () => setWebAccessProfile(scopeOf(auth), agentId, input, auth.userId),
      (mutation) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          agentId,
          mode: mutation.profile.mode,
          changed: mutation.changed,
          generation: mutation.profile.publishedGeneration,
        },
      }),
    );
    return c.json(result.profile);
  });

  app.delete("/:agentId/web-access", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    await withAudit(
      () =>
        setWebAccessProfile(
          scopeOf(auth),
          agentId,
          { mode: "open" },
          auth.userId,
        ),
      (mutation) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: {
          agentId,
          mode: "open",
          changed: mutation.changed,
          generation: mutation.profile.publishedGeneration,
        },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
