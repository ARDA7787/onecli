-- `web` reuses the network target's host/path/method columns, but makes the
-- host optional so an empty selector means every public-web destination.
-- Prisma cannot express this CHECK, so keep the hand-authored target-shape
-- constraint in lockstep with PolicyRuleTarget.kind.
ALTER TABLE "policy_rule_targets" DROP CONSTRAINT "policy_rule_targets_kind_shape";
ALTER TABLE "policy_rule_targets" ADD CONSTRAINT "policy_rule_targets_kind_shape" CHECK (
    (kind = 'app' AND "app_provider" IS NOT NULL AND "app_connection_id" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'connection' AND "app_connection_id" IS NOT NULL AND "app_provider" IS NULL AND "app_connection_scope" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'secret' AND num_nonnulls("secret_id", "secret_scope") = 1 AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "app_connection_scope" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'network' AND "host_pattern" IS NOT NULL AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "app_connection_scope" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL)
    OR (kind = 'web' AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "app_connection_scope" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL)
);
