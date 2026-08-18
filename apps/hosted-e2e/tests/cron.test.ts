import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fetchTranscript, transcriptText, waitFor } from "../src/v1.js";

/**
 * The schedule leg (step 7 through step 13's lens): a cron created over REST
 * force-fires through the REAL poll path (`POST /:cronId/run` only pulls
 * `nextFireAt` to now — the runner's next poll does the firing), runs in its
 * own cron-sourced conversation, and delivers the report to the creator's
 * direct thread.
 */

scenario(
  "a cron fires through the poll and reports to the origin thread",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    // The origin: the creator's direct thread (the cron door resolves it).
    const direct = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    const cron = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/agents/${cx.ids.agent}/crons`, {
        name: "nightly probe",
        prompt: "report the weather in the sandbox",
        schedule: "0 3 * * *",
        timezone: "UTC",
      }),
    );

    const fired = await stack.v1.post(
      `/v1/agents/${cx.ids.agent}/crons/${cron.id}/run`,
    );
    expect(fired.ok).toBe(true);

    // The run lands in its OWN cron-sourced conversation…
    const cronConversation = await waitFor(
      () =>
        cx.prisma.conversation.findFirst({
          where: { agentId: cx.ids.agent, source: "cron" },
        }),
      (conversation) => conversation !== null,
      "the cron-sourced conversation",
    );
    await waitFor(
      () =>
        cx.prisma.turn.findFirst({
          where: { conversationId: cronConversation?.id ?? "", status: "done" },
        }),
      (turn) => turn !== null,
      "the cron run to complete",
    );

    // …and the report is DELIVERED to the origin thread.
    await waitFor(
      async () => transcriptText(await fetchTranscript(stack.v1, direct.id)),
      (text) => text.includes("report the weather"),
      "the cron report to reach the direct thread",
    );

    await stack.runner.pausePump();
  },
);
