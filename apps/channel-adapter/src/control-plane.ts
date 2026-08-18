import { z } from "zod";
import {
  adapterConfigResponseSchema,
  adapterCursorResponseSchema,
  adapterDecisionResponseSchema,
  adapterIngestResponseSchema,
  adapterPromptClaimResponseSchema,
  adapterRegisterResponseSchema,
  adapterTranscriptResponseSchema,
  adapterUnsettledPromptsResponseSchema,
  adapterWorkResponseSchema,
  type AdapterConfigResponse,
  type AdapterDecisionRequest,
  type AdapterDecisionResponse,
  type AdapterIngestRequest,
  type AdapterIngestResponse,
  type AdapterWorkResponse,
} from "@onecli/agent-protocol";

/**
 * The control-plane HTTP client — plain `fetch` + zod-parsed responses, the
 * `apps/runner/src/control-plane.ts` shape: every response is parsed, never
 * cast, so a contract drift fails loudly here instead of somewhere deep in a
 * poll loop.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** An HTTP error the control plane ANSWERED — distinct from transport
 * failures so callers can retry the network and stop on a refusal. */
export class ControlPlaneError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export interface ControlPlaneClient {
  register(name: string): Promise<string>;
  // No heartbeat method on purpose: the adapter-auth middleware touches
  // `lastSeenAt` on every authenticated call, and the config/work polls run
  // continuously — the polls ARE the heartbeat (the `/heartbeat` route
  // exists for a future quiet mode).
  /** Returns null on a 304 (etag matched — nothing changed). */
  getConfig(etag: string | null): Promise<AdapterConfigResponse | null>;
  getWork(): Promise<AdapterWorkResponse>;
  ingest(request: AdapterIngestRequest): Promise<AdapterIngestResponse>;
  decide(request: AdapterDecisionRequest): Promise<AdapterDecisionResponse>;
  claimPrompt(input: {
    approvalId: string;
    presenceId: string;
    externalThreadId: string;
    /** ISO string or null — the gateway deadline persisted for restart re-arm. */
    expiresAt: string | null;
  }): Promise<boolean>;
  recordPromptMessage(
    approvalId: string,
    externalMessageRef: string,
  ): Promise<void>;
  settlePrompt(approvalId: string, state: "decided" | "expired"): Promise<void>;
  listUnsettledPrompts(): Promise<
    z.infer<typeof adapterUnsettledPromptsResponseSchema>["prompts"]
  >;
  /** `turnId` lets the control plane clear the turn's reaction receipt on a
   * CAS win — the answer is posting, so the "seen" reaction comes off. */
  advanceCursor(
    linkId: string,
    expect: string | null,
    next: string,
    turnId?: string,
  ): Promise<boolean>;
  reportApprovalHealth(presenceId: string, healthy: boolean): Promise<void>;
  /** The proactive credential sweep — staleness is decided server-side. */
  rotateIntegrations(): Promise<{ rotated: number; failed: number }>;
  readTranscript(
    conversationId: string,
    since: number | undefined,
  ): Promise<z.infer<typeof adapterTranscriptResponseSchema>>;
}

export const createControlPlane = (options: {
  baseUrl: string;
  token: string;
}): ControlPlaneClient => {
  const call = async <T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    init?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<z.infer<T>> => {
    const response = await fetch(`${options.baseUrl}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(init?.body !== undefined && {
          "content-type": "application/json",
        }),
        ...init?.headers,
      },
      ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new ControlPlaneError(
        response.status,
        `control plane answered ${response.status} for ${path}`,
      );
    }
    return schema.parse(await response.json()) as z.infer<T>;
  };

  return {
    async register(name) {
      const parsed = await call(
        "POST",
        "/channel-adapter/register",
        adapterRegisterResponseSchema,
        { body: { name } },
      );
      return parsed.adapterId;
    },

    async getConfig(etag) {
      const response = await fetch(
        `${options.baseUrl}/v1/channel-adapter/config`,
        {
          headers: {
            authorization: `Bearer ${options.token}`,
            ...(etag && { "if-none-match": etag }),
          },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
      );
      if (response.status === 304) return null;
      if (!response.ok) {
        throw new ControlPlaneError(
          response.status,
          `control plane answered ${response.status} for /config`,
        );
      }
      return adapterConfigResponseSchema.parse(await response.json());
    },

    getWork: () =>
      call("GET", "/channel-adapter/work", adapterWorkResponseSchema),

    ingest: (request) =>
      call("POST", "/channel-adapter/ingest", adapterIngestResponseSchema, {
        body: request,
      }),

    decide: (request) =>
      call("POST", "/channel-adapter/decision", adapterDecisionResponseSchema, {
        body: request,
      }),

    async claimPrompt(input) {
      const parsed = await call(
        "POST",
        "/channel-adapter/prompts/claim",
        adapterPromptClaimResponseSchema,
        { body: input },
      );
      return parsed.claimed;
    },

    async recordPromptMessage(approvalId, externalMessageRef) {
      await call(
        "POST",
        "/channel-adapter/prompts/message",
        z.object({ ok: z.boolean() }),
        { body: { approvalId, externalMessageRef } },
      );
    },

    async settlePrompt(approvalId, state) {
      await call(
        "POST",
        "/channel-adapter/prompts/settle",
        z.object({ prompt: z.unknown() }),
        { body: { approvalId, state } },
      );
    },

    async listUnsettledPrompts() {
      const parsed = await call(
        "GET",
        "/channel-adapter/prompts/unsettled",
        adapterUnsettledPromptsResponseSchema,
      );
      return parsed.prompts;
    },

    async advanceCursor(linkId, expect, next, turnId) {
      const parsed = await call(
        "POST",
        "/channel-adapter/cursor",
        adapterCursorResponseSchema,
        { body: { linkId, expect, next, ...(turnId && { turnId }) } },
      );
      return parsed.advanced;
    },

    async reportApprovalHealth(presenceId, healthy) {
      await call(
        "POST",
        "/channel-adapter/approval-health",
        z.object({ ok: z.boolean() }),
        { body: { presenceId, healthy } },
      );
    },

    rotateIntegrations: () =>
      call(
        "POST",
        "/channel-adapter/rotate-integrations",
        z.object({ rotated: z.number().int(), failed: z.number().int() }),
        { body: {} },
      ),

    readTranscript: (conversationId, since) =>
      call(
        "GET",
        `/channel-adapter/conversations/${encodeURIComponent(conversationId)}/events${
          since !== undefined ? `?since=${since}` : ""
        }`,
        adapterTranscriptResponseSchema,
      ),
  };
};
