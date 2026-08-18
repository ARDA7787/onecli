"use client";

import { usePathname } from "next/navigation";
import { useOnboarding } from "../onboarding-context";
import { stepSlugFromPathname, type StepSlug } from "../steps";

const SKIP_LINK_SLUGS: StepSlug[] = ["coding-agent", "autonomous-agent", "run"];

/** Footer escape hatch shown on the setup/run steps (parity with the old
 * portal that rendered from step ≥ 2). */
export const SkipIntroductionLink = () => {
  const pathname = usePathname();
  const { completing, handleComplete } = useOnboarding();

  const slug = stepSlugFromPathname(pathname);
  if (!slug || !SKIP_LINK_SLUGS.includes(slug)) return null;

  return (
    <p className="text-muted-foreground mb-2 text-sm">
      Already familiar with OneCLI?{" "}
      <button
        type="button"
        onClick={handleComplete}
        disabled={completing}
        className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80 disabled:pointer-events-none disabled:opacity-50"
      >
        {completing ? "Redirecting..." : "Skip this introduction"}
      </button>
    </p>
  );
};
