"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { getInstallInfo } from "@/lib/actions/secrets";
import { IS_CLOUD } from "@/lib/env";
import { TryDemoCommand } from "@/app/(dashboard)/_components/try-demo-command";
import {
  getOnboardingInstallStatus,
  type OnboardingSetupStatus,
} from "../actions";

type Stage = OnboardingSetupStatus["stage"];

// ── Left panel: migrate command ──────────────────────────────────────

interface StepSetupLocalFormProps {
  onStageChange?: (stage: Stage) => void;
  stageRef: React.RefObject<Stage>;
  onAgentNameChange?: (name: string | undefined) => void;
}

export const StepSetupLocalForm = ({
  onStageChange,
  stageRef,
  onAgentNameChange,
}: StepSetupLocalFormProps) => {
  const [installInfo, setInstallInfo] = useState<{
    apiKey: string | null;
    appUrl: string;
    apiUrl: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onAgentNameChangeRef = useRef(onAgentNameChange);
  useEffect(() => {
    onAgentNameChangeRef.current = onAgentNameChange;
  }, [onAgentNameChange]);
  const onStageChangeRef = useRef(onStageChange);
  useEffect(() => {
    onStageChangeRef.current = onStageChange;
  }, [onStageChange]);

  // Fetch install info on mount
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

  // Poll for status changes
  useEffect(() => {
    const poll = async () => {
      if (stageRef.current === "connected") return;
      try {
        const status = await getOnboardingInstallStatus();
        stageRef.current = status.stage;
        onStageChangeRef.current?.(status.stage);
        if (status.stage !== "pending" && "agentName" in status) {
          onAgentNameChangeRef.current?.(status.agentName);
        }
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
  }, [stageRef, onStageChangeRef, onAgentNameChangeRef, pollRef]);

  const buildCurlCommand = (path: string) => {
    if (!installInfo?.apiKey || !IS_CLOUD) return null;
    const params = [`key=${installInfo.apiKey}`];
    if (installInfo.appUrl !== "https://app.onecli.sh") {
      params.push(`url=${encodeURIComponent(installInfo.apiUrl)}`);
    }
    return `curl -fsSL "${installInfo.apiUrl}/v1/${path}?${params.join("&")}" | sh`;
  };

  const migrateCommand = buildCurlCommand("migrate/nanoclaw");

  return (
    <div className="mt-6 space-y-4">
      <p className="text-muted-foreground text-sm">
        Already running NanoClaw? Migrate to OneCLI cloud:
      </p>
      {migrateCommand ? (
        <TryDemoCommand command={migrateCommand} />
      ) : (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        </div>
      )}
      <p className="text-muted-foreground text-sm">
        This updates your CLI config, NanoClaw .env, and restarts the service.
        Secrets and app connections need to be re-added in the dashboard.
      </p>
      <p className="text-muted-foreground text-sm">
        Don&apos;t have NanoClaw yet?{" "}
        <a
          href="https://docs.nanoclaw.dev/introduction"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground font-medium underline underline-offset-2"
        >
          Get started here
        </a>
        , then come back to migrate.
      </p>
    </div>
  );
};

// ── Right panel: install polling status ─────────────────────────────

interface StepSetupLocalStatusProps {
  stage: Stage;
  agentName?: string;
}

export const StepSetupLocalStatus = ({
  stage,
  agentName,
}: StepSetupLocalStatusProps) => {
  if (stage === "connected" || stage === "installed") {
    return (
      <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-4">
        <div className="bg-muted inline-flex items-center gap-3 rounded-xl px-5 py-3.5">
          {stage === "connected" ? (
            <span className="bg-brand size-2.5 shrink-0 rounded-full" />
          ) : (
            <span className="relative flex size-5 shrink-0 items-center justify-center">
              <span className="bg-muted-foreground/60 relative z-10 size-2 rounded-full" />
              <span className="animate-pulse-ring border-muted-foreground/40 absolute inset-0 rounded-full border" />
            </span>
          )}
          <span className="text-foreground text-sm font-medium">
            {agentName ?? "Your agent"}
          </span>
        </div>
        <div className="text-muted-foreground space-y-1 text-xs">
          {stage === "connected" ? (
            <p>Agent connected</p>
          ) : (
            <>
              <p>Waiting for container&hellip;</p>
              <p>
                Setup usually takes about 5 minutes. This will update
                automatically once the agent is online.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <PulsingDot />
      <div>
        <p className="text-muted-foreground text-sm font-medium">
          Waiting for your first agent
        </p>
        <p className="text-muted-foreground/60 mt-1 text-xs">
          Run the command on the left to get started
        </p>
      </div>
    </div>
  );
};

export const PulsingDot = () => (
  <div className="relative flex size-12 items-center justify-center">
    <span className="bg-muted-foreground/70 relative z-10 size-3 rounded-full" />
    <span className="animate-pulse-ring border-muted-foreground/20 absolute inset-0 rounded-full border-2" />
  </div>
);
