import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import { channelProvider } from "./registry";
import type {
  ChannelProviderId,
  UserLinkSource,
  ValidatedIntegrationCredential,
} from "./types";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "channel-integration-service" });

/**
 * Org-level channel integrations: the link between an organization and one
 * provider tenant (Slack: the workspace), holding the OPTIONAL automation
 * credential (Slack: the rotating app-configuration token pair).
 *
 * Free models, deliberately apart from the EE org-credential store: no
 * `requireEnterprise`, no `getOrgAppConfig()`, no `app_configs` rows — the
 * separation the boundary review checks for (§3.16 placement note).
 */

const integrationSelect = {
  id: true,
  provider: true,
  externalId: true,
  name: true,
  credentials: true,
  credentialsRotatedAt: true,
  createdAt: true,
} as const;

export interface IntegrationView {
  provider: ChannelProviderId;
  externalId: string;
  name: string | null;
  /** A usable automation credential is stored. */
  hasCredentials: boolean;
  /**
   * The credential died (rotation refused) and needs a re-paste. DERIVED, not
   * a column: connected once (`credentialsRotatedAt` set) but `credentials`
   * now null. A paste-floor integration — never had a credential — reads
   * false here and `hasCredentials` false: absence, not failure.
   */
  needsCredentials: boolean;
  credentialsRotatedAt: Date | null;
  presenceCount: number;
}

export const getIntegrationView = async (
  organizationId: string,
): Promise<IntegrationView[]> => {
  const rows = await db.channelIntegration.findMany({
    where: { organizationId },
    select: {
      ...integrationSelect,
      _count: { select: { agentChannels: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    provider: row.provider as ChannelProviderId,
    externalId: row.externalId,
    name: row.name,
    hasCredentials: row.credentials !== null,
    needsCredentials:
      row.credentials === null && row.credentialsRotatedAt !== null,
    credentialsRotatedAt: row.credentialsRotatedAt,
    presenceCount: row._count.agentChannels,
  }));
};

/**
 * Connect (or re-connect) the org's automation credential for a provider.
 * The provider validates and normalizes the paste — for Slack, by rotating
 * it, which also names the workspace.
 */
export const connectIntegration = async (
  organizationId: string,
  provider: ChannelProviderId,
  rawCredential: string,
  actorUserId: string,
) => {
  const validated =
    await channelProvider(provider).connectIntegration(rawCredential);
  const encrypted = await getCrypto().encrypt(validated.credentialsJson);

  const existing = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: {
      id: true,
      externalId: true,
      _count: { select: { agentChannels: true } },
    },
  });

  if (existing && existing.externalId !== validated.tenant.externalId) {
    // A credential for a DIFFERENT workspace while presences live on the old
    // one would silently orphan every attached agent. Rebinding is a
    // deliberate act: detach first.
    if (existing._count.agentChannels > 0) {
      throw new ServiceError(
        "CONFLICT",
        "This token belongs to a different Slack workspace than the agents already attached here. Detach them first, or paste a token for the connected workspace.",
      );
    }
    await db.channelIntegration.update({
      where: { id: existing.id },
      data: {
        externalId: validated.tenant.externalId,
        name: validated.tenant.name,
        credentials: encrypted,
        credentialsRotatedAt: new Date(),
        createdByUserId: actorUserId,
      },
    });
    return { provider, tenant: validated.tenant };
  }

  await db.channelIntegration.upsert({
    where: { organizationId_provider: { organizationId, provider } },
    create: {
      organizationId,
      provider,
      externalId: validated.tenant.externalId,
      name: validated.tenant.name,
      credentials: encrypted,
      credentialsRotatedAt: new Date(),
      createdByUserId: actorUserId,
    },
    update: {
      credentials: encrypted,
      credentialsRotatedAt: new Date(),
    },
  });
  return { provider, tenant: validated.tenant };
};

/**
 * Disconnect the org credential. Presences keep working — their tokens are
 * their own — so the row survives (links and tenant identity hang off it) with
 * the credential cleared; only an integration nothing references disappears
 * entirely.
 */
export const disconnectIntegration = async (
  organizationId: string,
  provider: ChannelProviderId,
): Promise<void> => {
  const existing = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: {
      id: true,
      _count: { select: { agentChannels: true, userLinks: true } },
    },
  });
  if (!existing) throw new ServiceError("NOT_FOUND", "Integration not found");

  if (existing._count.agentChannels === 0 && existing._count.userLinks === 0) {
    await db.channelIntegration.delete({ where: { id: existing.id } });
    return;
  }
  await db.channelIntegration.update({
    where: { id: existing.id },
    // The timestamp goes WITH the credential: `needsCredentials` derives "the
    // token died" from `credentials == null && credentialsRotatedAt != null`,
    // so leaving it would make a deliberate disconnect read as a failure.
    data: { credentials: null, credentialsRotatedAt: null },
  });
};

/**
 * Rotate-on-use: run `fn` with a fresh provider access token. The replacement
 * pair is persisted in ONE update before `fn` runs — the refresh half is
 * single-use, so a torn write (new pair in memory, old pair on disk) would
 * strand the org; encrypt-then-single-UPDATE cannot tear.
 *
 * A refused rotation clears the stored credential (the pair is dead — Slack
 * refresh tokens are consumed by the attempt) so the org page surfaces the
 * re-paste state, then rethrows for the caller's error envelope.
 */
export const withFreshIntegrationCredentials = async <T>(
  organizationId: string,
  provider: ChannelProviderId,
  fn: (accessToken: string, integrationId: string) => Promise<T>,
): Promise<T> => {
  const row = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: { id: true, credentials: true, externalId: true },
  });
  if (!row?.credentials) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The organization has no Slack automation token. Connect one in the org's Channels settings, or use the manifest flow instead.",
    );
  }

  const crypto = getCrypto();
  const storedCiphertext = row.credentials;
  let credentialsJson = await crypto.decrypt(storedCiphertext);

  const impl = channelProvider(provider);
  let rotated: ValidatedIntegrationCredential | null;
  try {
    rotated = await impl.rotateIntegrationCredential(credentialsJson);
  } catch (err) {
    log.warn(
      { err, organizationId, provider },
      "integration credential rotation refused; clearing for re-paste",
    );
    // Fence the clear on the ciphertext we read: a concurrent call that
    // already rotated to a fresh pair must NOT have its valid credential
    // wiped by our stale refusal (Slack refresh tokens are single-use, so the
    // loser's rotate always fails — without the fence it would destroy the
    // winner's still-good pair).
    await db.channelIntegration.updateMany({
      where: { id: row.id, credentials: storedCiphertext },
      data: { credentials: null },
    });
    throw new ServiceError(
      "UNPROCESSABLE",
      "The stored Slack automation token has expired and could not be refreshed. Paste a fresh one in the org's Channels settings.",
    );
  }

  if (rotated !== null) {
    if (rotated.tenant.externalId !== row.externalId) {
      // The rotation succeeded but named a workspace other than the one this
      // org is bound to. Persisting the pair would hand the org's automation
      // credential to a foreign tenant — and the stored pair is dead anyway
      // (the rotate consumed its refresh half) — so refuse exactly like a
      // dead credential: fenced clear, re-paste surfaced. The tenant binding
      // (`externalId`) is never rebound outside `connectIntegration`.
      log.warn(
        {
          organizationId,
          provider,
          expected: row.externalId,
          actual: rotated.tenant.externalId,
        },
        "rotated integration credential names a different workspace; clearing",
      );
      await db.channelIntegration.updateMany({
        where: { id: row.id, credentials: storedCiphertext },
        data: { credentials: null },
      });
      throw new ServiceError(
        "CONFLICT",
        "The stored Slack automation token belongs to a different workspace than the one connected to this organization. Paste a token for the connected workspace in the org's Channels settings.",
      );
    }
    const encrypted = await crypto.encrypt(rotated.credentialsJson);
    // Same fence on the write: only replace the pair we actually rotated from.
    await db.channelIntegration.updateMany({
      where: { id: row.id, credentials: storedCiphertext },
      data: { credentials: encrypted, credentialsRotatedAt: new Date() },
    });
    credentialsJson = rotated.credentialsJson;
  }

  const { accessToken } = JSON.parse(credentialsJson) as {
    accessToken: string;
  };
  return fn(accessToken, row.id);
};

/** Proactively rotate anything not rotated for this long. Half the 12h
 * access-token lifetime, so even a whole failed sweep leaves a full margin. */
const PROACTIVE_ROTATE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The proactive rotation sweep, called by the channel adapter (~hourly): keep
 * every stored integration credential fresh even when nothing USES it.
 * Exists because whether an unused refresh token outlives its access token is
 * undocumented (verified 2026-08-07) — lazy rotate-on-use alone would gamble
 * an idle org's credential on that silence. Serialized per integration on
 * purpose: each rotation invalidates the previous refresh token, and the
 * fenced writes (same discipline as `withFreshIntegrationCredentials`) make a
 * concurrent user-triggered rotation safe.
 */
export const rotateStaleIntegrations = async (): Promise<{
  rotated: number;
  failed: number;
}> => {
  const cutoff = new Date(Date.now() - PROACTIVE_ROTATE_AGE_MS);
  const stale = await db.channelIntegration.findMany({
    where: {
      credentials: { not: null },
      OR: [
        { credentialsRotatedAt: null },
        { credentialsRotatedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, provider: true, credentials: true, externalId: true },
  });

  const crypto = getCrypto();
  let rotated = 0;
  let failed = 0;
  for (const row of stale) {
    if (!row.credentials) continue;
    try {
      const json = await crypto.decrypt(row.credentials);
      const next = await channelProvider(
        row.provider as ChannelProviderId,
      ).rotateIntegrationCredential(json, { force: true });
      if (next === null) continue;
      if (next.tenant.externalId !== row.externalId) {
        // Same refusal as the rotate-on-use path: a pair naming a foreign
        // workspace is never persisted — fenced clear, re-paste surfaced.
        log.warn(
          {
            integrationId: row.id,
            expected: row.externalId,
            actual: next.tenant.externalId,
          },
          "proactive rotation named a different workspace; clearing",
        );
        await db.channelIntegration
          .updateMany({
            where: { id: row.id, credentials: row.credentials },
            data: { credentials: null },
          })
          .catch(() => {});
        failed += 1;
        continue;
      }
      const encrypted = await crypto.encrypt(next.credentialsJson);
      await db.channelIntegration.updateMany({
        where: { id: row.id, credentials: row.credentials },
        data: { credentials: encrypted, credentialsRotatedAt: new Date() },
      });
      rotated += 1;
    } catch (err) {
      // A refused rotation means the pair is dead (rotation consumes the
      // refresh token) — clear it, fenced, so the org page shows re-paste.
      log.warn(
        { err, integrationId: row.id },
        "proactive rotation refused; clearing for re-paste",
      );
      await db.channelIntegration
        .updateMany({
          where: { id: row.id, credentials: row.credentials },
          data: { credentials: null },
        })
        .catch(() => {});
      failed += 1;
    }
  }
  return { rotated, failed };
};

// ── User links: provider user ↔ platform user, per integration ──────────────

const userLinkSelect = {
  id: true,
  externalUserId: true,
  linkedVia: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

export const listUserLinks = async (organizationId: string) =>
  db.channelUserLink.findMany({
    where: { integration: { organizationId } },
    select: { ...userLinkSelect, integration: { select: { provider: true } } },
    orderBy: { createdAt: "asc" },
  });

/**
 * An explicit (admin-made) link. The target must be an ACTIVE member of this
 * org — a link is an authorization input, and pointing one at a foreign or
 * suspended user would let a provider identity borrow access nobody granted.
 */
export const addUserLink = async (
  organizationId: string,
  provider: ChannelProviderId,
  input: { externalUserId: string; userId: string },
  linkedVia: UserLinkSource = "manual",
) => {
  const integration = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: { id: true },
  });
  if (!integration) {
    throw new ServiceError(
      "NOT_FOUND",
      "Connect the workspace before linking users",
    );
  }

  const membership = await db.organizationMember.findFirst({
    where: {
      organizationId,
      userId: input.userId,
      NOT: { status: "suspended" },
    },
    select: { userId: true },
  });
  if (!membership) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "That user is not an active member of this organization",
    );
  }

  try {
    return await db.channelUserLink.create({
      data: {
        integrationId: integration.id,
        externalUserId: input.externalUserId.trim(),
        userId: input.userId,
        linkedVia,
      },
      select: userLinkSelect,
    });
  } catch (err) {
    // Both uniques — (integration, externalUserId) and (integration, userId) —
    // surface a normal re-link attempt; a 409 is the honest answer, not a 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "That member or Slack account is already linked.",
      );
    }
    throw err;
  }
};

export const removeUserLink = async (
  organizationId: string,
  linkId: string,
): Promise<void> => {
  // Fenced delete: the link must belong to this org's integration.
  const removed = await db.channelUserLink.deleteMany({
    where: { id: linkId, integration: { organizationId } },
  });
  if (removed.count === 0) {
    throw new ServiceError("NOT_FOUND", "Link not found");
  }
};
