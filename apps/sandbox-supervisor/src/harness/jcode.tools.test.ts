import { describe, expect, it } from "vitest";
import { JCODE_DISABLED_TOOLS_VALUE, managedConfigToml } from "./jcode";

/**
 * The harness-native tool kill-switches, pinned. These two values are what
 * keeps a hosted agent gateway-first: the env list removes the runtime's own
 * integration tooling from the model's tool list, and the config opt-out
 * stops the sponsor catalog from registering at all. Both were live-observed
 * steering an agent into vendor login flows and third-party product
 * recommendations before it found the gateway.
 */

describe("the disabled harness-native tools", () => {
  it("disables the gateway competitors alongside the platform duplicates", () => {
    // MUTATION-PROOF: drop any entry and this fails. The exact-string pin is
    // deliberate — this constant IS the launch env value, and upstream
    // matches names exactly (aliases resolved on its side). `memory` is the
    // write-back amendment's lockdown: [features] memory=false alone leaves
    // the native tool callable (v0.71.1 source), and platform memory must be
    // the ONLY memory.
    expect(JCODE_DISABLED_TOOLS_VALUE).toBe(
      "schedule,skill_manage,gmail,integration_tools,memory",
    );
  });
});

describe("the managed config's sponsor opt-out", () => {
  it("opts out of integration discovery", () => {
    expect(managedConfigToml).toMatch(/\[sponsors\]\nenabled = false/);
  });

  it("never writes an endpoint key — that shape trips the upstream repair", () => {
    // The harness force-re-enables a [sponsors] section holding exactly
    // enabled=false PLUS its default endpoint (it reads that pair as
    // machine-written); a bare enabled=false is respected. MUTATION-PROOF:
    // add `endpoint = "..."` to the section and this fails.
    expect(managedConfigToml).not.toMatch(/endpoint/);
  });
});
