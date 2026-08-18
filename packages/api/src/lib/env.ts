/**
 * Centralized environment variable access for the API package.
 *
 * Reads both `X` and `NEXT_PUBLIC_X` variants so this works in both
 * Next.js (where build-time NEXT_PUBLIC_ prefix is required) and
 * standalone Node.js (where plain env vars are used).
 */

import { capabilitiesFor, parseEdition } from "./edition";
import { isEntitled } from "./entitlements";

// ── App URLs ────────────────────────────────────────────────────────────

export const APP_URL =
  process.env.APP_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:10254";

export const API_URL =
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:10256";

export const GATEWAY_API_URL =
  process.env.GATEWAY_API_URL ??
  process.env.NEXT_PUBLIC_GATEWAY_API_URL ??
  "http://localhost:10255";

/**
 * Server-side address of the gateway (cache flushes): an explicit internal
 * override for layouts where the public URL isn't routable from this process
 * (the self-host compose points it at the gateway service), else the public
 * URL — which is exactly right on cloud and in single-host layouts.
 */
export const GATEWAY_INTERNAL_URL =
  process.env.GATEWAY_INTERNAL_URL ?? GATEWAY_API_URL;

export const GATEWAY_BASE_URL =
  process.env.GATEWAY_BASE_URL ?? "host.docker.internal:10255";

// ── Edition ─────────────────────────────────────────────────────────────

/** Parsed build edition + variant (single source of truth). */
export const EDITION_INFO = parseEdition(
  process.env.EDITION ?? process.env.NEXT_PUBLIC_EDITION,
);

/**
 * Capability set derived from the current edition + entitlement. Evaluated at
 * module load: server processes have their env at boot, and the entitlement
 * flag cannot change mid-process (same contract as the edition itself).
 */
export const CAPS = capabilitiesFor(EDITION_INFO, { entitled: isEntitled() });

/** Convenience flag for cloud-specific logic. */
export const IS_CLOUD = EDITION_INFO.edition === "cloud";

// ── Auth & Encryption ───────────────────────────────────────────────────

/**
 * Signs self-hosted session cookies (better-auth), and is the HMAC key the
 * gateway verifies them with. Required on a self-hosted deployment — without
 * it nobody can sign in. Unset on cloud, which authenticates with Cognito.
 */
export const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "";

// UNSUBSCRIBE_TOKEN_SECRET is deliberately NOT exported here: the
// unsubscribe-token service reads it at call time and FAILS CLOSED when
// empty (an HMAC keyed by "" is forgeable — anyone could mint unsubscribe
// links). Empty ⇒ no tokens are minted, outgoing mail omits the
// List-Unsubscribe headers, and no token verifies. Set a real value in any
// deployment that sends email; rotating it invalidates live links.

export const SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "";

/** Shared secret the gateway presents to the internal `/v1/internal/*` endpoints. */
export const GATEWAY_INTERNAL_SECRET =
  process.env.GATEWAY_INTERNAL_SECRET ?? "";

export const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET ?? "";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

// ── Cloud: Cognito ──────────────────────────────────────────────────────

export const COGNITO_CLIENT_ID =
  process.env.COGNITO_CLIENT_ID ??
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ??
  "";

export const COGNITO_DOMAIN =
  process.env.COGNITO_DOMAIN ?? process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "";

export const COGNITO_USER_POOL_ID =
  process.env.COGNITO_USER_POOL_ID ??
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ??
  "";

// ── Cloud: Stripe ───────────────────────────────────────────────────────

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";

export const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID ?? "";

// ── Cloud: Notifications ────────────────────────────────────────────────

export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

// The Resend webhook signing secrets (svix `whsec_…`, one PER ENDPOINT from
// the Resend dashboard) are deliberately not exported here: the intake reads
// them at call time and FAILS CLOSED — unset ⇒ that route rejects everything,
// so deployments that never configure them (all self-hosts by default) expose
// no unauthenticated write surface.
//   RESEND_WEBHOOK_SECRET          → POST /v1/webhooks/resend
//   RESEND_INBOUND_WEBHOOK_SECRET  → POST /v1/webhooks/inbound
// Each accepts a whitespace/comma separated list, so a rotation can keep the
// old secret valid alongside the new one.

export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

export const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

// ── Cloud: KMS ──────────────────────────────────────────────────────────

export const KMS_KEY_ARN = process.env.KMS_KEY_ARN ?? "";

// ── Cloud: Redis ────────────────────────────────────────────────────────

export const REDIS_HOST = process.env.REDIS_HOST ?? "";

export const REDIS_PORT = process.env.REDIS_PORT ?? "6379";

export const REDIS_USERNAME = process.env.REDIS_USERNAME ?? "";

export const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? "";

// ── Gateway TLS ─────────────────────────────────────────────────────────

export const GATEWAY_CA_CERT = process.env.GATEWAY_CA_CERT ?? "";

export const GATEWAY_CA_PEM_FILE = process.env.GATEWAY_CA_PEM_FILE ?? "";

// ── Runner plane (hosted agents) ────────────────────────────────────────

/**
 * The instance registration anchor for the runner plane (§5.1): a runner
 * presenting exactly this `rnr_` token may create its Runner row. Empty =
 * registration of new runners is impossible (cloud's posture — the hosted
 * surface stays dark, invariant 13). install.sh generates it into the
 * self-host `.env` shared by the api and runner services.
 */
export const RUNNER_TOKEN = process.env.RUNNER_TOKEN ?? "";

/**
 * The channel adapter's registration anchor (step 6) — the `cha_` twin of
 * `RUNNER_TOKEN`, with identical semantics: presenting exactly this token may
 * create the ChannelAdapter row; empty means no adapter can ever register.
 */
export const CHANNEL_ADAPTER_TOKEN = process.env.CHANNEL_ADAPTER_TOKEN ?? "";

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** A runner whose last heartbeat is older than this is offline (§3.13). */
export const RUNNER_ONLINE_THRESHOLD_SECONDS = positiveInt(
  process.env.RUNNER_ONLINE_THRESHOLD_SECONDS,
  90,
);

/** Idle window after which a running sandbox is parked (§3.9 sleep). */
export const SANDBOX_IDLE_STOP_SECONDS = positiveInt(
  process.env.SANDBOX_IDLE_STOP_SECONDS,
  1800,
);

/**
 * Ceiling on a single turn, from when it was posted. A turn that never reaches
 * a terminal state blocks its conversation permanently (the active-turn
 * index), so this bound is what guarantees a conversation always recovers.
 */
export const TURN_CEILING_SECONDS = positiveInt(
  process.env.TURN_CEILING_SECONDS,
  1800,
);

/**
 * Operator override for the per-runner held-awake ceiling (§3.9 / step 13):
 * how many sandboxes live background work may hold out of idle-stop at once.
 * Unset/invalid = null = the derived default, `max(1, maxSandboxes − 1)` per
 * runner — which always leaves one slot free for interactive turns and needs
 * no operator input. There is deliberately NO "unlimited" spelling: the
 * ceiling exists because unbounded keep-awake is a legitimate-usage path to
 * wedging the host (plans/v2-todo.md, release blocker).
 */
const optionalPositiveInt = (raw: string | undefined): number | null => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const MAX_HELD_AWAKE_SANDBOXES = optionalPositiveInt(
  process.env.MAX_HELD_AWAKE_SANDBOXES,
);

// ── Logging & Runtime ───────────────────────────────────────────────────

export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const NODE_ENV = process.env.NODE_ENV ?? "development";

export const HOME = process.env.HOME ?? "";
