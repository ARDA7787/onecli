import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "oc_org_web-access-test";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const auditCreate = vi.hoisted(() => vi.fn(async () => ({})));
const apiKeyFindFirst = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: apiKeyFindFirst,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
      }),
    },
    workspace: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "workspace-1" ? { id: "workspace-1" } : null,
    },
    auditLog: { create: auditCreate },
  },
}));

vi.mock("../services/web-access-service", () => ({
  getWebAccessProfile: services.get,
  setWebAccessProfile: services.set,
}));

vi.mock("../services/agent-service", () => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  agentExistsByIdentifier: vi.fn(),
  getAgentDetail: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  regenerateAgentToken: vi.fn(),
}));

const { createApiApp } = await import("../app");
const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${KEY}`,
  "x-workspace-id": "workspace-1",
  "content-type": "application/json",
};

beforeEach(() => {
  vi.clearAllMocks();
  services.get.mockResolvedValue({
    mode: "open",
    generatedRules: 0,
    publishedGeneration: null,
  });
  services.set.mockResolvedValue({
    profile: {
      mode: "research",
      allowedMethods: ["GET", "HEAD"],
      writeBehavior: "ask",
      generatedRules: 2,
      publishedGeneration: 2,
    },
    changed: true,
  });
});

describe("agent Web Access routes", () => {
  it("reads the profile in the authenticated workspace", async () => {
    const response = await app.request("/v1/agents/agent-1/web-access", {
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "open" });
    expect(services.get).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", organizationId: "org-1" },
      "agent-1",
    );
  });

  it("validates and audits a profile update", async () => {
    const response = await app.request("/v1/agents/agent-1/web-access", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({
        mode: "research",
        allowedMethods: ["HEAD", "GET"],
      }),
    });
    expect(response.status).toBe(200);
    expect(services.set).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", organizationId: "org-1" },
      "agent-1",
      { mode: "research", allowedMethods: ["HEAD", "GET"] },
      "user-1",
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "update",
        service: "policy",
        workspaceId: "workspace-1",
        metadata: expect.objectContaining({
          agentId: "agent-1",
          mode: "research",
          changed: true,
          generation: 2,
        }),
      }),
    });
    expect(apiKeyFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      select: { key: true },
    });
  });

  it("rejects incompatible fields before calling the service", async () => {
    const response = await app.request("/v1/agents/agent-1/web-access", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ mode: "open", allowedMethods: ["GET"] }),
    });
    expect(response.status).toBe(422);
    expect(services.set).not.toHaveBeenCalled();
  });

  it("clears through Open and returns 204", async () => {
    services.set.mockResolvedValueOnce({
      profile: {
        mode: "open",
        generatedRules: 0,
        publishedGeneration: 3,
      },
      changed: true,
    });
    const response = await app.request("/v1/agents/agent-1/web-access", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(response.status).toBe(204);
    expect(services.set).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", organizationId: "org-1" },
      "agent-1",
      { mode: "open" },
      "user-1",
    );
  });

  it("requires authentication", async () => {
    const response = await app.request("/v1/agents/agent-1/web-access", {
      headers: { "x-workspace-id": "workspace-1" },
    });
    expect(response.status).toBe(401);
  });
});
