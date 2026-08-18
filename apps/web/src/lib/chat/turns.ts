import {
  ACTIVE_TURN_STATUSES,
  AUTOMATION_SOURCES,
  UNSETTLED_TURN_STATUSES,
} from "@onecli/api/validations/conversation";
import type { Turn, TurnStatus } from "@/lib/api/types";

/**
 * Turn-activity helpers over the SERVER's active-status set — the one behind
 * its one-active-turn-per-conversation index, which is why `activeTurn` can
 * return a single turn. The binding below is a compile-time drift alarm: a
 * status added server-side that the client union doesn't know fails here.
 */
const ACTIVE: readonly TurnStatus[] = ACTIVE_TURN_STATUSES;

/** Active, plus `joining` follow-ups — everything still owed an outcome. */
const UNSETTLED: readonly TurnStatus[] = UNSETTLED_TURN_STATUSES;

export const isActiveTurn = (turn: Turn): boolean =>
  ACTIVE.includes(turn.status);

/** A mid-run follow-up riding the active turn (steering, or parked). */
export const isJoiningTurn = (turn: Turn): boolean => turn.status === "joining";

/** A follow-up the live run consumed — its answer is the target's answer. */
export const isJoinedTurn = (turn: Turn): boolean => turn.status === "joined";

/** A row that renders WITH its target rather than as its own exchange —
 *  promoted follow-ups (queued/running/…) are their own turns and don't
 *  count, even though they keep `followUpOfTurnId` as provenance. */
export const isFollowUpRow = (turn: Turn): boolean =>
  isJoiningTurn(turn) || isJoinedTurn(turn);

/**
 * A platform automation door (a scheduled run or a process watch firing),
 * taken straight from the server's own set — the same drift-alarm trick, so a
 * new automation source added there is understood here for free.
 */
export type AutomationSource = (typeof AUTOMATION_SOURCES)[number];

/**
 * A platform-posted DELIVERY turn — a cron/watch report materialized into the
 * origin thread as a completed turn (`userId` null, `message` the
 * platform-authored header). The person never typed it, so the chat renders it
 * as a system report, never a user bubble. Narrows `source` (a bare `string`
 * on the wire type) to the automation union for the render branch.
 */
export const isAutomationTurn = (
  turn: Turn,
): turn is Turn & { source: AutomationSource } =>
  (AUTOMATION_SOURCES as readonly string[]).includes(turn.source);

/** The one in-flight turn, if any. `undefined` input reads as "none". */
export const activeTurn = (turns: Turn[] | undefined): Turn | undefined =>
  turns?.find(isActiveTurn);

export const hasActiveTurn = (turns: Turn[] | undefined): boolean =>
  activeTurn(turns) !== undefined;

/**
 * The POLL predicate: anything still owed an outcome keeps the turns poll
 * alive. Wider than `hasActiveTurn` on purpose — a `joining` follow-up can
 * fail with no transcript event (a park writes `Turn.error` and nothing
 * streams), so a poll that stopped at the active turn's close would leave
 * its bubble reading "received" forever.
 */
export const hasUnsettledTurn = (turns: Turn[] | undefined): boolean =>
  turns?.some((turn) => UNSETTLED.includes(turn.status)) ?? false;
