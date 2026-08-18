"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { useAgents } from "@/hooks/use-agents";
import { useGrantsSummary } from "@/hooks/use-grants";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { showsHostedSurface } from "@/lib/agents/availability";
import { createDoor } from "@/lib/agents/create-door";
import { IS_CLOUD } from "@/lib/env";
import { agentSectionPath, AGENT_CREATE_PARAM } from "@/lib/navigation";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AgentCard } from "./agent-card";
import { CreateAgentDialog } from "./create-agent-dialog";
import { NewHostedAgentDialog } from "./new-hosted-agent-dialog";
import { HostedOnboardingDialog } from "./hosted-onboarding-dialog";
import { AgentCreateDoor, type CreateDoorPrimary } from "./agent-create-door";

interface AgentsContentProps {
  /** Cloud composes its quota-gated primary button in here. */
  renderCreateButton?: (primary: CreateDoorPrimary) => React.ReactNode;
}

export const AgentsContent = ({
  renderCreateButton,
}: AgentsContentProps = {}) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const manageAgentId = searchParams.get("manage");
  const createRequested = searchParams.get(AGENT_CREATE_PARAM) !== null;
  const { data: agents, isPending: loading } = useAgents();
  // The door needs to tell "no agents" from "we don't know yet" (an error
  // leaves `data` undefined with `loading` false), but every RENDER below
  // wants a list — without this, a failed read paints neither cards nor the
  // empty state, just a blank page.
  const agentList = agents ?? [];
  const { data: summaries = [] } = useGrantsSummary();
  const [createOpen, setCreateOpen] = useState(false);
  const [hostedOpen, setHostedOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Read, not polled: the sidebar and the chat section own the availability
  // poll; the shared cache is fresh enough to decide which create door shows.
  const availability = useHostedAvailability();
  // ONE door, chosen by what this user already has (§3.15 as amended).
  const door = createDoor({ agents, availability });
  // A legacy user's move to hosted is a migration, so their hosted entry books
  // the onboarding call; a new user goes straight into creation. Cloud only:
  // the call migrates them onto OUR runners. A self-host deployment's hosted
  // agents run on its own runner — there is nothing for us to migrate, so its
  // chevron opens hosted creation directly.
  const onCreateHosted = () =>
    door === "hosted" || !IS_CLOUD
      ? setHostedOpen(true)
      : setOnboardingOpen(true);

  // `?new=1` (the primary button's landing): open the create flow on arrival
  // and strip the param, so a refresh doesn't reopen it.
  //
  // It opens THE SAME door the page's own create button would (§3.15 as
  // amended) — deliberately routed through `onCreateHosted`, so a legacy BYO
  // user still gets the onboarding call rather than being dropped into hosted
  // creation. Opening the hosted dialog directly here would have quietly
  // bypassed that migration gate for anyone arriving by link.
  //
  // Waits for BOTH reads the door depends on: availability, and the agent
  // list (`createDoor` treats `undefined` as "still loading" and falls back to
  // BYO), so a first paint can't pick the wrong door.
  //
  // The guard is the PARAM's presence, never a latch: stripping it is what
  // makes this fire once, so pressing the button again on this same page
  // reopens the dialog. A one-shot ref silently broke that second press.
  useEffect(() => {
    if (!createRequested || availability === "loading" || loading) return;
    if (showsHostedSurface(availability)) onCreateHosted();
    else setCreateOpen(true);
    const params = new URLSearchParams(searchParams);
    params.delete(AGENT_CREATE_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
    // `onCreateHosted` is intentionally not a dependency: it is recreated every
    // render, and the door it picks is already pinned by `availability` and
    // `door` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    createRequested,
    availability,
    loading,
    door,
    searchParams,
    router,
    pathname,
  ]);

  // `?manage=<id-prefix>` (attach-model step 3): the deep link lands on the
  // agent page's Connections section — the attach surfaces live there now. Prefix
  // matching preserved from the old dialog-opening behavior; one-shot per
  // mount.
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current || !manageAgentId || !agents?.length) return;
    const target = agents.find((a) => a.id.startsWith(manageAgentId));
    if (!target) return;
    redirected.current = true;
    router.replace(agentSectionPath(pathname, target.id, "connections"));
    // Depends on `agents` (the query's stable reference), never on the
    // `agentList` fallback: a fresh array literal every render would re-run
    // this effect on every render.
  }, [manageAgentId, agents, router, pathname]);

  const summaryByAgent = new Map(summaries.map((s) => [s.id, s.grantsSummary]));

  // Gate only on the agents read. Availability "loading" deliberately falls
  // back to the BYO door (see createDoor) rather than holding the page:
  // useInstance returns null for BOTH in-flight and failed reads, so waiting
  // on it would turn an instance-read failure into a permanent skeleton.
  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <AgentCreateDoor
          door={door}
          onCreateByo={() => setCreateOpen(true)}
          onCreateHosted={onCreateHosted}
          renderPrimary={renderCreateButton}
        />
      </div>

      {agentList.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <AgentIcon className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No agents yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            {/* Describes the PRIMARY button on this page — keyed to the door,
                not the hosted surface: a failed agents read leaves the split
                door over an empty list, where the visible primary is BYO and
                promising the brief-and-chat flow would point at a button that
                isn't there. */}
            {door === "hosted"
              ? "Create an agent, give it a brief, and start chatting."
              : "Create an agent to generate an access token for connecting to the gateway."}
          </p>
        </Card>
      ) : (
        agentList.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            summary={summaryByAgent.get(agent.id)}
          />
        ))
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <NewHostedAgentDialog open={hostedOpen} onOpenChange={setHostedOpen} />
      <HostedOnboardingDialog
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
      />
    </div>
  );
};
