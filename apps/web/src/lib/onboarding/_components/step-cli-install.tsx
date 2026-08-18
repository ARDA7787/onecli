"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { getInstallInfo } from "@/lib/actions/secrets";
import { IS_CLOUD } from "@/lib/env";
import { buildCliInstallCommand, CODING_TOOLS } from "@/lib/install-command";
import { TryDemoCommand } from "@/app/(dashboard)/_components/try-demo-command";
import {
  getOnboardingInstallStatus,
  type OnboardingSetupStatus,
} from "../actions";
import { PulsingDot } from "./step-setup-local";

type Stage = OnboardingSetupStatus["stage"];

interface StepCliInstallProps {
  /** The survey's coding-tool pick (a framework id, possibly "other"). */
  tool?: string | null;
  onStageChange?: (stage: Stage) => void;
}

export const StepCliInstall = ({
  tool,
  onStageChange,
}: StepCliInstallProps) => {
  const [installInfo, setInstallInfo] = useState<{
    apiKey: string | null;
    appUrl: string;
    apiUrl: string;
  } | null>(null);
  const [stage, setStage] = useState<Stage>("pending");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stageRef = useRef<Stage>("pending");
  const onStageChangeRef = useRef(onStageChange);
  useEffect(() => {
    onStageChangeRef.current = onStageChange;
  }, [onStageChange]);

  useEffect(() => {
    getInstallInfo({ fallbackToDefault: true })
      .then((info) =>
        setInstallInfo({
          apiKey: info.apiKey,
          appUrl: info.appUrl,
          apiUrl: info.apiUrl,
        }),
      )
      .catch(() => setInstallInfo({ apiKey: null, appUrl: "", apiUrl: "" }));
  }, []);

  useEffect(() => {
    const poll = async () => {
      if (stageRef.current === "connected") return;
      try {
        const status = await getOnboardingInstallStatus();
        stageRef.current = status.stage;
        setStage(status.stage);
        onStageChangeRef.current?.(status.stage);
        if (status.stage === "connected" && pollRef.current) {
          clearInterval(pollRef.current);
        }
      } catch {
        // ignore polling errors
      }
    };

    pollRef.current = setInterval(poll, 5000);
    poll();

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // The survey may say "other" (or an autonomous id) — only real coding tools
  // ride the tool= param.
  const toolId = CODING_TOOLS.find((t) => t.id === tool)?.id;

  const curlCommand =
    installInfo?.apiKey && IS_CLOUD
      ? buildCliInstallCommand(
          {
            apiUrl: installInfo.apiUrl,
            appUrl: installInfo.appUrl,
            apiKey: installInfo.apiKey,
          },
          { tool: toolId },
        )
      : null;

  return (
    <div className="flex w-full flex-col items-center">
      <div className="grid w-full gap-6 md:grid-cols-[1.6fr_1fr]">
        {/* Left panel */}
        <div className="rounded-2xl border p-8">
          <h2 className="text-2xl font-bold tracking-tight">
            Install OneCLI CLI
          </h2>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Run this command in your terminal to get started.
          </p>

          <div className="mt-6 space-y-4">
            <p className="text-muted-foreground text-sm">
              Run this in your terminal:
            </p>
            {curlCommand ? (
              <TryDemoCommand command={curlCommand} />
            ) : (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              </div>
            )}
            <div className="text-muted-foreground space-y-1 text-sm">
              <p>This will:</p>
              <ol className="list-inside list-decimal space-y-1 pl-1">
                <li>Install the OneCLI CLI</li>
                <li>Authenticate with your API key</li>
              </ol>
            </div>
            <a
              href="https://onecli.sh/docs/guides/coding-agents"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline underline-offset-2 transition-colors"
            >
              Read the setup guide
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>

        {/* Right panel: status */}
        <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border p-8 text-center">
          {stage === "connected" ? (
            <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-4">
              <div className="bg-muted inline-flex items-center gap-3 rounded-xl px-5 py-3.5">
                <span className="bg-brand size-2.5 shrink-0 rounded-full" />
                <span className="text-foreground text-sm font-medium">
                  CLI Installed
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                OneCLI CLI is ready to use
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <PulsingDot />
              <div>
                <p className="text-muted-foreground text-sm font-medium">
                  Waiting for installation
                </p>
                <p className="text-muted-foreground/60 mt-1 text-xs">
                  Run the command on the left to get started
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
