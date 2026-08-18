import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@onecli/agent-protocol";

/**
 * The jcode adapter's steer plumbing against a MOCKED SDK client — the layer
 * between the pure matcher (jcode.steering.test.ts) and the env-gated live
 * conformance. What only this level can pin:
 *
 * - `cancelSoftInterrupts` runs at TURN START, before the gate opens — the
 *   belt against jcode's idle-queue leak (an interrupt still queued when a
 *   turn ends is injected into the NEXT turn; a mid-run message must never
 *   resurface in a later, unrelated run).
 * - `steer` maps to a NON-URGENT `softInterrupt` on the attached session,
 *   refuses between turns, and propagates a coded refusal (the bridge's
 *   one-attached-session law) — a refusal provably injected nothing, so the
 *   caller's promote fallback is safe.
 * - The terminal reconcile: cancel → history → `message.joined` BEFORE the
 *   terminal event; a history failure degrades every pending steer to
 *   missed (no joined events) instead of guessing.
 */

interface FakeCall {
  method: string;
  args: unknown[];
}

const state: {
  calls: FakeCall[];
  events: (
    | { ev: "turn_done" }
    | { ev: "text_delta"; text: string }
    | { ev: "error"; message: string }
  )[];
  history: { role: string; content: string }[];
  historyError: Error | null;
  softInterruptError: Error | null;
} = {
  calls: [],
  events: [{ ev: "turn_done" }],
  history: [],
  historyError: null,
  softInterruptError: null,
};

vi.mock("@1jehuang/jcode-sdk", () => {
  const record = (method: string, ...args: unknown[]) => {
    state.calls.push({ method, args });
  };
  class FakeJcodeClient {
    static launch() {
      return Promise.resolve(new FakeJcodeClient());
    }
    on() {}
    close() {
      return Promise.resolve();
    }
    createSession(workingDir: string) {
      record("createSession", workingDir);
      return Promise.resolve({ session_id: "s-1" });
    }
    attachSession(id: string) {
      record("attachSession", id);
      return Promise.resolve({ session_id: id });
    }
    detachSession() {
      return Promise.resolve();
    }
    setModel() {
      return Promise.resolve();
    }
    setReasoningEffort() {
      return Promise.resolve();
    }
    sendMessage(sessionId: string, content: string) {
      record("sendMessage", sessionId, content);
      return Promise.resolve();
    }
    softInterrupt(sessionId: string, content: string, urgent?: boolean) {
      record("softInterrupt", sessionId, content, urgent);
      return state.softInterruptError
        ? Promise.reject(state.softInterruptError)
        : Promise.resolve();
    }
    cancelSoftInterrupts(sessionId: string) {
      record("cancelSoftInterrupts", sessionId);
      return Promise.resolve();
    }
    getHistory(sessionId: string) {
      record("getHistory", sessionId);
      return state.historyError
        ? Promise.reject(state.historyError)
        : Promise.resolve(state.history);
    }
    cancel(sessionId: string) {
      record("cancel", sessionId);
      return Promise.resolve();
    }
    respondToPermission() {
      return Promise.resolve();
    }
    async *events() {
      for (const event of state.events) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield event;
      }
      // Stay open like the real stream — the adapter returns on terminal.
      await new Promise(() => {});
    }
  }
  return {
    JcodeClient: FakeJcodeClient,
    // Something that exists on disk — resolveJcodeBinary demands a real path.
    bundledJcodeBinary: () => process.execPath,
  };
});

import { createJcodeHarness } from "./jcode";

const collect = async (
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const startSession = async () => {
  const harness = createJcodeHarness();
  const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
  const session = await harness.startSession({ homeDir });
  return { harness, session };
};

const callsOf = (method: string) =>
  state.calls.filter((c) => c.method === method);

beforeEach(() => {
  state.calls = [];
  state.events = [{ ev: "turn_done" }];
  state.history = [];
  state.historyError = null;
  state.softInterruptError = null;
  delete process.env.ONECLI_JCODE_BINARY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe("the jcode steer plumbing", () => {
  it("cancels leaked interrupts at TURN START, before the message is sent", async () => {
    // MUTATION-PROOF for the leak belt: remove the turn-start
    // cancelSoftInterrupts and an interrupt queued at the previous turn's
    // very end is injected into THIS unrelated run.
    const { session } = await startSession();
    await collect(session.runTurn({ message: "hello" }));

    const order = state.calls.map((c) => c.method);
    const firstCancel = order.indexOf("cancelSoftInterrupts");
    const send = order.indexOf("sendMessage");
    expect(firstCancel).toBeGreaterThan(-1);
    expect(firstCancel).toBeLessThan(send);
  });

  it("steer maps to a NON-URGENT softInterrupt while the turn runs", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started — the gate is open

    await session.steer?.({ id: "f1", message: "fold this in" });

    expect(callsOf("softInterrupt")).toEqual([
      { method: "softInterrupt", args: ["s-1", "fold this in", false] },
    ]);
    // Drain to completion so the shared fake stays clean.
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
  });

  it("REFUSES a steer between turns — never queued for a later run", async () => {
    const { session } = await startSession();
    await expect(
      session.steer?.({ id: "f1", message: "too early" }),
    ).rejects.toThrow("no turn in flight");
    expect(callsOf("softInterrupt")).toHaveLength(0);
  });

  it("propagates a coded harness refusal — the one-attached-session law", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.softInterruptError = Object.assign(new Error("unknown_session"), {
      code: "unknown_session",
    });
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();

    await expect(
      session.steer?.({ id: "f1", message: "wrong session" }),
    ).rejects.toThrow("unknown_session");

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }
    // Never tracked as delivered → never confirmed joined.
    expect(events.some((e) => e.type === "message.joined")).toBe(false);
  });

  it("reconciles at the terminal: cancel → history → message.joined BEFORE turn.done", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    // History GROWS like the real daemon's: the prompt alone at turn start
    // (when the baseline is captured), the injection appended later.
    state.history = [{ role: "user", content: "task" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "fold this in" });
    state.history = [
      { role: "user", content: "task" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "fold this in" },
    ];

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("message.joined");
    expect(kinds.indexOf("message.joined")).toBeLessThan(
      kinds.indexOf("turn.done"),
    );
    // Cancel precedes the RECONCILE history read (the first read is the
    // turn-start baseline capture): after the cancel nothing more can
    // inject, so the read is stable.
    const order = state.calls.map((c) => c.method);
    expect(order.lastIndexOf("cancelSoftInterrupts")).toBeLessThan(
      order.lastIndexOf("getHistory"),
    );
  });

  it("a steer whose text EQUALS the prompt still reconciles joined — the index anchor", async () => {
    // The content-anchor trap: matching the prompt from the END would find
    // the INJECTED copy and read everything out of the window. The baseline
    // index makes the duplicate a normal candidate.
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.history = [{ role: "user", content: "again" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "again" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "again" });
    state.history = [
      { role: "user", content: "again" },
      { role: "assistant", content: "working on it" },
      { role: "user", content: "again" },
    ];

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(
      events.some((e) => e.type === "message.joined" && e.followUpId === "f1"),
    ).toBe(true);
  });

  it("a steer matching only the turn's OWN prompt reads as missed — never joined", async () => {
    // The false-positive the exact-window rule kills: "ok" appears inside
    // the prompt (memory context + message travel there verbatim), and a
    // matcher over the whole history would mark it joined — the message
    // silently swallowed.
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.history = [
      { role: "user", content: "please check everything is ok today" },
      { role: "assistant", content: "done" },
    ];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "please check everything is ok today" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "ok" });

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(events.some((e) => e.type === "message.joined")).toBe(false);
  });

  it("a history failure degrades every pending steer to missed", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.historyError = new Error("bridge went away");
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "fold this in" });

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    // No joined events — and the terminal still arrived (the turn is not
    // held hostage by the reconcile).
    expect(events.some((e) => e.type === "message.joined")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("abort also drops the daemon's queued interrupts — Stop means silence", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();

    await session.abort();

    const order = state.calls.map((c) => c.method);
    // Both verbs fired, cancel-interrupts before the hard cancel.
    expect(
      order.filter((m) => m === "cancelSoftInterrupts").length,
    ).toBeGreaterThanOrEqual(2); // turn-start + abort
    expect(order).toContain("cancel");
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
  });
});
