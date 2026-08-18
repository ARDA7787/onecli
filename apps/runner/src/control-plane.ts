import {
  runnerRegisterResponseSchema,
  runnerSandboxCheckResponseSchema,
  runnerSandboxesResponseSchema,
  runnerWorkResponseSchema,
  type RunnerCapabilities,
  type RunnerEvent,
  type RunnerWorkItem,
  runnerMemoryWriteResponseSchema,
  runnerToolCallResponseSchema,
  type RunnerMemoryWriteRequest,
  type RunnerMemoryWriteResponse,
  type RunnerToolCallRequest,
  type RunnerToolCallResponse,
} from "@onecli/agent-protocol";

/**
 * The runner's only outbound dependency: the control plane's `/v1/runner/*`
 * surface (§3.3 — the runner dials out, nothing dials in). Native fetch, the
 * house pattern for server-side HTTP in this repo.
 */

export interface ControlPlaneClient {
  register(
    name: string,
    capabilities: RunnerCapabilities,
  ): Promise<{ runnerId: string }>;
  pollWork(wait: number, limit: number): Promise<RunnerWorkItem[]>;
  postEvents(events: RunnerEvent[]): Promise<void>;
  heartbeat(capabilities?: RunnerCapabilities): Promise<void>;
  listSandboxIds(): Promise<string[]>;
  /** The orphan sweep's authority: which of these sandbox ids exist NOWHERE
   * in the control plane. Throws on any failure — the sweep destroys nothing
   * without a positive answer. */
  checkSandboxIds(sandboxIds: string[]): Promise<string[]>;
  /** Relay a platform-tool call (step 7) and return the control plane's
   * answer. Throws on transport failure — the caller turns that into a tool
   * error, never silence. */
  toolCall(request: RunnerToolCallRequest): Promise<RunnerToolCallResponse>;
  /** Relay a harvested memory-file write (the projection's write-back half)
   * — same contract as toolCall: throws on transport failure, the caller
   * answers the sandbox in both outcomes. */
  memoryWrite(
    request: RunnerMemoryWriteRequest,
  ): Promise<RunnerMemoryWriteResponse>;
  /** Pull one attachment's bytes behind a `turn.deliver` manifest (bytes
   * deliberately never ride the poll JSON). Throws on any non-200 — the
   * caller degrades to delivering the turn without the file. */
  fetchAttachment(attachmentId: string): Promise<Buffer>;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ControlPlaneOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const createControlPlaneClient = ({
  baseUrl,
  token,
  fetchImpl = fetch,
}: ControlPlaneOptions): ControlPlaneClient => {
  const call = async (
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  ): Promise<unknown> => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });

    if (!response.ok) {
      throw new ControlPlaneError(
        response.status,
        `${init.method} ${path} failed: ${response.status}`,
      );
    }

    if (response.status === 204) return null;
    return response.json();
  };

  return {
    async register(name, capabilities) {
      const body = await call("/v1/runner/register", {
        method: "POST",
        body: { name, capabilities },
        timeoutMs: 15_000,
      });
      return runnerRegisterResponseSchema.parse(body);
    },

    async pollWork(wait, limit) {
      // The held poll is bounded server-side (25s); this timeout only needs
      // to outlast it plus travel.
      const body = await call("/v1/runner/work", {
        method: "POST",
        body: { wait, limit },
        timeoutMs: (wait + 15) * 1000,
      });
      return runnerWorkResponseSchema.parse(body).items;
    },

    async postEvents(events) {
      if (events.length === 0) return;
      await call("/v1/runner/events", {
        method: "POST",
        body: { events },
        timeoutMs: 15_000,
      });
    },

    async toolCall(request) {
      // 15s transport ceiling sits inside the supervisor's 25s correlator,
      // which sits inside jcode's 30s — every layer times out into the layer
      // above's error text, never into a vendor's generic one.
      const body = await call("/v1/runner/tool-call", {
        method: "POST",
        body: request,
        timeoutMs: 15_000,
      });
      return runnerToolCallResponseSchema.parse(body);
    },

    async memoryWrite(request) {
      // The toolCall ceilings: 15s transport inside the supervisor's 25s
      // correlator. A 400 (schema refusal) throws ControlPlaneError — the
      // relay maps it to a non-retryable refusal for this content.
      const body = await call("/v1/runner/memory-write", {
        method: "POST",
        body: request,
        timeoutMs: 15_000,
      });
      return runnerMemoryWriteResponseSchema.parse(body);
    },

    async heartbeat(capabilities) {
      await call("/v1/runner/heartbeat", {
        method: "POST",
        body: capabilities ? { capabilities } : {},
        timeoutMs: 15_000,
      });
    },

    async fetchAttachment(attachmentId) {
      // Binary, so not through `call` (which JSON-parses). 30s: a 10MB file
      // over a slow link, still bounded well under the turn ceiling.
      const response = await fetchImpl(
        `${baseUrl.replace(/\/$/, "")}/v1/runner/attachments/${encodeURIComponent(attachmentId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new ControlPlaneError(
          response.status,
          `GET /v1/runner/attachments failed: ${response.status}`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async listSandboxIds() {
      // Parsed, not cast: this list decides what reconcile destroys, so a
      // response that isn't the shape we expect must throw (reconcile logs and
      // skips) rather than read as an empty list and reap every sandbox.
      const body = await call("/v1/runner/sandboxes", {
        method: "GET",
        timeoutMs: 15_000,
      });
      return runnerSandboxesResponseSchema.parse(body).sandboxIds;
    },

    async checkSandboxIds(sandboxIds: string[]) {
      // Same zod-parse-don't-cast law as listSandboxIds, and for the same
      // reason: this answer decides what the orphan sweep force-deletes.
      const body = await call("/v1/runner/sandboxes/check", {
        method: "POST",
        body: { sandboxIds },
        timeoutMs: 15_000,
      });
      return runnerSandboxCheckResponseSchema.parse(body).missing;
    },
  };
};
