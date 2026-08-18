import { db } from "@onecli/db";
import { canAccessWorkspaceAsUser } from "./workspace-access-check";
import {
  claimTriggeredWatches,
  sweepExpiredWatches,
  sweepLostProcesses,
  sweepWatchCoherence,
  type DueWatchFire,
} from "./due-work";
import { ensureSourcedConversation } from "./conversation-service";
import { createTurn, materializeAutomationDelivery } from "./turn-service";
import { ServiceError } from "./errors";
import { stripControl } from "../lib/text";
import { logger } from "../lib/logger";

const log = logger.child({ component: "watch-fire" });

/**
 * Firing background-process watches (step 10) — the cron-fire template, with
 * two deliberate differences: watches are ONE-SHOT (no schedule to advance,
 * no consecutive-failure disable), and a watch fires from a control-plane
 * poll after the SWEEPS convert triggered/lost/expired states. Driven from
 * the runner work poll (§3.3), best-effort per watch — one broken watch must
 * never block the others or the poll.
 *
 * The CLAIM lives in due-work (the dispatch seam owns dueness); this module
 * owns what a fire IS: a fire-time authorization check, then a normal turn in
 * the watch's own conversation, created through the same funnel as a human
 * message so door-1, the sandbox wake, and the one-active-turn conflict all
 * apply unchanged.
 */

const cleanName = (raw: string): string =>
  stripControl(raw).replace(/\n/g, " ").trim().slice(0, 100);

/** The trigger, said in plain words for the fired turn's header. */
const triggerSentence = (watch: DueWatchFire): string => {
  switch (watch.trigger) {
    case "exited":
      return watch.exitCode === null
        ? "the process finished"
        : `the process exited with code ${watch.exitCode}`;
    case "matched":
      return "its output matched what you were watching for";
    case "silent":
      return "the process went quiet";
    case "lost":
      return "the process was lost when the machine restarted — it is no longer running";
    default:
      return "the watched condition occurred";
  }
};

export const buildWatchRunMessage = (watch: DueWatchFire): string => {
  const label = cleanName(watch.processName ?? watch.processCommand);
  const header = `[Watch on process "${label}" fired: ${triggerSentence(watch)} — triggered automatically, not by a person typing. Do the task below and finish with a concise report; it will be delivered to the chat where this watch was created.]`;
  const excerpt = watch.excerpt
    ? `\n\n[Recent output:]\n${stripControl(watch.excerpt)}`
    : "";
  return `${header}\n\n${watch.prompt}${excerpt}`;
};

const fireOne = async (watch: DueWatchFire): Promise<void> => {
  // Fire-time authorization, exactly as crons: a creator who lost workspace
  // access cannot keep a foothold through a watch they armed earlier. A
  // one-shot watch has nothing to disable — it is simply canceled.
  if (watch.createdByUserId) {
    const workspace = await db.workspace.findUnique({
      where: { id: watch.workspaceId },
      select: { id: true, organizationId: true },
    });
    const allowed = workspace
      ? await canAccessWorkspaceAsUser(watch.createdByUserId, workspace)
      : false;
    if (!allowed) {
      await db.processWatch.updateMany({
        where: { id: watch.id, status: "triggered" },
        data: { status: "canceled" },
      });
      log.warn(
        { watchId: watch.id, agentId: watch.agentId },
        "watch canceled: creator lost workspace access",
      );
      return;
    }
  }

  // One persistent conversation per watch: externalRef = the watch id, so the
  // (agentId, source, externalRef) unique makes this race-safe.
  const conversation = await ensureSourcedConversation(
    watch.workspaceId,
    watch.agentId,
    {
      source: "watch",
      externalRef: watch.id,
      title: watch.processName ?? "Process watch",
    },
  );

  // Mark fired REGARDLESS of the turn's outcome — a watch is one-shot, so this
  // is the terminal step whether the run starts, is refused, or conflicts.
  const markFired = () =>
    db.processWatch.updateMany({
      where: { id: watch.id, status: "triggered" },
      data: { status: "fired", firedAt: new Date() },
    });

  try {
    const turn = await createTurn(
      watch.workspaceId,
      conversation.id,
      buildWatchRunMessage(watch),
      { source: "watch", userId: null },
    );
    await markFired();
    // Door 1 (no model key): the turn is born failed and never reaches
    // finishTurn, so — unlike a cron, which retries next occurrence — the
    // "wake me" would vanish silently. Deliver the failure to the origin so
    // the person learns the watch fired but could not run.
    if (turn.status === "failed" && watch.originConversationId) {
      await materializeAutomationDelivery(
        watch.originConversationId,
        `Watch on "${cleanName(watch.processName ?? watch.processCommand)}"`,
        `The watch fired, but the run could not start: ${turn.error ?? "no model key."}`,
        "watch",
      );
    }
  } catch (error) {
    if (error instanceof ServiceError && error.code === "CONFLICT") {
      // The watch's own conversation already has a turn running (a prior fire
      // still going). One-shot: mark fired and move on — no retry.
      await markFired();
      log.info({ watchId: watch.id }, "watch conversation busy; fired anyway");
      return;
    }
    throw error;
  }
};

/**
 * Fire everything due. The sweep ORDER matters: lost → coherence → expiry →
 * claim, so this poll's claim already sees the conversions, and expiry runs
 * AFTER coherence so a watch that triggered in time still fires even if its
 * deadline has since passed.
 */
export const fireDueWatches = async (): Promise<number> => {
  await sweepLostProcesses();
  await sweepWatchCoherence();
  await sweepExpiredWatches();
  const due = await claimTriggeredWatches();
  for (const watch of due) {
    try {
      await fireOne(watch);
    } catch (err) {
      log.error({ err, watchId: watch.id }, "watch fire failed");
    }
  }
  return due.length;
};
