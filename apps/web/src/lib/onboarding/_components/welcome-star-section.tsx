"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { selectableCard } from "./selectable";

const GITHUB_REPO_URL = "https://github.com/onecli/onecli";

type StarChoice = "sure" | "nah" | null;

interface WelcomeStarSectionProps {
  completed: boolean;
  onComplete: () => void;
  className?: string;
}

export const WelcomeStarSection = ({
  completed,
  onComplete,
  className,
}: WelcomeStarSectionProps) => {
  const [choice, setChoice] = useState<StarChoice>(null);

  const handleSure = () => {
    window.open(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");
    setChoice("sure");
    onComplete();
  };

  const handleNah = () => {
    setChoice("nah");
    onComplete();
  };

  return (
    <div className={cn("w-full", className)}>
      <h2 className="text-lg font-semibold">Star our open-source repo?</h2>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          aria-pressed={choice === "sure"}
          onClick={handleSure}
          disabled={completed}
          className={cn(
            "flex items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-medium",
            "animate-in fade-in slide-in-from-bottom-2 fill-mode-both",
            "disabled:pointer-events-none",
            selectableCard(choice === "sure"),
            // Dim the path not taken once the user has answered.
            completed && choice !== "sure" && "opacity-50",
          )}
        >
          <Star className={cn("size-4", choice === "sure" && "fill-current")} />
          Sure!
        </button>
        <button
          type="button"
          aria-pressed={choice === "nah"}
          onClick={handleNah}
          disabled={completed}
          className={cn(
            "flex items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-medium",
            "animate-in fade-in slide-in-from-bottom-2 fill-mode-both",
            "disabled:pointer-events-none",
            selectableCard(choice === "nah"),
            completed && choice !== "nah" && "opacity-50",
          )}
          style={{ animationDelay: "80ms" }}
        >
          Nah, I&apos;m good
        </button>
      </div>
    </div>
  );
};
