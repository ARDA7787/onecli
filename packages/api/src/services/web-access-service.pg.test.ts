import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Service = typeof import("./web-access-service");
type AgentService = typeof import("./agent-service");

let db: Db;
let service: Service;
let agentService: AgentService;

const P = "wap-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}workspace`;
const OTHER_WORKSPACE = `${P}other-workspace`;
const AGENT = `${P}agent`;
const FOREIGN_AGENT = `${P}foreign-agent`;
const SCOPE = { workspaceId: WORKSPACE, organizationId: ORG };

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const createRule = (
  status: "draft" | "published",
  generation: number,
  priority: number,
  name: string,
) =>
  db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      status,
      generation,
      priority,
      isDefault: false,
      source: "custom",
      logicalId: `${P}${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
      action: "allow",
      requireApproval: false,
      targets: {
        create: [{ kind: "network", hostPattern: `${name}.example.com` }],
      },
    },
  });

const seedPolicy = async () => {
  for (const [status, generation] of [
    ["draft", 0],
    ["published", 1],
  ] as const) {
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        status,
        generation,
        priority: 0,
        isDefault: true,
        source: "default",
        logicalId: `${P}default`,
        name: "Default Rule",
        action: "allow",
        requireApproval: false,
      },
    });
    await createRule(status, generation, 1, "Active custom");
  }
  await createRule("draft", 0, 2, "Staged only");
};

const liveRows = async () => {
  const max = await db.policyRuleV2.aggregate({
    where: { workspaceId: WORKSPACE, status: "published" },
    _max: { generation: true },
  });
  return db.policyRuleV2.findMany({
    where: {
      workspaceId: WORKSPACE,
      status: "published",
      generation: max._max.generation ?? -1,
    },
    include: { identities: true, targets: true },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  service = await import("./web-access-service");
  agentService = await import("./agent-service");
  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.organization.create({
    data: { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
  });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: {
      id: OTHER_WORKSPACE,
      name: OTHER_WORKSPACE,
      organizationId: OTHER_ORG,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  if (!PROOF_URL) return;
  await db.policyRuleV2.deleteMany({
    where: { workspaceId: { startsWith: P } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.create({
    data: {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: AGENT,
      identifier: AGENT,
      accessToken: `aoc_${P}agent`,
    },
  });
  await db.agent.create({
    data: {
      id: FOREIGN_AGENT,
      workspaceId: OTHER_WORKSPACE,
      name: FOREIGN_AGENT,
      identifier: FOREIGN_AGENT,
      accessToken: `aoc_${P}foreign`,
    },
  });
  await seedPolicy();
});

describe.skipIf(!PROOF_URL)("Web Access profiles over real PostgreSQL", () => {
  it("reads absence as Open and fences agents to the workspace", async () => {
    await expect(service.getWebAccessProfile(SCOPE, AGENT)).resolves.toEqual({
      mode: "open",
      generatedRules: 0,
      publishedGeneration: 1,
    });
    await expect(
      service.getWebAccessProfile(SCOPE, FOREIGN_AGENT),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("publishes a live clone without carrying unrelated staged rules", async () => {
    const result = await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "research" },
      "user-1",
    );
    expect(result).toMatchObject({
      changed: true,
      profile: {
        mode: "research",
        allowedMethods: ["GET", "HEAD"],
        writeBehavior: "ask",
        generatedRules: 2,
        publishedGeneration: 2,
      },
    });

    const live = await liveRows();
    expect(live.map((row) => row.name)).toEqual([
      "Default Rule",
      "Active custom",
      "[web-access] Research reads",
      "[web-access] Other research requests",
    ]);
    expect(live.some((row) => row.name === "Staged only")).toBe(false);
    expect(
      live
        .filter((row) => row.source === "web_access")
        .every(
          (row) =>
            row.identities.length === 1 && row.identities[0]?.agentId === AGENT,
        ),
    ).toBe(true);

    const draft = await db.policyRuleV2.findMany({
      where: { workspaceId: WORKSPACE, status: "draft" },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    expect(draft.map((row) => row.name)).toEqual([
      "Default Rule",
      "Active custom",
      "Staged only",
      "[web-access] Research reads",
      "[web-access] Other research requests",
    ]);
  });

  it("is generation-idempotent and GET round-trips normalized intent", async () => {
    await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      {
        mode: "restricted",
        allowDomains: ["B.EXAMPLE.COM", "a.example.com"],
        allowedMethods: ["HEAD", "GET"],
      },
      "user-1",
    );
    const second = await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      {
        mode: "restricted",
        allowDomains: ["a.example.com", "b.example.com"],
        allowedMethods: ["GET", "HEAD"],
      },
      "user-1",
    );
    expect(second.changed).toBe(false);
    expect(second.profile.publishedGeneration).toBe(2);
    await expect(service.getWebAccessProfile(SCOPE, AGENT)).resolves.toEqual(
      second.profile,
    );
  });

  it("rebuilds at the existing anchor and Open clears both sets", async () => {
    await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "research" },
      "user-1",
    );
    for (const [status, generation] of [
      ["draft", 0],
      ["published", 2],
    ] as const) {
      await createRule(status, generation, 99, "After profile");
    }
    await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "no_web" },
      "user-1",
    );
    expect((await liveRows()).map((row) => row.name)).toEqual([
      "Default Rule",
      "Active custom",
      "[web-access] No web",
      "After profile",
    ]);

    const cleared = await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "open" },
      "user-1",
    );
    expect(cleared.profile).toMatchObject({ mode: "open", generatedRules: 0 });
    expect((await liveRows()).some((row) => row.source === "web_access")).toBe(
      false,
    );
    expect(
      await db.policyRuleV2.count({
        where: {
          workspaceId: WORKSPACE,
          status: "draft",
          source: "web_access",
        },
      }),
    ).toBe(0);
  });

  it("surfaces managed-stack drift and repairs it on PUT", async () => {
    await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "no_web" },
      "user-1",
    );
    await db.policyRuleV2.updateMany({
      where: {
        workspaceId: WORKSPACE,
        source: "web_access",
      },
      data: { name: "drift" },
    });
    await expect(
      service.getWebAccessProfile(SCOPE, AGENT),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const repaired = await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "no_web" },
      "user-1",
    );
    expect(repaired.changed).toBe(true);
    expect(repaired.profile.publishedGeneration).toBe(3);
    await expect(
      service.getWebAccessProfile(SCOPE, AGENT),
    ).resolves.toMatchObject({ mode: "no_web" });
  });

  it("removes every profile generation before deleting an agent", async () => {
    await service.setWebAccessProfile(
      SCOPE,
      AGENT,
      { mode: "no_web" },
      "user-1",
    );
    await agentService.deleteAgent(WORKSPACE, AGENT);
    expect(
      await db.policyRuleV2.count({
        where: { workspaceId: WORKSPACE, source: "web_access" },
      }),
    ).toBe(0);
  });

  it("checks approval entitlements before changing policy", async () => {
    const providers = await import("../providers");
    providers.initRuleActionGate({
      assertAllowed: async (_scope, actions) => {
        if (actions.includes("manual_approval")) {
          throw new Error("approval unavailable");
        }
      },
    });
    await expect(
      service.setWebAccessProfile(SCOPE, AGENT, { mode: "research" }, "user-1"),
    ).rejects.toThrow("approval unavailable");
    expect(
      await db.policyRuleV2.count({
        where: { workspaceId: WORKSPACE, source: "web_access" },
      }),
    ).toBe(0);
  });

  it("retains ten published generations", async () => {
    for (let index = 0; index < 12; index += 1) {
      await service.setWebAccessProfile(
        SCOPE,
        AGENT,
        { mode: index % 2 === 0 ? "no_web" : "search_only" },
        "user-1",
      );
    }
    const generations = await db.policyRuleV2.findMany({
      where: { workspaceId: WORKSPACE, status: "published" },
      distinct: ["generation"],
      select: { generation: true },
      orderBy: { generation: "asc" },
    });
    expect(generations.map((row) => row.generation)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("serializes concurrent profile writes under the scope lock", async () => {
    await Promise.all([
      service.setWebAccessProfile(SCOPE, AGENT, { mode: "no_web" }, "user-1"),
      service.setWebAccessProfile(
        SCOPE,
        AGENT,
        { mode: "search_only" },
        "user-2",
      ),
    ]);
    const profile = await service.getWebAccessProfile(SCOPE, AGENT);
    expect(["no_web", "search_only"]).toContain(profile.mode);
    expect(profile.generatedRules).toBe(1);
    expect(profile.publishedGeneration).toBe(3);
  });
});
