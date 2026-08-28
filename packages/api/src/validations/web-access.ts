import { z } from "zod";
import { hostPatternSchema } from "./secret";

export const webMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type WebMethod = (typeof webMethods)[number];

const webMethodSchema = z.enum(webMethods);
const behaviorSchema = z.enum(["ask", "block"]);
const rateLimitSchema = z
  .object({
    requests: z.number().int().min(1).max(1_000_000),
    window: z.enum(["minute", "hour", "day"]),
  })
  .strict();

const domainSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/\.$/, "")
      : value,
  hostPatternSchema,
);

const openProfile = z.object({ mode: z.literal("open") }).strict();
const noWebProfile = z.object({ mode: z.literal("no_web") }).strict();
const searchOnlyProfile = z.object({ mode: z.literal("search_only") }).strict();
const researchProfile = z
  .object({
    mode: z.literal("research"),
    allowedMethods: z.array(webMethodSchema).min(1).optional(),
    writeBehavior: behaviorSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
  })
  .strict();
const restrictedProfile = z
  .object({
    mode: z.literal("restricted"),
    allowDomains: z.array(domainSchema).min(1),
    allowedMethods: z.array(webMethodSchema).min(1).optional(),
    writeBehavior: behaviorSchema.optional(),
    unknownDomains: behaviorSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const domains = new Set(value.allowDomains);
    const methods = new Set(value.allowedMethods ?? ["GET", "HEAD"]);
    if (domains.size * methods.size > 100) {
      ctx.addIssue({
        code: "custom",
        message:
          "Restricted profiles support at most 100 domain and method combinations.",
        path: ["allowDomains"],
      });
    }
  });

export const webAccessProfileSchema = z.discriminatedUnion("mode", [
  openProfile,
  noWebProfile,
  searchOnlyProfile,
  researchProfile,
  restrictedProfile,
]);

export type WebAccessProfileInput = z.infer<typeof webAccessProfileSchema>;

export type RateLimitInput = z.infer<typeof rateLimitSchema>;
export type WebBehavior = z.infer<typeof behaviorSchema>;
