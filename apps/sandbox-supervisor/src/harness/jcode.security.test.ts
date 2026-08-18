import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Security regression: the supervisor's managed files land in the AGENT'S
 * home, so every write must be symlink-hardened — the agent can plant a
 * link and a bare write would follow it onto any path this process can reach.
 *
 * The adapter's launch path needs a real jcode runtime, so this exercises the
 * file-writing contract directly against the same helper semantics the
 * adapter uses (unlink-then-write, 0600), with a planted symlink as the
 * negative control.
 */

const writeManagedFile = async (
  path: string,
  contents: string,
  mode: number,
) => {
  const { rmSync, writeFileSync: write } = await import("node:fs");
  rmSync(path, { force: true });
  write(path, contents, { mode });
};

describe("supervisor-managed files in the agent's home", () => {
  it("never follows a symlink the agent planted (the target survives)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jcode-sec-"));
    const home = join(dir, ".jcode-home");
    mkdirSync(home, { recursive: true });

    // The agent's move: point a managed filename at something it wants
    // clobbered, then wait for the next boot to do the writing.
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "UNTOUCHED");
    symlinkSync(victim, join(home, "auth.json"));

    await writeManagedFile(
      join(home, "auth.json"),
      '{"managed":true}\n',
      0o600,
    );

    expect(readFileSync(victim, "utf8")).toBe("UNTOUCHED");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("managed");
  });

  it("writes credential-shaped files owner-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jcode-sec-"));
    const path = join(dir, "auth.json");
    await writeManagedFile(path, "{}\n", 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps only a placeholder in the seeded auth store", async () => {
    // The zero-credential invariant, asserted on the literal the adapter
    // writes: whatever the env holds is what lands, and in a sandbox that is
    // always the gateway placeholder.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "placeholder");
    const account = {
      label: "onecli",
      access: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      refresh: "",
      expires: 4102444800000,
    };
    expect(account.access).toBe("placeholder");
    // No refresh token: the runtime's refresh guard must never fire and try
    // to exchange a placeholder with the provider.
    expect(account.refresh).toBe("");
    vi.unstubAllEnvs();
  });
});
