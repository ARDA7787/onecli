import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AdapterPresence } from "@onecli/agent-protocol";
import type { ControlPlaneClient } from "./control-plane";
import {
  ApprovalsAuthError,
  approvalCardBlocks,
  createApprovalsManager,
  fetchPendingApprovals,
  type PendingApproval,
} from "./approvals";
import {
  createFakeControlPlane,
  settle,
  startFakeGatewayServer,
  startFakeSlackServer,
  waitReal,
  type FakeGatewayServer,
  type FakeSlackServer,
} from "./test/fakes";

/**
 * The approvals surface against a fake gateway (a real node:http server that
 * HOLDS requests once its script runs out — the long-poll, which is also
 * what paces the loop in tests) plus a fake control plane and Slack server.
 *
 * Where a test needs the loop's own sleeps (the 60s auth backoff, the 5s
 * expiry sweep) it fakes ONLY the timer families and advances them by hand;
 * setImmediate stays real so HTTP keeps flowing and `waitReal` keeps working.
 */

const TIMER_FAMILIES = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

let gateway: FakeGatewayServer;
let slack: FakeSlackServer;
let managers: ReturnType<typeof createApprovalsManager>[];

beforeEach(async () => {
  gateway = await startFakeGatewayServer();
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) manager.stop();
  vi.useRealTimers();
  delete process.env.SLACK_API_BASE_URL;
  await gateway.close();
  await slack.close();
});

const presence = (
  overrides: Partial<AdapterPresence> = {},
): AdapterPresence => ({
  presenceId: "p1",
  provider: "slack",
  transport: "socket",
  status: "active",
  externalId: "B123",
  identityRef: null,
  agent: { id: "ag1", name: "Deploy Agent", workspaceId: "proj1" },
  tenant: { externalId: "T1", name: "Acme" },
  credentialsJson: JSON.stringify({ botToken: "xoxb-bot" }),
  approvalsKey: "svc-key-1",
  links: [
    {
      id: "l1",
      conversationId: "cv1",
      externalThreadId: "D100",
      kind: "direct",
      externalUserId: "U1",
      mirrorCursor: null,
    },
  ],
  ...overrides,
});

const pendingBody = (id: string, expiresAt?: string): unknown => ({
  requests: [
    {
      id,
      method: "POST",
      host: "api.example.com",
      path: "/v1/emails",
      summary: {
        action: "Send an email",
        details: [{ label: "To", value: "a@example.com" }],
      },
      agent: { id: "ag1", name: "Deploy Agent" },
      ...(expiresAt && { expiresAt }),
    },
  ],
});

const makeManager = (controlPlane: ControlPlaneClient) => {
  const manager = createApprovalsManager({
    controlPlane,
    gatewayUrl: gateway.url,
    approvalsPollSeconds: 1,
    onLog: () => {},
  });
  managers.push(manager);
  return manager;
};

describe("fetchPendingApprovals", () => {
  it("presents the presence's service key and the exclude list", async () => {
    gateway.script.push({ status: 200, body: pendingBody("app-1") });

    const pending = await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: ["a", "b c"],
      timeoutMs: 5_000,
    });

    expect(pending.map((request) => request.id)).toEqual(["app-1"]);
    expect(gateway.calls[0]).toEqual({
      path: "/v1/approvals/pending",
      token: "svc-key-1",
      exclude: ["a", "b c"],
    });
  });

  it("sends no exclude param when nothing is tracked", async () => {
    gateway.script.push({ status: 200, body: { requests: [] } });

    await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: [],
      timeoutMs: 5_000,
    });

    expect(gateway.calls[0]?.exclude).toEqual([]);
  });

  it.each([401, 403])(
    "turns a %d into an ApprovalsAuthError",
    async (status) => {
      gateway.script.push({ status, body: { error: "nope" } });

      await expect(
        fetchPendingApprovals({
          gatewayUrl: gateway.url,
          serviceKey: "svc-key-1",
          excludeIds: [],
          timeoutMs: 5_000,
        }),
      ).rejects.toBeInstanceOf(ApprovalsAuthError);
    },
  );

  it("keeps a 5xx an ordinary (retryable) error, NOT an auth error", async () => {
    // The distinction is load-bearing: auth errors back off for a minute and
    // flag the presence; transport blips retry in seconds and stay quiet.
    gateway.script.push({ status: 500, body: {} });

    const error: unknown = await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: [],
      timeoutMs: 5_000,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApprovalsAuthError);
  });
});

describe("the approval card", () => {
  const approval: PendingApproval = {
    id: "app-7",
    method: "POST",
    host: "api.example.com",
    path: "/v1/emails",
    summary: {
      action: "<!here> Send email",
      details: [{ label: "To<", value: "x&y" }],
    },
    agent: { id: "ag1", name: "Bot <b>" },
    expiresAt: undefined,
  };

  it("escapes every dynamic field — cards must not ping the workspace either", () => {
    const rendered = JSON.stringify(approvalCardBlocks(approval));
    expect(rendered).not.toContain("<!here>");
    expect(rendered).toContain("&lt;!here&gt; Send email");
    expect(rendered).toContain("Bot &lt;b&gt;");
    expect(rendered).toContain("To&lt;");
    expect(rendered).toContain("x&amp;y");
  });

  it("falls back to method/host/path when the gateway sent no summary", () => {
    const rendered = JSON.stringify(
      approvalCardBlocks({ ...approval, summary: null }),
    );
    expect(rendered).toContain("POST api.example.com/v1/emails");
  });

  it("says undecided-means-denied when there is no expiry", () => {
    const rendered = JSON.stringify(approvalCardBlocks(approval));
    expect(rendered).toContain("Undecided means denied.");
  });

  it("clamps an oversized detail value (and the title) at ~200 chars with a trailing ellipsis", () => {
    // The gateway's summary fields are unbounded; a Slack section block caps
    // at 3,000 chars. clampDetail keeps each dynamic field ≤200+ellipsis so
    // 8 details plus the title always fit — delete the clamp and the raw
    // 300-char value lands whole in the card (and a long enough one kills
    // the entire post with invalid_blocks, silencing the approval).
    const rendered = JSON.stringify(
      approvalCardBlocks({
        ...approval,
        summary: {
          action: "t".repeat(300),
          details: [{ label: "Body", value: "v".repeat(300) }],
        },
      }),
    );
    expect(rendered).toContain(`${"v".repeat(200)}…`);
    expect(rendered).not.toContain("v".repeat(201));
    expect(rendered).toContain(`${"t".repeat(200)}…`);
    expect(rendered).not.toContain("t".repeat(201));
  });
});

describe("posting a card", () => {
  const cardBlocksSchema = z.array(z.looseObject({ type: z.string() }));
  const actionsSchema = z.looseObject({
    type: z.literal("actions"),
    elements: z.array(
      z.looseObject({ action_id: z.string(), value: z.string() }),
    ),
  });

  it("claims FIRST, posts the card with ONLY the opaque approval id in the buttons, and records the ref", async () => {
    // Two laws in one flow. Claim-before-post is the restart/twin dedupe.
    // And the buttons carry the approval id and NOTHING else — anything
    // richer would move server state into a client payload (Slack caps
    // `value` at 2000 chars, and the id is the whole authority a click may
    // carry; the control plane authorizes the clicker server-side).
    const order: string[] = [];
    const claims: unknown[] = [];
    const records: [string, string][] = [];
    slack.onCall = (call) => order.push(`slack:${call.method}`);
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        order.push("claim");
        claims.push(input);
        return true;
      },
      recordPromptMessage: async (approvalId, ref) => {
        records.push([approvalId, ref]);
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });

    makeManager(controlPlane).reconcile([presence()]);
    // The loop re-polling (and being held) proves the whole postCard ran.
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(order).toEqual(["claim", "slack:chat.postMessage"]);
    // The claim now carries the gateway deadline (null here — this pending body
    // has no expiry) so a restart can re-arm against the REAL deadline.
    expect(claims).toEqual([
      {
        approvalId: "app-42",
        presenceId: "p1",
        externalThreadId: "D100",
        expiresAt: null,
      },
    ]);

    const card = slack.callsTo("chat.postMessage")[0]!;
    expect(card.token).toBe("xoxb-bot");
    expect(card.form.channel).toBe("D100");
    // No avatar on this presence — no icon_url key on the card either.
    expect("icon_url" in card.form).toBe(false);
    const blocks = cardBlocksSchema.parse(JSON.parse(card.form.blocks!));
    const actions = actionsSchema.parse(
      blocks.find((block) => block.type === "actions"),
    );
    expect(actions.elements.map((el) => el.action_id)).toEqual([
      "channel_approve",
      "channel_deny",
    ]);
    expect(actions.elements.map((el) => el.value)).toEqual([
      "app-42",
      "app-42",
    ]);

    expect(records).toEqual([
      [
        "app-42",
        `${String(card.response.channel)}:${String(card.response.ts)}`,
      ],
    ]);
    // The tracked prompt is excluded from the next long-poll.
    expect(gateway.calls[1]?.exclude).toEqual(["app-42"]);
  });

  it("carries the agent's avatar as icon_url on the card when the feed serves one", async () => {
    const controlPlane = createFakeControlPlane({
      claimPrompt: async () => true,
      recordPromptMessage: async () => {},
    });
    gateway.script.push({ status: 200, body: pendingBody("app-43") });

    makeManager(controlPlane).reconcile([
      presence({
        agent: {
          id: "ag1",
          name: "Deploy Agent",
          workspaceId: "proj1",
          imageUrl: "https://api.example.com/v1/agent-images/ag1/abc",
        },
      }),
    ]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(slack.callsTo("chat.postMessage")[0]!.form.icon_url).toBe(
      "https://api.example.com/v1/agent-images/ag1/abc",
    );
  });

  it("posts NO card when the claim is lost", async () => {
    // MUTATION-PROOF: the claim is the restart/twin dedupe — delete the
    // `if (!claimed) return` in postCard and a restarted adapter (or a
    // deploy-overlap twin) posts a second card for the same approval.
    const claims: unknown[] = [];
    const records: unknown[] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input);
        return false;
      },
      recordPromptMessage: async (approvalId, ref) => {
        records.push([approvalId, ref]);
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(claims).toHaveLength(1);
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe("gateway auth health", () => {
  it("reports unhealthy ONCE across repeated 401 polls, and healthy again on recovery", async () => {
    // Flap suppression: the report fires on the TRANSITION, not per poll.
    // MUTATION-PROOF: remove the `healthy` latch and the middle section
    // sees a second ["p1", false] report for the second 401.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES] });
    const reports: [string, boolean][] = [];
    const controlPlane = createFakeControlPlane({
      reportApprovalHealth: async (presenceId, healthy) => {
        reports.push([presenceId, healthy]);
      },
    });
    gateway.script.push(
      { status: 401, body: {} },
      { status: 401, body: {} },
      { status: 200, body: { requests: [] } },
    );

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => reports.length === 1, "first unhealthy report");
    expect(reports).toEqual([["p1", false]]);

    // Wait for the loop to park on its 60s backoff (expiry interval + sleep
    // = two fake timers), then release it into the second 401.
    await waitReal(() => vi.getTimerCount() >= 2, "parked on the backoff");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => gateway.calls.length >= 2, "second poll");
    await settle();
    expect(reports).toEqual([["p1", false]]);

    // The healthy poll flips it back — exactly once.
    await waitReal(() => vi.getTimerCount() >= 2, "parked again");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => reports.length === 2, "healthy report");
    expect(reports[1]).toEqual(["p1", true]);
  });
});

describe("expiry", () => {
  it("settles an expired prompt and rewrites the card as timed out", async () => {
    // REAL timers throughout: the sweep is driven directly via the manager's
    // own `sweepExpired` handle. The old version faked the clock and advanced
    // into the 5s interval — but faking global timers around live HTTP hangs
    // undici on CI's Node (the card post to the fake Slack server never
    // completed), which is exactly the flake this replaced. The interval's
    // wiring is pinned by the health test's fake-timer count.
    const settles: [string, string][] = [];
    const recorded: string[] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      recordPromptMessage: async (approvalId) => {
        recorded.push(approvalId);
      },
    });
    const past = new Date(Date.now() - 1_000).toISOString();
    gateway.script.push({ status: 200, body: pendingBody("app-9", past) });

    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    // Wait for the RECORD step — the point where the prompt is fully tracked
    // (waiting on the server-side post count races the response leg).
    await waitReal(() => recorded.length === 1, "card posted and recorded");
    const card = slack.callsTo("chat.postMessage")[0]!;

    await manager.sweepExpired();
    expect(settles).toEqual([["app-9", "expired"]]);

    await waitReal(
      () => slack.callsTo("chat.update").length === 1,
      "card rewritten",
    );
    const update = slack.callsTo("chat.update")[0]!;
    expect(update.form.ts).toBe(card.response.ts);
    expect(update.form.text).toBe("⏱️ Timed out. The request was denied.");
  });
});

describe("settleDecided", () => {
  it("rewrites the tracked card with the decision text, once", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "card posted");
    const card = slack.callsTo("chat.postMessage")[0]!;

    await manager.settleDecided("app-42", "✅ Approved by Ada");

    const updates = slack.callsTo("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.ts).toBe(card.response.ts);
    expect(updates[0]?.form.text).toBe("✅ Approved by Ada");

    // The ledger entry is consumed — a second settle touches nothing.
    await manager.settleDecided("app-42", "again?");
    expect(slack.callsTo("chat.update")).toHaveLength(1);
  });
});

describe("boot recovery", () => {
  it("re-arms unsettled prompts so THIS instance can update cards it never posted", async () => {
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () => [
        {
          approvalId: "app-9",
          agentChannelId: "p1",
          externalThreadId: "D100",
          externalMessageRef: "C9:123.456",
          // A future deadline keeps this test purely about exclude + routing;
          // the real-deadline sweep is exercised in "boot recovery re-arms".
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const manager = makeManager(controlPlane);

    await manager.recoverUnsettled();
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 1, "loop started");

    // The recovered prompt is excluded from the very first long-poll…
    expect(gateway.calls[0]?.exclude).toEqual(["app-9"]);

    // …and a decision routes the update to the RECORDED message ref.
    await manager.settleDecided("app-9", "⛔ Denied by Ada");
    const updates = slack.callsTo("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.channel).toBe("C9");
    expect(updates[0]?.form.ts).toBe("123.456");
  });
});

describe("reconcile", () => {
  it("stops the poll loop for a removed presence", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({ status: 200, body: { requests: [] } });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "second poll held");

    manager.reconcile([]); // the presence was detached
    gateway.releaseHeld(200, { requests: [] });
    await settle();

    // The released poll ran its course but no third poll followed.
    expect(gateway.calls).toHaveLength(2);
  });
});

describe("claim carries the real gateway deadline", () => {
  it("passes the approval's expiresAt through to the claim when one is present", async () => {
    // The claim persists the deadline so a restart re-arms the card against the
    // REAL gateway timeout, not a guess (see the boot-recovery test below).
    const claims: { expiresAt: string | null }[] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input);
        return true;
      },
    });
    const future = new Date(Date.now() + 120_000).toISOString();
    gateway.script.push({ status: 200, body: pendingBody("app-e", future) });

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => claims.length === 1, "prompt claimed");

    expect(claims[0]?.expiresAt).toBe(future);
  });
});

describe("stale-links (the running loop reads the LIVE presence view)", () => {
  it("posts NO card while the presence has no link home, then posts once a DM link appears (finding D)", async () => {
    // The approval arrives before the agent's first DM, so the presence has no
    // link yet. The SAME running loop reads the live presenceById map, so when
    // a later reconcile brings a direct link the next poll finds the home and
    // posts. MUTATION-PROOF: revert runLoop/postCard to a snapshot captured at
    // loop start and the card never posts until the process restarts — the
    // second half of this test (the card appearing) then fails.
    const controlPlane = createFakeControlPlane();
    const manager = makeManager(controlPlane);

    // A presence with a service key but NO links (no DM has happened yet).
    manager.reconcile([presence({ links: [] })]);
    await waitReal(() => gateway.calls.length >= 1, "first poll held");
    gateway.releaseHeld(200, pendingBody("app-1"));
    await waitReal(
      () => gateway.calls.length >= 2,
      "loop re-armed after no-home",
    );

    // No home for the card → nothing claimed, nothing posted.
    expect(slack.callsTo("chat.postMessage")).toEqual([]);

    // A later config feed brings the DM link; the SAME loop now has a home.
    manager.reconcile([presence()]);
    gateway.releaseHeld(200, pendingBody("app-1"));
    await waitReal(
      () => slack.callsTo("chat.postMessage").length === 1,
      "card posted once the link exists",
    );
    expect(slack.callsTo("chat.postMessage")[0]?.form.channel).toBe("D100");
  });
});

describe("boot recovery re-arms against the ledger's real deadline (finding E)", () => {
  const unsettled = (expiresAt: string | null) => [
    {
      approvalId: "app-r",
      agentChannelId: "p1",
      externalThreadId: "D100",
      externalMessageRef: "C9:1.1",
      expiresAt,
      createdAt: new Date().toISOString(),
    },
  ];

  it("does NOT expire a recovered prompt whose deadline is still in the future", async () => {
    // MUTATION-PROOF: the old re-arm used `Date.now() + 5_000`, so the very
    // first 5s sweep would settle a still-live approval as timed out. With the
    // real (future) deadline threaded through, six sweep cycles touch nothing.
    //
    // Date is faked alongside the timers so advancing the sweep interval also
    // advances the clock settleExpired reads — otherwise the mutation's
    // `now + 5_000` would sit in the real future for the whole (sub-ms) test
    // and never trip, hiding the regression.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES, "Date"] });
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: async () =>
        unsettled(new Date(Date.now() + 120_000).toISOString()),
    });
    const manager = makeManager(controlPlane);

    await manager.recoverUnsettled();
    manager.reconcile([presence()]); // arms the 5s expiry sweep

    await vi.advanceTimersByTimeAsync(30_000); // six sweeps
    expect(settles).toEqual([]);
  });

  it("DOES expire a recovered prompt whose deadline is already past", async () => {
    // The other side of the same guard: a past ledger deadline settles on the
    // next sweep, so recovery re-arms correctly rather than never expiring.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES, "Date"] });
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: async () =>
        unsettled(new Date(Date.now() - 1_000).toISOString()),
    });
    const manager = makeManager(controlPlane);

    await manager.recoverUnsettled();
    manager.reconcile([presence()]);

    await vi.advanceTimersByTimeAsync(5_000); // one sweep
    await waitReal(() => settles.length === 1, "past deadline swept");
    expect(settles).toEqual([["app-r", "expired"]]);
  });
});

describe("health-report latch (finding H)", () => {
  it("retries the health report while it THROWS, then latches once it succeeds", async () => {
    // The `healthy` flag flips false only AFTER the report resolves. So a
    // report that throws leaves `healthy` true and the NEXT 401 retries it;
    // once a report succeeds the flag latches and further 401s are quiet.
    // MUTATION-PROOF: set `healthy = false` even when the report throws and the
    // second 401 is suppressed — reportApprovalHealth is never called again
    // (reportCalls stalls at 1 and the "poll 2 retried" wait times out).
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES] });
    let reportShouldThrow = true;
    let reportCalls = 0;
    const reports: [string, boolean][] = [];
    const controlPlane = createFakeControlPlane({
      reportApprovalHealth: async (presenceId, healthy) => {
        reportCalls += 1;
        if (reportShouldThrow) throw new Error("health door down");
        reports.push([presenceId, healthy]);
      },
    });
    gateway.script.push(
      { status: 401, body: {} }, // poll 1 → report throws, healthy STAYS true
      { status: 401, body: {} }, // poll 2 → report RETRIED (still throws)
      { status: 401, body: {} }, // poll 3 → report succeeds, healthy latches false
      { status: 401, body: {} }, // poll 4 → suppressed (already false)
    );

    makeManager(controlPlane).reconcile([presence()]);

    // Poll 1: the report was attempted but threw — nothing recorded.
    await waitReal(() => reportCalls >= 1, "poll 1 report attempted");
    await settle();
    expect(reportCalls).toBe(1);
    expect(reports).toEqual([]);

    // Poll 2: the throw left `healthy` true, so the report is RETRIED.
    await waitReal(() => vi.getTimerCount() >= 2, "parked on backoff 1");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => reportCalls >= 2, "poll 2 report RETRIED");
    await settle();
    expect(reports).toEqual([]); // still throwing, still nothing recorded

    // Poll 3: let the report succeed — healthy flips false, recorded once.
    reportShouldThrow = false;
    await waitReal(() => vi.getTimerCount() >= 2, "parked on backoff 2");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => reports.length === 1, "poll 3 report recorded");
    expect(reports).toEqual([["p1", false]]);
    expect(reportCalls).toBe(3);

    // Poll 4: healthy has latched false → NO further report.
    await waitReal(() => vi.getTimerCount() >= 2, "parked on backoff 3");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => gateway.calls.length >= 4, "poll 4 happened");
    await settle();
    expect(reportCalls).toBe(3);
    expect(reports).toEqual([["p1", false]]);
  });
});
