import { beforeEach, describe, expect, it, vi } from "vitest";

// The import path's legacy handling. The payload is built by the customer's OWN
// self-hosted instance, which on any older release still sends `rules` and
// `agentSecrets` and offers no way to omit them — so the importable half must
// still land, and what was dropped has to come back visibly.

const store = vi.hoisted(() => ({
  agents: [] as { workspaceId: string; identifier: string }[],
  secrets: [] as { workspaceId: string; name: string }[],
  created: { agents: 0, secrets: 0 },
}));

vi.mock("@onecli/db", () => {
  const tx = {
    agent: {
      findFirst: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          identifier?: string;
          isDefault?: boolean;
        };
      }) =>
        store.agents.find(
          (a) =>
            a.workspaceId === where.workspaceId &&
            (where.identifier === undefined ||
              a.identifier === where.identifier),
        ) ?? null,
      create: async () => {
        store.created.agents++;
        return { id: `agent-${store.created.agents}` };
      },
    },
    secret: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; name: string };
      }) =>
        store.secrets.find(
          (s) => s.workspaceId === where.workspaceId && s.name === where.name,
        ) ?? null,
      create: async () => {
        store.created.secrets++;
        return { id: `secret-${store.created.secrets}` };
      },
    },
  };
  return {
    Prisma: { JsonNull: null, InputJsonValue: null },
    db: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock("../providers", () => ({
  getCrypto: () => ({ encrypt: async (v: string) => `enc:${v}` }),
}));

const { migrateImportRoutes } = await import("./migrate-import");
const { ServiceError } = await import("../services/errors");

vi.mock("../middleware/auth", () => ({
  auth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", { userId: "u1", workspaceId: "p1", organizationId: "o1" });
      return next();
    },
  requireWorkspaceId: () => "p1",
}));

const secret = (name: string) => ({
  name,
  type: "generic" as const,
  value: "v",
  hostPattern: "api.example.com",
  pathPattern: null,
  injectionConfig: {
    headerName: "Authorization",
    valueFormat: "Bearer {value}",
  },
  metadata: null,
});

const agent = (identifier: string) => ({
  name: identifier,
  identifier,
  isDefault: false,
});

const rule = (name: string) => ({
  name,
  hostPattern: "api.example.com",
  pathPattern: null,
  method: null,
  action: "block" as const,
  enabled: true,
  agentIdentifier: null,
  rateLimit: null,
  rateLimitWindow: null,
});

const post = async (payload: Record<string, unknown>) => {
  const app = migrateImportRoutes();
  const res = await app.request("/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, ...payload }),
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  store.agents = [];
  store.secrets = [];
  store.created = { agents: 0, secrets: 0 };
});

describe("migrate import — legacy arms", () => {
  it("still imports secrets and agents when the payload carries legacy rules", async () => {
    // The load-bearing case: an older self-hosted instance sends rules it cannot
    // omit. Failing the request would strand the secrets and agents too.
    const { status, body } = await post({
      secrets: [secret("token")],
      agents: [agent("worker")],
      rules: [rule("Block npm")],
    });
    expect(status).toBe(200);
    expect(body.imported).toMatchObject({ secrets: 1, agents: 1 });
  });

  it("reports every dropped rule by name", async () => {
    const { body } = await post({
      secrets: [secret("token")],
      rules: [rule("Block npm"), rule("Block PyPI")],
    });
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "rule", name: "Block npm" }),
        expect.objectContaining({ type: "rule", name: "Block PyPI" }),
      ]),
    );
    // Never counted as imported — they were not.
    expect(body.imported.rules).toBe(0);
  });

  it("reports dropped per-agent grants once per agent, with a count", async () => {
    const { body } = await post({
      secrets: [secret("a"), secret("b")],
      agents: [agent("worker")],
      agentSecrets: [
        { agentIdentifier: "worker", secretName: "a" },
        { agentIdentifier: "worker", secretName: "b" },
      ],
    });
    const entry = body.skipped.find(
      (s: { type: string }) => s.type === "agentSecrets",
    );
    expect(entry.name).toBe("worker (2 credentials)");
    expect(entry.reason).toMatch(/Policy console/);
    expect(body.imported.agentSecrets).toBe(0);
  });

  it("fails loud when the payload is ONLY legacy content", async () => {
    // Nothing would be created, so reporting success would be a lie.
    const { status, body } = await post({
      rules: [rule("Block npm")],
      agentSecrets: [{ agentIdentifier: "worker", secretName: "a" }],
    });
    expect(status).toBe(410);
    expect(body.error).toMatch(/only legacy/i);
  });

  it("a clean payload skips nothing", async () => {
    const { status, body } = await post({
      secrets: [secret("token")],
      agents: [agent("worker")],
    });
    expect(status).toBe(200);
    expect(body.skipped).toEqual([]);
  });

  it("an old export's all-mode agent imports but reports its dropped pool access", async () => {
    // Legacy "all" meant access to every workspace credential. The column is
    // gone; the agent itself still imports and the implicit pool access is
    // reported once, pointing at the Policy console.
    const { status, body } = await post({
      agents: [{ ...agent("worker"), secretMode: "all" as const }],
    });
    expect(status).toBe(200);
    expect(body.imported.agents).toBe(1);
    expect(body.skipped).toEqual([
      {
        type: "agentSecrets",
        name: "worker",
        reason: expect.stringMatching(/all.*Policy console/s),
      },
    ]);
  });

  it("maps GONE to 410, not 500", async () => {
    // The local handler used to fall through to 500 for GONE — the reject was
    // never actually reaching the caller as a 410.
    expect(new ServiceError("GONE", "x").code).toBe("GONE");
    const { status } = await post({ rules: [rule("Block npm")] });
    expect(status).toBe(410);
  });
});
