"use client";

import { useRef, useState } from "react";
import type { OnboardingSetupStatus } from "../actions";
import { StepSetupLocalForm, StepSetupLocalStatus } from "./step-setup-local";

type Stage = OnboardingSetupStatus["stage"];

interface StepSetupProps {
  onStageChange?: (stage: Stage) => void;
}

export const StepSetup = ({ onStageChange }: StepSetupProps) => {
  const [stage, setStage] = useState<Stage>("pending");
  const [agentName, setAgentName] = useState<string | undefined>();
  const stageRef = useRef<Stage>("pending");

  const handleStageChange = (s: Stage) => {
    stageRef.current = s;
    setStage(s);
    onStageChange?.(s);
  };

  return (
    <div className="flex w-full flex-col items-center">
      <div className="grid w-full gap-6 md:grid-cols-[1.6fr_1fr]">
        <div className="rounded-2xl border p-8">
          <h2 className="text-2xl font-bold tracking-tight">
            Let&apos;s add your first agent.
          </h2>
          <StepSetupLocalForm
            onStageChange={handleStageChange}
            stageRef={stageRef}
            onAgentNameChange={setAgentName}
          />
        </div>

        <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border p-8 text-center">
          <StepSetupLocalStatus stage={stage} agentName={agentName} />
        </div>
      </div>
    </div>
  );
};
