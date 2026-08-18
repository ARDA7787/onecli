import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTerminalEvent,
  type AgentEvent,
  type Harness,
} from "@onecli/agent-protocol";

/**
 * The harness conformance suite (§3.5 rule 3): the contract every adapter —
 * fake and real alike — must pass. This suite, not prose, is what makes a
 * second adapter a day's work instead of a rewrite. The fake adapter runs it
 * in CI; a real adapter runs it behind its own env-gated live suite (it
 * needs the runtime binary and a credential path — same env-gating
 * philosophy as the pg proof suites).
 */

export interface ConformanceTarget {
  name: string;
  makeHarness: (ctx: { homeDir: string }) => Promise<Harness>;
  /** A prompt every adapter can answer (the fake ignores it). */
  turnPrompt?: string;
  /** A long-enough prompt for the steer case to land mid-run. */
  steerPrompt?: string;
  /** The mid-run message the steer case injects. */
  steerMessage?: string;
  /** Assert at least one tool.started/tool.finished pair appears. */
  expectToolUse?: boolean;
  /** Per-test timeout — live adapters need room for a real model call. */
  timeoutMs?: number;
}

const collect = async (
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

export const runHarnessConformance = (target: ConformanceTarget): void => {
  const timeout = target.timeoutMs ?? 15_000;
  const prompt =
    target.turnPrompt ?? "Reply with the single word: pong. Use no tools.";

  describe(`harness conformance: ${target.name}`, () => {
    it(
      "one turn yields ordered events with exactly one terminal at the end",
      { timeout },
      async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        try {
          const session = await harness.startSession({ homeDir });
          const events = await collect(session.runTurn({ message: prompt }));

          expect(events.length).toBeGreaterThanOrEqual(2);
          expect(events[0]?.type).toBe("turn.started");
          const terminal = events.at(-1);
          expect(terminal && isTerminalEvent(terminal)).toBe(true);
          // Exactly one terminal, and it is the last event.
          expect(events.filter(isTerminalEvent)).toHaveLength(1);

          // The capability profile is a promise, not a hint (§3.5 rule on
          // undeclared capabilities): events outside it must never appear.
          if (!harness.capabilities.thinking) {
            expect(events.some((e) => e.type === "thinking.delta")).toBe(false);
          }
          if (!harness.capabilities.toolEvents) {
            expect(
              events.some(
                (e) => e.type === "tool.started" || e.type === "tool.finished",
              ),
            ).toBe(false);
          }
        } finally {
          await harness.dispose();
        }
      },
    );

    it("tool events pair start→finish by callId", { timeout }, async () => {
      const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
      const harness = await target.makeHarness({ homeDir });
      try {
        if (!harness.capabilities.toolEvents) return;
        const session = await harness.startSession({ homeDir });
        const events = await collect(
          session.runTurn({
            message:
              target.expectToolUse === false
                ? prompt
                : "List the files in the current directory, then say done.",
          }),
        );

        const started = new Set(
          events
            .filter((e) => e.type === "tool.started")
            .map((e) => (e.type === "tool.started" ? e.callId : "")),
        );
        for (const event of events) {
          if (event.type === "tool.finished") {
            expect(started.has(event.callId)).toBe(true);
          }
        }
        if (target.expectToolUse) {
          expect(started.size).toBeGreaterThan(0);
        }
      } finally {
        await harness.dispose();
      }
    });

    it(
      "a turn input carrying inline images still completes cleanly",
      { timeout },
      async () => {
        // Images are ADDITIVE on TurnInput: an adapter that can carry them
        // hands them to its harness, one that cannot ignores them — either
        // way the turn must run to its terminal, never crash on the field.
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        try {
          const session = await harness.startSession({ homeDir });
          const events = await collect(
            session.runTurn({
              message: prompt,
              images: [
                {
                  mediaType: "image/png",
                  // A 1×1 PNG — enough to exercise the carry path.
                  dataBase64:
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              ],
            }),
          );
          const terminal = events.at(-1);
          expect(terminal && isTerminalEvent(terminal)).toBe(true);
        } finally {
          await harness.dispose();
        }
      },
    );

    it(
      "abort mid-turn still ends the stream with a terminal event",
      { timeout },
      async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        try {
          const session = await harness.startSession({ homeDir });
          const iterator = session
            .runTurn({
              message:
                "Count slowly from one to one hundred, one number per line.",
            })
            [Symbol.asyncIterator]();

          const events: AgentEvent[] = [];
          const first = await iterator.next();
          if (!first.done && first.value) events.push(first.value);

          await session.abort();

          let result = await iterator.next();
          while (!result.done) {
            if (result.value) events.push(result.value);
            result = await iterator.next();
          }

          const terminal = events.at(-1);
          expect(terminal && isTerminalEvent(terminal)).toBe(true);
        } finally {
          await harness.dispose();
        }
      },
    );

    it(
      "reports no terminal failure for a healthy turn or a deliberate dispose",
      { timeout },
      async () => {
        // `onFailure` recycles the whole sandbox, so a false positive is
        // expensive: it would tear down a working container mid-conversation,
        // and — because `dispose()` closes the very connection whose loss
        // means "the harness died" — it would do so on every ordinary
        // shutdown. Both halves of that are asserted here.
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        const failures: string[] = [];
        harness.onFailure((reason) => failures.push(reason));

        try {
          const session = await harness.startSession({ homeDir });
          await collect(session.runTurn({ message: prompt }));
          expect(failures).toEqual([]);
        } finally {
          await harness.dispose();
        }
        expect(failures).toEqual([]);
      },
    );

    it(
      "a steered message joins the live turn and the stream stays coherent",
      { timeout },
      async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        try {
          if (!harness.capabilities.steer) return;
          const session = await harness.startSession({ homeDir });
          expect(session.steer).toBeDefined();

          const iterator = session
            .runTurn({
              message:
                target.steerPrompt ??
                "Count slowly from one to twenty, one number per line.",
            })
            [Symbol.asyncIterator]();

          const events: AgentEvent[] = [];
          const first = await iterator.next();
          if (!first.done && first.value) events.push(first.value);

          // The turn is in flight — the gate must be open.
          await session.steer?.({
            id: "conformance-steer-1",
            message: target.steerMessage ?? "Also say the word: banana.",
          });

          let result = await iterator.next();
          while (!result.done) {
            if (result.value) events.push(result.value);
            result = await iterator.next();
          }

          // Coherent stream: exactly one terminal, at the very end.
          const terminal = events.at(-1);
          expect(terminal && isTerminalEvent(terminal)).toBe(true);
          expect(events.filter(isTerminalEvent)).toHaveLength(1);

          // The consumed steer is confirmed BEFORE the terminal event.
          const joined = events.filter((e) => e.type === "message.joined");
          expect(
            joined.map((e) =>
              e.type === "message.joined" ? e.followUpId : "",
            ),
          ).toContain("conformance-steer-1");
          expect(events.indexOf(joined[0] as AgentEvent)).toBeLessThan(
            events.indexOf(terminal as AgentEvent),
          );
        } finally {
          await harness.dispose();
        }
      },
    );

    it(
      "steering between turns refuses instead of queueing",
      { timeout },
      async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        try {
          if (!harness.capabilities.steer) return;
          const session = await harness.startSession({ homeDir });
          // No turn in flight: the contract says refuse — a steer accepted
          // here would surface in a later, unrelated run.
          await expect(
            session.steer?.({ id: "conformance-steer-2", message: "hello" }),
          ).rejects.toThrow();
        } finally {
          await harness.dispose();
        }
      },
    );

    it(
      "resume reopens a session when the capability is declared",
      { timeout },
      async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "conformance-"));
        const harness = await target.makeHarness({ homeDir });
        try {
          if (!harness.capabilities.resume) return;
          const first = await harness.startSession({ homeDir });
          await collect(first.runTurn({ message: prompt }));
          expect(first.sessionRef).toBeTruthy();

          const resumed = await harness.startSession({
            homeDir,
            resumeSessionRef: first.sessionRef ?? undefined,
          });
          expect(resumed.sessionRef).toBe(first.sessionRef);
          const events = await collect(resumed.runTurn({ message: prompt }));
          const terminal = events.at(-1);
          expect(terminal && isTerminalEvent(terminal)).toBe(true);
        } finally {
          await harness.dispose();
        }
      },
    );
  });
};
