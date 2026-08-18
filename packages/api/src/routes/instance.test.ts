import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The §3.13 auto-hide proof, route level (step 13): `GET /v1/instance` is the
 * ONE place the browser learns whether hosted agents exist here, so the
 * route's contract — unauthenticated, `runners` always present, exactly two
 * booleans, truthfully derived from the Runner table — IS the merge gate's
 * API half. The web half (the sidebar rendering each posture) lives in
 * apps/web/src/lib/dashboard/dashboard-sidebar.test.tsx.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  delete process.env.ENTERPRISE_ENABLED;
});

const store = vi.hoisted(() => ({ total: 0, online: 0 }));

vi.mock("@onecli/db", () => ({
  db: {
    runner: {
      // Two calls per availability read: bare count (registered), then the
      // lastSeenAt-windowed count (online).
      count: async (args?: { where?: unknown }) =>
        args?.where ? store.online : store.total,
    },
  },
}));

const { createApiApp } = await import("../app");
const { initEntitlementForTests } = await import("../lib/entitlements");
const { resetRunnerAvailabilityCache } =
  await import("../services/runner-service");

const app = createApiApp({ getSession: async () => null });

beforeEach(() => {
  store.total = 0;
  store.online = 0;
  // The 5s availability cache would otherwise leak one case into the next.
  resetRunnerAvailabilityCache();
});

describe("GET /v1/instance (the auto-hide fact)", () => {
  it("answers unauthenticated — posture, never data", async () => {
    const res = await app.request("/v1/instance");
    expect(res.status).toBe(200);
  });

  it("a deployment that never had a runner: registered:false, online:false", async () => {
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: unknown };
    expect(body.runners).toEqual({ registered: false, online: false });
  });

  it("a registered-but-stale runner reads offline, never absent", async () => {
    store.total = 1;
    store.online = 0;
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: unknown };
    expect(body.runners).toEqual({ registered: true, online: false });
  });

  it("a fresh heartbeat reads ready", async () => {
    store.total = 1;
    store.online = 1;
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: unknown };
    expect(body.runners).toEqual({ registered: true, online: true });
  });

  it("entitled flips with the license flag — the ONE fact the browser gates on", async () => {
    initEntitlementForTests(false);
    const off = (await (await app.request("/v1/instance")).json()) as {
      entitled: boolean;
    };
    expect(off.entitled).toBe(false);

    initEntitlementForTests(true);
    const on = (await (await app.request("/v1/instance")).json()) as {
      entitled: boolean;
    };
    expect(on.entitled).toBe(true);

    initEntitlementForTests(null);
  });

  it("carries exactly the posture surface: edition, entitlement, version, two runner booleans", async () => {
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "edition",
      "entitled",
      "runners",
      "version",
    ]);
    // Two booleans, no runner identity, no counts — the posture-not-data rule.
    expect(Object.keys(body.runners as object).sort()).toEqual([
      "online",
      "registered",
    ]);
    expect(body.edition).toBe("onprem");
    expect(typeof body.entitled).toBe("boolean");
  });
});
