"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";

export interface StepNavProps {
  onBack?: () => void;
  /** Right-side controls: `continue-other` (agent step, custom agent name),
   * `skip-continue` (intermediate setup step), `final` (last step with
   * "Go to Dashboard"). Omit for a bare row (welcome — spacing parity). */
  variant?: "continue-other" | "skip-continue" | "final";
  canProceed?: boolean;
  completing?: boolean;
  onContinue?: () => void;
  /** Skip / "Go to Dashboard": leaves onboarding (marks it complete and
   * redirects), shared by the `skip-continue` and `final` variants. */
  onComplete?: () => void;
}

export const StepNav = ({
  onBack,
  variant,
  canProceed = false,
  completing = false,
  onContinue,
  onComplete,
}: StepNavProps) => (
  <div className="mt-10 flex w-full items-center justify-between">
    <div>
      {onBack && (
        <Button variant="ghost" onClick={onBack} disabled={completing}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
      )}
    </div>
    <div className="flex items-center gap-2">
      {variant === "final" ? (
        <>
          {!canProceed && (
            // Skip is the active completion trigger when the step can't be
            // satisfied, so the spinner belongs here, not on the disabled
            // "Go to Dashboard".
            <Button variant="outline" onClick={onComplete} loading={completing}>
              Skip
            </Button>
          )}
          <Tooltip open={!canProceed && !completing ? undefined : false}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex",
                  !canProceed && !completing && "cursor-not-allowed",
                )}
              >
                <Button
                  variant="brand"
                  onClick={onComplete}
                  loading={canProceed && completing}
                  disabled={!canProceed || completing}
                >
                  Go to Dashboard
                  <ArrowRight className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              Complete the setup or skip to continue
            </TooltipContent>
          </Tooltip>
        </>
      ) : variant === "continue-other" ? (
        <Button variant="brand" onClick={onContinue} disabled={!canProceed}>
          Continue
          <ArrowRight className="size-4" />
        </Button>
      ) : variant === "skip-continue" ? (
        <>
          {/* Skip leaves onboarding entirely (same as the final step); Continue
           * proceeds to the next step once the setup is detected. */}
          <Button variant="outline" onClick={onComplete} loading={completing}>
            Skip
          </Button>
          <Tooltip open={!canProceed && !completing ? undefined : false}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex",
                  !canProceed && !completing && "cursor-not-allowed",
                )}
              >
                <Button
                  variant="brand"
                  onClick={onContinue}
                  disabled={!canProceed || completing}
                >
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              Complete the setup to continue, or skip onboarding
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
    </div>
  </div>
);
