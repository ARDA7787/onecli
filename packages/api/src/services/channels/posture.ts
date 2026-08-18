import { getSelfUrl } from "../../providers/self-url";
import type { ChannelTransport } from "./types";

/**
 * The deployment's transport posture (§step-6 decision 7): a presence can use
 * the provider's HTTP events arm — the one-click install — only when the
 * provider can reach this API over public HTTPS. A config-presence signal
 * (the house rule: config beats edition where honest), never an edition read:
 * cloud and a TLS'd self-host both qualify; a laptop on localhost does not.
 *
 * `getSelfUrl()` is the API's own configured origin (`apps/api-server`
 * initializes it from `API_URL`), which is exactly the URL the provider would
 * be given to call back — so the answer and the baked manifest URL can never
 * disagree.
 */
export const publicApiUrl = (): string | null => {
  const url = getSelfUrl();
  try {
    return new URL(url).protocol === "https:" ? url.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
};

/** Which transport a NEW presence gets. Existing presences keep their stamp —
 * the provider-side app config baked one, so switching is detach/re-attach. */
export const defaultTransport = (): ChannelTransport =>
  publicApiUrl() ? "events" : "socket";
