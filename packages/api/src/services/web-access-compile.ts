import type {
  RateLimitInput,
  WebAccessProfileInput,
  WebBehavior,
  WebMethod,
} from "../validations/web-access";
import { webAccessProfileSchema, webMethods } from "../validations/web-access";

export const WEB_ACCESS_SOURCE = "web_access";
export const WEB_ACCESS_DESCRIPTION =
  "Managed by the agent Web Access profile.";

const DEFAULT_METHODS: WebMethod[] = ["GET", "HEAD"];
const METHOD_ORDER = new Map(
  webMethods.map((method, index) => [method, index]),
);

export type NormalizedWebAccessProfile =
  | { mode: "open" }
  | { mode: "no_web" }
  | { mode: "search_only" }
  | {
      mode: "research";
      allowedMethods: WebMethod[];
      writeBehavior: WebBehavior;
      rateLimit?: RateLimitInput;
    }
  | {
      mode: "restricted";
      allowDomains: string[];
      allowedMethods: WebMethod[];
      writeBehavior: WebBehavior;
      unknownDomains: WebBehavior;
      rateLimit?: RateLimitInput;
    };

export interface CompiledWebTarget {
  kind: "web";
  hostPattern: string | null;
  pathPattern: null;
  method: WebMethod | null;
}

export interface CompiledWebAccessRule {
  logicalId: string;
  source: typeof WEB_ACCESS_SOURCE;
  name: string;
  description: typeof WEB_ACCESS_DESCRIPTION;
  enabled: true;
  isDefault: false;
  action: "allow" | "block";
  rateLimit: number | null;
  rateLimitWindow: RateLimitInput["window"] | null;
  requireApproval: boolean;
  conditions: null;
  targets: CompiledWebTarget[];
}

export interface StoredWebAccessRuleShape {
  logicalId: string;
  source: string;
  name: string;
  description: string | null;
  enabled: boolean;
  isDefault: boolean;
  action: string;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  requireApproval: boolean;
  conditions: unknown;
  identities: {
    agentId: string | null;
    userId: string | null;
    groupId: string | null;
  }[];
  targets: {
    kind: string;
    hostPattern: string | null;
    pathPattern: string | null;
    method: string | null;
  }[];
}

const canonicalMethods = (methods: readonly WebMethod[] | undefined) =>
  [...new Set(methods ?? DEFAULT_METHODS)].sort(
    (a, b) => (METHOD_ORDER.get(a) ?? 0) - (METHOD_ORDER.get(b) ?? 0),
  );

const canonicalDomains = (domains: readonly string[]) =>
  [
    ...new Set(
      domains.map((domain) => domain.trim().toLowerCase().replace(/\.$/, "")),
    ),
  ].sort();

export const normalizeWebAccessProfile = (
  input: WebAccessProfileInput,
): NormalizedWebAccessProfile => {
  switch (input.mode) {
    case "open":
    case "no_web":
    case "search_only":
      return { mode: input.mode };
    case "research":
      return {
        mode: "research",
        allowedMethods: canonicalMethods(input.allowedMethods),
        writeBehavior: input.writeBehavior ?? "ask",
        ...(input.rateLimit ? { rateLimit: input.rateLimit } : {}),
      };
    case "restricted":
      return {
        mode: "restricted",
        allowDomains: canonicalDomains(input.allowDomains),
        allowedMethods: canonicalMethods(input.allowedMethods),
        writeBehavior: input.writeBehavior ?? "ask",
        unknownDomains: input.unknownDomains ?? "block",
        ...(input.rateLimit ? { rateLimit: input.rateLimit } : {}),
      };
  }
};

const target = (
  hostPattern: string | null,
  method: WebMethod | null,
): CompiledWebTarget => ({
  kind: "web",
  hostPattern,
  pathPattern: null,
  method,
});

const behaviorRule = (
  base: Omit<CompiledWebAccessRule, "action" | "requireApproval">,
  behavior: WebBehavior,
): CompiledWebAccessRule => ({
  ...base,
  action: behavior === "block" ? "block" : "allow",
  requireApproval: behavior === "ask",
});

const baseRule = (
  agentId: string,
  mode: Exclude<NormalizedWebAccessProfile["mode"], "open">,
  slot: string,
  name: string,
  targets: CompiledWebTarget[],
): Omit<CompiledWebAccessRule, "action" | "requireApproval"> => ({
  logicalId: `web-access:${agentId}:${mode}:${slot}`,
  source: WEB_ACCESS_SOURCE,
  name,
  description: WEB_ACCESS_DESCRIPTION,
  enabled: true,
  isDefault: false,
  rateLimit: null,
  rateLimitWindow: null,
  conditions: null,
  targets,
});

export const compileWebAccessProfile = (
  agentId: string,
  profile: NormalizedWebAccessProfile,
): CompiledWebAccessRule[] => {
  switch (profile.mode) {
    case "open":
      return [];
    case "no_web":
    case "search_only":
      return [
        behaviorRule(
          baseRule(
            agentId,
            profile.mode,
            "terminal",
            profile.mode === "no_web"
              ? "[web-access] No web"
              : "[web-access] Search only",
            [target(null, null)],
          ),
          "block",
        ),
      ];
    case "research": {
      const allowed = baseRule(
        agentId,
        profile.mode,
        "allowed",
        "[web-access] Research reads",
        profile.allowedMethods.map((method) => target(null, method)),
      );
      return [
        {
          ...allowed,
          action: "allow",
          requireApproval: false,
          rateLimit: profile.rateLimit?.requests ?? null,
          rateLimitWindow: profile.rateLimit?.window ?? null,
        },
        behaviorRule(
          baseRule(
            agentId,
            profile.mode,
            "writes",
            "[web-access] Other research requests",
            [target(null, null)],
          ),
          profile.writeBehavior,
        ),
      ];
    }
    case "restricted": {
      const allowedTargets = profile.allowedMethods.flatMap((method) =>
        profile.allowDomains.map((domain) => target(domain, method)),
      );
      const allowed = baseRule(
        agentId,
        profile.mode,
        "allowed",
        "[web-access] Allowed domains",
        allowedTargets,
      );
      return [
        {
          ...allowed,
          action: "allow",
          requireApproval: false,
          rateLimit: profile.rateLimit?.requests ?? null,
          rateLimitWindow: profile.rateLimit?.window ?? null,
        },
        behaviorRule(
          baseRule(
            agentId,
            profile.mode,
            "writes",
            "[web-access] Other allowlisted requests",
            profile.allowDomains.map((domain) => target(domain, null)),
          ),
          profile.writeBehavior,
        ),
        behaviorRule(
          baseRule(
            agentId,
            profile.mode,
            "unknown",
            "[web-access] Unknown domains",
            [target(null, null)],
          ),
          profile.unknownDomains,
        ),
      ];
    }
  }
};

const behaviorOf = (rule: StoredWebAccessRuleShape): WebBehavior | null => {
  if (rule.action === "block" && !rule.requireApproval) return "block";
  if (rule.action === "allow" && rule.requireApproval) return "ask";
  return null;
};

const comparable = (rule: {
  logicalId: string;
  source: string;
  name: string;
  description: string | null;
  enabled: boolean;
  isDefault: boolean;
  action: string;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  requireApproval: boolean;
  conditions: unknown;
  targets: {
    kind: string;
    hostPattern: string | null;
    pathPattern: string | null;
    method: string | null;
  }[];
}) => ({
  logicalId: rule.logicalId,
  source: rule.source,
  name: rule.name,
  description: rule.description,
  enabled: rule.enabled,
  isDefault: rule.isDefault,
  action: rule.action,
  rateLimit: rule.rateLimit,
  rateLimitWindow: rule.rateLimitWindow,
  requireApproval: rule.requireApproval,
  conditions: rule.conditions ?? null,
  targets: rule.targets
    .map((item) => ({
      kind: item.kind,
      hostPattern: item.hostPattern,
      pathPattern: item.pathPattern,
      method: item.method,
    }))
    .sort((a, b) =>
      `${a.kind}\0${a.hostPattern ?? ""}\0${a.method ?? ""}\0${a.pathPattern ?? ""}`.localeCompare(
        `${b.kind}\0${b.hostPattern ?? ""}\0${b.method ?? ""}\0${b.pathPattern ?? ""}`,
      ),
    ),
});

export const webAccessStackEquals = (
  existing: StoredWebAccessRuleShape[],
  desired: CompiledWebAccessRule[],
  agentId: string,
): boolean =>
  existing.length === desired.length &&
  existing.every((rule, index) => {
    const identity = rule.identities[0];
    return (
      rule.identities.length === 1 &&
      identity?.agentId === agentId &&
      identity.userId === null &&
      identity.groupId === null &&
      JSON.stringify(comparable(rule)) ===
        JSON.stringify(comparable(desired[index] as CompiledWebAccessRule))
    );
  });

export const decodeWebAccessProfile = (
  agentId: string,
  rows: StoredWebAccessRuleShape[],
): NormalizedWebAccessProfile | null => {
  if (rows.length === 0) return { mode: "open" };
  const prefix = `web-access:${agentId}:`;
  const suffix = rows[0]?.logicalId.startsWith(prefix)
    ? rows[0].logicalId.slice(prefix.length)
    : "";
  const mode = suffix.split(":")[0];
  let profile: NormalizedWebAccessProfile | null = null;

  if (mode === "no_web" || mode === "search_only") {
    profile = { mode };
  } else if (mode === "research") {
    const allowed = rows[0];
    const writes = rows[1];
    const writeBehavior = writes ? behaviorOf(writes) : null;
    const methods = allowed?.targets.map((item) => item.method) ?? [];
    if (
      allowed &&
      writeBehavior &&
      methods.every((method): method is WebMethod =>
        webMethods.includes(method as WebMethod),
      )
    ) {
      profile = {
        mode,
        allowedMethods: canonicalMethods(methods),
        writeBehavior,
        ...(allowed.rateLimit != null && allowed.rateLimitWindow
          ? {
              rateLimit: {
                requests: allowed.rateLimit,
                window: allowed.rateLimitWindow as RateLimitInput["window"],
              },
            }
          : {}),
      };
    }
  } else if (mode === "restricted") {
    const allowed = rows[0];
    const writes = rows[1];
    const unknown = rows[2];
    const writeBehavior = writes ? behaviorOf(writes) : null;
    const unknownDomains = unknown ? behaviorOf(unknown) : null;
    const domains = writes?.targets.map((item) => item.hostPattern) ?? [];
    const methods = allowed?.targets.map((item) => item.method) ?? [];
    if (
      allowed &&
      writeBehavior &&
      unknownDomains &&
      domains.every((domain): domain is string => domain !== null) &&
      methods.every((method): method is WebMethod =>
        webMethods.includes(method as WebMethod),
      )
    ) {
      profile = {
        mode,
        allowDomains: [...new Set(domains)].sort(),
        allowedMethods: canonicalMethods(methods),
        writeBehavior,
        unknownDomains,
        ...(allowed.rateLimit != null && allowed.rateLimitWindow
          ? {
              rateLimit: {
                requests: allowed.rateLimit,
                window: allowed.rateLimitWindow as RateLimitInput["window"],
              },
            }
          : {}),
      };
    }
  }

  if (!profile) return null;
  const parsed = webAccessProfileSchema.safeParse(profile);
  if (!parsed.success) return null;
  const normalized = normalizeWebAccessProfile(parsed.data);
  return webAccessStackEquals(
    rows,
    compileWebAccessProfile(agentId, normalized),
    agentId,
  )
    ? normalized
    : null;
};
