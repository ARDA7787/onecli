"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { WelcomeDiscoverySection } from "./welcome-discovery-section";
import { WelcomeInterestsSection } from "./welcome-interests-section";
import { WelcomeStarSection } from "./welcome-star-section";

interface StepWelcomeProps {
  /** Previously saved answers, so back-navigation and refresh keep the
   * sections filled in. */
  initialDiscovery?: string[];
  initialInterests?: string[];
  onComplete: (data: { discovery: string[]; interests: string[] }) => void;
}

export const StepWelcome = ({
  initialDiscovery,
  initialInterests,
  onComplete,
}: StepWelcomeProps) => {
  const [discovery, setDiscovery] = useState<Set<string>>(
    () => new Set(initialDiscovery),
  );
  const [interests, setInterests] = useState<Set<string>>(
    () => new Set(initialInterests),
  );
  // Returning users already passed the star prompt — don't gate Continue on
  // it again.
  const [starCompleted, setStarCompleted] = useState(
    (initialInterests?.length ?? 0) > 0,
  );

  const interestsRef = useRef<HTMLDivElement>(null);
  const starRef = useRef<HTMLDivElement>(null);

  const showInterests = discovery.size > 0;
  const showStar = interests.size > 0;
  const isComplete = discovery.size > 0 && interests.size > 0 && starCompleted;

  const handleDiscoveryToggle = useCallback((id: string) => {
    setDiscovery((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleInterestToggle = useCallback((id: "coding" | "autonomous") => {
    setInterests((prev) => {
      const next = new Set(prev);
      next.delete("idk");
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleIdkToggle = useCallback(() => {
    setInterests((prev) => (prev.has("idk") ? new Set() : new Set(["idk"])));
  }, []);

  useEffect(() => {
    if (showInterests) {
      const t = setTimeout(
        () =>
          interestsRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          }),
        100,
      );
      return () => clearTimeout(t);
    }
  }, [showInterests]);

  useEffect(() => {
    if (showStar) {
      const t = setTimeout(
        () =>
          starRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          }),
        100,
      );
      return () => clearTimeout(t);
    }
  }, [showStar]);

  const handleContinue = () => {
    onComplete({
      discovery: [...discovery],
      interests: [...interests],
    });
  };

  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to OneCLI</h1>
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-10">
        <WelcomeDiscoverySection
          selected={discovery}
          onToggle={handleDiscoveryToggle}
        />

        {showInterests && (
          <div ref={interestsRef}>
            <WelcomeInterestsSection
              className="animate-in fade-in slide-in-from-bottom-4 fill-mode-both"
              selected={interests}
              onToggle={handleInterestToggle}
              onIdkToggle={handleIdkToggle}
            />
          </div>
        )}

        {showStar && (
          <div ref={starRef}>
            <WelcomeStarSection
              className="animate-in fade-in slide-in-from-bottom-4 fill-mode-both"
              completed={starCompleted}
              onComplete={() => setStarCompleted(true)}
            />
          </div>
        )}

        <Button
          variant="brand"
          size="lg"
          className="w-full"
          disabled={!isComplete}
          onClick={handleContinue}
        >
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
};
