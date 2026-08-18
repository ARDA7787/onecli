import { afterEach, describe, expect, it, vi } from "vitest";
import { createOnpremAuth, trustedOrigins } from "./better-auth";
import {
  SESSION_COOKIE_NAMES,
  readExternalAuthId,
} from "./better-auth-contract";

// The cookie NAME is a contract between three independent implementations:
// this configuration issues it, the browser client reads it back, and the Rust
// gateway hardcodes the same strings because it cannot import them. Nothing
// else pins it — the library derives the name from a cookie prefix and a
// "secure cookies" decision that, left to its defaults, follows NODE_ENV.
// Both Docker images bake NODE_ENV=production while the stock self-host URL is
// plain HTTP, so an unpinned deployment would issue a `__Secure-` cookie that
// browsers refuse to send back over http:// — a login that silently never
// completes.

const secret = "test-better-auth-secret-test-better-auth-secret";

const sessionCookieFor = async (baseURL: string, cookieDomain?: string) => {
  const auth = createOnpremAuth({ secret, baseURL, cookieDomain });
  const context = await auth.$context;
  return context.authCookies.sessionToken;
};

const cookieNameFor = async (baseURL: string): Promise<string> =>
  (await sessionCookieFor(baseURL)).name;

describe("onprem auth configuration", () => {
  it("names the session cookie exactly what the gateway looks for", async () => {
    await expect(cookieNameFor("http://localhost:10256")).resolves.toBe(
      "better-auth.session_token",
    );
    await expect(cookieNameFor("https://api.example.com")).resolves.toBe(
      "__Secure-better-auth.session_token",
    );
  });

  it("issues only cookie names the shared contract declares", async () => {
    // The gateway accepts exactly these two, most specific first.
    for (const baseURL of [
      "http://localhost:10256",
      "https://api.example.com",
    ]) {
      expect(SESSION_COOKIE_NAMES).toContain(await cookieNameFor(baseURL));
    }
  });

  it("kills every session when a password is reset", () => {
    // Registration is open and addresses are unverified, so an account may
    // have been created by someone squatting another person's email. The
    // reset is how the real owner reclaims it — a session that survived it
    // would leave the squatter inside the reclaimed account.
    const auth = createOnpremAuth({
      secret,
      baseURL: "http://localhost:10256",
    });
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(
      true,
    );
  });

  it("stamps cookieDomain into the cookie attributes without touching the rest", async () => {
    // The Domain attribute is what lets sibling subdomains (dashboard on the
    // parent, API on api.*) share a session. Everything else is a contract
    // pinned elsewhere: the NAME is what the gateway greps for, and Lax is
    // the CSRF stance — neither may drift when a deployment turns this on.
    const spanning = await sessionCookieFor(
      "https://api.onecli.example.com",
      "onecli.example.com",
    );
    expect(spanning.attributes.domain).toBe("onecli.example.com");
    expect(spanning.attributes.sameSite).toBe("lax");
    expect(spanning.name).toBe("__Secure-better-auth.session_token");

    const hostOnly = await sessionCookieFor("https://api.onecli.example.com");
    expect(hostOnly.attributes.domain).toBeUndefined();
    expect(hostOnly.attributes.sameSite).toBe("lax");
  });

  it("refuses to run without a secret rather than signing with a default one", () => {
    // better-auth would otherwise fall back to a documented development
    // secret, and anyone could forge a session cookie for the deployment.
    expect(() =>
      createOnpremAuth({ secret: "", baseURL: "http://localhost:10256" }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("is never built on cloud, which authenticates with Cognito", async () => {
    vi.stubEnv("NEXT_PUBLIC_EDITION", "cloud");
    vi.resetModules();
    const { getOnpremAuth } = await import("./better-auth");

    // The api-server guards the mount on the edition; this is the second
    // lock, so a future caller cannot quietly stand up a second identity
    // system beside Cognito.
    expect(() => getOnpremAuth()).toThrow(/Cognito/);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads identity only from a usable externalAuthId", () => {
    expect(readExternalAuthId({ externalAuthId: "ba:1" })).toBe("ba:1");
    // A row without one predates the guarantee: it is not an identity.
    expect(readExternalAuthId({})).toBeNull();
    expect(readExternalAuthId({ externalAuthId: "" })).toBeNull();
    expect(readExternalAuthId({ externalAuthId: 42 })).toBeNull();
  });
});

// Asserted on the returned list, never through better-auth's HTTP handler:
// under NODE_ENV=test the library silently sets skipOriginCheck, so an
// end-to-end accept/deny test would pass no matter what this returns.
describe("trustedOrigins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // trustedOrigins() reads four env vars, and a developer's shell can export
  // any of them into vitest through turbo's passthrough — NODE_ENV especially
  // (a shell with NODE_ENV=production would otherwise silently flip the belt).
  // So pin ALL FOUR every case; NODE_ENV defaults to "development" here so the
  // dev-flag cases exercise the flag rather than the production belt.
  const pin = (env: Record<string, string>) => {
    vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "development");
    for (const key of [
      "APP_URL",
      "NEXT_PUBLIC_APP_URL",
      "DEV_TRUST_ANY_AUTH_ORIGIN",
    ]) {
      vi.stubEnv(key, env[key] ?? "");
    }
  };

  it("trusts every origin under the dev flag", () => {
    pin({ DEV_TRUST_ANY_AUTH_ORIGIN: "1" });
    expect(trustedOrigins()).toEqual(["*"]);
  });

  it("ignores the dev flag when NODE_ENV is production — the belt is load-bearing", () => {
    // Mutation test: deleting the NODE_ENV guard in trustedOrigins() must
    // fail exactly this case. The flag should never reach production (only
    // the pnpm dev launchers load .env.dev), but a leaked env var must not
    // be able to open the origin check there.
    pin({
      DEV_TRUST_ANY_AUTH_ORIGIN: "1",
      NODE_ENV: "production",
      APP_URL: "https://onecli.example.com",
    });
    expect(trustedOrigins()).toEqual(["https://onecli.example.com"]);
  });

  it("returns the configured dashboard origin", () => {
    pin({ APP_URL: "https://onecli.example.com" });
    expect(trustedOrigins()).toEqual(["https://onecli.example.com"]);
  });

  it("returns undefined (and warns) when nothing is configured", () => {
    pin({});
    expect(trustedOrigins()).toBeUndefined();
  });
});
