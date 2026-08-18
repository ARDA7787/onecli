"use client";

import { usePendingApprovals } from "@/hooks/use-approvals";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { InlineApprovalItem } from "./inline-approval-item";

/**
 * Pending gateway approvals, inside the conversation they belong to (step-5
 * debt): while the agent is blocked on a held request, the person watching the
 * thread must see it HERE, not only in the header bell. Rides the same
 * long-poll cache entry as the bell (`usePendingApprovals`), filtered to this
 * agent; decisions go through the shared `ApprovalActions` pair, so optimistic
 * removal and rollback behave identically in both places.
 *
 * Renders nothing when this agent has nothing pending — the strip reserves no
 * space in the chat column.
 */
export const InlineApprovals = () => {
  const agent = useAgentPageAgent();
  const { data: approvals = [] } = usePendingApprovals();
  const mine = approvals.filter((a) => a.agent.id === agent.id);

  if (mine.length === 0) return null;

  return (
    <div className="shrink-0 px-3 pt-2">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {mine.map((approval) => (
          <InlineApprovalItem key={approval.id} approval={approval} />
        ))}
      </div>
    </div>
  );
};
