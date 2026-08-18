import { IS_CLOUD } from "./lib/env";
import { cryptoService as kmsCrypto } from "./ee/kms-crypto";
import * as oauthOrg from "./apps/oauth-org";
import { appAvailability as eeAppAvailability } from "./ee/apps/app-availability-provider";
import { enforceSsoSession } from "./ee/sso/sso-enforcement";
import { orgAppConfig } from "./apps/org-app-config";
import {
  eeWorkspaceAccessChecker,
  getUserRole,
} from "./ee/services/authorization-service";
import { eeConnectionHooks } from "./ee/hooks/connection-hooks";
import { eeResourceHooks } from "./ee/hooks/resource-hooks";
import { eeTeamHooks } from "./ee/hooks/team-hooks";
import { eeRuleActionGate } from "./ee/hooks/rule-action-gate";
import { eePolicyValidator } from "./ee/granular-access";
import { eeNewOrgPolicySeeder } from "./ee/services/new-org-policy-seeder";
import { onpremNewWorkspacePolicySeeder } from "./services/policy-onprem-seeder";
import { pgAttachmentBlobStore } from "./services/attachments/pg-blob-store";
import { setDefaultAttachmentStore } from "./providers/attachment-store";
import { isEntitled } from "./lib/entitlements";
import { setDefaultCrypto } from "./providers/crypto";
import { initOAuthOrg, setDefaultOAuthOrg } from "./providers/oauth-org";
import { setDefaultAppAvailability } from "./providers/app-availability";
import { setDefaultSessionEnforcer } from "./providers/session-enforcer";
import {
  initOrgAppConfig,
  setDefaultOrgAppConfig,
} from "./providers/org-app-config";
import {
  initRoleResolver,
  setDefaultRoleResolver,
} from "./providers/role-resolver";
import {
  initWorkspaceAccessChecker,
  setDefaultWorkspaceAccessChecker,
} from "./providers/access-checker";
import { setDefaultConnectionHooks } from "./providers/hooks/connection-hooks";
import { setDefaultResourceHooks } from "./providers/hooks/resource-hooks";
import {
  setDefaultTeamHooks,
  initTeamHooks,
} from "./providers/hooks/team-hooks";
import { setDefaultRuleActionGate } from "./providers/hooks/rule-action-gate";
import { setDefaultPolicyValidator } from "./providers/hooks/policy-validator";
import { setDefaultNewOrgPolicySeeder } from "./providers/hooks/new-org-policy-seeder";
import { markEditionDefaultsApplied } from "./providers/edition-state";

let applied = false;

/**
 * Inject the running edition's provider defaults, once per process.
 *
 * The provider getters themselves stay CLIENT-SAFE: several cloud
 * implementations (KMS crypto, SSO enforcement, RBAC, the quota/plan graph
 * with its Redis client, the policy seeders with the DB client) must never
 * enter a browser bundle, and provider getters ride service graphs that
 * client files import. So the cloud implementations live here — a module
 * exported from the package ROOT only, imported exclusively by server entry
 * points — and are injected imperatively. STILL required on every server boot
 * path:
 *
 * - `createApiApp` — every HTTP host (web /v1 catch-all, api-server, SCIM).
 * - the web app's eager server init (`lib/init/server.ts`) — server actions
 *   call the shared services directly without ever running `createApiApp`.
 * - standalone server scripts (`cloud-scripts/*`) that touch providers.
 *
 * A cloud read of an uninjected default FAILS LOUDLY (see
 * `providers/edition-state.ts`) — silently falling through to the onprem
 * default would mean quotas, RBAC, SSO, or KMS quietly off on the hosted
 * platform. Idempotent: guarded to run once per process.
 */
export const ensureEditionDefaults = (): void => {
  if (applied) return;
  applied = true;

  // Attachment BYTES (free feature — deliberately outside the ee/ block
  // below): the inline-Postgres store serves both editions today. Like the
  // policy seeder, both arms ride the DB client, so the impl is injected
  // here rather than resolved as a static onprem default. Cloud's future
  // scalable arm (S3) replaces this line behind config presence (bucket env
  // set), never an edition branch — rows dispatch per `storageRef`, so mixed
  // backends coexist.
  setDefaultAttachmentStore(pgAttachmentBlobStore);

  // Org-scoped OAuth interception and the org app-config tier are shared
  // features (both editions serve /org/apps + /org/connections), but their
  // implementations ride the DB client and the connection services — too
  // heavy for the client-reachable providers barrel. So, like the attachment
  // store above, they are injected here on every server boot: the cloud arm
  // through the slot's cloud default, the onprem arm through the override
  // (`init*`, the same route `initRoleResolver` rides — a slot's cloud
  // default is invisible to the onprem getter).
  if (IS_CLOUD) {
    setDefaultOAuthOrg(oauthOrg);
    setDefaultOrgAppConfig(orgAppConfig);
  } else {
    initOAuthOrg(oauthOrg);
    initOrgAppConfig(orgAppConfig);
  }

  if (IS_CLOUD) {
    setDefaultCrypto(kmsCrypto);
    setDefaultAppAvailability(eeAppAvailability);
    setDefaultSessionEnforcer(enforceSsoSession);
    setDefaultRoleResolver({ getUserRole });
    setDefaultWorkspaceAccessChecker(eeWorkspaceAccessChecker);
    setDefaultConnectionHooks(eeConnectionHooks);
    setDefaultResourceHooks(eeResourceHooks);
    setDefaultTeamHooks(eeTeamHooks);
    setDefaultRuleActionGate(eeRuleActionGate);
    setDefaultPolicyValidator(eePolicyValidator);
    setDefaultNewOrgPolicySeeder(eeNewOrgPolicySeeder);
  } else {
    // The seeder is the one provider whose ONPREM arm is also too heavy for
    // the client graph (it rides policy-service → the DB client).
    setDefaultNewOrgPolicySeeder(onpremNewWorkspacePolicySeeder);

    // A LICENSED self-host gets role enforcement (#66): CAPS.rbac flips on
    // via the entitlement, and the role reads come from the same DB-backed
    // resolver cloud uses. `initRoleResolver`, not `setDefaultRoleResolver`:
    // the "cloud default" arm of a slot is invisible to the onprem getter, so
    // the injection must ride the override arm here. Unlicensed keeps the
    // null resolver — the flat-team behavior role checks fall back to.
    if (isEntitled()) {
      initRoleResolver({ getUserRole });
      // The workspace-access checker rides the same override arm: the shared
      // predicates delegate to the licensed admin-or-binding resolution the
      // moment CAPS.rbac flips on, in lockstep with the resolver.
      initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
      // Same reasoning for the team hooks: a licensed self-host reconciles
      // invited roles against directory group mappings. Its seat-cap half is
      // inert here — quotas are a billing concept and this edition has none —
      // so injecting the pair together costs nothing.
      initTeamHooks(eeTeamHooks);
    }
  }

  markEditionDefaultsApplied();
};
