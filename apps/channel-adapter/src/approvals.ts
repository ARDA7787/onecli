import { z } from "zod";
import { escapeSlackText, type AdapterPresence } from "@onecli/agent-protocol";
import type { ControlPlaneClient } from "./control-plane";
import { postBlocks, updateBlocks } from "./slack/client";
import { replyTargetForLink } from "./targets";

/**
 * The approvals surface: per presence, long-poll the GATEWAY's pending list
 * with the presence's service key, post one Block Kit card per approval, and
 * settle the card on decision or expiry.
 *
 * Restart-safe by the control plane's `ChannelApprovalPrompt` ledger: a card
 * is CLAIMED (unique by approval id) before it is posted, so a restarted or
 * twin adapter never re-posts; the message ref is recorded so any instance
 * can update the card later; unsettled prompts are re-armed at boot.
 *
 * The card carries ONLY the opaque approval id in its button values (the
 * 2000-char cap and the injection rule both point the same way); everything
 * else stays server-side. Decisions are forwarded to the control plane,
 * which authorizes the CLICKER as a workspace member before the gateway is
 * asked anything — the fence is never Slack-side.
 */

const pendingResponse = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      method: z.string().optional(),
      host: z.string().optional(),
      path: z.string().optional(),
      summary: z
        .object({
          action: z.string().optional(),
          details: z
            .array(z.object({ label: z.string(), value: z.string() }))
            .optional(),
        })
        .nullish(),
      agent: z.object({ id: z.string(), name: z.string() }).partial().nullish(),
      expiresAt: z.string().optional(),
    }),
  ),
  timeoutSeconds: z.number().optional(),
});
export type PendingApproval = z.infer<
  typeof pendingResponse
>["requests"][number];

export class ApprovalsAuthError extends Error {}

/** One long-poll against the gateway (it holds ~30s when the list is empty). */
export const fetchPendingApprovals = async (input: {
  gatewayUrl: string;
  serviceKey: string;
  excludeIds: string[];
  timeoutMs: number;
}): Promise<PendingApproval[]> => {
  const exclude = input.excludeIds.length
    ? `?exclude=${encodeURIComponent(input.excludeIds.join(","))}`
    : "";
  const response = await fetch(
    `${input.gatewayUrl}/v1/approvals/pending${exclude}`,
    {
      headers: { authorization: `Bearer ${input.serviceKey}` },
      signal: AbortSignal.timeout(input.timeoutMs),
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new ApprovalsAuthError(`gateway refused: ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`gateway approvals answered ${response.status}`);
  }
  return pendingResponse.parse(await response.json()).requests;
};

/** Keep each gateway-supplied detail well inside the section block's 3,000-
 * char cap (8 details × ~200 + title leaves ample margin). */
const clampDetail = (value: string): string =>
  value.length <= 200 ? value : `${value.slice(0, 200)}…`;

/** The card. Template text is OURS; every dynamic field is escaped. */
export const approvalCardBlocks = (approval: PendingApproval): unknown[] => {
  const title = approval.summary?.action
    ? escapeSlackText(clampDetail(approval.summary.action))
    : `${escapeSlackText(approval.method ?? "?")} ${escapeSlackText(approval.host ?? "")}${escapeSlackText(clampDetail(approval.path ?? ""))}`;
  const details = (approval.summary?.details ?? [])
    .slice(0, 8)
    .map(
      (d) =>
        `*${escapeSlackText(clampDetail(d.label))}*: ${escapeSlackText(clampDetail(d.value))}`,
    )
    .join("\n");
  const expires = approval.expiresAt
    ? `Expires <!date^${Math.floor(new Date(approval.expiresAt).getTime() / 1000)}^{time_secs}|soon>. Undecided means denied.`
    : "Undecided means denied.";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:shield: *Approval needed${approval.agent?.name ? `: ${escapeSlackText(approval.agent.name)}` : ""}*\n${title}${details ? `\n${details}` : ""}`,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: expires }],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: "channel_approve",
          value: approval.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: "channel_deny",
          value: approval.id,
        },
      ],
    },
  ];
};

interface TrackedPrompt {
  approvalId: string;
  presenceId: string;
  channel: string;
  ts: string | null;
  expiresAt: number | null;
}

export interface ApprovalsManagerDeps {
  controlPlane: ControlPlaneClient;
  gatewayUrl: string;
  approvalsPollSeconds: number;
  onLog: (message: string, detail?: unknown) => void;
}

/**
 * The per-adapter approvals manager: one poll loop per presence that holds a
 * service key, plus the shared prompt ledger.
 */
export const createApprovalsManager = (deps: ApprovalsManagerDeps) => {
  const loops = new Map<string, { stop: () => void }>();
  const prompts = new Map<string, TrackedPrompt>();
  /** The live presence view, refreshed on every reconcile — the running loops
   * read it so new links and rotated keys take effect without a restart. */
  const presenceById = new Map<string, AdapterPresence>();
  let expiryTimer: ReturnType<typeof setInterval> | undefined;

  const settleExpired = async (): Promise<void> => {
    const now = Date.now();
    for (const prompt of [...prompts.values()]) {
      if (prompt.expiresAt === null || prompt.expiresAt > now) continue;
      prompts.delete(prompt.approvalId);
      try {
        await deps.controlPlane.settlePrompt(prompt.approvalId, "expired");
        if (prompt.ts) {
          await updateBlocksSafe(
            prompt,
            "⏱️ Timed out. The request was denied.",
          );
        }
      } catch (err) {
        deps.onLog("expiry settle failed", { err: String(err) });
      }
    }
  };

  const tokenFor = new Map<string, string>();

  const updateBlocksSafe = async (
    prompt: TrackedPrompt,
    text: string,
  ): Promise<void> => {
    const botToken = tokenFor.get(prompt.presenceId);
    if (!botToken || !prompt.ts) return;
    try {
      await updateBlocks(botToken, {
        channel: prompt.channel,
        ts: prompt.ts,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    } catch (err) {
      deps.onLog("card update failed", { err: String(err) });
    }
  };

  /** A decided approval (the interactivity path already updated the card via
   * response_url on the events arm; the socket arm calls this). */
  const settleDecided = async (
    approvalId: string,
    text: string,
  ): Promise<void> => {
    const prompt = prompts.get(approvalId);
    prompts.delete(approvalId);
    if (prompt) await updateBlocksSafe(prompt, text);
  };

  const postCard = async (
    presenceId: string,
    approval: PendingApproval,
  ): Promise<void> => {
    // Read the CURRENT presence, not a snapshot captured when the loop began —
    // a card that arrives before the agent's first DM must find its home once
    // the DM (and its link) shows up in a later config feed.
    const presence = presenceById.get(presenceId);
    const botToken = presence ? tokenFor.get(presenceId) : undefined;
    if (!presence || !botToken) return;

    // Where the card goes: the presence's direct thread when there is one,
    // else its first link. No home at all → leave it unclaimed; a later poll
    // retries once a DM exists.
    const link =
      presence.links.find((l) => l.kind === "direct") ?? presence.links[0];
    if (!link) return;
    const target = replyTargetForLink(link);

    const claimed = await deps.controlPlane.claimPrompt({
      approvalId: approval.id,
      presenceId,
      externalThreadId: link.externalThreadId,
      expiresAt: approval.expiresAt ?? null,
    });
    if (!claimed) return;

    const posted = await postBlocks(botToken, {
      channel: target.channel,
      text: "Approval needed",
      blocks: approvalCardBlocks(approval),
      ...(target.threadTs && { threadTs: target.threadTs }),
      ...(presence.agent.imageUrl && { iconUrl: presence.agent.imageUrl }),
    });
    await deps.controlPlane.recordPromptMessage(
      approval.id,
      `${posted.channel}:${posted.ts}`,
    );
    prompts.set(approval.id, {
      approvalId: approval.id,
      presenceId,
      channel: posted.channel,
      ts: posted.ts,
      expiresAt: approval.expiresAt
        ? new Date(approval.expiresAt).getTime()
        : null,
    });
  };

  const runLoop = (presenceId: string): void => {
    let stopped = false;
    let healthy = true;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        const presence = presenceById.get(presenceId);
        const serviceKey = presence?.approvalsKey;
        if (!serviceKey) {
          // Not (yet) usable — wait for a config feed that gives it a key.
          await sleep(5_000, () => stopped);
          continue;
        }
        try {
          const pending = await fetchPendingApprovals({
            gatewayUrl: deps.gatewayUrl,
            serviceKey,
            excludeIds: [...prompts.keys()],
            timeoutMs: (deps.approvalsPollSeconds + 10) * 1000,
          });
          if (!healthy) {
            // Flip the flag only AFTER the report lands, so a failed report
            // doesn't leave the dashboard stuck on "needs attention".
            await deps.controlPlane.reportApprovalHealth(presenceId, true);
            healthy = true;
          }
          for (const approval of pending) {
            if (prompts.has(approval.id)) continue;
            await postCard(presenceId, approval);
          }
        } catch (err) {
          if (err instanceof ApprovalsAuthError) {
            if (healthy) {
              try {
                await deps.controlPlane.reportApprovalHealth(presenceId, false);
                healthy = false;
              } catch {
                // Couldn't report — stay "healthy" so the next 401 retries the
                // report rather than silently never flagging it.
              }
              deps.onLog("approvals key refused; presence flagged", {
                presenceId,
              });
            }
            // Back off hard on a refusal — nothing changes until re-attach.
            await sleep(60_000, () => stopped);
            continue;
          }
          deps.onLog("approvals poll failed", { err: String(err) });
          await sleep(5_000, () => stopped);
        }
      }
    };
    void loop();
    loops.set(presenceId, {
      stop: () => {
        stopped = true;
      },
    });
  };

  return {
    /**
     * The expiry sweep, callable directly — exactly what the 5s interval
     * runs. Exposed so the sweep's behavior is testable on REAL timers
     * (faking the clock around live HTTP is what made the old expiry test
     * hang on CI); the interval's own wiring is pinned by the health test's
     * timer count.
     */
    sweepExpired: settleExpired,

    /** Reconcile the poll loops against the current presence set. */
    reconcile(presences: AdapterPresence[]): void {
      const wanted = new Map(
        presences
          .filter((p) => p.approvalsKey)
          .map((p) => [p.presenceId, p] as const),
      );
      // Refresh the live view FIRST, so running loops immediately see new
      // links / rotated keys without a restart.
      presenceById.clear();
      for (const [presenceId, presence] of wanted) {
        presenceById.set(presenceId, presence);
        const botToken = botTokenOf(presence);
        if (botToken) tokenFor.set(presenceId, botToken);
      }
      for (const [presenceId, loop] of loops) {
        if (!wanted.has(presenceId)) {
          loop.stop();
          loops.delete(presenceId);
          presenceById.delete(presenceId);
          tokenFor.delete(presenceId);
        }
      }
      for (const presenceId of wanted.keys()) {
        if (!loops.has(presenceId)) runLoop(presenceId);
      }
      if (!expiryTimer) {
        expiryTimer = setInterval(() => void settleExpired(), 5_000);
        expiryTimer.unref?.();
      }
    },

    /** Boot sweep: re-arm cards the ledger says are still pending, against the
     * REAL gateway deadline (not a guess). */
    async recoverUnsettled(): Promise<void> {
      const unsettled = await deps.controlPlane.listUnsettledPrompts();
      for (const prompt of unsettled) {
        const ref = prompt.externalMessageRef;
        const separator = ref?.indexOf(":") ?? -1;
        prompts.set(prompt.approvalId, {
          approvalId: prompt.approvalId,
          presenceId: prompt.agentChannelId,
          channel:
            ref && separator > 0
              ? ref.slice(0, separator)
              : prompt.externalThreadId,
          ts: ref && separator > 0 ? ref.slice(separator + 1) : null,
          // The gateway's own recorded deadline, so a fast restart never marks
          // a still-live approval timed-out early. A row with no recorded
          // expiry (older) gets one sweep cycle to settle.
          expiresAt: prompt.expiresAt
            ? new Date(prompt.expiresAt).getTime()
            : Date.now() + 5_000,
        });
      }
    },

    settleDecided,

    stop(): void {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
      if (expiryTimer) clearInterval(expiryTimer);
      expiryTimer = undefined;
    },
  };
};

const botTokenOf = (presence: AdapterPresence): string | null => {
  if (!presence.credentialsJson) return null;
  try {
    const parsed = JSON.parse(presence.credentialsJson) as {
      botToken?: string;
    };
    return parsed.botToken ?? null;
  } catch {
    return null;
  }
};

const sleep = (ms: number, cancelled: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    if (cancelled()) {
      clearTimeout(timer);
      resolve();
    }
  });
