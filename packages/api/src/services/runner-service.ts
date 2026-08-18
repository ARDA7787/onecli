import { timingSafeEqual } from "node:crypto";
import { db } from "@onecli/db";
import {
  runnerCapabilitiesSchema,
  type RunnerCapabilities,
} from "@onecli/agent-protocol";
import { RUNNER_TOKEN } from "../lib/env";
import { heldAwakeCeilingFor, heldAwakeCountsByRunner } from "./due-work";
import { onlineSince } from "./placement";

/**
 * The runner registry: registration, liveness, and the availability fact the
 * hosted surface is gated on (§3.13 — no runner, no feature).
 *
 * Registration is anchored on the instance's `RUNNER_TOKEN` (§5.1): a runner
 * presenting it may create its row, and afterwards presents the same token as
 * its credential. This keeps the self-host story zero-touch — install.sh
 * generates one secret into the `.env` both services read — while making an
 * unknown token unable to conjure a runner. With `RUNNER_TOKEN` unset (cloud's
 * posture) only already-registered runners authenticate and NOTHING can
 * register, so the surface stays dark.
 */

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export interface RegisterRunnerInput {
  token: string;
  name: string;
  capabilities: RunnerCapabilities;
}

export type RegisterRunnerResult =
  | { ok: true; runnerId: string }
  | { ok: false };

/**
 * Register (or re-register) a runner. Re-registration is the normal restart
 * path: the same token updates the existing row rather than accumulating
 * duplicates. An unrecognized token is refused without a hint — the caller
 * returns the same 401 as any other auth failure.
 */
export const registerRunner = async ({
  token,
  name,
  capabilities,
}: RegisterRunnerInput): Promise<RegisterRunnerResult> => {
  const existing = await db.runner.findUnique({
    where: { token },
    select: { id: true },
  });

  if (existing) {
    await db.runner.update({
      where: { id: existing.id },
      data: { name, capabilities, lastSeenAt: new Date() },
    });
    return { ok: true, runnerId: existing.id };
  }

  if (!RUNNER_TOKEN || !safeEqual(token, RUNNER_TOKEN)) return { ok: false };

  const created = await db.runner.create({
    data: { token, name, capabilities, lastSeenAt: new Date() },
    select: { id: true },
  });
  return { ok: true, runnerId: created.id };
};

/**
 * Whether one runner advertised the `attachments` capability — read at
 * dispatch time (the steerMessages precedent gates in SQL; this arm gates in
 * the composer because the turn CLAIM itself is capability-independent: the
 * turn always delivers, only the manifest + note are withheld from a runner
 * that could not pull the bytes).
 */
export const runnerSupportsAttachments = async (
  runnerId: string,
): Promise<boolean> => {
  const runner = await db.runner.findUnique({
    where: { id: runnerId },
    select: { capabilities: true },
  });
  const parsed = runnerCapabilitiesSchema.safeParse(runner?.capabilities);
  return parsed.success && parsed.data.attachments === true;
};

export const heartbeatRunner = async (
  runnerId: string,
  capabilities?: RunnerCapabilities,
): Promise<void> => {
  await db.runner.update({
    where: { id: runnerId },
    data: { lastSeenAt: new Date(), ...(capabilities && { capabilities }) },
  });
};

export interface RunnerSummary {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: Date | null;
  sandboxCount: number;
  capabilities: unknown;
  /** Sandboxes live background work is holding out of idle-stop (step 13). */
  heldAwakeCount: number;
  /** The ceiling that count is enforced against (env or derived). */
  heldAwakeCeiling: number;
}

export const listRunners = async (): Promise<RunnerSummary[]> => {
  const threshold = onlineSince();
  const [runners, heldAwake] = await Promise.all([
    db.runner.findMany({
      select: {
        id: true,
        name: true,
        lastSeenAt: true,
        capabilities: true,
        _count: { select: { sandboxes: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    heldAwakeCountsByRunner(),
  ]);

  return runners.map((runner) => ({
    id: runner.id,
    name: runner.name,
    online: runner.lastSeenAt !== null && runner.lastSeenAt >= threshold,
    lastSeenAt: runner.lastSeenAt,
    sandboxCount: runner._count.sandboxes,
    capabilities: runner.capabilities,
    heldAwakeCount: heldAwake.get(runner.id) ?? 0,
    heldAwakeCeiling: heldAwakeCeilingFor(runner.capabilities),
  }));
};

export interface RunnerAvailability {
  registered: boolean;
  online: boolean;
}

/**
 * Short cache in front of the availability read. `GET /v1/instance` is
 * unauthenticated by design, so without this every anonymous request would
 * reach the database — and the answer it returns is a liveness signal with a
 * 90-second threshold, so a couple of seconds of staleness changes nothing a
 * caller could observe.
 */
const AVAILABILITY_TTL_MS = 5_000;
let cached: { value: RunnerAvailability; at: number } | null = null;

/**
 * The §3.13 availability fact, in one round trip: has a runner EVER
 * registered here, and is one online right now? `registered` gates the
 * entrance (a deployment that never had a runner shows nothing); `online`
 * is what the hosted surfaces use to say "offline" rather than hiding an
 * existing agent.
 */
export const getRunnerAvailability = async (): Promise<RunnerAvailability> => {
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) {
    return cached.value;
  }

  const [total, online] = await Promise.all([
    db.runner.count(),
    db.runner.count({ where: { lastSeenAt: { gte: onlineSince() } } }),
  ]);
  const value = { registered: total > 0, online: online > 0 };
  cached = { value, at: Date.now() };
  return value;
};

/** Test seam: drop the cached availability so a suite sees its own writes. */
export const resetRunnerAvailabilityCache = (): void => {
  cached = null;
};
