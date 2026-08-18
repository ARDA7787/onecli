import type { HostedAvailability } from "./availability";
import { showsHostedSurface } from "./availability";

/**
 * ONE create door, not two buttons (amends §3.15's "two doors, never a
 * picker" — which shipped as literally two primary buttons competing for the
 * same corner).
 *
 * The door is chosen by what the user already has, because that is the only
 * honest read of what they came here to do:
 *
 * - Someone who has never made an agent is a NEW user. Hosted is the product;
 *   they get one button and never learn the word "BYO".
 * - Someone who already runs BYO agents came back to make another one. Their
 *   button keeps doing what it always did — changing a returning user's
 *   primary action out from under them is how you break a workflow. Hosted
 *   lives one click away, in the chevron.
 *
 * Hosted is not offered at all where the surface doesn't exist (`absent`, or
 * still `loading` — never flash the wrong door).
 */
export type CreateDoor =
  /** Hosted only: one button, straight into hosted creation. */
  | "hosted"
  /** BYO only: one button, exactly today's flow. No hosted surface here. */
  | "byo"
  /** Split: BYO primary + a chevron whose menu offers hosted. */
  | "byo-with-hosted";

export interface CreateDoorInput {
  /** The workspace's agents. `undefined` while the list is still loading.
   *  `kind` is typed loosely because the server action widens it to `string`;
   *  an unrecognized kind simply isn't legacy, which is the safe read. */
  agents: { kind: string }[] | undefined;
  availability: HostedAvailability;
}

export const createDoor = ({
  agents,
  availability,
}: CreateDoorInput): CreateDoor => {
  const hostedPossible = showsHostedSurface(availability);
  // Still loading: fall back to the flow that always works. A BYO button that
  // later gains a chevron is a quiet upgrade; a hosted button that later
  // disappears is a broken product.
  if (agents === undefined) return hostedPossible ? "byo-with-hosted" : "byo";
  if (!hostedPossible) return "byo";
  // "Has an old agent" is specifically a BYO one. A workspace whose only
  // agents are hosted is already living in the new world.
  const hasLegacy = agents.some((a) => a.kind === "byo");
  return hasLegacy ? "byo-with-hosted" : "hosted";
};

/**
 * The 15-minute onboarding call (cal.com). A legacy user's move to hosted
 * agents is a migration, not a form submission: their BYO setup, their keys
 * and their scripts all have to land somewhere. So the chevron's hosted entry
 * books a human rather than opening the create dialog — deliberately, until
 * self-serve migration exists.
 */
export const ONBOARDING_CALL_URL = "https://cal.com/onecli/15min";
