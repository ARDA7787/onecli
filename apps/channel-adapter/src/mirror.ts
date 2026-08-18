import { escapeSlackText, type AdapterWorkItem } from "@onecli/agent-protocol";
import type { ControlPlaneClient } from "./control-plane";
import { replyTargetForLink } from "./targets";
import { postMessage } from "./slack/client";
import { markdownToMrkdwn } from "./slack/mrkdwn";

/**
 * The COMPLETION PASS — the one and only answer path (the de-streaming
 * decision, recorded in the step-6 plan notes): every finished turn on a
 * linked conversation posts here, exactly once, on completion.
 *
 * - A PROVIDER-originated turn posts its answer (or its error — a door
 *   failure's `turn.error` IS the answer). The user's "seen" signal while it
 *   ran was the reaction receipt, which the control plane clears on this
 *   pass's winning claim.
 * - A WEB-originated turn is mirrored — question attributed, then the
 *   answer — so both doors of the same conversation stay visually in sync.
 *
 * The cursor makes it exactly-once: the work poll only surfaces finished
 * turns past `mirrorCursor`, and the cursor advances by COMPARE-AND-SET —
 * an adapter twin (deploy overlap, a stale snapshot) loses the claim and
 * posts nothing.
 */

const answerFromTranscript = async (
  controlPlane: ControlPlaneClient,
  conversationId: string,
  turnId: string,
): Promise<string | null> => {
  let since: number | undefined;
  let answer: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const history = await controlPlane.readTranscript(conversationId, since);
    for (const event of history.events) {
      if (event.turnId !== turnId) continue;
      const payload = (event.payload ?? {}) as { text?: string };
      if (event.type === "text" && payload.text) answer = payload.text;
    }
    since = history.nextSince;
    if (!history.hasMore) break;
  }
  return answer;
};

export interface MirrorDeps {
  controlPlane: ControlPlaneClient;
  botToken: string;
  provider: string;
  /** The agent's public avatar URL, posted as `icon_url` when set. */
  iconUrl?: string | null;
  /** The link's cursor as this adapter last knew it (the CAS expectation). */
  knownCursor: string | null;
  item: AdapterWorkItem;
  onLog: (message: string, detail?: unknown) => void;
}

/**
 * Handle one finished turn: post what the provider surface is missing, then
 * CAS the cursor. Returns the new cursor when this adapter won, or null when
 * a twin did (nothing was posted in that case).
 */
export const mirrorFinishedTurn = async (
  deps: MirrorDeps,
): Promise<string | null> => {
  const { item } = deps;
  const target = replyTargetForLink(item);
  const iconUrl = deps.iconUrl ?? undefined;

  // Claim FIRST: the CAS is the exactly-once gate, so the post happens only
  // on the winning side. (Claim-then-post means a crash between the two can
  // drop one mirror post — the same at-most-once tradeoff the ingestion
  // doors document; a duplicate post to a human channel is worse than a
  // missing mirror of something the web already shows.) The turn id rides
  // along so the control plane clears the turn's reaction receipt on the
  // winning claim — the answer is about to post, so the "seen" comes off.
  const advanced = await deps.controlPlane.advanceCursor(
    item.linkId,
    deps.knownCursor,
    item.turn.createdAt,
    item.turn.id,
  );
  if (!advanced) return null;

  const fromProvider = item.turn.source === deps.provider;
  // An automated run's report (crons step 7, watches step 10): the turn is a
  // platform-materialized delivery whose message is the automation header,
  // not a person's question — labelling it "(from the web)" would attribute
  // automation to a human. One message: the header as a caption, then the
  // report. The icon distinguishes the two, and watch volume is bounded by
  // one-shot semantics (the decided answer to the posting-shape question).
  // This list mirrors `AUTOMATION_SOURCES` in @onecli/api's conversation
  // validations. This app cannot import that package, so the two are kept in
  // sync by convention — a new automation source must be added in BOTH places
  // or it will be bridged in the control plane yet mis-attributed here.
  const automated = item.turn.source === "cron" || item.turn.source === "watch";
  const automationIcon =
    item.turn.source === "watch" ? ":stopwatch:" : ":calendar:";

  try {
    const answer =
      (await answerFromTranscript(
        deps.controlPlane,
        item.conversationId,
        item.turn.id,
      )) ??
      item.turn.error ??
      null;

    if (automated) {
      await postMessage(deps.botToken, {
        channel: target.channel,
        // The header is quoted verbatim (escape only); the report body is
        // model markdown — converted (markdownToMrkdwn escapes internally).
        text: `${automationIcon} _${escapeSlackText(item.turn.message)}_${answer ? `\n${markdownToMrkdwn(answer)}` : ""}`,
        ...(target.threadTs && { threadTs: target.threadTs }),
        ...(iconUrl && { iconUrl }),
      });
      return item.turn.createdAt;
    }

    if (!fromProvider) {
      // The question came from elsewhere (the web): show it, attributed.
      await postMessage(deps.botToken, {
        channel: target.channel,
        text: `_(from the web)_ ${escapeSlackText(item.turn.message)}`,
        ...(target.threadTs && { threadTs: target.threadTs }),
        ...(iconUrl && { iconUrl }),
      });
    }

    // Mid-run follow-ups the turn consumed: the answer below covers them, so
    // the provider thread must show the web-sourced ones or it reads as an
    // answer to questions it never saw. Provider-sourced follow-ups are
    // already in the channel — posting them again would echo the user.
    for (const followUp of item.followUps ?? []) {
      if (followUp.source === deps.provider) continue;
      await postMessage(deps.botToken, {
        channel: target.channel,
        text: `_(from the web)_ ${escapeSlackText(followUp.message)}`,
        ...(target.threadTs && { threadTs: target.threadTs }),
        ...(iconUrl && { iconUrl }),
      });
    }

    if (answer) {
      await postMessage(deps.botToken, {
        channel: target.channel,
        // The answer is model-authored markdown (or a door failure's
        // turn.error — plain text the converter passes through): convert to
        // mrkdwn so **bold**/headings/lists render instead of showing their
        // markers (escaping happens inside the converter, first).
        text: markdownToMrkdwn(answer),
        ...(target.threadTs && { threadTs: target.threadTs }),
        ...(iconUrl && { iconUrl }),
      });
    }
  } catch (err) {
    // The cursor already moved: log loudly rather than retry into a double
    // post. The web remains the complete record.
    deps.onLog("mirror post failed after cursor advance", {
      err: String(err),
      turnId: item.turn.id,
    });
  }

  return item.turn.createdAt;
};
