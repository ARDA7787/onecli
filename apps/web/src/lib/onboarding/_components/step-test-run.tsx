"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { TryDemoCommand } from "@/app/(dashboard)/_components/try-demo-command";
import { hasFirstGatewayRequest } from "../actions";
import { PulsingDot } from "./step-setup-local";

const AGENT_COMMANDS: Record<string, string> = {
  "claude-code": "onecli run -- claude",
  cursor: "onecli run -- cursor",
  codex: "onecli run -- codex",
  "github-copilot": "onecli run -- copilot",
};

interface StepTestRunProps {
  agent?: string | null;
  onReady?: () => void;
}

export const StepTestRun = ({ agent, onReady }: StepTestRunProps) => {
  const [detected, setDetected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectedRef = useRef(false);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const poll = async () => {
      if (detectedRef.current) return;
      try {
        const has = await hasFirstGatewayRequest();
        if (has) {
          detectedRef.current = true;
          setDetected(true);
          onReadyRef.current?.();
          if (pollRef.current) clearInterval(pollRef.current);
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

  const command = (agent && AGENT_COMMANDS[agent]) || "onecli run -- claude";

  return (
    <div className="flex w-full flex-col items-center">
      <div className="grid w-full gap-6 md:grid-cols-[1.6fr_1fr]">
        {/* Left panel */}
        <div className="rounded-2xl border p-8">
          <h2 className="text-2xl font-bold tracking-tight">Test Your Setup</h2>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Run your first request through the OneCLI gateway to make sure
            everything is working.
          </p>

          <div className="mt-6 space-y-4">
            <p className="text-muted-foreground text-sm">
              Run this in your terminal:
            </p>
            <TryDemoCommand command={command} />
            <p className="text-muted-foreground text-sm">
              Start your coding agent and send a message. We&apos;ll detect the
              request automatically.
            </p>
          </div>
        </div>

        {/* Right panel: status */}
        <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border p-8 text-center">
          {detected ? (
            <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-4">
              <div className="bg-brand/10 flex size-14 items-center justify-center rounded-full">
                <Check className="size-6 text-brand" />
              </div>
              <div>
                <p className="text-sm font-semibold">Request detected</p>
                <p className="text-muted-foreground mt-1.5 text-xs">
                  Your requests are routing through OneCLI.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <PulsingDot />
              <div>
                <p className="text-muted-foreground text-sm font-medium">
                  Waiting for first request
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
