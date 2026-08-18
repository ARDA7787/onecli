"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { channels } from "@/lib/api";
import type { ChannelProvider, CompletePresenceInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Channel mutations are headless (the use-app-config convention): the callers
// (the agent Channels section, the org settings cards) own the toasts. No
// `invalidateGatewayCache()` anywhere — deliberate: the gateway reads none of
// the channel tables (its approvals key is matched by raw string, not cached
// config), so a flush would be pure noise.

/** The one payload the agent's Channels section renders: presences + posture
 * + org-integration availability + adapter liveness. */
export const useAgentChannels = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.channels.agent(agentId),
    queryFn: () => channels.agentView(agentId),
  });

/** The paste floor's step 0 — fetched only while the floor is on screen. */
export const useChannelManifest = (
  agentId: string,
  provider: ChannelProvider,
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.channels.manifest(agentId, provider),
    queryFn: () => channels.manifest(agentId, provider),
    enabled,
  });

/** The guided arm: create the provider app from the org credential. Safe to
 * re-run on a pending presence — the server returns fresh URLs (resume). */
export const useAttachChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => channels.attach(agentId, provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

/** The pasted-tokens completion door (socket arm + the whole paste floor). */
export const useCompleteChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CompletePresenceInput) =>
      channels.complete(agentId, provider, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

export const useDetachChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (options: { deleteRemote: boolean }) =>
      channels.detach(agentId, provider, options),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};
