import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/api/types";
import {
  hasActiveTurn,
  hasUnsettledTurn,
  isJoinedTurn,
  isJoiningTurn,
} from "./turns";

const turn = (status: Turn["status"]): Turn => ({
  id: `t-${status}`,
  conversationId: "cv",
  status,
  source: "web",
  userId: "u1",
  message: "m",
  error: null,
  errorCode: null,
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-10T00:00:00.000Z",
});

describe("the poll predicate", () => {
  it("a lone JOINING follow-up keeps the poll alive after the active turn closed", () => {
    // The no-event failure gap: a joining row can fail (a park writes
    // Turn.error, nothing streams) after its target finished. A poll keyed
    // on ACTIVE alone stops at the close and the bubble reads "received"
    // forever — unsettled is the honest predicate.
    const turns = [turn("done"), turn("joining")];
    expect(hasActiveTurn(turns)).toBe(false);
    expect(hasUnsettledTurn(turns)).toBe(true);
  });

  it("settles once everything is terminal", () => {
    expect(
      hasUnsettledTurn([turn("done"), turn("joined"), turn("aborted")]),
    ).toBe(false);
  });

  it("joining is NOT active — the Stop button targets the running turn, never a follow-up", () => {
    expect(hasActiveTurn([turn("joining")])).toBe(false);
  });
});

describe("follow-up narrowing", () => {
  it("tells the two follow-up states apart", () => {
    expect(isJoiningTurn(turn("joining"))).toBe(true);
    expect(isJoiningTurn(turn("joined"))).toBe(false);
    expect(isJoinedTurn(turn("joined"))).toBe(true);
    expect(isJoinedTurn(turn("running"))).toBe(false);
  });
});
