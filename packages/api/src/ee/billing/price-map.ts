import type { Plan } from "./plans";
import { STRIPE_PRO_PRICE_ID } from "../../lib/env";
import {
  STRIPE_ENTERPRISE_PRICE_ID,
  STRIPE_PRO_YEARLY_PRICE_ID,
  STRIPE_SCALE_PRICE_ID,
  STRIPE_SCALE_SELF_HOSTED_PRICE_ID,
  STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID,
  STRIPE_SCALE_YEARLY_PRICE_ID,
  STRIPE_TEAM_BASE_PRICE_ID,
  STRIPE_TEAM_LEGACY_PRICE_ID,
  STRIPE_TEAM_YEARLY_PRICE_ID,
} from "./env";

/**
 * The single Stripe-price → plan mapping. Stripe is the source of truth for
 * `Organization.subscriptionStatus` (webhooks write it, the billing
 * reconcile-on-read converges it) — every consumer must share this map or
 * plans drift by code path.
 *
 * Unset ids are skipped: an empty-string key would otherwise map Stripe
 * items with missing price ids to whichever plan spread last.
 */
export const buildPriceToPlan = (
  entries: [priceId: string, plan: Plan][],
): Record<string, Plan> =>
  Object.fromEntries(entries.filter(([priceId]) => priceId.length > 0));

export const PRICE_TO_PLAN: Record<string, Plan> = buildPriceToPlan([
  [STRIPE_PRO_PRICE_ID, "pro"],
  [STRIPE_PRO_YEARLY_PRICE_ID, "pro"],
  [STRIPE_TEAM_BASE_PRICE_ID, "team"],
  [STRIPE_TEAM_YEARLY_PRICE_ID, "team"],
  // Pre-July-2026 $200/mo Team price. Subscriptions keep billing on a
  // retired price until they next switch plans, so a retired price must stay
  // mapped while ANY live subscription holds it — dropping a live price id
  // silently resolves those orgs to the "pro" fallback and rewrites their
  // plan in the DB. (The July-2026 $149 pair was dropped only after a
  // live-Stripe audit found zero remaining subscriptions.)
  [STRIPE_TEAM_LEGACY_PRICE_ID, "team"],
  [STRIPE_SCALE_PRICE_ID, "scale"],
  [STRIPE_SCALE_YEARLY_PRICE_ID, "scale"],
  // Managed self-hosting (sales-managed, dashboard-created).
  [STRIPE_SCALE_SELF_HOSTED_PRICE_ID, "scale"],
  [STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID, "scale"],
  // Sales-managed: subscriptions on this price are created from the Stripe
  // dashboard, never via self-serve checkout.
  [STRIPE_ENTERPRISE_PRICE_ID, "enterprise"],
]);

/** Base price ids this deployment recognizes. */
export const KNOWN_BASE_PRICE_IDS = Object.keys(PRICE_TO_PLAN);
