import { describe, it, expect } from "vitest";
import { createDoor } from "./create-door";
import type { HostedAvailability } from "./availability";

const byo = { kind: "byo" as const };
const hosted = { kind: "hosted" as const };

describe("createDoor", () => {
  it("gives a brand-new user the hosted door alone", () => {
    // The whole point: someone who has never made an agent never meets the
    // word "BYO".
    expect(createDoor({ agents: [], availability: "ready" })).toBe("hosted");
  });

  it("keeps a legacy user's primary action on BYO, hosted in the chevron", () => {
    expect(createDoor({ agents: [byo], availability: "ready" })).toBe(
      "byo-with-hosted",
    );
  });

  it("treats a hosted-only workspace as new — it is already in the new world", () => {
    expect(createDoor({ agents: [hosted], availability: "ready" })).toBe(
      "hosted",
    );
  });

  it("sees one legacy agent among hosted ones and keeps the split door", () => {
    expect(
      createDoor({ agents: [hosted, hosted, byo], availability: "ready" }),
    ).toBe("byo-with-hosted");
  });

  it("offers hosted while agents are OFFLINE — they exist, they are just down", () => {
    // Offline is a runtime state, not "the surface doesn't exist"; the dialog
    // itself explains the outage.
    expect(createDoor({ agents: [byo], availability: "offline" })).toBe(
      "byo-with-hosted",
    );
    expect(createDoor({ agents: [], availability: "offline" })).toBe("hosted");
  });

  it("falls back to BYO alone where no hosted surface exists", () => {
    // Byte-identical to today's page on a deployment with no runner.
    for (const agents of [[], [byo], [hosted]]) {
      expect(createDoor({ agents, availability: "absent" })).toBe("byo");
    }
  });

  it("never flashes a door it might take away while loading", () => {
    // Agents unknown: show the flow that works in EVERY end state. Gaining a
    // chevron later is quiet; losing a button is not.
    const cases: [HostedAvailability, string][] = [
      ["loading", "byo"],
      ["absent", "byo"],
      ["ready", "byo-with-hosted"],
      ["offline", "byo-with-hosted"],
    ];
    for (const [availability, expected] of cases) {
      expect(createDoor({ agents: undefined, availability })).toBe(expected);
    }
  });

  it("hides hosted while availability is still loading, even with agents known", () => {
    expect(createDoor({ agents: [], availability: "loading" })).toBe("byo");
    expect(createDoor({ agents: [byo], availability: "loading" })).toBe("byo");
  });
});
