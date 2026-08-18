"use client";

import { useState } from "react";
import Image from "next/image";
import { CircleHelp } from "lucide-react";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { cn } from "@onecli/ui/lib/utils";
import { selectableCard } from "./selectable";

const INTEREST_CARDS = [
  {
    id: "coding" as const,
    name: "Coding Agents",
    description: "AI assistants that help you write code",
    agents: [
      {
        id: "claude-code",
        name: "Claude Code",
        icon: "/icons/claude-code.svg",
      },
      { id: "cursor", name: "Cursor", icon: "/icons/cursor.svg" },
      { id: "codex", name: "Codex", icon: "/icons/codex.svg" },
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        icon: "/icons/github-copilot.svg",
      },
    ],
  },
  {
    id: "autonomous" as const,
    name: "Autonomous Agents",
    description: "Standalone AI agents that run independently",
    agents: [
      { id: "openclaw", name: "OpenClaw", icon: "/icons/openclaw.svg" },
      { id: "hermes", name: "Hermes", icon: "/icons/hermes.svg" },
      { id: "nanoclaw", name: "NanoClaw", icon: "/icons/nanoclaw.svg" },
      { id: "ironclaw", name: "IronClaw", icon: "/icons/ironclaw.svg" },
    ],
  },
];

interface WelcomeInterestsSectionProps {
  selected: Set<string>;
  onToggle: (id: "coding" | "autonomous") => void;
  onIdkToggle: () => void;
  className?: string;
}

export const WelcomeInterestsSection = ({
  selected,
  onToggle,
  onIdkToggle,
  className,
}: WelcomeInterestsSectionProps) => {
  const [imgErrors, setImgErrors] = useState<Set<string>>(() => new Set());
  const isIdk = selected.has("idk");

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">What are you interested in?</h2>
        <span className="text-muted-foreground text-sm">
          Select all that apply
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        {INTEREST_CARDS.map((card, i) => {
          const isSelected = selected.has(card.id);

          return (
            <button
              key={card.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggle(card.id)}
              style={{ animationDelay: `${i * 80}ms` }}
              className={cn(
                "group flex h-full flex-col items-center justify-between gap-5 rounded-2xl p-8 duration-200",
                "animate-in fade-in slide-in-from-bottom-2 fill-mode-both",
                selectableCard(isSelected),
              )}
            >
              <div className="text-center">
                <p className="text-lg font-semibold">{card.name}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {card.description}
                </p>
              </div>

              <div className="flex items-center gap-3">
                {card.agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex size-8 items-center justify-center rounded-lg bg-muted/50"
                    title={agent.name}
                  >
                    {imgErrors.has(agent.id) ? (
                      <AgentIcon className="text-muted-foreground size-4" />
                    ) : (
                      <Image
                        src={agent.icon}
                        alt={agent.name}
                        width={20}
                        height={20}
                        className="rounded"
                        onError={() =>
                          setImgErrors((prev) => new Set([...prev, agent.id]))
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-pressed={isIdk}
        onClick={onIdkToggle}
        className={cn(
          "mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-medium",
          "animate-in fade-in slide-in-from-bottom-2 fill-mode-both",
          selectableCard(isIdk),
        )}
        style={{ animationDelay: "160ms" }}
      >
        <CircleHelp className="size-4" />I Don&apos;t Know
      </button>
    </div>
  );
};
