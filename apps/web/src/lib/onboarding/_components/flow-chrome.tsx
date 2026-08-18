"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@onecli/ui/lib/utils";
import { useOnboarding } from "../onboarding-context";
import {
  onboardingPath,
  STEP_LABELS,
  STEP_SLUGS_BY_FLOW,
  stepSlugFromPathname,
  type FlowType,
  type StepSlug,
} from "../steps";

const widthForStep = (
  slug: StepSlug | null,
  flowType: FlowType | null,
): string => {
  if (
    slug === "coding-agent" ||
    slug === "autonomous-agent" ||
    slug === "run"
  ) {
    return "max-w-5xl";
  }
  if (slug === "agent" && flowType === "autonomous") {
    return "max-w-5xl";
  }
  return "max-w-4xl";
};

/** Shared wizard frame: width container + progress dots. Lives in the layout
 * so it persists (and the dots animate) across step navigations. */
export const FlowChrome = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const pathname = usePathname();
  const { flowType } = useOnboarding();

  const slugs = STEP_SLUGS_BY_FLOW[flowType ?? "default"];
  const currentSlug = stepSlugFromPathname(pathname);
  const currentIndex = currentSlug ? slugs.indexOf(currentSlug) : -1;

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center",
        widthForStep(currentSlug, flowType),
      )}
    >
      {currentIndex >= 0 && (
        <nav aria-label="Onboarding progress" className="mb-6">
          <ol className="flex items-center gap-1.5">
            {slugs.map((slug, i) => {
              const isCurrent = i === currentIndex;
              const isDone = i < currentIndex;
              return (
                <li key={slug} className="flex">
                  <button
                    type="button"
                    aria-label={`${STEP_LABELS[slug]}${isDone ? " (go back)" : ""}`}
                    aria-current={isCurrent ? "step" : undefined}
                    onClick={() => isDone && router.push(onboardingPath(slug))}
                    disabled={!isDone}
                    className={cn(
                      "group rounded-full p-1 outline-none transition-all disabled:cursor-default",
                      "focus-visible:ring-ring/50 focus-visible:ring-2",
                      isDone && "cursor-pointer",
                    )}
                  >
                    <span
                      className={cn(
                        "block rounded-full transition-all",
                        isCurrent
                          ? "bg-brand h-2 w-6"
                          : isDone
                            ? "bg-brand/40 size-2 group-hover:bg-brand/70"
                            : "bg-border size-2",
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {children}
    </div>
  );
};
