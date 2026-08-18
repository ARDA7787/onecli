"use client";

import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { useStepGuard } from "./use-step-guard";
import { onboardingPath } from "./steps";
import { StepSetup } from "./_components/step-setup";
import { StepNav } from "./_components/step-nav";

export default function AutonomousAgentPage() {
  const router = useRouter();
  const { setupStage, setSetupStage, completing, handleComplete } =
    useOnboarding();
  const allowed = useStepGuard("autonomous-agent");

  if (!allowed) return null;

  return (
    <>
      <div className="w-full">
        <StepSetup onStageChange={setSetupStage} />
      </div>
      <StepNav
        onBack={() => router.push(onboardingPath("agent"))}
        variant="final"
        canProceed={setupStage === "connected"}
        completing={completing}
        onComplete={handleComplete}
      />
    </>
  );
}
