import { describe, expect, it } from "vitest";
import { computeNextFire } from "./agent-cron-service";
import { ServiceError } from "./errors";

/**
 * The schedule math — pure, so pinned as units. Validation is BY
 * CONSTRUCTION (the same croner object that computes occurrences accepts or
 * rejects), and the timezone is validated through Intl upfront because
 * croner only surfaces a bad zone lazily.
 */
describe("computeNextFire", () => {
  it("computes the next occurrence in the schedule's own timezone", () => {
    // 14:00 in London on a BST date is 13:00 UTC — tz math, not string math.
    const next = computeNextFire(
      "0 14 * * *",
      "Europe/London",
      new Date("2026-08-07T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-08-07T13:00:00.000Z");
  });

  it("advances past the from-point — firing never re-fires the missed slot", () => {
    // Misfire coalescing rests on this: computing from NOW after downtime
    // yields the next FUTURE slot, one late fire, never a backlog.
    const next = computeNextFire(
      "0 14 * * *",
      "UTC",
      new Date("2026-08-07T14:00:01Z"),
    );
    expect(next.toISOString()).toBe("2026-08-08T14:00:00.000Z");
  });

  it("rejects an invalid expression with the engine's own words", () => {
    expect(() =>
      computeNextFire("99 99 * * *", "UTC", new Date()),
    ).toThrowError(ServiceError);
    expect(() => computeNextFire("99 99 * * *", "UTC", new Date())).toThrow(
      /Invalid schedule expression/,
    );
  });

  it("rejects an unknown timezone upfront — croner would only fail lazily", () => {
    expect(() => computeNextFire("0 9 * * *", "Not/AZone", new Date())).toThrow(
      /Unknown timezone/,
    );
  });
});
