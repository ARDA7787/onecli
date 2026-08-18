import type { AgentEvent } from "@onecli/agent-protocol";
import { logger } from "../lib/logger";

const log = logger.child({ component: "event-bus" });

/**
 * THE LIVE FAN-OUT SEAM (plans/hosted-agents-v2.md §3.17, invariant 15).
 *
 * Every live delivery of transcript events goes through `publish`/`subscribe`
 * and nowhere else. v2's implementation is an in-process emitter, which is
 * exactly right while an install runs one api instance; Redis pub/sub (or
 * `LISTEN/NOTIFY`) swaps in HERE — injected through the provider seam, since
 * shared code may not import `ee/` — the day instances multiply.
 *
 * **Postgres stays the truth.** This bus is a latency optimization, not a
 * delivery guarantee: a dropped publish costs a reconnect, never an event,
 * because every subscriber resumes from a `seq` and the history endpoint is
 * authoritative. Nothing may be built on the assumption that a publish
 * arrives.
 */

/** What a live subscriber receives: transcript events already assigned `seq`. */
export interface PublishedEvent {
  seq: number;
  turnId: string;
  /** The event's own discriminant, kept narrow so consumers can switch on it. */
  type: AgentEvent["type"];
  event: AgentEvent;
}

export type EventListener = (events: PublishedEvent[]) => void;

const listeners = new Map<string, Set<EventListener>>();

/**
 * Deliver to everyone currently tailing this conversation. Never throws: one
 * broken subscriber must not take down a turn's event path, and the publisher
 * is on the runner's critical path.
 */
export const publish = (
  conversationId: string,
  events: PublishedEvent[],
): void => {
  if (events.length === 0) return;
  const subscribers = listeners.get(conversationId);
  if (!subscribers) return;

  // Iterate a copy: a listener may unsubscribe (or subscribe) while we run.
  for (const listener of [...subscribers]) {
    try {
      listener(events);
    } catch (err) {
      log.warn({ err, conversationId }, "event listener threw");
    }
  }
};

/**
 * Tail a conversation. Returns the unsubscribe function — callers MUST invoke
 * it (a stream handler in `finally` and on abort), or a closed browser tab
 * leaks a listener for the process's lifetime.
 */
export const subscribe = (
  conversationId: string,
  listener: EventListener,
): (() => void) => {
  const subscribers = listeners.get(conversationId) ?? new Set<EventListener>();
  subscribers.add(listener);
  listeners.set(conversationId, subscribers);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = listeners.get(conversationId);
    if (!current) return;
    current.delete(listener);
    // Drop the empty set so the map does not grow one entry per conversation
    // ever streamed.
    if (current.size === 0) listeners.delete(conversationId);
  };
};

/** Test seam: how many listeners are tailing a conversation right now. */
export const subscriberCount = (conversationId: string): number =>
  listeners.get(conversationId)?.size ?? 0;

/** Test seam: how many conversations have any listener — catches map leaks. */
export const trackedConversationCount = (): number => listeners.size;
