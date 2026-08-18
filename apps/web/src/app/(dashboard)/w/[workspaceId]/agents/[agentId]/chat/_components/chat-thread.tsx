"use client";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@onecli/ui/components/message-scroller";
import type { Turn } from "@/lib/api/types";
import type { OutgoingMessage } from "@/hooks/use-conversations";
import type { RenderedTurn } from "@/lib/chat/transcript";
import { isFollowUpRow } from "@/lib/chat/turns";
import { TurnBlock } from "./turn-block";
import { UserBubble } from "./user-bubble";

/**
 * The conversation as the reader sees it. Purely presentational: turns give
 * the order and the user side; the folded transcript gives the agent side.
 *
 * Mid-run follow-ups (`joining`/`joined` rows) render WITH their target turn
 * — between its user bubble and its agent block — so the answer that covers
 * them is the LAST thing in the exchange, not something their bubbles dangle
 * under looking unanswered. A follow-up whose target isn't in the list (a
 * pathological orphan) falls back to its own row so it is never invisible.
 */
interface ChatThreadProps {
  turns: Turn[];
  folded: ReadonlyMap<string, RenderedTurn>;
  /** The optimistic user message riding the send/refetch seam — text plus
   *  the staged attachments' local previews. */
  pending?: OutgoingMessage;
  /** Where the pending row's attachment chips resolve their blobs. */
  conversationId: string;
  /** Where a "connect a model key" notice points. */
  modelsHref?: string;
}

export const ChatThread = ({
  turns,
  folded,
  pending,
  conversationId,
  modelsHref,
}: ChatThreadProps) => {
  const targetIds = new Set(turns.map((turn) => turn.id));
  const followUpsByTarget = new Map<string, Turn[]>();
  for (const turn of turns) {
    if (!isFollowUpRow(turn) || !turn.followUpOfTurnId) continue;
    if (!targetIds.has(turn.followUpOfTurnId)) continue; // orphan → own row
    const group = followUpsByTarget.get(turn.followUpOfTurnId) ?? [];
    group.push(turn);
    followUpsByTarget.set(turn.followUpOfTurnId, group);
  }
  const grouped = new Set(
    [...followUpsByTarget.values()].flat().map((turn) => turn.id),
  );

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
            {turns
              .filter((turn) => !grouped.has(turn.id))
              .map((turn) => (
                <MessageScrollerItem key={turn.id} messageId={turn.id}>
                  <TurnBlock
                    turn={turn}
                    rendered={folded.get(turn.id)}
                    followUps={followUpsByTarget.get(turn.id)}
                    modelsHref={modelsHref}
                  />
                </MessageScrollerItem>
              ))}
            {pending !== undefined && (
              <MessageScrollerItem messageId="pending">
                <UserBubble
                  text={pending.message}
                  conversationId={conversationId}
                  attachments={pending.attachments}
                />
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
};
