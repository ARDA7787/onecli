"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { useStepGuard } from "./use-step-guard";
import { onboardingPath } from "./steps";
import { StepCliInstall } from "./_components/step-cli-install";
import { StepNav } from "./_components/step-nav";

export default function CodingAgentPage() {
  const router = useRouter();
  const { agent, setupStage, setSetupStage, completing, handleComplete } =
    useOnboarding();
  const allowed = useStepGuard("coding-agent");

  // Auto-advance only on a transition observed while on this page: arriving
  // already-connected (refresh, back-nav from /run) must not bounce forward
  // again. The stage can jump straight from "pending" to "connected".
  const initialStageRef = useRef(setupStage);

  useEffect(() => {
    if (allowed) router.prefetch(onboardingPath("run"));
  }, [allowed, router]);

  useEffect(() => {
    if (!allowed) return;
    if (initialStageRef.current !== "connected" && setupStage === "connected") {
      const timer = setTimeout(
        () => router.replace(onboardingPath("run")),
        3000,
      );
      return () => clearTimeout(timer);
    }
  }, [allowed, setupStage, router]);

  if (!allowed) return null;

  return (
    <>
      <div className="w-full">
        <StepCliInstall tool={agent} onStageChange={setSetupStage} />
      </div>
      <StepNav
        onBack={() => router.push(onboardingPath("agent"))}
        variant="skip-continue"
        canProceed={setupStage === "connected"}
        completing={completing}
        onComplete={handleComplete}
        onContinue={() => router.push(onboardingPath("run"))}
      />
    </>
  );
}
