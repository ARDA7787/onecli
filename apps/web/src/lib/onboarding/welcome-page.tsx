"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { onboardingPath } from "./steps";
import { StepWelcome } from "./_components/step-welcome";
import { StepNav } from "./_components/step-nav";

export default function WelcomePage() {
  const router = useRouter();
  const { discovery, interests, applyWelcome } = useOnboarding();

  useEffect(() => {
    router.prefetch(onboardingPath("agent"));
  }, [router]);

  return (
    <>
      <div className="w-full">
        <StepWelcome
          initialDiscovery={discovery}
          initialInterests={interests}
          onComplete={(data) => {
            applyWelcome(data);
            router.push(onboardingPath("agent"));
          }}
        />
      </div>
      <StepNav />
    </>
  );
}
