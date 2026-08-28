import { describe, expect, it } from "vitest";
import { policyTargetSchema } from "./policy";
import { webAccessProfileSchema } from "./web-access";

describe("webAccessProfileSchema", () => {
  it("accepts HEAD in both the profile and shared policy contracts", () => {
    expect(
      webAccessProfileSchema.parse({
        mode: "research",
        allowedMethods: ["HEAD"],
      }),
    ).toEqual({ mode: "research", allowedMethods: ["HEAD"] });
    expect(
      policyTargetSchema.safeParse({ kind: "web", method: "HEAD" }).success,
    ).toBe(true);
  });

  it("normalizes domain spelling before compilation", () => {
    const parsed = webAccessProfileSchema.parse({
      mode: "restricted",
      allowDomains: [" EXAMPLE.COM. ", "*.SEC.GOV"],
    });
    expect(parsed).toMatchObject({
      mode: "restricted",
      allowDomains: ["example.com", "*.sec.gov"],
    });
  });

  it("allows duplicates that normalize below the target cap", () => {
    const parsed = webAccessProfileSchema.safeParse({
      mode: "restricted",
      allowDomains: Array.from({ length: 101 }, () => "example.com"),
      allowedMethods: Array.from({ length: 20 }, () => "GET"),
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects fields belonging to another mode", () => {
    expect(
      webAccessProfileSchema.safeParse({
        mode: "no_web",
        allowedMethods: ["GET"],
      }).success,
    ).toBe(false);
    expect(
      webAccessProfileSchema.safeParse({
        mode: "research",
        unknownDomains: "ask",
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe wildcards and an oversized target product", () => {
    expect(
      webAccessProfileSchema.safeParse({
        mode: "restricted",
        allowDomains: ["*.com"],
      }).success,
    ).toBe(false);
    expect(
      webAccessProfileSchema.safeParse({
        mode: "restricted",
        allowDomains: Array.from({ length: 17 }, (_, i) => `d${i}.example.com`),
        allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      }).success,
    ).toBe(false);
  });
});
