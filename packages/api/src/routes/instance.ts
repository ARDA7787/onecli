import { Hono } from "hono";
import { EDITION_INFO } from "../lib/env";
import { isEntitled } from "../lib/entitlements";
import { getRunnerAvailability } from "../services/runner-service";

/**
 * Instance metadata — the browser's only source of runtime truth the client
 * bundle cannot know: the edition and the enterprise entitlement are runtime
 * env on the server, while everything `NEXT_PUBLIC_*` is baked at build time
 * into prebuilt self-host images. Unauthenticated by design, like `/health`:
 * it reveals deployment posture, never data.
 *
 * `runners` is the hosted-agents availability fact (§3.13): `registered`
 * gates the entrance — a deployment that never had a runner shows nothing —
 * and `online` is what lets the hosted surfaces say "offline" instead of
 * hiding agents that already exist. Same posture-not-data rule: two booleans,
 * no runner identity.
 */
export const instanceRoutes = (version?: string) => {
  const app = new Hono();

  app.get("/", async (c) =>
    c.json({
      edition: EDITION_INFO.edition,
      entitled: isEntitled(),
      version: version ?? "unknown",
      runners: await getRunnerAvailability(),
    }),
  );

  return app;
};
