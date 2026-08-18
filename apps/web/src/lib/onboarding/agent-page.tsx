"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { useStepGuard } from "./use-step-guard";
import { onboardingPath } from "./steps";
import { StepCodingAgent } from "./_components/step-coding-agent";
import { StepAutonomousAgent } from "./_components/step-autonomous-agent";
import { StepNav } from "./_components/step-nav";

export default function AgentPage() {
  const router = useRouter();
  const {
    flowType,
    agent,
    agentOther,
    setAgentOther,
    selectAgent,
    confirmOtherAgent,
    resetAgent,
  } = useOnboarding();
  const allowed = useStepGuard("agent");

  const nextPath = onboardingPath(
    flowType === "autonomous" ? "autonomous-agent" : "coding-agent",
  );

  useEffect(() => {
    if (allowed) router.prefetch(nextPath);
  }, [allowed, router, nextPath]);

  if (!allowed) return null;

  const handleSelect = (agentId: string) => {
    selectAgent(agentId);
    if (agentId !== "other") router.push(nextPath);
  };

  const handleConfirmOther = () => {
    if (confirmOtherAgent()) router.push(nextPath);
  };

  return (
    <>
      <div className="w-full">
        {flowType === "autonomous" ? (
          <StepAutonomousAgent
            selected={agent}
            otherValue={agentOther}
            onSelect={handleSelect}
            onOtherChange={setAgentOther}
            onConfirmOther={handleConfirmOther}
          />
        ) : (
          <StepCodingAgent
            selected={agent}
            otherValue={agentOther}
            onSelect={handleSelect}
            onOtherChange={setAgentOther}
            onConfirmOther={handleConfirmOther}
          />
        )}
      </div>
      <StepNav
        onBack={() => {
          resetAgent();
          router.push(onboardingPath("welcome"));
        }}
        variant={agent === "other" ? "continue-other" : undefined}
        canProceed={!!agentOther.trim()}
        onContinue={handleConfirmOther}
      />
    </>
  );
}
