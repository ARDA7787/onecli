/**
 * The shared failure-classification vocabulary for the sandbox lifecycle.
 *
 * These are the machine-readable code STRINGS that ride the wires — the
 * supervisor's `turn.result.errorCode`, the runner's `turn.finished.errorCode`
 * and `sandbox.status.reasonCode`. The user-facing COPY for each code lives in
 * the control plane only (`packages/api/src/validations/conversation.ts`),
 * which maps known codes through an allowlist and treats unknown ones as
 * absent — so a peer speaking a newer vocabulary degrades to today's raw
 * behavior instead of breaking. For the same reason the wire fields themselves
 * are open bounded strings, never enums: one novel code must not invalidate a
 * whole event batch or drop a must-deliver terminal frame.
 */

/**
 * How a turn's failure relates to the harness's life. Attached by the
 * supervisor (and by the runner's synthetic no-channel failures) ONLY when the
 * harness actually died — an ordinary turn failure on a live harness carries
 * no code and keeps its raw error.
 *
 * - `agent_restarted`: the harness died AFTER the turn's stream opened —
 *   observable work may exist, so the failure must stay visible.
 * - `agent_start_failed`: the harness died BEFORE the stream opened — nothing
 *   observable happened, which is what makes the control plane's invisible
 *   one-shot revival safe.
 */
export const TURN_FAILURE_CODES = {
  agentRestarted: "agent_restarted",
  agentStartFailed: "agent_start_failed",
} as const;
export type TurnFailureCode =
  (typeof TURN_FAILURE_CODES)[keyof typeof TURN_FAILURE_CODES];

/**
 * Why a sandbox start failed, classified by the runner (the only party that
 * saw the underlying error). `start_failed` is the deliberate catch-all — the
 * control plane treats any unknown value exactly like it.
 */
export const SANDBOX_START_FAILURE_REASONS = [
  "image_unavailable",
  "at_capacity",
  "start_failed",
] as const;
export type SandboxStartFailureReason =
  (typeof SANDBOX_START_FAILURE_REASONS)[number];
