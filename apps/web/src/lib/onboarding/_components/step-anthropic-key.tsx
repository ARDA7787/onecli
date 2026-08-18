"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import {
  hasAnthropicSecret,
  createSecret,
  validateAnthropicKey,
} from "@/lib/actions/secrets";
import { looksLikeAnthropicKey } from "@onecli/api/validations/secret";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export type AnthropicKeyMode = "checking" | "choose" | "enter" | "done";

interface StepAnthropicKeyProps {
  onReady?: () => void;
  mode?: AnthropicKeyMode;
  onModeChange?: (mode: AnthropicKeyMode) => void;
}

export const StepAnthropicKey = ({
  onReady,
  mode: controlledMode,
  onModeChange,
}: StepAnthropicKeyProps) => {
  const [internalMode, setMode] = useState<AnthropicKeyMode>("checking");
  const mode = controlledMode ?? internalMode;
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  const onModeChangeRef = useRef(onModeChange);
  useEffect(() => {
    onModeChangeRef.current = onModeChange;
  }, [onModeChange]);

  const updateMode = (next: AnthropicKeyMode) => {
    setMode(next);
    onModeChangeRef.current?.(next);
  };

  useEffect(() => {
    hasAnthropicSecret({ fallbackToDefault: true }).then((has) => {
      if (has) {
        updateMode("done");
        onReadyRef.current?.();
      } else {
        updateMode("enter");
      }
    });
  }, []);

  const handleSaveKey = async () => {
    const trimmed = key.trim();
    if (!looksLikeAnthropicKey(trimmed)) {
      toast.error("That doesn't look like an Anthropic API key.");
      return;
    }

    setSaving(true);
    try {
      const validation = await validateAnthropicKey(trimmed);
      if (!validation.valid) {
        toast.error(validation.error ?? "Invalid API key.");
        return;
      }

      await createSecret(
        {
          name: "Anthropic API Key",
          type: "anthropic",
          value: trimmed,
          hostPattern: "api.anthropic.com",
        },
        { fallbackToDefault: true },
      );
      updateMode("done");
      onReadyRef.current?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save secret");
    } finally {
      setSaving(false);
    }
  };

  if (mode === "checking") {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center">
      <div className="grid w-full gap-6 md:grid-cols-[1.6fr_1fr]">
        {/* Left panel */}
        <div className="rounded-2xl border p-8">
          <h2 className="text-2xl font-bold tracking-tight">Connect Claude</h2>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Add your Anthropic API key so OneCLI can route Claude requests
            through the gateway.
          </p>

          {mode === "choose" && (
            <div className="mt-6 space-y-3">
              <button
                type="button"
                onClick={() => updateMode("enter")}
                className="flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
              >
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <KeyRound className="size-3.5 text-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Use my own API key</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Paste your Anthropic API key or Claude subscription token.
                  </p>
                </div>
              </button>
            </div>
          )}

          {mode === "enter" && (
            <div className="mt-6 space-y-4">
              <div className="space-y-3">
                <Input
                  placeholder="sk-ant-..."
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  className="font-mono text-xs"
                  autoFocus
                />
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                  >
                    API key
                    <ExternalLink className="size-2.5" />
                  </a>
                  <span className="text-border">|</span>
                  <span>
                    Subscription:{" "}
                    <button
                      type="button"
                      onClick={() => copy("claude setup-token")}
                      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:bg-muted/80"
                    >
                      claude setup-token
                      {copied ? (
                        <Check className="size-2.5 text-brand" />
                      ) : (
                        <Copy className="size-2.5 text-muted-foreground" />
                      )}
                    </button>
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-end">
                <Button
                  size="sm"
                  variant="brand"
                  onClick={handleSaveKey}
                  disabled={!key.trim() || saving}
                >
                  {saving ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Validating...
                    </>
                  ) : (
                    <>
                      <Check className="size-3.5" />
                      Save key
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {mode === "done" && (
            <div className="mt-6 flex items-center gap-3 rounded-xl bg-brand/5 px-4 py-3">
              <Check className="size-4 text-brand" />
              <p className="text-sm font-medium">Claude is connected</p>
            </div>
          )}
        </div>

        {/* Right panel: status */}
        <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border p-8 text-center">
          {mode === "done" ? (
            <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-4">
              <div className="bg-brand/10 flex size-14 items-center justify-center rounded-full">
                <Check className="size-6 text-brand" />
              </div>
              <div>
                <p className="text-sm font-semibold">You&apos;re all set</p>
                <p className="text-muted-foreground mt-1.5 text-xs">
                  Claude requests will be routed through OneCLI.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <div className="flex size-14 items-center justify-center rounded-full bg-muted">
                <KeyRound className="size-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-muted-foreground text-sm font-medium">
                  Connect your Claude credentials
                </p>
                <p className="text-muted-foreground/60 mt-1 text-xs">
                  Choose an option on the left
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
