import type { Metadata } from "next";
import { ModelCard } from "../_components/model-card";
import { SecretGrantsTab } from "../_components/secret-grants-tab";

export const metadata: Metadata = {
  title: "Models",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/**
 * What the agent runs, and the keys that decide it — in that order, because
 * the key is the cause and the model is the consequence (§3.10).
 */
export default async function AgentModelsPage({ params }: Props) {
  const { agentId } = await params;
  return (
    <div className="flex flex-col gap-6">
      <ModelCard agentId={agentId} />
      <SecretGrantsTab agentId={agentId} kind="llm" />
    </div>
  );
}
