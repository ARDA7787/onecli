"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalActions } from "@/lib/components/approvals/approval-actions";
import {
  formatCountdown,
  useCountdown,
} from "@/lib/components/approvals/use-countdown";

/**
 * One held request as a compact chat-strip row: the same summary + countdown +
 * decision pair the header bell renders, minus the agent name — the strip only
 * ever shows THIS agent's approvals, so naming it would be noise.
 */
export const InlineApprovalItem = ({
  approval,
}: {
  approval: PendingApproval;
}) => {
  const remaining = useCountdown(approval.expiresAt);
  const urgent = remaining <= 30;

  return (
    <div className="bg-muted/50 flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {approval.summary?.action ?? `${approval.method} request`}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {approval.host} ·{" "}
          <span
            className={cn(
              "font-mono tabular-nums",
              urgent && "text-amber-600 dark:text-amber-500",
            )}
          >
            {formatCountdown(remaining)}
          </span>
        </p>
      </div>
      <ApprovalActions
        approvalId={approval.id}
        size="xs"
        className="shrink-0"
      />
    </div>
  );
};
