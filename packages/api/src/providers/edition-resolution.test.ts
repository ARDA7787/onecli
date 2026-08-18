import { afterEach, describe, expect, it, vi } from "vitest";

// End-to-end proof of the entitlement choke points, on the REAL seams (not the
// slot factory, which has its own unit tests): one call site —
// `getRuleActionGate()` / `getSessionEnforcer()` — resolves to the PLAN-based
// cloud implementation after `ensureEditionDefaults()`, to the permissive
// onprem default with zero setup, and fails loudly on cloud when the boot
// wiring was skipped. This resolution is exactly what the entitlement-flag PR
// slots into: the onprem arm swaps from "allow all" to "ask the feature
// flags", and no feature call site changes.

const ORIGINAL_EDITION = process.env.EDITION;
const ORIGINAL_PUBLIC_EDITION = process.env.NEXT_PUBLIC_EDITION;

const loadAs = async (edition: "cloud" | "onprem") => {
  vi.resetModules();
  process.env.EDITION = edition === "cloud" ? "cloud" : "";
  process.env.NEXT_PUBLIC_EDITION = process.env.EDITION;
  // Same module generation for all three, so identity comparisons are valid.
  const providers = await import("./index");
  const defaults = await import("../edition-defaults");
  const eeGate = await import("../ee/hooks/rule-action-gate");
  const eeSso = await import("../ee/sso/sso-enforcement");
  return { providers, defaults, eeGate, eeSso };
};

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.EDITION;
  else process.env.EDITION = ORIGINAL_EDITION;
  if (ORIGINAL_PUBLIC_EDITION === undefined)
    delete process.env.NEXT_PUBLIC_EDITION;
  else process.env.NEXT_PUBLIC_EDITION = ORIGINAL_PUBLIC_EDITION;
  vi.resetModules();
});

describe("edition resolution at the real seams", () => {
  it("onprem: permissive defaults with zero setup — the gate allows, SSO never enforces", async () => {
    const { providers } = await loadAs("onprem");
    // No init, no ensureEditionDefaults — the self-hosted process shape.
    await expect(
      providers
        .getRuleActionGate()
        .assertAllowed({ organizationId: "org-1" }, ["manual_approval"]),
    ).resolves.toBeUndefined();
    expect(providers.getSessionEnforcer()).toBeNull();
    // No checker either: the flat team's shared predicates short-circuit on
    // !CAPS.rbac and never consult the slot.
    expect(providers.getWorkspaceAccessChecker()).toBeNull();
  });

  it("cloud: a read before ensureEditionDefaults() is a loud wiring error, never a silent onprem fallback", async () => {
    const { providers } = await loadAs("cloud");
    expect(() => providers.getRuleActionGate()).toThrow(
      /ruleActionGate.*ensureEditionDefaults/s,
    );
  });

  it("cloud: after ensureEditionDefaults(), call sites get the real plan-gated implementations", async () => {
    const { providers, defaults, eeGate, eeSso } = await loadAs("cloud");
    defaults.ensureEditionDefaults();
    expect(providers.getRuleActionGate()).toBe(eeGate.eeRuleActionGate);
    expect(providers.getSessionEnforcer()).toBe(eeSso.enforceSsoSession);
  });

  // The workspace-access checker's boot wiring, pinned in both arms: deleting
  // either `setDefaultWorkspaceAccessChecker`/`initWorkspaceAccessChecker`
  // line in edition-defaults.ts reproduces the silent-deny outage the seam's
  // comments memorialize (entitled owner bounced off every workspace) — so
  // the wiring itself must be under test, not just the seam's arms.
  it("cloud: the workspace-access checker resolves to the licensed implementation", async () => {
    const { providers, defaults } = await loadAs("cloud");
    const authz = await import("../ee/services/authorization-service");
    defaults.ensureEditionDefaults();
    expect(providers.getWorkspaceAccessChecker()).toBe(
      authz.eeWorkspaceAccessChecker,
    );
  });

  it("entitled self-host: the same licensed checker rides the override arm", async () => {
    const { providers, defaults } = await loadAs("onprem");
    const ent = await import("../lib/entitlements");
    const authz = await import("../ee/services/authorization-service");
    ent.initEntitlementForTests(true);
    defaults.ensureEditionDefaults();
    expect(providers.getWorkspaceAccessChecker()).toBe(
      authz.eeWorkspaceAccessChecker,
    );
    ent.initEntitlementForTests(null);
  });

  it("tests/hosts can still override, and null-reset returns to the edition default", async () => {
    const { providers, defaults, eeGate } = await loadAs("cloud");
    defaults.ensureEditionDefaults();
    const fake = { assertAllowed: vi.fn(async () => {}) };
    providers.initRuleActionGate(fake);
    expect(providers.getRuleActionGate()).toBe(fake);
    providers.initRuleActionGate(null);
    expect(providers.getRuleActionGate()).toBe(eeGate.eeRuleActionGate);
  });
});
