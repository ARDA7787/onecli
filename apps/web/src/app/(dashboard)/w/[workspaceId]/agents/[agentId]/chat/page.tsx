import type { Metadata } from "next";
import { DirectThreadSection } from "./_components/direct-thread-section";

export const metadata: Metadata = {
  title: "Chat",
};

/** The agent's Chat section (§3.18): the one direct thread. It owns the
 *  page's full height — the frame hands it the raw cell (no section shell)
 *  because the section table marks it `fullHeight`. */
export default function AgentChatPage() {
  return <DirectThreadSection />;
}
