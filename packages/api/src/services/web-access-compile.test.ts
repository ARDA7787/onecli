import { describe, expect, it } from "vitest";
import { evaluateNew } from "./policy-translation/evaluator";
import type { NewRule, PolicyRequest } from "./policy-translation/types";
import {
  compileWebAccessProfile,
  decodeWebAccessProfile,
  normalizeWebAccessProfile,
  webAccessStackEquals,
  type CompiledWebAccessRule,
  type StoredWebAccessRuleShape,
} from "./web-access-compile";

const AGENT = "agent-1";

const stored = (rules: CompiledWebAccessRule[]): StoredWebAccessRuleShape[] =>
  rules.map((rule) => ({
    ...rule,
    identities: [{ agentId: AGENT, userId: null, groupId: null }],
  }));

const evaluable = (rules: CompiledWebAccessRule[]): NewRule[] =>
  rules.map((rule, priority) => ({
    ...rule,
    scope: "workspace",
    priority,
    identities: [{ type: "agent", id: AGENT }],
  }));

const request = (overrides: Partial<PolicyRequest> = {}): PolicyRequest => ({
  host: "news.example.com",
  path: "/story",
  method: "GET",
  agentId: AGENT,
  hasInjections: false,
  isLlmHost: false,
  ...overrides,
});

describe("web access profile compiler", () => {
  it("compiles Open to absence and keeps No Web distinct from Search Only", () => {
    expect(compileWebAccessProfile(AGENT, { mode: "open" })).toEqual([]);
    const noWeb = compileWebAccessProfile(AGENT, { mode: "no_web" });
    const search = compileWebAccessProfile(AGENT, { mode: "search_only" });
    expect(noWeb).toHaveLength(1);
    expect(noWeb[0]).toMatchObject({
      logicalId: `web-access:${AGENT}:no_web:terminal`,
      action: "block",
      requireApproval: false,
      targets: [{ hostPattern: null, method: null }],
    });
    expect(search[0]?.logicalId).toBe(
      `web-access:${AGENT}:search_only:terminal`,
    );
  });

  it("normalizes Research defaults and shares one rate-limited allow rule", () => {
    const profile = normalizeWebAccessProfile({
      mode: "research",
      allowedMethods: ["HEAD", "GET", "HEAD"],
      rateLimit: { requests: 50, window: "hour" },
    });
    expect(profile).toEqual({
      mode: "research",
      allowedMethods: ["GET", "HEAD"],
      writeBehavior: "ask",
      rateLimit: { requests: 50, window: "hour" },
    });
    const rules = compileWebAccessProfile(AGENT, profile);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      action: "allow",
      rateLimit: 50,
      rateLimitWindow: "hour",
      targets: [
        { hostPattern: null, method: "GET" },
        { hostPattern: null, method: "HEAD" },
      ],
    });
    expect(rules[1]).toMatchObject({
      action: "allow",
      requireApproval: true,
      targets: [{ hostPattern: null, method: null }],
    });
  });

  it("compiles Restricted in allow, write-fallback, unknown order", () => {
    const profile = normalizeWebAccessProfile({
      mode: "restricted",
      allowDomains: ["b.example.com", "a.example.com", "a.example.com"],
      allowedMethods: ["HEAD", "GET"],
      writeBehavior: "block",
      unknownDomains: "ask",
    });
    expect(profile).toMatchObject({
      allowDomains: ["a.example.com", "b.example.com"],
      allowedMethods: ["GET", "HEAD"],
    });
    const rules = compileWebAccessProfile(AGENT, profile);
    expect(rules.map((rule) => rule.logicalId.split(":").at(-1))).toEqual([
      "allowed",
      "writes",
      "unknown",
    ]);
    expect(rules[0]?.targets).toEqual([
      expect.objectContaining({ hostPattern: "a.example.com", method: "GET" }),
      expect.objectContaining({ hostPattern: "b.example.com", method: "GET" }),
      expect.objectContaining({ hostPattern: "a.example.com", method: "HEAD" }),
      expect.objectContaining({ hostPattern: "b.example.com", method: "HEAD" }),
    ]);
    expect(rules[1]).toMatchObject({ action: "block", requireApproval: false });
    expect(rules[2]).toMatchObject({ action: "allow", requireApproval: true });
  });

  it("round-trips every compiler-owned stack and refuses drift", () => {
    const profiles = [
      { mode: "open" as const },
      { mode: "no_web" as const },
      { mode: "search_only" as const },
      normalizeWebAccessProfile({ mode: "research" }),
      normalizeWebAccessProfile({
        mode: "restricted",
        allowDomains: ["example.com", "*.sec.gov"],
      }),
    ];
    for (const profile of profiles) {
      const compiled = compileWebAccessProfile(AGENT, profile);
      const rows = stored(compiled);
      for (const row of rows) row.targets.reverse();
      expect(webAccessStackEquals(rows, compiled, AGENT)).toBe(true);
      expect(decodeWebAccessProfile(AGENT, rows)).toEqual(profile);
    }

    const rules = stored(
      compileWebAccessProfile(
        AGENT,
        normalizeWebAccessProfile({ mode: "research" }),
      ),
    );
    rules[0]!.name = "hand edited";
    expect(decodeWebAccessProfile(AGENT, rules)).toBeNull();
  });

  it("governs public web without catching managed credentials or LLM traffic", () => {
    const noWeb = evaluable(compileWebAccessProfile(AGENT, { mode: "no_web" }));
    expect(evaluateNew(noWeb, request())).toEqual({ action: "block" });
    expect(evaluateNew(noWeb, request({ hasInjections: true }))).toEqual({
      action: "allow",
    });
    expect(evaluateNew(noWeb, request({ isLlmHost: true }))).toEqual({
      action: "allow",
    });

    const research = evaluable(
      compileWebAccessProfile(
        AGENT,
        normalizeWebAccessProfile({ mode: "research" }),
      ),
    );
    expect(evaluateNew(research, request({ method: "HEAD" }))).toEqual({
      action: "allow",
    });
    expect(evaluateNew(research, request({ method: "POST" }))).toEqual({
      action: "allow",
      requireApproval: true,
    });
  });
});
