"use client";

import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { useStepGuard } from "./use-step-guard";
import { onboardingPath } from "./steps";
import { StepTestRun } from "./_components/step-test-run";
import { StepNav } from "./_components/step-nav";

export default function RunPage() {
  const router = useRouter();
  const { agent, testRunReady, setTestRunReady, completing, handleComplete } =
    useOnboarding();
  const allowed = useStepGuard("run");

  if (!allowed) return null;

  return (
    <>
      <div className="w-full">
        <StepTestRun agent={agent} onReady={() => setTestRunReady(true)} />
      </div>
      <StepNav
        onBack={() => router.push(onboardingPath("coding-agent"))}
        variant="final"
        canProceed={testRunReady}
        completing={completing}
        onComplete={handleComplete}
      />
    </>
  );
}
