import { db, Prisma } from "@onecli/db";
import { getRuleActionGate } from "../providers";
import type { WebAccessProfileInput } from "../validations/web-access";
import { ServiceError } from "./errors";
import {
  ensureDefault,
  gatedActions,
  lockScope,
  PUBLISHED_GENERATION_RETENTION,
  RULE_INCLUDE,
  type PolicyRuleRow,
  type PolicyScopeBase,
} from "./policy-service";
import {
  compileWebAccessProfile,
  decodeWebAccessProfile,
  normalizeWebAccessProfile,
  WEB_ACCESS_SOURCE,
  webAccessStackEquals,
  type CompiledWebAccessRule,
  type NormalizedWebAccessProfile,
} from "./web-access-compile";

export interface WebAccessScope {
  workspaceId: string;
  organizationId: string;
}

export type WebAccessView = NormalizedWebAccessProfile & {
  generatedRules: number;
  publishedGeneration: number | null;
};

export interface WebAccessMutationResult {
  profile: WebAccessView;
  changed: boolean;
}

type Tx = Prisma.TransactionClient;

const base = (scope: WebAccessScope): PolicyScopeBase => ({
  scope: "workspace",
  workspaceId: scope.workspaceId,
});

const requireAgent = async (
  client: Tx | typeof db,
  scope: WebAccessScope,
  agentId: string,
) => {
  const agent = await client.agent.findFirst({
    where: { id: agentId, workspaceId: scope.workspaceId },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
  return agent;
};

const activeGeneration = async (
  client: Tx | typeof db,
  scopeBase: PolicyScopeBase,
): Promise<number | null> => {
  const result = await client.policyRuleV2.aggregate({
    where: { ...scopeBase, status: "published" },
    _max: { generation: true },
  });
  return result._max.generation;
};

const listRules = (
  client: Tx | typeof db,
  scopeBase: PolicyScopeBase,
  status: "draft" | "published",
  generation?: number,
): Promise<PolicyRuleRow[]> =>
  client.policyRuleV2.findMany({
    where: {
      ...scopeBase,
      status,
      ...(generation === undefined ? {} : { generation }),
    },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });

const isAgentProfileRule = (rule: PolicyRuleRow, agentId: string): boolean =>
  rule.source === WEB_ACCESS_SOURCE &&
  (rule.logicalId.startsWith(`web-access:${agentId}:`) ||
    rule.identities.some((identity) => identity.agentId === agentId));

const profileRows = (rows: PolicyRuleRow[], agentId: string) =>
  rows.filter((row) => isAgentProfileRule(row, agentId));

const profilesEqual = (
  a: NormalizedWebAccessProfile,
  b: NormalizedWebAccessProfile,
) => JSON.stringify(a) === JSON.stringify(b);

const view = (
  profile: NormalizedWebAccessProfile,
  generatedRules: number,
  publishedGeneration: number | null,
): WebAccessView => ({
  ...profile,
  generatedRules,
  publishedGeneration,
});

const conflict = (): never => {
  throw new ServiceError(
    "CONFLICT",
    "The stored Web Access profile is inconsistent. Save or clear the profile to repair it.",
  );
};

export const getWebAccessProfile = async (
  scope: WebAccessScope,
  agentId: string,
): Promise<WebAccessView> => {
  await requireAgent(db, scope, agentId);
  const scopeBase = base(scope);
  const generation = await activeGeneration(db, scopeBase);
  const [draft, published] = await Promise.all([
    listRules(db, scopeBase, "draft"),
    generation === null
      ? Promise.resolve([] as PolicyRuleRow[])
      : listRules(db, scopeBase, "published", generation),
  ]);
  const draftRows = profileRows(draft, agentId);
  const publishedRows = profileRows(published, agentId);
  const draftProfile = decodeWebAccessProfile(agentId, draftRows);
  const publishedProfile = decodeWebAccessProfile(agentId, publishedRows);
  if (
    !draftProfile ||
    !publishedProfile ||
    !profilesEqual(draftProfile, publishedProfile)
  ) {
    return conflict();
  }
  return view(draftProfile, draftRows.length, generation);
};

const identityCreates = (row: PolicyRuleRow) =>
  row.identities.map((identity) => {
    if (identity.agentId) {
      return { agent: { connect: { id: identity.agentId } } };
    }
    if (identity.userId) {
      return { user: { connect: { id: identity.userId } } };
    }
    if (identity.groupId) {
      return { group: { connect: { id: identity.groupId } } };
    }
    throw new Error("policy identity row names no principal");
  });

const targetCreates = (row: PolicyRuleRow) =>
  row.targets.map((target) => ({
    kind: target.kind,
    appProvider: target.appProvider,
    appTools: target.appTools,
    appConnectionScope: target.appConnectionScope,
    secretScope: target.secretScope,
    hostPattern: target.hostPattern,
    pathPattern: target.pathPattern,
    method: target.method,
    ...(target.appConnectionId
      ? {
          appConnection: { connect: { id: target.appConnectionId } },
        }
      : {}),
    ...(target.secretId
      ? { secret: { connect: { id: target.secretId } } }
      : {}),
  }));

const jsonInput = (
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull =>
  value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

const createStoredRule = async (
  tx: Tx,
  scopeBase: PolicyScopeBase,
  status: "draft" | "published",
  generation: number,
  priority: number,
  rule: PolicyRuleRow,
  userId: string | null,
) =>
  tx.policyRuleV2.create({
    data: {
      ...scopeBase,
      status,
      generation,
      priority,
      isDefault: rule.isDefault,
      source: rule.source,
      logicalId: rule.logicalId,
      enabled: rule.enabled,
      name: rule.name,
      description: rule.description,
      action: rule.action,
      rateLimit: rule.rateLimit,
      rateLimitWindow: rule.rateLimitWindow,
      requireApproval: rule.requireApproval,
      conditions: jsonInput(rule.conditions),
      createdByUserId: userId,
      identities: { create: identityCreates(rule) },
      targets: { create: targetCreates(rule) },
    },
    include: RULE_INCLUDE,
  });

const createCompiledRule = async (
  tx: Tx,
  scopeBase: PolicyScopeBase,
  status: "draft" | "published",
  generation: number,
  priority: number,
  rule: CompiledWebAccessRule,
  agentId: string,
  userId: string | null,
) =>
  tx.policyRuleV2.create({
    data: {
      ...scopeBase,
      status,
      generation,
      priority,
      isDefault: false,
      source: WEB_ACCESS_SOURCE,
      logicalId: rule.logicalId,
      enabled: true,
      name: rule.name,
      description: rule.description,
      action: rule.action,
      rateLimit: rule.rateLimit,
      rateLimitWindow: rule.rateLimitWindow,
      requireApproval: rule.requireApproval,
      conditions: Prisma.JsonNull,
      createdByUserId: userId,
      identities: { create: [{ agent: { connect: { id: agentId } } }] },
      targets: {
        create: rule.targets.map((item) => ({
          kind: "web",
          hostPattern: item.hostPattern,
          pathPattern: null,
          method: item.method,
        })),
      },
    },
    include: RULE_INCLUDE,
  });

type SequenceEntry =
  | { kind: "stored"; rule: PolicyRuleRow }
  | { kind: "compiled"; rule: CompiledWebAccessRule };

const replaceAtAnchor = (
  rows: PolicyRuleRow[],
  agentId: string,
  desired: CompiledWebAccessRule[],
): SequenceEntry[] => {
  const nonDefaults = rows.filter((row) => !row.isDefault);
  const first = nonDefaults.findIndex((row) =>
    isAgentProfileRule(row, agentId),
  );
  const anchor = first === -1 ? nonDefaults.length : first;
  const retained = nonDefaults.filter(
    (row) => !isAgentProfileRule(row, agentId),
  );
  return [
    ...retained
      .slice(0, anchor)
      .map((rule) => ({ kind: "stored" as const, rule })),
    ...desired.map((rule) => ({ kind: "compiled" as const, rule })),
    ...retained
      .slice(anchor)
      .map((rule) => ({ kind: "stored" as const, rule })),
  ];
};

const replaceDraft = async (
  tx: Tx,
  scopeBase: PolicyScopeBase,
  rows: PolicyRuleRow[],
  agentId: string,
  desired: CompiledWebAccessRule[],
  userId: string,
) => {
  const doomed = profileRows(rows, agentId).map((row) => row.id);
  if (doomed.length > 0) {
    await tx.policyRuleV2.deleteMany({ where: { id: { in: doomed } } });
  }
  const sequence = replaceAtAnchor(rows, agentId, desired);
  for (const [index, entry] of sequence.entries()) {
    const priority = index + 1;
    if (entry.kind === "stored") {
      if (entry.rule.priority !== priority) {
        await tx.policyRuleV2.update({
          where: { id: entry.rule.id },
          data: { priority },
        });
      }
    } else {
      await createCompiledRule(
        tx,
        scopeBase,
        "draft",
        0,
        priority,
        entry.rule,
        agentId,
        userId,
      );
    }
  }
};

const snapshotLiveProfile = async (
  tx: Tx,
  scopeBase: PolicyScopeBase,
  rows: PolicyRuleRow[],
  draftDefault: PolicyRuleRow,
  currentGeneration: number | null,
  agentId: string,
  desired: CompiledWebAccessRule[],
  userId: string,
): Promise<number> => {
  const generation = (currentGeneration ?? 0) + 1;
  const sequence = replaceAtAnchor(rows, agentId, desired);
  for (const [index, entry] of sequence.entries()) {
    if (entry.kind === "stored") {
      await createStoredRule(
        tx,
        scopeBase,
        "published",
        generation,
        index + 1,
        entry.rule,
        userId,
      );
    } else {
      await createCompiledRule(
        tx,
        scopeBase,
        "published",
        generation,
        index + 1,
        entry.rule,
        agentId,
        userId,
      );
    }
  }
  const currentDefault = rows.find((row) => row.isDefault) ?? draftDefault;
  await createStoredRule(
    tx,
    scopeBase,
    "published",
    generation,
    0,
    currentDefault,
    userId,
  );
  if (generation > PUBLISHED_GENERATION_RETENTION) {
    await tx.policyRuleV2.deleteMany({
      where: {
        ...scopeBase,
        status: "published",
        generation: { lte: generation - PUBLISHED_GENERATION_RETENTION },
      },
    });
  }
  return generation;
};

export const setWebAccessProfile = async (
  scope: WebAccessScope,
  agentId: string,
  input: WebAccessProfileInput,
  userId: string,
): Promise<WebAccessMutationResult> => {
  const normalized = normalizeWebAccessProfile(input);
  const desired = compileWebAccessProfile(agentId, normalized);
  // Fence before entitlement checks so a foreign agent is always a 404. The
  // transaction repeats the check after taking the lock to close deletion races.
  await requireAgent(db, scope, agentId);
  const actions = [
    ...new Set(
      desired.flatMap((rule) =>
        gatedActions({
          rateLimit: rule.rateLimit,
          requireApproval: rule.requireApproval,
        }),
      ),
    ),
  ];
  if (actions.length > 0) {
    await getRuleActionGate().assertAllowed(scope, actions);
  }

  const scopeBase = base(scope);
  return db.$transaction(async (tx) => {
    await lockScope(tx, scopeBase);
    await requireAgent(tx, scope, agentId);
    let draft = await listRules(tx, scopeBase, "draft");
    const generation = await activeGeneration(tx, scopeBase);
    const published =
      generation === null
        ? []
        : await listRules(tx, scopeBase, "published", generation);
    const draftProfileRows = profileRows(draft, agentId);
    const publishedProfileRows = profileRows(published, agentId);
    const draftSame = webAccessStackEquals(draftProfileRows, desired, agentId);
    const liveSame =
      webAccessStackEquals(publishedProfileRows, desired, agentId) &&
      (desired.length === 0 || published.some((row) => row.isDefault));

    if (draftSame && liveSame) {
      return {
        profile: view(normalized, desired.length, generation),
        changed: false,
      };
    }

    const draftDefault = await ensureDefault(tx, scopeBase);
    if (!draft.some((row) => row.id === draftDefault.id)) {
      draft = [...draft, draftDefault];
    }
    if (!draftSame) {
      await replaceDraft(tx, scopeBase, draft, agentId, desired, userId);
    }
    const nextGeneration = liveSame
      ? generation
      : await snapshotLiveProfile(
          tx,
          scopeBase,
          published,
          draftDefault,
          generation,
          agentId,
          desired,
          userId,
        );
    return {
      profile: view(normalized, desired.length, nextGeneration),
      changed: true,
    };
  });
};
