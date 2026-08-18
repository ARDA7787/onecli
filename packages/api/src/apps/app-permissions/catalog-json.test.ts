import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAppPermissionDefinitions } from "./index";
import { buildCatalogJson, serializeCatalogJson } from "./catalog-json";
import { allGroupTools } from "./types";

// Drift check: the catalog JSON the gateway embeds (its own build artifact, next
// to the engine) must equal the current TS catalog — one unified file covering
// every provider. Regenerate with `pnpm generate:catalog` after editing any
// provider's tools.
const gatewayCatalog = (relPath: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../apps/gateway/src/${relPath}`, import.meta.url),
    ),
    "utf8",
  );

describe("gateway catalog JSON stays in sync with the TS catalog", () => {
  it("catalog.generated.json (every registered provider)", () => {
    expect(gatewayCatalog("policy_engine/catalog.generated.json")).toBe(
      serializeCatalogJson(buildCatalogJson(getAppPermissionDefinitions())),
    );
  });
});

// Guards the one app-target fidelity divergence the step-4 shadow bake CANNOT
// catch (the shadow uses network-verbatim projection, no catalog): a tool
// authored with an explicit empty `methods: []` fans out to zero variants in TS
// `allRuleVariants` (matches nothing) but is read as "any method" by the
// gateway's catalog.rs (fail-open). Genuine any-method tools omit method/methods.
describe("catalog tools never author an explicit empty methods array", () => {
  it("every registered provider", () => {
    for (const def of getAppPermissionDefinitions()) {
      for (const group of def.groups) {
        for (const tool of allGroupTools(group)) {
          expect(
            Array.isArray(tool.methods) && tool.methods.length === 0,
            `${def.provider}/${tool.id}: explicit "methods: []" is fail-open — use a real method list or omit method/methods for any-method`,
          ).toBe(false);
        }
      }
    }
  });
});
